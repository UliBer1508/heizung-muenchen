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
