// Gemeinsame Bausteine der Auto-Steuerung (Plan und Verlauf) – 12.11.2026.
// Übernommen aus Heizung Venediger (src/components/ki/planerTeile.tsx, Commit bf8d3a7), Gestaltung mit den Klassen
// der Münchner App. Farben wie Venediger (geprüft hell/dunkel inkl. Farbenblindheit), definiert in styles.css (.auto).
export const TZ = 'Europe/Berlin';
export const hm = (ms) => new Date(ms).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', timeZone: TZ });
export const num = (v, d = 1) => (v == null || Number.isNaN(Number(v)) ? '–' : Number(v).toLocaleString('de-DE', { minimumFractionDigits: d, maximumFractionDigits: d }));
export const tagKurz = (iso) => new Date(`${iso}T12:00:00Z`).toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit' });
export const TIP = { contentStyle: { background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 8, fontSize: 12 } };
export const ACHSE = { fontSize: 11, fill: 'var(--muted)' };

export function Kachel({ k, v, s, d, vglName }) {
  return (
    <div className="card tile">
      <div className="eyebrow">{k}</div>
      <div className="tile-value">{v}</div>
      {s && <div className="muted small">{s}</div>}
      {d && <div className={`delta ${d.gut ? 'good' : 'bad'}`}>{d.text} <span className="muted">je Tag gegenüber {vglName}</span></div>}
    </div>
  );
}
