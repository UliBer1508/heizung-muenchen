// Heizlogik – reine Funktionen ohne Ein-/Ausgabe, damit sie testbar bleiben.
//
// Grundidee (übernommen aus der Venediger-Lösung, angepasst an
// Wasser-Fußbodenheizung + Wärmepumpe):
//   * Die App setzt pro Raum nur die Komforttemperatur (ϑch) im Loxone-Raumregler.
//   * Loxone regelt das Ventil selbst (Hysterese, Frostschutz bleiben aktiv).
//   * Ab 0.5: Tagesphase + PV-Stufe + Raumprofil bestimmen den Sollwert je Raum
//     (siehe unten). Ein manueller Override hat immer Vorrang.

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
// Ab Version 0.5: Tagesphasen + PV-Stufen + Raumprofile
//
//   Tagesphase (nur Uhrzeit):  NACHT → MORGEN → TAG → ABEND → NACHT
//   PV-Stufe (nur Energie):    0 = kein Überschuss, 1–3 = Räume mit Priorität ≤ Stufe
//                              bekommen ihren PV-Wert, 4 = Batterie voll → alle "Voll"
//   Raumprofil (je Raum):      heat_morning / heat_day / heat_evening = in dieser Phase
//                              auf Normal halten, sonst Absenkwert (temp_night);
//                              pv_prio 0 = nie mit PV aufheizen, 1 = zuerst … 3 = zuletzt
// Sollwert eines Raums = max(Grundwert der Phase, PV-Wert der Stufe).
// ---------------------------------------------------------------------------

export const PHASES = Object.freeze({ NACHT: 'NACHT', MORGEN: 'MORGEN', TAG: 'TAG', ABEND: 'ABEND' });
export const PV_FULL = 4;

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
 * Gewünschte PV-Stufe (ohne Haltezeit).
 * Gemessen wird der Überschuss NACH dem, was die Heizung schon verbraucht:
 *   – noch genug übrig (≥ stage_up_w)  → eine Stufe höher
 *   – fast nichts mehr übrig (< surplus_off_w) → eine Stufe niedriger
 */
export function desiredPvLevel({ energy, phase, settings, currentLevel = 0 }) {
  if (phase === PHASES.NACHT) return { level: 0, reason: 'Nacht – keine PV-Aktionen', immediate: true };
  if (!energy) return { level: 0, reason: 'Keine FENECON-Daten – kein PV-Aufheizen', immediate: true };
  const surplus = surplusW(energy, settings);
  const soc = energy.soc;
  const cur = Math.max(0, Math.min(PV_FULL, currentLevel || 0));

  if (soc != null && soc >= settings.full_soc && surplus >= settings.full_export_w) {
    return { level: PV_FULL, reason: `Akku ${soc} % ≥ ${settings.full_soc} % und Überschuss ${surplus} W` };
  }
  if (cur === PV_FULL) {
    // Batterie nicht mehr voll bzw. weniger Export → zurück auf die höchste normale Stufe
    return surplus >= settings.surplus_off_w
      ? { level: 3, reason: `Überschuss ${surplus} W – zurück auf Stufe 3` }
      : { level: 2, reason: `Überschuss nur ${surplus} W – zurück auf Stufe 2` };
  }
  if (cur === 0) {
    return surplus >= settings.surplus_on_w
      ? { level: 1, reason: `Überschuss ${surplus} W ≥ ${settings.surplus_on_w} W → Stufe 1` }
      : { level: 0, reason: `Kein Überschuss (${surplus} W)` };
  }
  if (surplus < settings.surplus_off_w) {
    return { level: cur - 1, reason: `Überschuss nur ${surplus} W < ${settings.surplus_off_w} W → Stufe ${cur - 1}` };
  }
  if (cur < 3 && surplus >= settings.stage_up_w) {
    return { level: cur + 1, reason: `Noch ${surplus} W übrig ≥ ${settings.stage_up_w} W → Stufe ${cur + 1}` };
  }
  return { level: cur, reason: `Stufe ${cur}, Überschuss ${surplus} W` };
}

/**
 * Haltezeit für die PV-Stufe: Wechsel erst nach `hold_minutes` seit dem letzten Wechsel.
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
    reason: `Stufe ${current.level} – Wechsel auf ${desired.level} in ${rest} min (${desired.reason})`,
    changed: false,
    pending: desired.level,
  };
}

/** Anzeige-Modus des Hauses aus Phase und Stufe (für Status, Protokoll, Analyse). */
export function houseModeOf(phase, level) {
  if (level >= PV_FULL) return 'BATTERIE_VOLL';
  if (level > 0) return `PV_${level}`;
  return phase;
}

