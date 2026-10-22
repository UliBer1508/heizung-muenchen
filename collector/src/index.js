// Heizung München – Collector & Steuerung
// Läuft als Windows-Dienst (NSSM) auf dem Mini-PC im Heimnetz.
// Jede Minute: FENECON lesen → Loxone lesen → entscheiden → ggf. Sollwert schreiben → Supabase.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFenecon } from './fenecon.js';
import { LoxoneClient, readRoom } from './loxone.js';
import { Db } from './db.js';
import {
  DEFAULT_SETTINGS, averageEnergy, desiredHouseMode, applyHold, roomTarget, needsWrite, surplusW,
} from './logic.js';

const VERSION = '0.1.0';
const here = path.dirname(fileURLToPath(import.meta.url));
const stateDir = process.env.STATE_DIR || path.join(here, '..', 'state');
const cacheFile = path.join(stateDir, 'cache.json');

const env = process.env;
const cfg = {
  intervalMs: Number(env.INTERVAL_SECONDS || 60) * 1000,
  forceDryRun: env.FORCE_DRY_RUN === '1',
  retentionDays: Number(env.RETENTION_DAYS || 90),
  fenecon: {
    host: env.FENECON_HOST || '192.168.188.59',
    port: Number(env.FENECON_PORT || 502),
    unitId: Number(env.FENECON_UNIT_ID || 1),
    functionCode: Number(env.FENECON_FUNCTION_CODE || 3),
  },
  loxone: {
    host: env.LOXONE_HOST || '192.168.188.128',
    user: env.LOXONE_USER,
    password: env.LOXONE_PASSWORD,
  },
  supabase: { url: env.SUPABASE_URL, key: env.SUPABASE_SERVICE_ROLE_KEY },
};

const log = (...a) => console.log(new Date().toISOString(), ...a);
const db = new Db(cfg.supabase);
const lox = new LoxoneClient(cfg.loxone);

// Laufzeitzustand
const buffer = []; // Messpuffer FENECON (letzte 30 min)
const lastWritten = new Map(); // roomId -> { target, at }
let house = null; // { mode, since, reason }
let cache = loadCache();
let lastCleanupDay = null;

function loadCache() {
  try {
    return JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
  } catch {
    return { settings: null, rooms: [], house: null };
  }
}
function saveCache() {
  try {
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(cacheFile, JSON.stringify({ ...cache, house }, null, 2));
  } catch (e) {
    log('Cache konnte nicht gespeichert werden:', e.message);
  }
}

async function loadConfig() {
  if (!db.enabled) return;
  try {
    const [settings] = await db.select('settings', 'id=eq.1');
    const rooms = await db.select('rooms', 'enabled=eq.true&order=sort.asc');
    cache.settings = settings || cache.settings;
    cache.rooms = rooms || cache.rooms;
  } catch (e) {
    log('Konfiguration aus Supabase nicht ladbar, nutze Cache:', e.message);
  }
}

async function safeDb(label, fn) {
  if (!db.enabled) return;
  try {
    await fn();
  } catch (e) {
    log(`DB (${label}):`, e.message);
  }
}

