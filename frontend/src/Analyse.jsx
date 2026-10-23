import { useEffect, useMemo, useState } from 'react';
import {
  ResponsiveContainer, ComposedChart, Line, Area, XAxis, YAxis, Tooltip, CartesianGrid, Legend, ReferenceArea,
} from 'recharts';
import { supabase } from './supabase.js';

const C = {
  pv: '#d9a400', use: '#57534e', heat: '#c2410c', car: '#64748b', grid: '#b4234a',
  bat: '#1d6f8c', outdoor: '#16a34a', temp: '#c2410c', set: '#1d4ed8', valve: '#c2410c',
};
const SRC = [
  { k: 'pv', label: 'Sonne', color: '#d9a400' },
  { k: 'bat', label: 'Batterie', color: '#1d6f8c' },
  { k: 'grid', label: 'Netz', color: '#b4234a' },
];

const todayBerlin = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Berlin' });
const shiftDate = (d, days) => {
  const x = new Date(`${d}T12:00:00Z`);
  x.setUTCDate(x.getUTCDate() + days);
  return x.toISOString().slice(0, 10);
};
const fmtDate = (d) => new Date(`${d}T12:00:00Z`).toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'UTC' });
const hourOf = (ts) => {
  const p = new Intl.DateTimeFormat('de-DE', { timeZone: 'Europe/Berlin', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(ts));
  return Number(p.find((x) => x.type === 'hour').value) + Number(p.find((x) => x.type === 'minute').value) / 60;
};
const hm = (h) => `${String(Math.floor(h)).padStart(2, '0')}:${String(Math.round((h % 1) * 60)).padStart(2, '0')}`;
const toH = (s) => { const [a, b] = String(s || '0:0').split(':').map(Number); return a + (b || 0) / 60; };
const n = (v) => (v == null ? null : Number(v));
const kwh = (v) => (v == null ? '–' : `${Number(v).toLocaleString('de-DE', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} kWh`);
const num = (v, d = 1, unit = '') => (v == null ? '–' : `${Number(v).toLocaleString('de-DE', { minimumFractionDigits: d, maximumFractionDigits: d })}${unit}`);

function useRpc(fn, args, deps) {
  const [state, setState] = useState({ data: null, error: null, loading: true });
  useEffect(() => {
    let cancel = false;
    setState((s) => ({ ...s, loading: true }));
    supabase.rpc(fn, args).then(({ data, error }) => {
      if (!cancel) setState({ data, error: error?.message ?? null, loading: false });
    });
    return () => { cancel = true; };
  }, deps); // eslint-disable-line react-hooks/exhaustive-deps
  return state;
}

function DateNav({ date, setDate }) {
  const today = todayBerlin();
  return (
    <div className="datenav">
      <button className="btn" onClick={() => setDate(shiftDate(date, -1))} aria-label="Vortag">◀</button>
      <label className="datenav-label">
        <span>{fmtDate(date)}</span>
        <input type="date" value={date} max={today} onChange={(e) => e.target.value && setDate(e.target.value)} />
      </label>
      <button className="btn" onClick={() => setDate(shiftDate(date, 1))} disabled={date >= today} aria-label="Folgetag">▶</button>
      {date !== today && <button className="btn ghost small" onClick={() => setDate(today)}>Heute</button>}
    </div>
  );
}

function SourceBar({ parts, unit = 'kWh', digits = 1 }) {
  const total = parts.reduce((s, p) => s + (p.v || 0), 0);
  if (!total) return <div className="muted small">Keine Daten</div>;
  return (
    <div>
      <div className="srcbar" role="img" aria-label={parts.map((p) => `${p.label} ${Math.round((100 * (p.v || 0)) / total)} %`).join(', ')}>
        {parts.map((p) => (p.v > 0 ? <span key={p.k} style={{ width: `${(100 * p.v) / total}%`, background: p.color }} /> : null))}
      </div>
      <div className="srclegend">
        {parts.map((p) => (
          <span key={p.k}><i style={{ background: p.color }} />{p.label} <strong>{num(p.v, digits)} {unit}</strong> · {Math.round((100 * (p.v || 0)) / total)} %</span>
        ))}
      </div>
    </div>
  );
}

// Recharts erkennt nur direkte Kinder – deshalb eine Funktion, die ein Array liefert
function nightAreas(settings) {
  const s = toH(settings.night_start);
  const e = toH(settings.night_end);
  const ranges = s > e ? [[0, e], [s, 24]] : [[s, e]];
  return ranges.map(([x1, x2]) => (
    <ReferenceArea key={`n${x1}`} yAxisId="a" x1={x1} x2={x2} fill="var(--night-bg)" fillOpacity={0.6} ifOverflow="hidden" />
  ));
}

const xAxis = (
  <XAxis dataKey="h" type="number" domain={[0, 24]} ticks={[0, 3, 6, 9, 12, 15, 18, 21, 24]} tickFormatter={(h) => `${h}`} stroke="var(--muted)" fontSize={12} />
);

/* ------------------------------ Tag ------------------------------ */
// Farben nach Bedeutung: Herkunft (Sonne/Batterie/Netz) und Verbraucher
const F = {
  sun: '#d9a400', bat: '#1d6f8c', grid: '#b4234a',
  house: '#a8a29e', heat: '#c2410c', car: '#64748b', batIn: '#5aa9c4', feed: '#16a34a',
};
const PERIODS = [
  { k: 'n1', label: 'Nacht 0–6', from: 0, to: 6 },
  { k: 'mo', label: 'Morgen 6–9', from: 6, to: 9 },
  { k: 'day', label: 'Tag 9–16', from: 9, to: 16 },
  { k: 'ev', label: 'Abend 16–20', from: 16, to: 20 },
  { k: 'n2', label: 'Nacht 20–24', from: 20, to: 24 },
];

// Energiefluss je 15-Minuten-Block (Leistungen in kW)
function flows(r) {
  const kw = (w) => Math.max(0, Number(w) || 0) / 1000;
  const c = kw(r.consumption_w); const gi = kw(r.grid_in_w); const bo = kw(r.bat_out_w);
  const bi = kw(r.bat_in_w); const go = kw(r.grid_out_w); const pv = kw(r.pv_w);
  const car = Math.min(kw(r.car_w), c);
  const heat = Math.min(kw(r.heat_w), Math.max(0, c - car));
  const house = Math.max(0, c - car - heat);
  const pvDirect = Math.max(0, c - gi - bo);
  const fs = c > 0 ? { sun: pvDirect / c, bat: bo / c, grid: gi / c } : { sun: 0, bat: 0, grid: 0 };
  const split = (x) => ({ sun: x * fs.sun, bat: x * fs.bat, grid: x * fs.grid });
  return {
    h: hourOf(r.bucket), pv, c, gi, go, bi, bo, soc: r.soc, out: n(r.outdoor_c),
    heat, car, house,
    heatS: split(heat), carS: split(car), houseS: split(house),
    pvHouse: house * fs.sun, pvHeat: heat * fs.sun, pvCar: car * fs.sun, pvBat: Math.min(bi, pv), pvFeed: go,
  };
}

const sumBy = (rows, f) => rows.reduce((s, r) => s + f(r) * 0.25, 0); // kW × 0,25 h = kWh

function Insight({ tone, title, children }) {
  return (
    <div className={`insight tone-${tone}`}>
      <div className="insight-title">{title}</div>
      <div className="small">{children}</div>
    </div>
  );
}

function Section({ nr, title, question, children }) {
  return (
    <section className="card qsec">
      <div className="qsec-head">
        <span className="qsec-nr">{nr}</span>
        <div>
          <div className="chart-title">{title}</div>
          <div className="muted small">{question}</div>
        </div>
      </div>
      {children}
    </section>
  );
}

const tip = { labelFormatter: (h) => `${hm(h)} Uhr`, formatter: (v) => `${Number(v).toFixed(2)} kW` };

function DayView({ date, settings }) {
  const k = useRpc('muc_day_kpis', { p_date: date }, [date]);
  const e = useRpc('muc_day_energy', { p_date: date }, [date]);
  const kp = k.data?.[0];
  const rows = useMemo(() => (e.data || []).map(flows).map((f) => ({
    ...f,
    // Diagrammreihen
    hSun: f.heatS.sun, hBat: f.heatS.bat, hGrid: f.heatS.grid,
    batPlus: f.bi, batMinus: -f.bo,
  })), [e.data]);

  if (k.error || e.error) return <div className="alert">{k.error || e.error}</div>;
  if (k.loading || e.loading) return <div className="muted">Lade Auswertung …</div>;
  if (!kp || kp.data_hours == null || rows.length === 0) return <div className="card muted">Für diesen Tag gibt es keine Messwerte.</div>;

  // ---- Summen
  const T = {
    pv: sumBy(rows, (r) => r.pv), use: sumBy(rows, (r) => r.c), gridIn: sumBy(rows, (r) => r.gi), feed: sumBy(rows, (r) => r.go),
    pvHouse: sumBy(rows, (r) => r.pvHouse), pvHeat: sumBy(rows, (r) => r.pvHeat), pvCar: sumBy(rows, (r) => r.pvCar), pvBat: sumBy(rows, (r) => r.pvBat),
    batOut: sumBy(rows, (r) => r.bo), batHouse: sumBy(rows, (r) => r.houseS.bat), batHeat: sumBy(rows, (r) => r.heatS.bat), batCar: sumBy(rows, (r) => r.carS.bat),
    heat: sumBy(rows, (r) => r.heat), heatSun: sumBy(rows, (r) => r.heatS.sun), heatBat: sumBy(rows, (r) => r.heatS.bat), heatGrid: sumBy(rows, (r) => r.heatS.grid),
    car: sumBy(rows, (r) => r.car), carSun: sumBy(rows, (r) => r.carS.sun), carBat: sumBy(rows, (r) => r.carS.bat), carGrid: sumBy(rows, (r) => r.carS.grid),
  };
  const per = PERIODS.map((p) => {
    const rr = rows.filter((r) => r.h >= p.from && r.h < p.to);
    return { ...p, heat: sumBy(rr, (r) => r.heat), grid: sumBy(rr, (r) => r.heatS.grid), bat: sumBy(rr, (r) => r.heatS.bat), sun: sumBy(rr, (r) => r.heatS.sun), hasData: rr.length > 0 };
  });
  const socMax = Math.max(...rows.map((r) => r.soc ?? 0));
  const fullAt = rows.find((r) => r.soc >= 95)?.h;
  const emptyAt = rows.filter((r) => r.h >= 12).find((r) => r.soc <= 5)?.h;
  const sunOutsideDay = per.filter((p) => p.k !== 'day').reduce((s, p) => s + p.heat, 0);
  const heatDay = per.find((p) => p.k === 'day').heat;

  // ---- Erkenntnisse in Klartext
  const ins = [];
  if (T.heatGrid >= 1) {
    const nightGrid = per.filter((p) => p.k !== 'day').reduce((s, p) => s + p.grid, 0);
    ins.push({ tone: 'rose', title: `Wärmepumpe: ${kwh(T.heatGrid)} aus dem Netz`, text: `${Math.round((100 * nightGrid) / Math.max(T.heatGrid, 0.01))} % davon außerhalb der Sonnenstunden. Empfehlung: Heizzeit und Warmwasser in den Tag (ca. 11–16 Uhr) verschieben, nachts tiefer absenken.` });
  }
  if (heatDay < sunOutsideDay * 0.5 && T.pv > 5) {
    ins.push({ tone: 'sun', title: 'Geheizt wird vor allem, wenn keine Sonne scheint', text: `Tagsüber (9–16 Uhr) ${kwh(heatDay)}, außerhalb ${kwh(sunOutsideDay)}. Der Estrich könnte mittags „vorgeladen“ werden.` });
  }
  if (T.batCar >= 0.3) ins.push({ tone: 'rose', title: `Auto hat ${kwh(T.batCar)} aus der Hausbatterie geladen`, text: 'Diese Energie fehlt abends. Empfehlung: in evcc die Entladung der Hausbatterie für das Fahrzeug sperren – Auto nur mit Überschuss.' });
  if (T.carGrid >= 0.3) ins.push({ tone: 'sun', title: `Auto hat ${kwh(T.carGrid)} aus dem Netz geladen`, text: 'Im PV-Modus sollte das nicht vorkommen – Mindestladestrom (6 A ≈ 4,1 kW) prüfen.' });
  if (emptyAt != null) ins.push({ tone: 'cool', title: `Batterie leer ab ${hm(emptyAt)} Uhr`, text: `Davon gingen ${kwh(T.batHeat)} an die Heizung, ${kwh(T.batHouse)} an das Haus${T.batCar > 0.05 ? `, ${kwh(T.batCar)} an das Auto` : ''}.` });
  if (T.feed >= 1 && T.heatGrid >= 1) ins.push({ tone: 'green', title: `${kwh(T.feed)} eingespeist`, text: 'Gleichzeitig wurde aus dem Netz geheizt – diese Energie hätte mittags als Wärme gespeichert werden können.' });
  if (ins.length === 0) ins.push({ tone: 'green', title: 'Keine Auffälligkeiten', text: 'An diesem Tag lief alles weitgehend mit eigenem Strom.' });

  return (
    <div className="stack">
      {kp.data_hours < 20 && <div className="notice-warn">Unvollständiger Tag: nur {num(kp.data_hours, 1)} Stunden Messwerte – Summen gelten bis jetzt.</div>}

      <section className="kpis kpis-4">
        <div className="card tile"><div className="eyebrow">PV</div><div className="tile-value">{kwh(T.pv)}</div><div className="muted small">eingespeist {kwh(T.feed)}</div></div>
        <div className="card tile"><div className="eyebrow">Verbrauch</div><div className="tile-value">{kwh(T.use)}</div><div className="muted small">Autarkie {num(kp.autarky_pct, 0, ' %')}</div></div>
        <div className="card tile"><div className="eyebrow">Netzbezug</div><div className={`tile-value ${T.gridIn > 3 ? 'warn-text' : ''}`}>{kwh(T.gridIn)}</div><div className="muted small">davon Heizung {kwh(T.heatGrid)}</div></div>
        <div className="card tile"><div className="eyebrow">Außen</div><div className="tile-value">{kp.outdoor_avg != null ? `Ø ${num(kp.outdoor_avg, 1, ' °C')}` : '–'}</div><div className="muted small">{kp.outdoor_min != null ? `${num(kp.outdoor_min, 1)} … ${num(kp.outdoor_max, 1)} °C` : 'noch nicht erfasst'}</div></div>
      </section>

      <section className="card">
        <div className="chart-title">Das Wichtigste</div>
        <div className="insights">{ins.map((i) => <Insight key={i.title} tone={i.tone} title={i.title}>{i.text}</Insight>)}</div>
      </section>

      <Section nr="1" title="PV-Anlage" question="Wohin ging der Sonnenstrom?">
        <SourceBar parts={[
          { k: 'h', label: 'Haus', color: F.house, v: T.pvHouse }, { k: 'w', label: 'Heizung', color: F.heat, v: T.pvHeat },
          { k: 'c', label: 'Auto', color: F.car, v: T.pvCar }, { k: 'b', label: 'Batterie geladen', color: F.batIn, v: T.pvBat },
          { k: 'f', label: 'Eingespeist', color: F.feed, v: T.feed },
        ]} />
        <ResponsiveContainer width="100%" height={220}>
          <ComposedChart data={rows} margin={{ top: 12, right: 6, bottom: 0, left: -14 }}>
            <CartesianGrid stroke="var(--grid)" vertical={false} />
            {xAxis}
            <YAxis yAxisId="a" stroke="var(--muted)" fontSize={12} unit=" kW" width={56} />
            <Tooltip {...tip} />
            <Area yAxisId="a" stackId="pv" dataKey="pvHouse" name="Haus" stroke="none" fill={F.house} fillOpacity={0.9} isAnimationActive={false} />
            <Area yAxisId="a" stackId="pv" dataKey="pvHeat" name="Heizung" stroke="none" fill={F.heat} fillOpacity={0.9} isAnimationActive={false} />
            <Area yAxisId="a" stackId="pv" dataKey="pvCar" name="Auto" stroke="none" fill={F.car} fillOpacity={0.9} isAnimationActive={false} />
            <Area yAxisId="a" stackId="pv" dataKey="pvBat" name="Batterie geladen" stroke="none" fill={F.batIn} fillOpacity={0.9} isAnimationActive={false} />
            <Area yAxisId="a" stackId="pv" dataKey="pvFeed" name="Eingespeist" stroke="none" fill={F.feed} fillOpacity={0.9} isAnimationActive={false} />
          </ComposedChart>
        </ResponsiveContainer>
      </Section>

      <Section nr="2" title="Batterie" question="Wann wurde sie geladen – und wer hat sie geleert?">
        <div className="facts">
          <span>max. <strong>{socMax} %</strong>{fullAt != null && <> · voll um <strong>{hm(fullAt)}</strong></>}</span>
          <span>{emptyAt != null ? <>leer ab <strong>{hm(emptyAt)}</strong></> : <>min. <strong>{kp.soc_min} %</strong></>}</span>
          <span>geladen <strong>{kwh(T.pvBat)}</strong> · entladen <strong>{kwh(T.batOut)}</strong></span>
        </div>
        <div className="eyebrow">Entladen an</div>
        <SourceBar parts={[
          { k: 'w', label: 'Heizung', color: F.heat, v: T.batHeat }, { k: 'h', label: 'Haus', color: F.house, v: T.batHouse },
          { k: 'c', label: 'Auto', color: F.car, v: T.batCar },
        ]} />
        <ResponsiveContainer width="100%" height={220}>
          <ComposedChart data={rows} margin={{ top: 12, right: 6, bottom: 0, left: -14 }}>
            <CartesianGrid stroke="var(--grid)" vertical={false} />
            {xAxis}
            <YAxis yAxisId="a" stroke="var(--muted)" fontSize={12} unit=" kW" width={56} />
            <YAxis yAxisId="s" orientation="right" domain={[0, 100]} ticks={[0, 50, 100]} unit="%" stroke={F.bat} fontSize={12} width={40} />
            {nightAreas(settings)}
            <Tooltip labelFormatter={tip.labelFormatter} formatter={(v, name) => (name === 'Ladezustand' ? `${v} %` : `${Math.abs(v).toFixed(2)} kW`)} />
            <Area yAxisId="a" dataKey="batPlus" name="Laden" stroke="none" fill={F.feed} fillOpacity={0.5} isAnimationActive={false} />
            <Area yAxisId="a" dataKey="batMinus" name="Entladen" stroke="none" fill={F.grid} fillOpacity={0.45} isAnimationActive={false} />
            <Line yAxisId="s" dataKey="soc" name="Ladezustand" stroke={F.bat} strokeWidth={2} dot={false} isAnimationActive={false} />
          </ComposedChart>
        </ResponsiveContainer>
        <div className="muted small">Grün = laden, rot = entladen, Linie = Ladezustand. Nacht hinterlegt.</div>
      </Section>

      <Section nr="3" title="Wärmepumpe" question="Wann wurde geheizt – und womit?">
        <SourceBar parts={[
          { k: 's', label: 'Sonne', color: F.sun, v: T.heatSun }, { k: 'b', label: 'Batterie', color: F.bat, v: T.heatBat },
          { k: 'g', label: 'Netz', color: F.grid, v: T.heatGrid },
        ]} />
        <ResponsiveContainer width="100%" height={220}>
          <ComposedChart data={rows} margin={{ top: 12, right: 6, bottom: 0, left: -14 }}>
            <CartesianGrid stroke="var(--grid)" vertical={false} />
            {xAxis}
            <YAxis yAxisId="a" stroke="var(--muted)" fontSize={12} unit=" kW" width={56} />
            {nightAreas(settings)}
            <Tooltip {...tip} />
            <Area yAxisId="a" stackId="h" dataKey="hSun" name="aus Sonne" stroke="none" fill={F.sun} fillOpacity={0.85} isAnimationActive={false} />
            <Area yAxisId="a" stackId="h" dataKey="hBat" name="aus Batterie" stroke="none" fill={F.bat} fillOpacity={0.85} isAnimationActive={false} />
            <Area yAxisId="a" stackId="h" dataKey="hGrid" name="aus Netz" stroke="none" fill={F.grid} fillOpacity={0.85} isAnimationActive={false} />
            <Line yAxisId="a" dataKey="pv" name="PV-Erzeugung" stroke={F.sun} strokeDasharray="4 3" strokeWidth={1.5} dot={false} isAnimationActive={false} />
          </ComposedChart>
        </ResponsiveContainer>
        <table className="ptable">
          <thead><tr><th>Zeitraum</th><th>Heizstrom</th><th>davon Netz</th></tr></thead>
          <tbody>
            {per.map((p) => (
              <tr key={p.k} className={p.hasData ? '' : 'muted'}>
                <td>{p.label}</td>
                <td>{p.hasData ? kwh(p.heat) : '–'}</td>
                <td className={p.grid >= 0.5 ? 'warn-text' : ''}>{p.hasData ? kwh(p.grid) : '–'}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="muted small">Gestrichelt = verfügbare PV-Leistung. Heizstrom geschätzt (Verbrauch − Auto − Grundlast {kp.baseload_w} W), bis die Wärmepumpe selbst gemessen wird.</div>
      </Section>

      <Section nr="4" title="Auto" question="Woher kam der Ladestrom?">
        {!kp.car_measured ? <div className="muted small">An diesem Tag wurde die Auto-Ladeleistung noch nicht erfasst.</div>
          : T.car < 0.1 ? <div className="muted small">Heute nicht geladen.</div> : (
            <>
              <div className="facts"><span>geladen <strong>{kwh(T.car)}</strong></span></div>
              <SourceBar parts={[
                { k: 's', label: 'Sonne', color: F.sun, v: T.carSun }, { k: 'b', label: 'Hausbatterie', color: F.bat, v: T.carBat },
                { k: 'g', label: 'Netz', color: F.grid, v: T.carGrid },
              ]} />
              <div className="muted small">Ziel: 100 % Sonne. Anteil „Hausbatterie“ fehlt abends für Haus und Heizung.</div>
            </>
          )}
      </Section>
    </div>
  );
}

/* ------------------------------ Räume ------------------------------ */
function RoomStatCard({ r, selected, onSelect }) {
  const rate = (v) => (v == null ? '–' : `${v > 0 ? '+' : ''}${num(v, 2)} K/h`);
  return (
    <button type="button" className={`card roomstat ${selected ? 'selected' : ''}`} onClick={onSelect}>
      <div className="roomstat-head">
        <span className="room-name small-name">{r.name}</span>
        {r.data_hours == null ? <span className="pill neutral">keine Daten</span>
          : <span className={`pill ${Math.abs(r.dev_avg) <= 0.5 ? 'green' : r.dev_avg < 0 ? 'cool' : 'sun'}`}>Ø {r.dev_avg > 0 ? '+' : ''}{num(r.dev_avg, 1)} K</span>}
      </div>
      {r.data_hours != null && (
        <>
          <div className="roomstat-grid">
            <div><div className="eyebrow">Ø Ist / Soll</div><div className="mid">{num(r.temp_avg, 1)} / {num(r.setpoint_avg, 1)} °C</div></div>
            <div><div className="eyebrow">Spanne</div><div className="mid">{num(r.temp_min, 1)} … {num(r.temp_max, 1)} °C</div></div>
            <div><div className="eyebrow">Zu kalt</div><div className={`mid ${r.cold_h > 1 ? 'warn-text' : ''}`}>{num(r.cold_h, 1, ' h')}</div></div>
            <div><div className="eyebrow">Aufheizen</div><div className="mid">{rate(r.heat_rate_kph)}</div></div>
            <div><div className="eyebrow">Abkühlen</div><div className="mid">{rate(r.cool_rate_kph)}</div></div>
            <div><div className="eyebrow">Ventil-Starts</div><div className="mid">{r.valve_switches}×</div></div>
          </div>
          <div className="eyebrow">Ventil offen {num(r.valve_h, 1, ' h')} – Strom kam dabei aus</div>
          <SourceBar unit="h" parts={SRC.map((s) => ({ ...s, v: n(r[`valve_${s.k}_h`]) }))} />
        </>
      )}
    </button>
  );
}

function RoomsView({ date, settings, rooms }) {
  const st = useRpc('muc_room_day_stats', { p_date: date }, [date]);
  const [roomId, setRoomId] = useState(rooms[0]?.id);
  const series = useRpc('muc_room_day_series', { p_date: date, p_room: roomId }, [date, roomId]);
  const energy = useRpc('muc_day_energy', { p_date: date }, [date]);

  const rows = useMemo(() => {
    const out = new Map((energy.data || []).map((r) => [hourOf(r.bucket), n(r.outdoor_c)]));
    return (series.data || []).map((r) => {
      const h = hourOf(r.bucket);
      return { h, temp: n(r.temp), set: n(r.setpoint), valve: r.valve == null ? null : Math.round(n(r.valve) * 100), out: out.get(h) ?? null };
    });
  }, [series.data, energy.data]);

  if (st.error) return <div className="alert">{st.error}</div>;
  if (st.loading) return <div className="muted">Lade Raumauswertung …</div>;
  const stats = st.data || [];
  const room = stats.find((r) => r.room_id === roomId);

  return (
    <div className="stack">
      <div className="roomstats">
        {stats.map((r) => <RoomStatCard key={r.room_id} r={r} selected={r.room_id === roomId} onSelect={() => setRoomId(r.room_id)} />)}
      </div>

      <section className="card chart">
        <div className="chart-title">{room?.name || 'Raum'}: Temperatur, Soll und Ventil</div>
        {series.loading ? <div className="muted">Lade …</div> : rows.length === 0 ? <div className="muted small">Keine Messwerte an diesem Tag.</div> : (
          <ResponsiveContainer width="100%" height={270}>
            <ComposedChart data={rows} margin={{ top: 8, right: 4, bottom: 0, left: -6 }}>
              <CartesianGrid stroke="var(--grid)" vertical={false} />
              {xAxis}
              <YAxis yAxisId="a" domain={[(min) => Math.floor(min * 2 - 1) / 2, (max) => Math.ceil(max * 2 + 1) / 2]} allowDecimals tickFormatter={(v) => `${Number(v).toLocaleString('de-DE', { maximumFractionDigits: 1 })}°`} stroke="var(--muted)" fontSize={12} width={52} />
              <YAxis yAxisId="v" domain={[0, 100]} hide />
              <YAxis yAxisId="t" orientation="right" unit="°" stroke={C.outdoor} fontSize={12} width={34} allowDecimals={false} />
              {nightAreas(settings)}
              <Tooltip labelFormatter={(h) => `${hm(h)} Uhr`} formatter={(v, name) => (name === 'Ventil offen' ? `${v} %` : `${v} °C`)} />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              <Area yAxisId="v" dataKey="valve" name="Ventil offen" type="stepAfter" fill={C.valve} fillOpacity={0.12} stroke="none" isAnimationActive={false} />
              <Line yAxisId="a" dataKey="temp" name="Ist" stroke={C.temp} strokeWidth={2} dot={false} isAnimationActive={false} connectNulls />
              <Line yAxisId="a" dataKey="set" name="Soll" type="stepAfter" stroke={C.set} strokeWidth={2} strokeDasharray="5 3" dot={false} isAnimationActive={false} connectNulls />
              <Line yAxisId="t" dataKey="out" name="Außen" stroke={C.outdoor} strokeWidth={1.2} dot={false} isAnimationActive={false} connectNulls />
            </ComposedChart>
          </ResponsiveContainer>
        )}
      </section>

      <section className="card explain-card">
        <div className="chart-title">So liest du die Werte</div>
        <ul className="muted small">
          <li><strong>Ø Abweichung</strong>: Ist minus Soll im Tagesmittel. Grün = innerhalb ±0,5 K.</li>
          <li><strong>Zu kalt</strong>: Stunden, in denen der Raum mehr als 0,5 K unter dem Soll lag.</li>
          <li><strong>Aufheizen / Abkühlen</strong>: mittlere Temperaturänderung bei offenem bzw. geschlossenem Ventil. Langsames Abkühlen heißt: der Estrich speichert die Wärme lange – gut geeignet, um mittags mit Sonne vorzuheizen. Fußbodenheizung reagiert träge, die Werte zeigen eine Tendenz.</li>
          <li><strong>Strom während Ventil offen</strong>: woher der Hausstrom kam, während der Raum Wärme angefordert hat. Ziel: möglichst viel „Sonne“, wenig „Netz“.</li>
        </ul>
      </section>
    </div>
  );
}

export default function Analyse({ settings, rooms }) {
  const [view, setView] = useState('day');
  const [date, setDate] = useState(todayBerlin());
  return (
    <div className="stack">
      <div className="toolbar analyse-bar">
        <div className="seg seg-2">
          <button className={view === 'day' ? 'seg-btn active' : 'seg-btn'} onClick={() => setView('day')}>Tag</button>
          <button className={view === 'rooms' ? 'seg-btn active' : 'seg-btn'} onClick={() => setView('rooms')}>Räume</button>
        </div>
        <DateNav date={date} setDate={setDate} />
      </div>
      {view === 'day' ? <DayView date={date} settings={settings} /> : <RoomsView date={date} settings={settings} rooms={rooms.filter((r) => r.enabled)} />}
    </div>
  );
}
