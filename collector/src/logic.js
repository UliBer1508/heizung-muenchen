// Heizlogik – reine Funktionen ohne Ein-/Ausgabe, damit sie testbar bleiben.
//
// Grundidee (übernommen aus der Venediger-Lösung, angepasst an
// Wasser-Fußbodenheizung + Wärmepumpe):
//   * Die App setzt pro Raum nur die Komforttemperatur (ϑch) im Loxone-Raumregler.
//   * Loxone regelt das Ventil selbst (Hysterese, Frostschutz bleiben aktiv).
//   * Ab 0.11: Tagesmodus (Nacht, Abend, Wartetag, ohne PV, Überschuss) + Untergrenze + Priorität
//     bestimmen den Sollwert je Raum (siehe unten). Ein manueller Override hat immer Vorrang.

export const MODES = Object.freeze({
  OVERRIDE: 'OVERRIDE',
  NACHT: 'NACHT',
  NORMAL: 'NORMAL',
  PV_LADEN: 'PV_LADEN',
  BATTERIE_VOLL: 'BATTERIE_VOLL',
  ABEND_SCHUTZ: 'ABEND_SCHUTZ',
});

// Harte Sicherheitsgrenzen – gelten zusätzlich zu den Grenzen in Loxone.
export const HARD_MIN = 5;
export const HARD_MAX = 26;

/** "HH:MM" -> Minuten seit Mitternacht */
export function parseHm(hm) {
  const [h, m] = String(hm).split(':').map(Number);
  return h * 60 + (m || 0);
}