async function tick() {
  const now = new Date();
  const errors = [];
  await loadConfig();
  const settings = { ...DEFAULT_SETTINGS, ...(cache.settings || {}) };
  const dryRun = cfg.forceDryRun || settings.dry_run;
  if (!house && cache.house) house = cache.house;

  // 1) FENECON
  let feneconOk = true;
  try {
    const r = await readFenecon(cfg.fenecon);
    buffer.push(r);
  } catch (e) {
    feneconOk = false;
    errors.push(`FENECON: ${e.message}`);
  }
  while (buffer.length && buffer[0].ts < now - 30 * 60000) buffer.shift();
  const energy = averageEnergy(buffer, now, settings.average_minutes);
  const latest = feneconOk ? buffer[buffer.length - 1] : null;

  // 2) Modus des Hauses
  const desired = desiredHouseMode({ energy, now, settings, currentMode: house?.mode });
  const held = applyHold({ desired, current: house, now, settings });
  if (held.changed) {
    log(`Modus: ${house?.mode ?? '–'} → ${held.mode} (${held.reason})`);
    await safeDb('decision', () => db.insert('decisions', [{
      kind: 'mode', mode: held.mode, reason: held.reason, dry_run: dryRun,
    }]));
  }
  house = { mode: held.mode, since: held.since, reason: held.reason, pending: held.pending ?? null };

  // 3) Räume
  let loxoneOk = true;
  const roomRows = [];
  for (const room of cache.rooms) {
    const state = await readRoom(lox, room);
    if (state.errors.length) {
      loxoneOk = false;
      errors.push(...state.errors.map((m) => `${room.name}: ${m}`));
    }
    const t = roomTarget({ room, houseMode: house.mode, now });
    const lw = lastWritten.get(room.id);
    let written = false;

    if (settings.automation_enabled && needsWrite({
      target: t.target, loxoneSetpoint: state.setpoint, lastWrittenAt: lw?.at, now,
    })) {
      const reason = t.reason || house.reason;
      if (dryRun) {
        if (lw?.target !== t.target) {
          log(`[TESTMODUS] ${room.name}: würde ${t.target} °C setzen (${t.mode}, ${reason})`);
          lastWritten.set(room.id, { target: t.target, at: now });
          await safeDb('decision', () => db.insert('decisions', [{
            kind: 'write', room_id: room.id, mode: t.mode, target: t.target, reason, dry_run: true,
          }]));
        }
      } else {
        try {
          await lox.setNumber(room.loxone_setpoint_name, t.target);
          written = true;
          lastWritten.set(room.id, { target: t.target, at: now });
          log(`${room.name}: Soll ${state.setpoint ?? '?'} → ${t.target} °C (${t.mode}, ${reason})`);
          await safeDb('decision', () => db.insert('decisions', [{
            kind: 'write', room_id: room.id, mode: t.mode, target: t.target, reason, dry_run: false,
          }]));
        } catch (e) {
          loxoneOk = false;
          errors.push(`${room.name} schreiben: ${e.message}`);
        }
      }
    }

    roomRows.push({
      room_id: room.id,
      temp: state.temp,
      setpoint: written ? t.target : state.setpoint,
      valve: state.valve,
      target: t.target,
      mode: t.mode,
    });
  }

  // 4) Speichern
  if (latest) {
    await safeDb('energy', () => db.insert('energy_readings', [{
      pv_w: latest.pvW,
      grid_w: latest.gridW,
      battery_w: latest.batteryW,
      consumption_w: latest.consumptionW,
      soc: latest.soc,
      surplus_w: energy ? surplusW(energy, settings) : null,
      house_mode: house.mode,
    }]));
  }
  if (roomRows.length) await safeDb('rooms', () => db.insert('room_readings', roomRows));

  for (const e of errors) log('Fehler:', e);
  await safeDb('status', () => db.update('collector_status', 'id=eq.1', {
    last_seen: now.toISOString(),
    version: VERSION,
    house_mode: house.mode,
    mode_since: new Date(house.since).toISOString(),
    mode_reason: house.reason,
    pending_mode: house.pending,
    dry_run: dryRun,
    fenecon_ok: feneconOk,
    loxone_ok: loxoneOk,
    last_error: errors.length ? errors.join(' | ').slice(0, 1000) : null,
  }));
  if (errors.length) {
    await safeDb('decision', () => db.insert('decisions', [{
      kind: 'error', mode: house.mode, reason: errors.join(' | ').slice(0, 1000), dry_run: dryRun,
    }]));
  }

  // 5) Einmal täglich alte Messwerte löschen
  const day = now.toISOString().slice(0, 10);
  if (lastCleanupDay !== day) {
    lastCleanupDay = day;
    const before = new Date(now - cfg.retentionDays * 86400000).toISOString();
    await safeDb('cleanup', async () => {
      await db.delete('energy_readings', `ts=lt.${before}`);
      await db.delete('room_readings', `ts=lt.${before}`);
    });
  }

  saveCache();
}

async function main() {
  log(`Heizung München Collector ${VERSION} startet`);
  if (!cfg.loxone.user || !cfg.loxone.password) log('Warnung: LOXONE_USER / LOXONE_PASSWORD fehlen in .env');
  if (!db.enabled) log('Warnung: Supabase nicht konfiguriert – läuft nur lokal mit Cache');
  if (cfg.forceDryRun) log('FORCE_DRY_RUN=1: es wird nichts nach Loxone geschrieben');

  const once = process.argv.includes('--once');
  const run = async () => {
    try {
      await tick();
    } catch (e) {
      log('Unerwarteter Fehler:', e.stack || e.message);
    }
  };
  await run();
  if (once) return;
  setInterval(run, cfg.intervalMs);
}

main();
