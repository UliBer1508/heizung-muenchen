// Energiefluss-Kachel (PV / Verbraucher / Netz / Batterie um den Wechselrichter)
// Erwartet das energy-Objekt aus der Übersicht:
//   { pv_w, grid_w (+Bezug/−Einspeisung), battery_w (+Entladen/−Laden), consumption_w, soc }
// Keine weiteren Abhängigkeiten, Styles sind eingebettet.

const IDLE_W = 30; // darunter gilt eine Leitung als "steht"
const MAX_W = 10000; // Vollausschlag der Ringe (10 kWp / ~10 kW Hauslast)

const C = {
  pv: '#f2a12e',
  home: '#4a90d9',
  grid: '#8a8f98',
  battery: '#7cb342',
  track: 'rgba(140,150,160,0.18)',
  ring: 'rgba(140,150,160,0.45)',
  line: 'rgba(140,150,160,0.35)',
};

const R = 46; // Radius der Gauges
const CX = 200;
const CY = 215;
const NODES = {
  pv: { x: 85, y: 95 },
  home: { x: 315, y: 95 },
  grid: { x: 85, y: 335 },
  battery: { x: 315, y: 335 },
};
const INV_R = 38;

function fmtW(w) {
  if (w == null || !Number.isFinite(w)) return '–';
  const a = Math.abs(w);
  return a >= 1000 ? `${(a / 1000).toFixed(2)} kW` : `${Math.round(a)} W`;
}

// Punkt auf der Strecke zwischen Gauge-Rand und Wechselrichter-Rand
function edge(from, to, r) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const d = Math.hypot(dx, dy);
  return { x: from.x + (dx / d) * r, y: from.y + (dy / d) * r };
}

// Ring-Bogen von 135° bis 405° (offen nach unten, wie ein Tacho)
function arc(cx, cy, r, frac) {
  const start = (135 * Math.PI) / 180;
  const sweep = (270 * Math.PI) / 180 * Math.max(0, Math.min(1, frac));
  const end = start + sweep;
  const x1 = cx + r * Math.cos(start);
  const y1 = cy + r * Math.sin(start);
  const x2 = cx + r * Math.cos(end);
  const y2 = cy + r * Math.sin(end);
  const large = sweep > Math.PI ? 1 : 0;
  return `M ${x1} ${y1} A ${r} ${r} 0 ${large} 1 ${x2} ${y2}`;
}

function Ticks({ cx, cy }) {
  const out = [];
  for (let i = 0; i <= 18; i++) {
    const a = ((135 + i * 15) * Math.PI) / 180;
    const r1 = R + 9;
    const r2 = R + (i % 3 === 0 ? 14 : 12);
    out.push(
      <line
        key={i}
        x1={cx + r1 * Math.cos(a)}
        y1={cy + r1 * Math.sin(a)}
        x2={cx + r2 * Math.cos(a)}
        y2={cy + r2 * Math.sin(a)}
        stroke={C.ring}
        strokeWidth="1"
      />
    );
  }
  return <g>{out}</g>;
}

const ICONS = {
  pv: (
    <g fill="none" strokeWidth="2" strokeLinecap="round">
      <circle cx="0" cy="0" r="6" />
      {[0, 45, 90, 135, 180, 225, 270, 315].map((a) => {
        const r = (a * Math.PI) / 180;
        return <line key={a} x1={9 * Math.cos(r)} y1={9 * Math.sin(r)} x2={13 * Math.cos(r)} y2={13 * Math.sin(r)} />;
      })}
    </g>
  ),
  home: (
    <path d="M-11 -1 L0 -11 L11 -1 M-8 -3 V11 H-3 V4 H3 V11 H8 V-3" fill="none" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
  ),
  grid: <path d="M2 -12 L-7 2 H0 L-2 12 L7 -2 H0 Z" fill="none" strokeWidth="2" strokeLinejoin="round" />,
  battery: (
    <g fill="none" strokeWidth="2">
      <rect x="-11" y="-6" width="20" height="12" rx="2" />
      <line x1="11.5" y1="-2.5" x2="11.5" y2="2.5" strokeLinecap="round" />
    </g>
  ),
};

function Gauge({ id, label, value, frac, color, labelBelow }) {
  const { x, y } = NODES[id];
  return (
    <g>
      <circle cx={x} cy={y} r={R + 16} fill="var(--ef-bg)" stroke={C.ring} strokeWidth="1.5" />
      <Ticks cx={x} cy={y} />
      <path d={arc(x, y, R, 1)} stroke={C.track} strokeWidth="9" fill="none" strokeLinecap="round" />
      {frac > 0.005 && (
        <path className="ef-arc" d={arc(x, y, R, frac)} stroke={color} strokeWidth="9" fill="none" strokeLinecap="round" />
      )}
      <g transform={`translate(${x} ${y - 14})`} stroke={color}>
        {ICONS[id]}
      </g>
      <text x={x} y={y + 16} textAnchor="middle" className="ef-value">
        {value}
      </text>
      <text x={x} y={labelBelow ? y + R + 36 : y - R - 24} textAnchor="middle" className="ef-label">
        {label}
      </text>
    </g>
  );
}

