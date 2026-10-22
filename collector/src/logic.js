// Heizlogik – reine Funktionen ohne Ein-/Ausgabe, damit sie testbar bleiben.
//
// Grundidee (übernommen aus der Venediger-Lösung, angepasst an
// Wasser-Fußbodenheizung + Wärmepumpe):
//   * Die App setzt pro Raum nur die Komforttemperatur (ϑch) im Loxone-Raumregler.
//   * Loxone regelt das Ventil selbst (Hysterese, Frostschutz bleiben aktiv).
//   * Der Modus des Hauses bestimmt den Sollwert: NACHT / NORMAL / PV_LADEN /
//     BATTERIE_VOLL / ABEND_SCHUTZ. Ein manueller Override hat immer Vorrang.

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

/**
 * Gewünschter Modus des Hauses (ohne Haltezeit).
 * energy: gemittelte Werte der letzten Minuten oder null, wenn FENECON fehlt.
 */
export function desiredHouseMode({ energy, now, settings, currentMode }) {
  const min = localMinutes(now, settings.timezone);
  if (inWindow(min, settings.night_start, settings.night_end)) {
    return { mode: MODES.NACHT, reason: `Nachtfenster ${settings.night_start}–${settings.night_end}` };
  }
  if (!energy) {
    return { mode: MODES.NORMAL, reason: 'Keine FENECON-Daten – sicherer Normalbetrieb' };
  }
  const surplus = surplusW(energy, settings);
  const soc = energy.soc;

  if (soc >= settings.full_soc && surplus >= settings.full_export_w) {
    return { mode: MODES.BATTERIE_VOLL, reason: `SoC ${soc} % ≥ ${settings.full_soc} %, Überschuss ${surplus} W` };
  }
  const pvActive = currentMode === MODES.PV_LADEN || currentMode === MODES.BATTERIE_VOLL;
  const threshold = pvActive ? settings.surplus_off_w : settings.surplus_on_w;
  if (surplus >= threshold) {
    return {
      mode: MODES.PV_LADEN,
      reason: pvActive
        ? `Überschuss ${surplus} W ≥ Aus-Schwelle ${settings.surplus_off_w} W`
        : `Überschuss ${surplus} W ≥ Ein-Schwelle ${settings.surplus_on_w} W`,
    };
  }
  if (min >= parseHm(settings.evening_start) && soc < settings.reserve_soc) {
    return { mode: MODES.ABEND_SCHUTZ, reason: `Ab ${settings.evening_start} und SoC ${soc} % < Reserve ${settings.reserve_soc} %` };
  }
  return { mode: MODES.NORMAL, reason: `Kein Überschuss (${surplus} W)` };
}

/**
 * Haltezeit: Ein Moduswechsel wird erst nach `hold_minutes` umgesetzt.
 * Ausnahmen (sofort): Wechsel in/aus NACHT, erster Lauf.
 */
export function applyHold({ desired, current, now, settings }) {
  if (!current || !current.mode) {
    return { mode: desired.mode, reason: desired.reason, since: now, changed: true };
  }
  if (desired.mode === current.mode) {
    return { mode: current.mode, reason: desired.reason, since: current.since, changed: false };
  }
  const immediate = desired.mode === MODES.NACHT || current.mode === MODES.NACHT;
  const heldMin = (now - new Date(current.since)) / 60000;
  if (immediate || heldMin >= settings.hold_minutes) {
    return { mode: desired.mode, reason: desired.reason, since: now, changed: true };
  }
  const rest = Math.ceil(settings.hold_minutes - heldMin);
  return {
    mode: current.mode,
    reason: `Haltezeit: ${desired.mode} gewünscht, Wechsel in ${rest} min (${desired.reason})`,
    since: current.since,
    changed: false,
    pending: desired.mode,
  };
}

export function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

const MODE_TEMP_FIELD = {
  [MODES.NACHT]: 'temp_night',
  [MODES.NORMAL]: 'temp_normal',
  [MODES.PV_LADEN]: 'temp_pv',
  [MODES.BATTERIE_VOLL]: 'temp_full',
  [MODES.ABEND_SCHUTZ]: 'temp_night',
};

export function overrideActive(room, now) {
  return room.override_temp != null && room.override_until != null && new Date(room.override_until) > now;
}

/** Sollwert für einen Raum. */
export function roomTarget({ room, houseMode, now }) {
  const lo = Math.max(HARD_MIN, room.min_temp ?? HARD_MIN);
  const hi = Math.min(HARD_MAX, room.max_temp ?? HARD_MAX);
  if (overrideActive(room, now)) {
    return {
      mode: MODES.OVERRIDE,
      target: clamp(Number(room.override_temp), lo, hi),
      reason: `Manuell bis ${new Date(room.override_until).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Berlin' })}`,
    };
  }
  const field = MODE_TEMP_FIELD[houseMode];
  return { mode: houseMode, target: clamp(Number(room[field]), lo, hi), reason: null };
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
  night_start: '20:00',
  night_end: '09:00',
  evening_start: '16:00',
  surplus_on_w: 1500,
  surplus_off_w: 300,
  pv_min_soc: 60,
  reserve_soc: 40,
  full_soc: 95,
  full_export_w: 3000,
  hold_minutes: 30,
  average_minutes: 5,
});