/** Minuten seit Mitternacht in einer Zeitzone (Standard Europe/Berlin). */
export function localMinutes(date, timeZone = 'Europe/Berlin') {
  const parts = new Intl.DateTimeFormat('de-DE', {
    timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(date);
  const h = Number(parts.find((p) => p.type === 'hour').value);
  const m = Number(parts.find((p) => p.type === 'minute').value);
  return h * 60 + m;
}

/** Liegt `min` im Fenster [start, end)? Fenster über Mitternacht erlaubt. */
export function inWindow(min, startHm, endHm) {
  const s = parseHm(startHm);
  const e = parseHm(endHm);
  if (s === e) return false;
  return s < e ? min >= s && min < e : min >= s || min < e;
}

/**
 * Nutzbarer Überschuss in Watt.
 *   gridW:    Netzleistung (FEMS GridActivePower), + = Bezug, − = Einspeisung
 *   batteryW: Batterieleistung (FEMS EssDischargePower), + = Entladen, − = Laden
 * Einspeisung zählt immer. Die Ladeleistung der Batterie zählt nur, wenn der
 * Speicher schon ausreichend voll ist (soc >= pvMinSoc) – sonst gehört die
 * Sonne zuerst der Batterie (Abendreserve).
 */
export function surplusW({ gridW, batteryW, soc }, settings) {
  const exportW = Math.max(0, -(gridW ?? 0));
  const chargeW = Math.max(0, -(batteryW ?? 0));
  const countCharge = soc != null && soc >= settings.pv_min_soc;
  return Math.round(exportW + (countCharge ? chargeW : 0));
}

// ---------------------------------------------------------------------------
// Ab Version 0.11: Tagesmodi wie in Venediger (doc/KONZEPT-TAGESMODI-2026-11-09.md)
//
//   Tagesphase (Uhrzeit):    NACHT → MORGEN → TAG → ABEND → NACHT
//   Tagesmodus:              night · evening · wait (Wartetag) · grid (Schlechter Tag, Modell b)
//                            + pv / full (Überschuss, Modell a)
//   Untergrenze je Raum:     muc_rooms.temp_night – nachts, abends und am Wartetag das Ziel
//   Raumprofil (je Raum):    heat_morning / heat_day = an einem Tag ohne PV in dieser Phase auf Normal
//   Priorität (je Raum):     muc_rooms.priority 1–4 – gilt für beide Modelle; pv_prio 0 = nie mit PV laden
//
// Ein Raum = ein Fußbodenkreis mit eigenem Ventil (Loxone). Alle Kreise hängen an EINER Wärmepumpe.
// Deshalb zählt München „offene Kreise“, wo Venediger Watt zählt:
//   Modell a: so viele Räume, wie der Überschuss trägt (Rückmeldung über den Rest-Überschuss)
//   Modell b: höchstens max_grid_circuits Räume gleichzeitig (Netzgrenze)
// ---------------------------------------------------------------------------

export const PHASES = Object.freeze({ NACHT: 'NACHT', MORGEN: 'MORGEN', TAG: 'TAG', ABEND: 'ABEND' });
/** Überschuss-Stufe „Batterie voll“: alle PV-Räume auf Voll. Darunter = Anzahl Räume mit PV-Wert. */
export const PV_FULL = 100;

/** Tagesphase zur Uhrzeit. */
export function phaseAt(now, settings) {
  const min = localMinutes(now, settings.timezone);
  if (inWindow(min, settings.night_start, settings.morning_start)) return PHASES.NACHT;
  if (inWindow(min, settings.morning_start, settings.morning_end)) return PHASES.MORGEN;
  if (inWindow(min, settings.evening_start, settings.night_start)) return PHASES.ABEND;
  return PHASES.TAG;
}

export const PHASE_LABEL = { NACHT: 'Nacht', MORGEN: 'Morgen', TAG: 'Tag', ABEND: 'Abend' };

/**
 * Modell a – wie viele Räume trägt der Überschuss? (ohne Haltezeit)
 * Gemessen wird der Überschuss NACH dem, was die Heizung schon verbraucht:
 *   – Start: ab surplus_on_w, je weitere stage_up_w ein Raum mehr
 *   – noch genug übrig (≥ stage_up_w) → je stage_up_w ein Raum mehr
 *   – fast nichts mehr übrig (< surplus_off_w) → ein Raum weniger (0 = Modell a endet)
 *   – Akku voll und viel Einspeisung → alle Räume auf Voll
 * level = Anzahl Räume (0 = kein Überschuss), PV_FULL = Batterie voll.
 */
export function desiredPvLevel({ energy, phase, settings, currentLevel = 0, nRooms = 1 }) {
  if (phase === PHASES.NACHT) return { level: 0, reason: 'Nacht – keine PV-Aktionen', immediate: true };
  if (!energy) return { level: 0, reason: 'Keine FENECON-Daten – kein PV-Aufheizen', immediate: true };
  const surplus = surplusW(energy, settings);
  const soc = energy.soc;
  const n = Math.max(1, nRooms);
  const up = Math.max(100, Number(settings.stage_up_w) || 1000);
  const cur = Math.max(0, Math.min(currentLevel >= PV_FULL ? PV_FULL : n, currentLevel || 0));
  const rooms = (k) => `${k} ${k === 1 ? 'Raum' : 'Räume'}`;

  if (soc != null && soc >= settings.full_soc && surplus >= settings.full_export_w) {
    return { level: PV_FULL, reason: `Akku ${soc} % ≥ ${settings.full_soc} % und Überschuss ${surplus} W → alle Räume voll` };
  }
  if (cur === PV_FULL) {
    return surplus >= settings.surplus_off_w
      ? { level: n, reason: `Akku nicht mehr voll, Überschuss ${surplus} W – ${rooms(n)} mit PV-Wert` }
      : { level: Math.max(1, Math.floor(n / 2)), reason: `Überschuss nur ${surplus} W – ${rooms(Math.max(1, Math.floor(n / 2)))} mit PV-Wert` };
  }
  if (cur === 0) {
    if (surplus < settings.surplus_on_w) return { level: 0, reason: `Kein Überschuss (${surplus} W)` };
    const k = Math.min(n, 1 + Math.floor((surplus - settings.surplus_on_w) / up));
    return { level: k, reason: `Überschuss ${surplus} W ≥ ${settings.surplus_on_w} W → ${rooms(k)}` };
  }
  if (surplus < settings.surplus_off_w) {
    return cur - 1 > 0
      ? { level: cur - 1, reason: `Überschuss nur ${surplus} W < ${settings.surplus_off_w} W → ${rooms(cur - 1)}` }
      : { level: 0, reason: `Überschuss nur ${surplus} W < ${settings.surplus_off_w} W → Überschuss-Heizen endet` };
  }
  if (cur < n && surplus >= up) {
    const k = Math.min(n, cur + Math.floor(surplus / up));
    return { level: k, reason: `Noch ${surplus} W übrig → ${rooms(k)}` };
  }
  return { level: cur, reason: `${rooms(cur)} mit Sonnenstrom, Überschuss ${surplus} W` };
}

/**
 * Haltezeit für den Überschuss: Wechsel erst nach `hold_minutes` seit dem letzten Wechsel.
 * Sofort: erster Lauf, Nacht, fehlende Daten.
 */
export function holdPvLevel({ desired, current, now, settings }) {
  if (!current || current.level == null) {
    return { level: desired.level, since: now, reason: desired.reason, changed: true };
  }
  if (desired.level === current.level) {
    return { level: current.level, since: current.since, reason: desired.reason, changed: false };
  }
  const heldMin = (now - new Date(current.since)) / 60000;
  if (desired.immediate || heldMin >= settings.hold_minutes) {
    return { level: desired.level, since: now, reason: desired.reason, changed: true };
  }
  const rest = Math.ceil(settings.hold_minutes - heldMin);
  return {
    level: current.level,
    since: current.since,
    reason: `${current.level >= PV_FULL ? 'Voll' : `${current.level} PV-Räume`} – Wechsel in ${rest} min (${desired.reason})`,
    changed: false,
    pending: desired.level,
  };
}

/**
 * Erwarteter Überschuss für den Rest des Tages in kWh (FEMS-Prognose).
 * PV-Leistung jetzt und in 1/3/6/12 h (Trapez), abzüglich Grundlast, abzüglich Akku bis voll.
 * null = keine (frische) Prognose.
 */
export function expectedSurplusKwh({ forecast, energy, settings, now }) {
  if (!forecast || forecast.at == null || now - new Date(forecast.at) > 90 * 60000) return null;
  const pts = [[0, energy?.pvW ?? forecast.pv_1h], [1, forecast.pv_1h], [3, forecast.pv_3h], [6, forecast.pv_6h], [12, forecast.pv_12h]]
    .filter(([, w]) => w != null && !Number.isNaN(Number(w)));
  if (pts.length < 3) return null;
  const base = Number(settings.baseload_w) || 350;
  let wh = 0;
  for (let i = 1; i < pts.length; i++) {
    const [h0, w0] = pts[i - 1];
    const [h1, w1] = pts[i];
    wh += ((Math.max(0, w0 - base) + Math.max(0, w1 - base)) / 2) * (h1 - h0);
  }
  const soc = energy?.soc;
  const toFull = soc == null ? 0 : (Number(settings.battery_kwh) || 10) * Math.max(0, 100 - soc) / 100;
  return Math.round((wh / 1000 - toFull) * 10) / 10;
}

/**
 * Tagesmodus.
 *   night   – Nacht: Ziel Untergrenze
 *   evening – Abend wie Nacht (Akku bleibt für den Haushalt)
 *   wait    – Wartetag: Überschuss ist heute noch zu erwarten → Untergrenze halten
 *   grid    – Schlechter Tag (Modell b): Profil-Räume auf Normal, Netzgrenze
 * Der Überschuss (Modell a) kommt in allocateRooms obendrauf.
 */
export function dayModeOf({ phase, energy, forecast, settings, now }) {
  if (phase === PHASES.NACHT) return { mode: 'night', reason: 'Nacht – nur Untergrenze halten' };
  if (phase === PHASES.ABEND) return { mode: 'evening', reason: 'Abend wie Nacht – nur Untergrenze halten, Akku bleibt für den Haushalt' };
  const minKwh = Number(settings.wait_min_kwh) || 0;
  if (minKwh > 0) {
    const kwh = expectedSurplusKwh({ forecast, energy, settings, now });
    if (kwh != null && kwh >= minKwh) {
      return { mode: 'wait', reason: `Wartetag – heute noch ca. ${fmt1(kwh)} kWh Überschuss erwartet (ab ${fmt1(minKwh)} kWh wird gewartet)`, kwh };
    }
    if (kwh != null) return { mode: 'grid', reason: `Tag ohne PV – nur ca. ${fmt1(kwh)} kWh Überschuss erwartet`, kwh };
  }
  return { mode: 'grid', reason: 'Tag ohne PV' };
}

/** Anzeige-Modus des Hauses (Status, Protokoll, Analyse). */
export function houseModeOf(phase, level, dayMode = null) {
  if (level >= PV_FULL) return 'BATTERIE_VOLL';
  if (level > 0) return 'PV';
  if (dayMode === 'wait') return 'WARTETAG';
  return phase;
}

export function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

export function overrideActive(room, now) {
  return room.override_temp != null && room.override_until != null && new Date(room.override_until) > now;
}

const flag = (v) => (v == null ? true : Boolean(v));
const pvAllowed = (room) => room.pv_prio == null || Number(room.pv_prio) > 0;
const prioOf = (room) => (room.priority == null ? 99 : Number(room.priority));
const prioTxt = (room) => (room.priority == null ? '' : `Prio ${room.priority} `);

/**
 * Wunsch-Sollwert eines Raums ohne Überschuss (Modell b bzw. Untergrenze).
 * Raum-Modi: OVERRIDE | NORMAL | ABSENK (= Untergrenze)
 */
export function roomTarget({ room, phase, dayMode = 'grid', now }) {
  const lo = Math.max(HARD_MIN, room.min_temp ?? HARD_MIN);
  const hi = Math.min(HARD_MAX, room.max_temp ?? HARD_MAX);
  if (overrideActive(room, now)) {
    return {
      mode: MODES.OVERRIDE,
      target: clamp(Number(room.override_temp), lo, hi),
      reason: `Manuell bis ${new Date(room.override_until).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Berlin' })}`,
    };
  }
  const floor = clamp(Number(room.temp_night), lo, hi);
  const hold = (why) => ({ mode: 'ABSENK', target: floor, reason: `${why} – hält Untergrenze ${fmt1(floor)} °C` });
  if (dayMode === 'night') return hold('Nacht');
  if (dayMode === 'evening') return hold('Abend wie Nacht');
  if (dayMode === 'wait') return hold('Wartetag – Sonne kommt noch');
  const heat = phase === PHASES.MORGEN ? flag(room.heat_morning) : flag(room.heat_day);
  if (!heat) return hold(phase === PHASES.MORGEN ? 'Morgens nicht heizen' : 'Tagsüber nur mit PV');
  const normal = clamp(Number(room.temp_normal), lo, hi);
  return { mode: 'NORMAL', target: Math.max(normal, floor), reason: `Ohne PV: Normal ${fmt1(normal)} °C` };
}

/** Sollwert, bei dem ein wartender Raum sicher nicht heizt: abgerundet Ist − 0,5 °C (0,5er-Schritte), nie über dem Wunsch. */
export function holdBelow(temp, want) {
  return Math.min(Number(want), Math.max(HARD_MIN, Math.floor((Number(temp) - 0.5) * 2) / 2));
}

/**
 * Verteilung auf die Kreise (ab 0.11) – ersetzt die Heiz-Reihenfolge 0.7–0.10.
 *
 * Reihenfolge der Durchgänge, ein gemeinsamer Zähler „offene Kreise“:
 *   0. Manuelle Räume, die gerade heizen, zählen mit.
 *   1. Räume UNTER ihrer Untergrenze → bis zur Untergrenze (geht vor, aber Grenze gilt immer).
 *   2. Modell a (level > 0): PV-Räume nach Priorität auf PV-Wert (Voll bei PV_FULL), höchstens `level`
 *      Räume zusätzlich zur Netzgrenze – der Überschuss bezahlt sie.
 *   3. Modell b (Tagesmodus grid): Profil-Räume nach Priorität auf Normal, bis die Netzgrenze voll ist.
 * Offen = Ist < Wunsch − seq_on_delta (bzw. − seq_off_delta, wenn der Raum den Wunsch schon erreicht hatte).
 * Wer keinen Kreis bekommt, wartet mit holdBelow (Ventil zu). Wer seit wait_boost_min wartet, kommt zuerst dran.
 * Fertige Räume halten ihren Wunsch. Ohne Messwert blockiert ein Raum niemanden.
 *
 * @param items     [{ room, temp, t }] – t = roomTarget()
 * @param level     Überschuss: Anzahl PV-Räume oder PV_FULL
 * @param reached   Set „raumId@Wunsch“ der Räume, die ihren Wunsch erreicht hatten
 * @param waitSince { raumId: ISO } seit wann ein Raum wartet
 * @param active    Set der Räume, die beim letzten Lauf heizten (bleiben bei gleicher Prio vorn)
 * @param rates     { raumId: °C/h } gelernt (muc_heat_rate) – nur für die Restzeit im Text
 */
export function allocateRooms({ items, settings, dayMode = 'grid', level = 0, reached = new Set(), waitSince = {}, active = new Set(), rates = {}, now = new Date() }) {
  const out = items.map((it) => ({ ...it, t: { ...it.t } }));
  const onDelta = Number(settings.seq_on_delta ?? 0.3);
  const offDelta = Math.max(onDelta, Number(settings.seq_off_delta ?? 0.8));
  const cap = Math.max(1, Number(settings.max_grid_circuits) || 6);
  const boostMin = Math.max(0, Number(settings.wait_boost_min ?? 60));
  const newReached = new Set();
  const granted = new Set();
  const waiting = new Map(); // id → Text
  let gridUsed = 0;
  let pvUsed = 0;

  const hasTemp = (it) => it.temp != null && !Number.isNaN(Number(it.temp));
  const isOpen = (it, want) => {
    if (!hasTemp(it)) return false;
    const key = `${it.room.id}@${Number(want)}`;
    const done = Number(it.temp) >= Number(want) - (reached.has(key) ? offDelta : onDelta) - 1e-9;
    if (done) newReached.add(key);
    return !done;
  };
  const boostedAt = (id) => {
    const s = waitSince[id];
    return s && boostMin > 0 && now - new Date(s) >= boostMin * 60000 ? new Date(s).getTime() : null;
  };
  const order = (a, b) => {
    const ba = boostedAt(a.room.id); const bb = boostedAt(b.room.id);
    if (ba != null && bb != null) return ba - bb;
    if (ba != null) return -1;
    if (bb != null) return 1;
    return prioOf(a.room) - prioOf(b.room)
      || (active.has(b.room.id) - active.has(a.room.id))
      || ((a.room.sort ?? 0) - (b.room.sort ?? 0));
  };
  const nachlauf = new Set(); // fertige Räume, deren Ventil noch offen ist – zählen mit
  const grant = (it, t, kind) => {
    it.t = t;
    granted.add(it.room.id);
    if (nachlauf.delete(it.room.id)) gridUsed -= 1;
    if (kind === 'pv') pvUsed += 1; else gridUsed += 1;
  };
  const valveOpen = (it) => Number(it.state?.valve ?? it.valve ?? 0) > 0;

  // 0. Manuelle Räume und Räume im Nachlauf
  const free = [];
  for (const it of out) {
    if (it.t.mode === MODES.OVERRIDE) {
      if (isOpen(it, it.t.target)) { granted.add(it.room.id); gridUsed += 1; }
    } else free.push(it);
  }
  for (const it of free) {
    if (hasTemp(it) && valveOpen(it) && Number(it.temp) >= Number(it.t.target) - onDelta) { nachlauf.add(it.room.id); gridUsed += 1; }
  }

  const floorOf = (it) => clamp(Number(it.room.temp_night), Math.max(HARD_MIN, it.room.min_temp ?? HARD_MIN), Math.min(HARD_MAX, it.room.max_temp ?? HARD_MAX));
  const lo = (it) => Math.max(HARD_MIN, it.room.min_temp ?? HARD_MIN);
  const hi = (it) => Math.min(HARD_MAX, it.room.max_temp ?? HARD_MAX);

  // 1. Unter der Untergrenze – zuerst, aber innerhalb der Netzgrenze
  const below = free.filter((it) => hasTemp(it) && Number(it.temp) < floorOf(it) - onDelta).sort(order);
  for (const it of below) {
    const f = floorOf(it);
    if (gridUsed < cap) {
      const t = it.t.target > f
        ? { ...it.t, reason: `unter Untergrenze ${fmt1(f)} °C – zuerst dran · ${it.t.reason}` }
        : { mode: 'ABSENK', target: f, reason: `unter Untergrenze ${fmt1(f)} °C – heizt bis dorthin` };
      grant(it, t, 'grid');
    } else {
      waiting.set(it.room.id, `unter Untergrenze, wartet – Netzgrenze ${cap} Kreise voll`);
    }
  }
  const belowIds = new Set(below.map((it) => it.room.id));

  // 2. Modell a: Überschuss – PV-Räume nach Priorität, höchstens `level` heizen damit gleichzeitig
  const pvWaiting = new Set();
  if (level > 0) {
    const full = level >= PV_FULL;
    const pvCands = free.filter((it) => !granted.has(it.room.id) && !belowIds.has(it.room.id) && pvAllowed(it.room)).sort(order);
    for (const it of pvCands) {
      const want = clamp(Number(full ? it.room.temp_full : it.room.temp_pv), lo(it), hi(it));
      if (want <= it.t.target) continue; // Grundwert ist schon gleich hoch → Durchgang 3
      const t = full
        ? { mode: 'VOLL', target: want, reason: 'Batterie voll – Estrich maximal laden' }
        : { mode: 'PV', target: want, reason: `PV-Überschuss ${prioTxt(it.room).trim() ? `(${prioTxt(it.room).trim()}) ` : ''}– Estrich laden` };
      if (!isOpen(it, want)) { it.t = t; it.pvHold = true; continue; } // PV-Wert erreicht → hält ihn
      if (full || pvUsed < level) grant(it, t, 'pv');
      else pvWaiting.add(it.room.id);
    }
  }

  // 3. Modell b bzw. Halten: übrige Räume mit ihrem Grundwert (Normal oder Untergrenze)
  const rest = free.filter((it) => !granted.has(it.room.id) && !belowIds.has(it.room.id) && !it.pvHold).sort(order);
  for (const it of rest) {
    const more = pvWaiting.has(it.room.id) ? ' · wartet auf mehr Überschuss' : '';
    if (!isOpen(it, it.t.target)) { it.t = { ...it.t, reason: `${it.t.reason}${more}` }; continue; } // fertig → hält
    if (gridUsed < cap) grant(it, { ...it.t, reason: `${it.t.reason}${more}` }, 'grid');
    else waiting.set(it.room.id, pvWaiting.has(it.room.id)
      ? `wartet auf mehr Überschuss, Netzgrenze ${cap} Kreise voll`
      : `wartet – Netzgrenze ${cap} Kreise voll`);
  }

  // Wartende: Ventil zu
  const heating = out.filter((it) => granted.has(it.room.id));
  const names = heating.map((it) => it.room.name);
  const newWait = {};
  for (const it of out) {
    if (!waiting.has(it.room.id) || granted.has(it.room.id)) continue;
    const want = it.t.target;
    newWait[it.room.id] = waitSince[it.room.id] ?? now.toISOString();
    it.t = {
      mode: 'WARTET',
      target: clamp(holdBelow(it.temp, want), lo(it), hi(it)),
      reason: `${prioTxt(it.room)}${waiting.get(it.room.id)}${names.length ? ` – es heizen: ${names.join(', ')}` : ''}`,
      wanted: want,
    };
  }

  const eta = {};
  for (const it of heating) {
    const rate = Number(rates[it.room.id]);
    if (rate > 0.01 && hasTemp(it)) eta[it.room.id] = Math.round(((it.t.target - Number(it.temp)) / rate) * 60);
  }
  const nWait = Object.keys(newWait).length;
  const until = (id) => (eta[id] != null ? `, fertig in ca. ${fmtDur(eta[id])}` : '');
  const list = heating.map((it) => `${it.room.name} ${fmt1(it.temp)} → ${fmt1(it.t.target)} °C${until(it.room.id)}`).join(' · ');
  const head = level >= PV_FULL ? 'Batterie voll'
    : level > 0 ? `Überschuss für ${level} ${level === 1 ? 'Raum' : 'Räume'}, Netzgrenze ${cap} Kreise`
      : `Netzgrenze ${cap} Kreise`;
  const reason = heating.length
    ? `${head}: es heizen ${heating.length} – ${list}${nWait ? ` · ${nWait} warten` : ''}`
    : `${head}: kein Raum muss heizen${nWait ? ` · ${nWait} warten` : ''}`;

  return {
    items: out, reached: newReached, waitSince: newWait, active: [...granted],
    gridUsed, pvUsed, eta, waitingOn: names, reason,
  };
}

const fmtDur = (min) => (min < 60 ? `${Math.max(1, Math.round(min))} min` : `${Math.floor(min / 60)} h ${String(Math.round(min % 60)).padStart(2, '0')} min`);

/**
 * Aufheiz-Messung (ab 0.8): Läuft für einen Raum, solange er heizen darf und offen ist.
 * Liefert für jeden beendeten Lauf eine Zeile für muc_heat_runs.
 *
 * @param runs   { raumId: { started, tempStart, target, ticks, activeSum, heatSum, heatN, outSum, outN } }
 * @param tick   { now, items, active: Set(ids), reached: Set(ids), heatW, outdoorC }
 * @returns { runs (neu), finished: [Zeilen] }
 */
export function trackHeatRuns(runs, { now, items, active, reached, heatW = null, outdoorC = null }) {
  const next = {};
  const finished = [];
  const byId = Object.fromEntries(items.map((it) => [it.room.id, it]));
  const nActive = active.size;
  const close = (id, run, reachedTarget) => {
    const it = byId[id];
    const tempEnd = it?.temp != null ? Number(it.temp) : run.tempLast;
    const minutes = (now - new Date(run.started)) / 60000;
    if (minutes < 30 || tempEnd == null || run.tempStart == null) return;
    finished.push({
      room_id: id,
      started_at: new Date(run.started).toISOString(),
      ended_at: now.toISOString(),
      minutes: Math.round(minutes),
      temp_start: run.tempStart,
      temp_end: tempEnd,
      target: run.target,
      reached: reachedTarget,
      rooms_heating: Math.round((run.activeSum / run.ticks) * 10) / 10,
      heat_w: run.heatN ? Math.round(run.heatSum / run.heatN) : null,
      outdoor_c: run.outN ? Math.round((run.outSum / run.outN) * 10) / 10 : null,
    });
  };
  for (const [id, run] of Object.entries(runs || {})) {
    const it = byId[id];
    if (!active.has(id) || !it) close(id, run, reached.has(id));
  }
  for (const id of active) {
    const it = byId[id];
    if (!it) continue;
    const temp = it.temp != null ? Number(it.temp) : null;
    const prev = runs?.[id];
    const run = prev || { started: now, tempStart: temp, target: Number(it.t.target), ticks: 0, activeSum: 0, heatSum: 0, heatN: 0, outSum: 0, outN: 0 };
    run.ticks += 1;
    run.activeSum += nActive;
    if (heatW != null) { run.heatSum += heatW; run.heatN += 1; }
    if (outdoorC != null) { run.outSum += Number(outdoorC); run.outN += 1; }
    if (temp != null) run.tempLast = temp;
    run.target = Number(it.t.target);
    next[id] = run;
  }
  return { runs: next, finished };
}

const fmt1 = (v) => (v == null ? '?' : Number(v).toLocaleString('de-DE', { minimumFractionDigits: 1, maximumFractionDigits: 1 }));

/**
 * Tagesprotokoll (ab 0.6): einmal am Tag beim ersten Lauf außerhalb der Nacht erfassen –
 * normalerweise direkt bei „Morgen ab“. Dann hält das Protokoll fest, was das FEMS für den
 * Tag vorhergesagt hat, bevor die Heizung darauf reagieren konnte.
 */
export function shouldCaptureDayContext({ phase, today, lastCapturedDay }) {
  return phase !== PHASES.NACHT && lastCapturedDay !== today;
}

/** Muss der Sollwert in Loxone geschrieben werden? */
export function needsWrite({ target, loxoneSetpoint, lastWrittenAt, now, resendMinutes = 120 }) {
  if (loxoneSetpoint == null || Number.isNaN(loxoneSetpoint)) return true;
  if (Math.abs(loxoneSetpoint - target) >= 0.05) return true;
  if (!lastWrittenAt) return false;
  // Gelegentlich bestätigen, falls der Wert in Loxone zurückgesetzt wurde.
  return (now - new Date(lastWrittenAt)) / 60000 >= resendMinutes;
}

/** Gleitender Mittelwert über die Messpuffer-Einträge der letzten `minutes`. */
export function averageEnergy(buffer, now, minutes) {
  const from = now - minutes * 60000;
  const recent = buffer.filter((r) => r.ts >= from);
  if (recent.length === 0) return null;
  const avg = (k) => {
    const vals = recent.map((r) => r[k]).filter((v) => v != null && !Number.isNaN(v));
    return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
  };
  return {
    pvW: Math.round(avg('pvW')),
    gridW: Math.round(avg('gridW')),
    batteryW: Math.round(avg('batteryW')),
    consumptionW: Math.round(avg('consumptionW')),
    // letzter gültiger Ladestand im Fenster (null statt 0, wenn keiner gelesen wurde)
    soc: (() => { const s = recent.map((r) => r.soc).filter((v) => v != null && v >= 0 && v <= 100); return s.length ? Math.round(s[s.length - 1]) : null; })(),
    samples: recent.length,
  };
}

export const DEFAULT_SETTINGS = Object.freeze({
  timezone: 'Europe/Berlin',
  automation_enabled: true,
  dry_run: true,
  night_start: '22:00',
  morning_start: '06:00',
  morning_end: '09:00',
  evening_start: '17:00',
  surplus_on_w: 1500,   // Überschuss-Heizen ein ab diesem Überschuss
  stage_up_w: 1000,     // je so viel übrigem Überschuss ein Raum mehr
  surplus_off_w: 300,   // ein Raum weniger, wenn weniger übrig ist
  pv_min_soc: 60,
  full_soc: 95,
  full_export_w: 3000,
  hold_minutes: 30,
  average_minutes: 5,
  baseload_w: 350,
  max_grid_circuits: 6, // Netzgrenze: so viele Kreise gleichzeitig ohne Überschuss (Konzept 09.11.2026 §5)
  wait_min_kwh: 5,      // Wartetag, wenn heute noch so viel Überschuss erwartet wird (0 = nie warten)
  battery_kwh: 10,      // Akku-Kapazität (für „Akku bis voll“ in der Wartetag-Rechnung)
  wait_boost_min: 60,   // wer so lange wartet, kommt zuerst dran
  seq_on_delta: 0.3,    // Raum gilt als fertig ab Soll − 0,3 °C
  seq_off_delta: 0.8,   // … und wieder als offen unter Soll − 0,8 °C
});
