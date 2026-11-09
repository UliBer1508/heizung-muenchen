export const MODE_META = {
  // Tagesphasen (Haus, ohne Überschuss)
  NACHT: { label: 'Nacht', tone: 'night', hint: 'Nur Räume unter ihrer Untergrenze heizen – Wärme aus dem Estrich' },
  MORGEN: { label: 'Morgen ohne PV', tone: 'neutral', hint: 'Räume mit „morgens“ auf Normal, nach Priorität, höchstens so viele Kreise wie die Netzgrenze' },
  TAG: { label: 'Tag ohne PV', tone: 'neutral', hint: 'Räume mit „tagsüber“ auf Normal, nach Priorität, höchstens so viele Kreise wie die Netzgrenze' },
  ABEND: { label: 'Abend', tone: 'cool', hint: 'Abend wie Nacht – nur Untergrenze, der Akku bleibt für den Haushalt' },
  WARTETAG: { label: 'Wartetag', tone: 'cool', hint: 'Heute kommt laut Prognose noch Überschuss – die Räume halten nur ihre Untergrenze' },
  // Überschuss (Haus)
  PV_1: { label: 'PV Stufe 1', tone: 'sun', hint: 'Überschuss → Räume mit Prio 1 laden den Estrich' },
  PV_2: { label: 'PV Stufe 2', tone: 'sun', hint: 'Überschuss → Räume mit Prio 1–2 laden den Estrich' },
  PV_3: { label: 'PV Stufe 3', tone: 'sun', hint: 'Überschuss → alle PV-Räume laden den Estrich' },
  BATTERIE_VOLL: { label: 'Batterie voll', tone: 'green', hint: 'Speicher voll, Überschuss maximal nutzen' },
  // Raum (PV gilt auch fürs Haus: Überschuss wird nach Priorität auf die Räume verteilt)
  NORMAL: { label: 'Normal', tone: 'neutral', hint: 'Raum auf Normaltemperatur' },
  ABSENK: { label: 'Untergrenze', tone: 'night', hint: 'Raum hält seine Untergrenze' },
  WARTET: { label: 'Wartet', tone: 'night', hint: 'Ventil zu – Netzgrenze voll oder zu wenig Überschuss, Räume mit kleinerer Prio-Nummer sind zuerst dran' },
  PV: { label: 'PV', tone: 'sun', hint: 'Überschuss wird nach Priorität auf die Räume verteilt – Estrich laden' },
  VOLL: { label: 'Voll', tone: 'green', hint: 'Batterie voll – maximal laden' },
  OVERRIDE: { label: 'Manuell', tone: 'rose', hint: 'Manueller Sollwert aktiv' },
  // ältere Einträge im Protokoll (bis Version 0.4)
  PV_LADEN: { label: 'PV-Laden', tone: 'sun', hint: 'Überschuss → Estrich wird geladen' },
  ABEND_SCHUTZ: { label: 'Abend-Schutz', tone: 'cool', hint: 'Batterie schonen für den Abend' },
};

export const PRIO_LABEL = { 0: 'nie', 1: 'Prio 1', 2: 'Prio 2', 3: 'Prio 3' };

/** Kurzbeschreibung des Raumprofils, z. B. „morgens · tagsüber · PV Prio 1“ */
export function profileText(r) {
  if (r.pv_prio === undefined) return null; // Migration 005 fehlt
  const parts = [];
  if (r.heat_morning) parts.push('morgens');
  if (r.heat_day) parts.push('tagsüber');
  if (!parts.length) parts.push('nur Untergrenze');
  if (r.priority != null) parts.push(`Prio ${r.priority}`);
  if (!(r.pv_prio > 0)) parts.push('kein PV-Laden');
  return parts.join(' · ');
}

export const modeMeta = (m) => MODE_META[m] || { label: m || '–', tone: 'neutral', hint: '' };

export const fmtW = (w) => {
  if (w == null) return '–';
  const a = Math.abs(w);
  return a >= 1000 ? `${(w / 1000).toLocaleString('de-DE', { maximumFractionDigits: 1, minimumFractionDigits: 1 })} kW` : `${Math.round(w)} W`;
};

export const fmtT = (t, digits = 1) =>
  t == null ? '–' : `${Number(t).toLocaleString('de-DE', { minimumFractionDigits: digits, maximumFractionDigits: digits })} °C`;

export const fmtTime = (ts) =>
  ts ? new Date(ts).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Berlin' }) : '–';

export const fmtDateTime = (ts) =>
  ts
    ? new Date(ts).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Berlin' })
    : '–';

export const minutesAgo = (ts) => (ts ? Math.round((Date.now() - new Date(ts)) / 60000) : null);

// Wetterlage nach WMO-Schlüssel (so liefert sie die FEMS-App „Wetter“)
export function weatherText(code) {
  if (code == null) return { icon: '·', text: '–' };
  const c = Number(code);
  if (c === 0) return { icon: '☀️', text: 'klar' };
  if (c === 1) return { icon: '🌤️', text: 'überwiegend klar' };
  if (c === 2) return { icon: '⛅', text: 'teils bewölkt' };
  if (c === 3) return { icon: '☁️', text: 'bewölkt' };
  if (c === 45 || c === 48) return { icon: '🌫️', text: 'Nebel' };
  if (c >= 51 && c <= 57) return { icon: '🌦️', text: 'Niesel' };
  if ((c >= 61 && c <= 67) || (c >= 80 && c <= 82)) return { icon: '🌧️', text: 'Regen' };
  if ((c >= 71 && c <= 77) || c === 85 || c === 86) return { icon: '🌨️', text: 'Schnee' };
  if (c >= 95) return { icon: '⛈️', text: 'Gewitter' };
  return { icon: '·', text: `Code ${c}` };
}

// Uhrzeit „ts + h Stunden“ in Berlin, auf volle Stunde gerundet: „13 Uhr“ bzw. „Sa 12 Uhr“
export function clockIn(ts, h) {
  const t = new Date(Math.round((new Date(ts).getTime() + h * 3600000) / 3600000) * 3600000);
  const day = (d) => d.toLocaleDateString('en-CA', { timeZone: 'Europe/Berlin' });
  const hour = Number(t.toLocaleString('en-GB', { hour: 'numeric', hour12: false, timeZone: 'Europe/Berlin' })) % 24;
  if (day(t) === day(new Date())) return `${hour} Uhr`;
  const wd = t.toLocaleDateString('de-DE', { weekday: 'short', timeZone: 'Europe/Berlin' }).replace('.', '');
  return `${wd} ${hour} Uhr`;
}