// Leitung mit laufenden Punkten. dir: +1 = zum Wechselrichter, −1 = vom Wechselrichter weg, 0 = Stillstand
function Flow({ id, watts, dir, color }) {
  const inv = { x: CX, y: CY };
  const a = edge(NODES[id], inv, R + 18);
  const b = edge(inv, NODES[id], INV_R + 4);
  const [p, q] = dir >= 0 ? [a, b] : [b, a];
  const d = `M ${p.x} ${p.y} L ${q.x} ${q.y}`;
  // schneller bei mehr Leistung: 0,6 s (≥ 8 kW) bis 3 s (sehr wenig)
  const dur = Math.max(0.6, 3 - (Math.abs(watts) / 1000) * 0.3);
  return (
    <g>
      <path d={d} stroke={C.line} strokeWidth="2" fill="none" />
      {dir !== 0 && (
        <path
          d={d}
          className="ef-dots"
          stroke={color}
          strokeWidth="8"
          strokeLinecap="round"
          fill="none"
          style={{ animationDuration: `${dur}s` }}
        />
      )}
    </g>
  );
}

const CSS = `
.ef-card { --ef-bg: var(--card, var(--surface, #fff)); }
.ef-svg { width: 100%; max-width: 440px; height: auto; display: block; margin: 0 auto; }
.ef-svg text { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; fill: currentColor; }
.ef-value { font-size: 14px; font-weight: 600; }
.ef-label { font-size: 15px; font-weight: 600; }
.ef-inv { font-size: 12px; opacity: .7; }
.ef-note { font-size: 12.5px; font-weight: 600; }
.ef-dots { stroke-dasharray: 0.1 18; animation: ef-move linear infinite; }
.ef-arc { transition: d .6s ease; }
@keyframes ef-move { from { stroke-dashoffset: 0; } to { stroke-dashoffset: -18.1; } }
.ef-compact { --ef-bg: transparent; flex: 0 0 auto; }
.ef-compact .ef-svg { width: 230px; max-width: 100%; margin: 0; }
.ef-compact .ef-value { font-size: 19px; }
.ef-compact .ef-label { font-size: 21px; }
.ef-compact .ef-note { font-size: 18px; }
.ef-compact .ef-inv { font-size: 14px; }
@media (prefers-color-scheme: dark) { .ef-card { --ef-bg: var(--card, var(--surface, #1c1f24)); } }
@media (prefers-reduced-motion: reduce) { .ef-dots { animation: none; stroke-dasharray: 0.1 9; } }
`;

export default function EnergyFlow({ energy, compact = false }) {
  if (!energy) return null;
  const pv = Math.max(0, energy.pv_w ?? 0);
  const grid = energy.grid_w ?? 0;
  const bat = energy.battery_w ?? 0;
  const soc = energy.soc;
  // Hausverbrauch: aus FENECON, sonst aus der Bilanz berechnet
  const home = energy.consumption_w ?? Math.max(0, pv + grid + bat);

  const sgn = (w) => (Math.abs(w) < IDLE_W ? 0 : w > 0 ? 1 : -1);

  let batNote = null;
  if (sgn(bat) > 0) batNote = { text: `Entlädt ${fmtW(bat)}`, color: C.pv };
  else if (sgn(bat) < 0) batNote = { text: `Lädt ${fmtW(bat)}`, color: C.battery };

  let gridNote = null;
  if (sgn(grid) > 0) gridNote = { text: "Bezug", color: '#d9534f' };
  else if (sgn(grid) < 0) gridNote = { text: "Einspeisung", color: C.battery };

  return (
    <div className={compact ? 'ef-card ef-compact' : 'card ef-card'}>
      <style>{CSS}</style>
      <svg className="ef-svg" viewBox="0 0 400 440" role="img" aria-label="Energiefluss">
        <Flow id="pv" watts={pv} dir={sgn(pv) > 0 ? 1 : 0} color={C.pv} />
        <Flow id="home" watts={home} dir={sgn(home) > 0 ? -1 : 0} color={C.home} />
        <Flow id="grid" watts={grid} dir={sgn(grid)} color={grid > 0 ? C.grid : C.battery} />
        <Flow id="battery" watts={bat} dir={sgn(bat)} color={C.battery} />

        <circle cx={CX} cy={CY} r={INV_R + 4} fill="var(--ef-bg)" stroke={C.ring} strokeWidth="1.5" />
        <circle cx={CX} cy={CY} r={INV_R - 2} fill="none" stroke={C.ring} strokeWidth="1" />
        <text x={CX} y={CY + 4} textAnchor="middle" className="ef-inv">FENECON</text>

        <Gauge id="pv" label="PV" value={fmtW(pv)} frac={pv / MAX_W} color={C.pv} />
        <Gauge id="home" label="Verbraucher" value={fmtW(home)} frac={home / MAX_W} color={C.home} />
        <Gauge id="grid" label="Netz" value={fmtW(grid)} frac={Math.abs(grid) / MAX_W} color={C.grid} labelBelow />
        <Gauge
          id="battery"
          label="Batterie"
          value={soc == null ? '–' : `${soc}%`}
          frac={(soc ?? 0) / 100}
          color={C.battery}
          labelBelow
        />

        {batNote && (
          <text x={NODES.battery.x} y={NODES.battery.y - R - 24} textAnchor="middle" className="ef-note" style={{ fill: batNote.color }}>
            {batNote.text}
          </text>
        )}
        {gridNote && (
          <text x={NODES.grid.x} y={NODES.grid.y - R - 24} textAnchor="middle" className="ef-note" style={{ fill: gridNote.color }}>
            {gridNote.text}
          </text>
        )}
      </svg>
    </div>
  );
}