export function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

export function overrideActive(room, now) {
  return room.override_temp != null && room.override_until != null && new Date(room.override_until) > now;
}

// Fehlen die neuen Spalten (Migration 005 noch nicht ausgeführt), verhält sich
// ein Raum wie bisher: in allen Phasen Normal, PV-Priorität 1.
const flag = (v) => (v == null ? true : Boolean(v));
const prioOf = (room) => (room.pv_prio == null ? 1 : Number(room.pv_prio));

/**
 * Sollwert für einen Raum.
 * Raum-Modi: OVERRIDE | VOLL | PV | NORMAL | ABSENK
 */
export function roomTarget({ room, phase, level = 0, soc = null, now, settings }) {
  const lo = Math.max(HARD_MIN, room.min_temp ?? HARD_MIN);
  const hi = Math.min(HARD_MAX, room.max_temp ?? HARD_MAX);
  if (overrideActive(room, now)) {
    return {
      mode: MODES.OVERRIDE,
      target: clamp(Number(room.override_temp), lo, hi),
      reason: `Manuell bis ${new Date(room.override_until).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Berlin' })}`,
    };
  }

  // 1) Grundwert nach Tagesphase und Raumprofil
  let heat = false;
  let why;
  if (phase === PHASES.MORGEN) {
    heat = flag(room.heat_morning);
    why = heat ? 'morgens heizen' : 'morgens nicht heizen';
  } else if (phase === PHASES.TAG) {
    heat = flag(room.heat_day);
    why = heat ? 'tagsüber heizen' : 'tagsüber nur mit PV';
  } else if (phase === PHASES.ABEND) {
    const wants = flag(room.heat_evening);
    const socOk = soc == null || soc >= settings.reserve_soc;
    heat = wants && socOk;
    why = !wants ? 'abends nicht heizen' : socOk ? 'abends heizen' : `abends nicht – Akku ${soc} % < ${settings.reserve_soc} %`;
  } else {
    why = 'Nacht – Wärme aus dem Estrich';
  }
  const base = Number(heat ? room.temp_normal : room.temp_night);
  let mode = heat ? 'NORMAL' : 'ABSENK';
  let target = base;
  let reason = `${PHASE_LABEL[phase] || phase}: ${why}`;

  // 2) PV-Aufheizen nach Priorität
  const prio = prioOf(room);
  if (prio > 0 && level >= PV_FULL) {
    const t = Number(room.temp_full);
    if (t > target) { target = t; mode = 'VOLL'; reason = 'Batterie voll – Estrich maximal laden'; }
  } else if (prio > 0 && level >= prio) {
    const t = Number(room.temp_pv);
    if (t > target) { target = t; mode = 'PV'; reason = `PV-Stufe ${level} (Raum-Prio ${prio}) – Estrich laden`; }
  } else if (prio > 0 && mode === 'ABSENK' && phase !== PHASES.NACHT) {
    reason += ` · wartet auf PV-Stufe ${prio}`;
  }

  return { mode, target: clamp(target, lo, hi), reason };
}

/**
 * Heiz-Reihenfolge (ab 0.7) – wie in Venediger: Räume werden nacheinander geheizt.
 *
 * Jeder Raum hat einen Rang (heat_rank, 1 = zuerst; gleicher Rang = gemeinsam).
 * Beteiligt sind nur Räume, die gerade mehr als ihren Absenkwert wollen (NORMAL, PV, VOLL).
 * Der vorderste Rang mit einem Raum, der seinen Sollwert noch nicht erreicht hat, ist „dran“.
 * Räume mit späterem Rang bekommen so lange ihren Absenkwert – das Ventil bleibt zu und das
 * Heizwasser geht in die Räume, die dran sind. Fertige Räume halten ihren Sollwert.
 *
 * „Erreicht“: Ist ≥ Soll − seq_on_delta. Mit Hysterese: Ein erreichter Raum gilt erst wieder als
 * offen, wenn er unter Soll − seq_off_delta fällt. Ohne Messwert blockiert ein Raum die anderen nicht.
 *
 * Schutz gegen Hängenbleiben: Kommt ein Rang nach seq_max_minutes nicht ans Ziel (Ventil defekt,
 * Wärmepumpe aus …), wird zusätzlich der nächste Rang freigegeben – je weitere seq_max_minutes einer mehr.
 *
 * @param items    [{ room, temp, t }] – t ist das Ergebnis von roomTarget()
 * @param reached  Set der Raum-IDs, die beim letzten Lauf als erreicht galten
 * @param turn     { rank, since } – welcher Rang seit wann dran ist (vom letzten Lauf)
 * @returns { items (mit angepasstem t), reached, turn, activeRank, waitingOn, reason }
 */
