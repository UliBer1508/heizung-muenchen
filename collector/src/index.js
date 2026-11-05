// Heizung München – Collector & Steuerung
// Läuft als Windows-Dienst (NSSM) auf dem Mini-PC im Heimnetz.
// Jede Minute: FENECON lesen → Loxone lesen → entscheiden → ggf. Sollwert schreiben → Supabase.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFenecon } from './fenecon.js';
import { LoxoneClient, readRoom } from './loxone.js';
import { Db } from './db.js';
import { readOutdoorTemp, readEvccChargePower } from './extras.js';
import { readFemsForecast } from './fems-rest.js';
import {
  DEFAULT_SETTINGS, averageEnergy, phaseAt, desiredPvLevel, holdPvLevel, houseModeOf, roomTarget, needsWrite, surplusW,
  shouldCaptureDayContext, applyHeatSequence, trackHeatRuns,
} from './logic.js';

const VERSION = '0.9.0';
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
  // Analyse (optional)
  // Wetter + Prognose vom FEMS (App "REST/JSON lesend"), Open-Meteo nur als Notlösung für die Außentemperatur
  femsRest: env.FEMS_REST === 'off' ? null : {
    host: env.FEMS_REST_HOST || env.FENECON_HOST || '192.168.188.59',
    port: Number(env.FEMS_REST_PORT || 80),
    password: env.FEMS_REST_PASSWORD || 'user',
    everyMin: 15,
  },
  weather: env.WEATHER === 'off' ? null : { lat: Number(env.WEATHER_LAT || 48.14), lon: Number(env.WEATHER_LON || 11.58) },
  evccUrl: env.EVCC_URL === '' ? null : (env.EVCC_URL || 'http://localhost:7070'),
};

const log = (...a) => console.log(new Date().toISOString(), ...a);
const db = new Db(cfg.supabase);
const lox = new LoxoneClient(cfg.loxone);

