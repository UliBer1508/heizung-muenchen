export const MODE_META = {
  NACHT: { label: 'Nacht', tone: 'night', hint: 'Absenkung, keine PV-Aktionen' },
  NORMAL: { label: 'Normal', tone: 'neutral', hint: 'Normaler Tagbetrieb' },
  PV_LADEN: { label: 'PV-Laden', tone: 'sun', hint: 'Überschuss → Estrich wird geladen' },
  BATTERIE_VOLL: { label: 'Batterie voll', tone: 'green', hint: 'Speicher voll, Überschuss maximal nutzen' },
  ABEND_SCHUTZ: { label: 'Abend-Schutz', tone: 'cool', hint: 'Batterie schonen für den Abend' },
  OVERRIDE: { label: 'Manuell', tone: 'rose', hint: 'Manueller Sollwert aktiv' },
};

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