export function applyHeatSequence({ items, settings, reached = new Set(), turn = null, now = new Date() }) {
  const out = items.map((it) => ({ ...it }));
  const newReached = new Set();
  if (!settings.sequence_enabled) {
    return { items: out, reached: newReached, turn: null, activeRank: null, waitingOn: [], reason: null };
  }
  const onDelta = Number(settings.seq_on_delta ?? 0.3);
  const offDelta = Math.max(onDelta, Number(settings.seq_off_delta ?? 0.8));
  const rankOf = (room) => (room.heat_rank == null ? 999 : Number(room.heat_rank));
  const absenkOf = (room) => Number(room.temp_night);

  const part = out.filter(({ room, t }) => t.mode !== MODES.OVERRIDE && t.mode !== 'ABSENK'
    && Number(t.target) > absenkOf(room) + 0.05);
  for (const it of part) {
    const { room, temp, t } = it;
    if (temp == null || Number.isNaN(Number(temp))) { it.done = true; continue; }
    const limit = reached.has(room.id) ? t.target - offDelta : t.target - onDelta;
    it.done = Number(temp) >= limit - 1e-9;
    if (it.done) newReached.add(room.id);
  }
  const open = part.filter((it) => !it.done);
  if (!open.length) {
    return { items: out, reached: newReached, turn: null, activeRank: null, waitingOn: [], reason: part.length ? 'alle Räume haben ihren Sollwert' : null };
  }
  const openRanks = [...new Set(open.map((it) => rankOf(it.room)))].sort((a, b) => a - b);
  const first = openRanks[0];
  const newTurn = turn && turn.rank === first && turn.since ? { rank: first, since: turn.since } : { rank: first, since: now };
  const maxMin = Number(settings.seq_max_minutes ?? 180);
  const waited = (now - new Date(newTurn.since)) / 60000;
  const extra = maxMin > 0 ? Math.floor(waited / maxMin) : 0;
  const activeRank = openRanks[Math.min(extra, openRanks.length - 1)];
  const waitingOn = open.filter((it) => rankOf(it.room) === first);
  const names = waitingOn.map((it) => `${it.room.name} ${fmt1(it.temp)} von ${fmt1(it.t.target)} °C`).join(', ');
  for (const it of part) {
    if (rankOf(it.room) <= activeRank) continue;
    const lo = Math.max(HARD_MIN, it.room.min_temp ?? HARD_MIN);
    const hi = Math.min(HARD_MAX, it.room.max_temp ?? HARD_MAX);
    it.t = {
      mode: 'WARTET',
      target: clamp(absenkOf(it.room), lo, hi),
      reason: `Reihenfolge: wartet (Rang ${rankOf(it.room)}), zuerst ${names}`,
      wanted: it.t.target,
    };
  }
  const freed = activeRank !== first ? ` · nach ${Math.round(waited)} min auch bis Rang ${activeRank} freigegeben` : '';
  return {
    items: out, reached: newReached, turn: newTurn, activeRank, waitingOn: waitingOn.map((it) => it.room.name),
    reason: `Reihenfolge: Rang ${first} ist dran – ${names}${freed}`,
  };
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
    soc: Math.round(recent[recent.length - 1].soc),
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
  surplus_on_w: 1500,   // Stufe 1 ein ab diesem Überschuss
  stage_up_w: 1000,     // nächste Stufe, wenn trotz Heizung noch so viel übrig ist
  surplus_off_w: 300,   // eine Stufe zurück, wenn weniger übrig ist
  pv_min_soc: 60,
  reserve_soc: 60,      // abends nur heizen, wenn der Akku mindestens so voll ist
  full_soc: 95,
  full_export_w: 3000,
  hold_minutes: 30,
  average_minutes: 5,
  sequence_enabled: false, // Heiz-Reihenfolge (Migration 008 schaltet sie ein)
  seq_on_delta: 0.3,    // Raum gilt als fertig ab Soll − 0,3 °C
  seq_off_delta: 0.8,   // … und wieder als offen unter Soll − 0,8 °C
  seq_max_minutes: 180, // kommt ein Rang so lange nicht ans Ziel, darf zusätzlich der nächste
});