// Laufzeitzustand
const buffer = []; // Messpuffer FENECON (letzte 30 min)
const lastWritten = new Map(); // roomId -> { target, at }
let house = null; // { mode, phase, level, levelSince, since, reason, pending }
let profileColsWarned = false;
let cache = loadCache();
let lastCleanupDay = null;
let outdoor = { temp: null, source: null, at: 0 }; // letzte Außentemperatur
let femsWarned = false;
let forecastTableWarned = false;
let evccWarned = false;
let missingColsWarned = false;
let lastDailyStore = null; // Datum (Berlin), an dem die Tageswerte zuletzt gespeichert wurden
let lastContextDay = null; // Datum (Berlin), an dem das Tagesprotokoll zuletzt erfasst wurde
let contextWarned = false;
let lastCarW = null;   // Auto-Ladeleistung vom letzten Lauf (für den geschätzten Heizstrom)
let heatRates = {};    // gelernte Aufheizrate je Raum (°C pro Stunde) aus muc_heat_rate
let ratesWarned = false;

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
    const [settings] = await db.select('muc_settings', 'id=eq.1');
    const rooms = await db.select('muc_rooms', 'enabled=eq.true&order=sort.asc');
    cache.settings = settings || cache.settings;
    cache.rooms = rooms || cache.rooms;
    try {
      const rates = await db.select('muc_heat_rate', 'select=room_id,rate_c_per_h');
      heatRates = Object.fromEntries((rates || []).map((r) => [r.room_id, Number(r.rate_c_per_h)]));
    } catch (e) {
      if (!ratesWarned) log('Aufheizraten nicht ladbar (migration-009 fehlt?):', e.message);
      ratesWarned = true;
    }
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
  if (!house && cache.house) {
    // Cache aus Version ≤ 0.4 (nur "mode") auf PV-Stufe umrechnen
    const h = cache.house;
    const level = h.level ?? (h.mode === 'BATTERIE_VOLL' ? 4 : h.mode === 'PV_LADEN' ? 1 : 0);
    house = { ...h, level, levelSince: h.levelSince ?? h.since };
  }

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

  // 2) Tagesphase + PV-Stufe
  const phase = phaseAt(now, settings);
  const desired = desiredPvLevel({ energy, phase, settings, currentLevel: house?.level ?? 0 });
  const held = holdPvLevel({
    desired, current: house ? { level: house.level, since: house.levelSince } : null, now, settings,
  });
  const mode = houseModeOf(phase, held.level);
  const modeChanged = !house || house.mode !== mode;
  if (modeChanged) {
    log(`Modus: ${house?.mode ?? '–'} → ${mode} (${held.reason})`);
    await safeDb('decision', () => db.insert('muc_decisions', [{
      kind: 'mode', mode, reason: held.reason, dry_run: dryRun,
    }]));
  }
  house = {
    mode,
    phase,
    level: held.level,
    levelSince: held.since,
    since: modeChanged ? now : house.since,
    reason: held.reason,
    pending: held.pending != null ? houseModeOf(phase, held.pending) : null,
  };
  if (!profileColsWarned && cache.rooms.length && cache.rooms[0].pv_prio === undefined) {
    log('Hinweis: Raumprofile fehlen – supabase/migration-005-raumprofile.sql ausführen (bis dahin heizen alle Räume wie bisher)');
    profileColsWarned = true;
  }

  // 3) Räume: erst alle lesen und Wunsch-Sollwert bestimmen …
  let loxoneOk = true;
  const roomRows = [];
  const items = [];
  for (const room of cache.rooms) {
    const state = await readRoom(lox, room);
    if (state.errors.length) {
      loxoneOk = false;
      errors.push(...state.errors.map((m) => `${room.name}: ${m}`));
    }
    const t = roomTarget({ room, phase, level: house.level, soc: energy?.soc ?? null, now, settings });
    items.push({ room, state, temp: state.temp, t });
  }

  // … dann die Heiz-Reihenfolge anwenden (ab 0.7) …
  const seq = applyHeatSequence({
    items, settings, now,
    reached: new Set(cache.seq?.reached || []),
    turn: cache.seq?.turn?.since ? { ...cache.seq.turn, since: new Date(cache.seq.turn.since) } : null,
    waits: cache.seq?.waits || {},
    rates: heatRates,
  });

  // Aufheiz-Messung: wie schnell wird ein Raum warm, während er heizen darf?
  const heatW = energy?.consumptionW != null ? Math.max(0, energy.consumptionW - (lastCarW || 0) - 400) : null;
  const tracked = trackHeatRuns(cache.seq?.runs || {}, {
    now, items: seq.items, active: new Set(seq.active), reached: seq.reached, heatW, outdoorC: outdoor.temp,
  });
  if (tracked.finished.length) {
    for (const f of tracked.finished) {
      const name = cache.rooms.find((r) => r.id === f.room_id)?.name || f.room_id;
      log(`Aufheiz-Messung ${name}: ${f.temp_start} → ${f.temp_end} °C in ${f.minutes} min (${f.rooms_heating} Räume gleichzeitig)`);
    }
    await safeDb('heat_runs', () => db.insert('muc_heat_runs', tracked.finished));
  }
  const seqKey = `${seq.activeRank ?? '-'}|${[...seq.active].sort().join(',')}`;
  if (seq.reason && cache.seq?.key !== seqKey) {
    log(seq.reason);
    await safeDb('decision', () => db.insert('muc_decisions', [{
      kind: 'sequence', mode: house.mode, reason: seq.reason, dry_run: dryRun,
    }]));
  }
  cache.seq = { reached: [...seq.reached], turn: seq.turn, waits: seq.waits, runs: tracked.runs, key: seqKey, reason: seq.reason };

  // … und schreiben.
  for (const { room, state, t } of seq.items) {
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
          await safeDb('decision', () => db.insert('muc_decisions', [{
            kind: 'write', room_id: room.id, mode: t.mode, target: t.target, reason, dry_run: true,
          }]));
        }
      } else {
        try {
          await lox.setNumber(room.loxone_setpoint_name, t.target);
          written = true;
          lastWritten.set(room.id, { target: t.target, at: now });
          log(`${room.name}: Soll ${state.setpoint ?? '?'} → ${t.target} °C (${t.mode}, ${reason})`);
          await safeDb('decision', () => db.insert('muc_decisions', [{
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

  // 4) Zusatzdaten für die Analyse (Fehler hier stören die Steuerung nicht)
  if (Date.now() - outdoor.at >= 15 * 60000) {
    outdoor.at = Date.now(); // auch bei Fehler nicht jede Minute neu versuchen
    let got = false;
    if (cfg.femsRest) {
      try {
        const { row, raw } = await readFemsForecast(cfg.femsRest);
        if (row.outdoor_c != null) { outdoor.temp = row.outdoor_c; outdoor.source = 'fems'; got = true; }
        if (femsWarned) log('FEMS-Wetter wieder verfügbar');
        femsWarned = false;
        await safeDb('forecast', async () => {
          try {
            await db.insert('muc_forecast', [{ ts: now.toISOString(), source: 'fems', ...row, raw }]);
          } catch (e) {
            if (!/muc_forecast|PGRST205|42P01/.test(e.message)) throw e;
            if (!forecastTableWarned) log('Hinweis: Tabelle muc_forecast fehlt – supabase/migration-004-prognose.sql ausführen');
            forecastTableWarned = true;
          }
        });
      } catch (e) {
        if (!femsWarned) log('FEMS-Wetter/Prognose nicht verfügbar:', e.message);
        femsWarned = true;
      }
    }
    if (!got && cfg.weather) {
      try {
        outdoor.temp = await readOutdoorTemp(cfg.weather);
        outdoor.source = 'open-meteo';
      } catch (e) {
        log('Außentemperatur nicht verfügbar:', e.message);
      }
    }
  }
  let carW = null;
  if (cfg.evccUrl) {
    try {
      carW = await readEvccChargePower({ url: cfg.evccUrl });
      lastCarW = carW;
      evccWarned = false;
    } catch (e) {
      if (!evccWarned) log('evcc nicht erreichbar (Auto-Ladeleistung fehlt in der Analyse):', e.message);
      evccWarned = true;
    }
  }

  // 5) Speichern
  if (latest) {
    const row = {
      pv_w: latest.pvW,
      grid_w: latest.gridW,
      battery_w: latest.batteryW,
      consumption_w: latest.consumptionW,
      soc: latest.soc,
      surplus_w: energy ? surplusW(energy, settings) : null,
      house_mode: house.mode,
      car_w: carW,
      outdoor_c: outdoor.temp,
      outdoor_source: outdoor.source,
    };
    await safeDb('energy', async () => {
      try {
        await db.insert('muc_energy_readings', [row]);
      } catch (e) {
        // Analyse-Spalten noch nicht angelegt (Migration fehlt) → ohne sie speichern
        if (!/car_w|outdoor_c|outdoor_source|PGRST204/.test(e.message)) throw e;
        const { outdoor_source, ...withoutSource } = row;
        try {
          await db.insert('muc_energy_readings', [withoutSource]); // nur migration-004 fehlt
          return;
        } catch (e2) {
          if (!/car_w|outdoor_c|PGRST204/.test(e2.message)) throw e2;
        }
        const { car_w, outdoor_c, ...basic } = withoutSource;
        await db.insert('muc_energy_readings', [basic]);
        if (!missingColsWarned) log('Hinweis: Spalten car_w/outdoor_c fehlen – supabase/migration-002-analyse.sql ausführen');
        missingColsWarned = true;
      }
    });
  }
  if (roomRows.length) await safeDb('rooms', () => db.insert('muc_room_readings', roomRows));

  for (const e of errors) log('Fehler:', e);
  await safeDb('status', () => db.update('muc_collector_status', 'id=eq.1', {
    last_seen: now.toISOString(),
    version: VERSION,
    house_mode: house.mode,
    mode_since: new Date(house.since).toISOString(),
    mode_reason: house.reason,
    pending_mode: house.pending,
    sequence_info: seq.reason,
    dry_run: dryRun,
    fenecon_ok: feneconOk,
    loxone_ok: loxoneOk,
    last_error: errors.length ? errors.join(' | ').slice(0, 1000) : null,
  }));
  if (errors.length) {
    await safeDb('decision', () => db.insert('muc_decisions', [{
      kind: 'error', mode: house.mode, reason: errors.join(' | ').slice(0, 1000), dry_run: dryRun,
    }]));
  }

  // 6) Tageswerte abgeschlossener Tage dauerhaft speichern (beim Start und nach Mitternacht)
  const berlinDay = now.toLocaleDateString('en-CA', { timeZone: settings.timezone || 'Europe/Berlin' });

  // 6a) Tagesprotokoll: Prognose am Morgen + geltende Einstellungen (ab 0.6, migration-006)
  if (db.enabled && shouldCaptureDayContext({ phase, today: berlinDay, lastCapturedDay: lastContextDay })) {
    lastContextDay = berlinDay;
    try {
      const r = await db.rpc('muc_capture_day_context', { p_version: VERSION });
      if (r && r !== 'vorhanden') log(`Tagesprotokoll ${berlinDay}: ${r}`);
      contextWarned = false;
    } catch (e) {
      if (!contextWarned) {
        log(/muc_capture_day_context|PGRST202|42883/.test(e.message)
          ? 'Hinweis: Tagesprotokoll fehlt – supabase/migration-006-tagesprotokoll.sql ausführen'
          : `Tagesprotokoll nicht gespeichert: ${e.message}`);
      }
      contextWarned = true;
    }
  }
  if (db.enabled && lastDailyStore !== berlinDay) {
    lastDailyStore = berlinDay;
    try {
      const n = await db.rpc('muc_store_missing_days');
      if (n) log(`Tageswerte gespeichert: ${n} Tag(e)`);
    } catch (e) {
      log('Tageswerte nicht gespeichert (migration-003-zeitraeume.sql ausgeführt?):', e.message);
    }
  }

  // 7) Einmal täglich alte Messwerte löschen
  const day = now.toISOString().slice(0, 10);
  if (lastCleanupDay !== day) {
    lastCleanupDay = day;
    const before = new Date(now - cfg.retentionDays * 86400000).toISOString();
    await safeDb('cleanup', async () => {
      await db.delete('muc_energy_readings', `ts=lt.${before}`);
      await db.delete('muc_room_readings', `ts=lt.${before}`);
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
