import { useEffect, useMemo, useState } from 'react';
import {
  ResponsiveContainer, ComposedChart, Line, Area, Bar, XAxis, YAxis, Tooltip, CartesianGrid, Legend, ReferenceArea,
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
  const e = toH(settings.morning_start ?? settings.night_end); // seit 0.5 endet die Nacht mit „Morgen ab“
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

// Eigenverbrauchsquote: Anteil der PV, der nicht ins Netz ging (Haus, Heizung, Auto, Batterie laden)
const selfUsePct = (pv, feed) => (pv > 0.1 ? Math.max(0, Math.min(100, Math.round(100 * (1 - feed / pv)))) : null);
const pctText = (v) => (v == null ? '–' : `${v} %`);

function selfUseInsight(quote, feed, heatGrid) {
  if (quote == null || quote >= 70 || feed < 2) return null;
  return {
    tone: 'sun',
    title: `Nur ${quote} % des Sonnenstroms selbst genutzt`,
    text: `${kwh(feed)} gingen ins Netz${heatGrid >= 1 ? `, während die Wärmepumpe ${kwh(heatGrid)} aus dem Netz zog` : ''}. Mittags gezielt vorheizen (Estrich als Speicher) hebt die Quote.`,
  };
}

function SelfUseTiles({ pv, feed, use, gridIn, pvHouse, pvHeat, pvCar, pvBat }) {
  const q = selfUsePct(pv, feed);
  const aut = use > 0.1 ? Math.max(0, Math.round(100 * (1 - gridIn / use))) : null;
  const parts = [['Haus', pvHouse], ['Heizung', pvHeat], ['Auto', pvCar], ['Akku', pvBat]]
    .filter(([, v]) => v >= 0.05).map(([l, v]) => `${l} ${kwh(v)}`).join(' · ');
  return (
    <>
      <div className="card tile accent">
        <div className="eyebrow">Eigenverbrauch</div>
        <div className="tile-value">{pctText(q)}</div>
        <div className="muted small">{q == null ? 'keine PV-Erzeugung' : `${kwh(Math.max(0, pv - feed))} selbst genutzt${parts ? ` – ${parts}` : ''}`}</div>
      </div>
      <div className="card tile">
        <div className="eyebrow">Autarkie</div>
        <div className="tile-value">{pctText(aut)}</div>
        <div className="muted small">{aut == null ? '' : `${kwh(gridIn)} aus dem Netz`}</div>
      </div>
    </>
  );
}

// Eigenverbrauch und Autarkie je Tag/Monat als Linien (0–100 %)
function PctChart({ data, height = 190 }) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <ComposedChart data={data} margin={{ top: 12, right: 8, bottom: 0, left: -6 }}>
        <CartesianGrid stroke="var(--grid)" vertical={false} />
        <XAxis dataKey="label" stroke="var(--muted)" fontSize={11} interval="preserveStartEnd" minTickGap={4} />
        <YAxis stroke="var(--muted)" fontSize={12} width={44} domain={[0, 100]} unit=" %" />
        <Tooltip formatter={(v, name) => [`${v} %`, name]} />
        <Line dataKey="self_use" name="Eigenverbrauch" stroke={F.feed} strokeWidth={2} dot={{ r: 2 }} connectNulls isAnimationActive={false} />
        <Line dataKey="autarky" name="Autarkie" stroke={C.bat} strokeWidth={2} dot={{ r: 2 }} connectNulls isAnimationActive={false} />
      </ComposedChart>
    </ResponsiveContainer>
  );
}

// Kumulierter Verlauf über den Tag: Quote „bis zu dieser Uhrzeit“
function cumulativePct(rows) {
  let pv = 0, go = 0, c = 0, gi = 0;
  return rows.map((r) => {
    pv += r.pv; go += r.go; c += r.c; gi += r.gi;
    return {
      h: r.h,
      self_use: pv >= 0.2 ? Math.max(0, Math.min(100, Math.round(100 * (1 - go / pv)))) : null,
      autarky: c >= 0.2 ? Math.max(0, Math.min(100, Math.round(100 * (1 - gi / c)))) : null,
    };
  });
}

function SelfUseFacts({ pv, feed, use, gridIn }) {
  const q = selfUsePct(pv, feed);
  const aut = use > 0.1 ? Math.max(0, Math.round(100 * (1 - gridIn / use))) : null;
  return (
    <div className="facts">
      <span>Eigenverbrauch <strong>{pctText(q)}</strong> · {kwh(Math.max(0, pv - feed))} von {kwh(pv)} selbst genutzt</span>
      <span>Autarkie <strong>{pctText(aut)}</strong> · {kwh(gridIn)} aus dem Netz</span>
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

  const cumPct = cumulativePct(rows);

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
  const suDay = selfUseInsight(selfUsePct(T.pv, T.feed), T.feed, T.heatGrid);
  if (suDay) ins.push(suDay);
  else if (T.feed >= 1 && T.heatGrid >= 1) ins.push({ tone: 'green', title: `${kwh(T.feed)} eingespeist`, text: 'Gleichzeitig wurde aus dem Netz geheizt – diese Energie hätte mittags als Wärme gespeichert werden können.' });
  if (ins.length === 0) ins.push({ tone: 'green', title: 'Keine Auffälligkeiten', text: 'An diesem Tag lief alles weitgehend mit eigenem Strom.' });

  return (
    <div className="stack">
      {kp.data_hours < 20 && <div className="notice-warn">Unvollständiger Tag: nur {num(kp.data_hours, 1)} Stunden Messwerte – Summen gelten bis jetzt.</div>}

      <section className="kpis">
        <div className="card tile"><div className="eyebrow">PV</div><div className="tile-value">{kwh(T.pv)}</div><div className="muted small">eingespeist {kwh(T.feed)}</div></div>
        <SelfUseTiles pv={T.pv} feed={T.feed} use={T.use} gridIn={T.gridIn} pvHouse={T.pvHouse} pvHeat={T.pvHeat} pvCar={T.pvCar} pvBat={T.pvBat} />
        <div className="card tile"><div className="eyebrow">Verbrauch</div><div className="tile-value">{kwh(T.use)}</div><div className="muted small">davon Heizung {kwh(T.heat)}</div></div>
        <div className="card tile"><div className="eyebrow">Netzbezug</div><div className={`tile-value ${T.gridIn > 3 ? 'warn-text' : ''}`}>{kwh(T.gridIn)}</div><div className="muted small">davon Heizung {kwh(T.heatGrid)}</div></div>
        <div className="card tile"><div className="eyebrow">Außen</div><div className="tile-value">{kp.outdoor_avg != null ? `Ø ${num(kp.outdoor_avg, 1, ' °C')}` : '–'}</div><div className="muted small">{kp.outdoor_min != null ? `${num(kp.outdoor_min, 1)} … ${num(kp.outdoor_max, 1)} °C` : 'noch nicht erfasst'}</div></div>
      </section>

      <section className="card">
        <div className="chart-title">Das Wichtigste</div>
        <div className="insights">{ins.map((i) => <Insight key={i.title} tone={i.tone} title={i.title}>{i.text}</Insight>)}</div>
      </section>

      <Section nr="1" title="PV-Anlage" question="Wohin ging der Sonnenstrom?">
        <SelfUseFacts pv={T.pv} feed={T.feed} use={T.use} gridIn={T.gridIn} />
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
        <div className="chart-title">Eigenverbrauch und Autarkie im Tagesverlauf (aufsummiert bis zur jeweiligen Uhrzeit)</div>
        <ResponsiveContainer width="100%" height={180}>
          <ComposedChart data={cumPct} margin={{ top: 12, right: 6, bottom: 0, left: -14 }}>
            <CartesianGrid stroke="var(--grid)" vertical={false} />
            {xAxis}
            <YAxis stroke="var(--muted)" fontSize={12} unit=" %" width={56} domain={[0, 100]} />
            <Tooltip formatter={(v, name) => [`${v} %`, name]} labelFormatter={(h) => `bis ${hm(h)} Uhr`} />
            <Line dataKey="self_use" name="Eigenverbrauch" stroke={F.feed} strokeWidth={2} dot={false} connectNulls isAnimationActive={false} />
            <Line dataKey="autarky" name="Autarkie" stroke={C.bat} strokeWidth={2} dot={false} connectNulls isAnimationActive={false} />
          </ComposedChart>
        </ResponsiveContainer>
        <Legend2 items={[{ label: 'Eigenverbrauch (PV selbst genutzt)', color: F.feed }, { label: 'Autarkie (Verbrauch ohne Netz)', color: C.bat }]} />
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

/* ------------------------------ Zeiträume ------------------------------ */
const MONTHS = ['Jan', 'Feb', 'Mär', 'Apr', 'Mai', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez'];
const MONTHS_LONG = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];
const iso = (d) => d.toISOString().slice(0, 10);
const utc = (s) => new Date(`${s}T12:00:00Z`);

function rangeOf(period, date) {
  const d = utc(date);
  if (period === 'week') {
    const wd = (d.getUTCDay() + 6) % 7; // Mo = 0
    const from = new Date(d); from.setUTCDate(d.getUTCDate() - wd);
    const to = new Date(from); to.setUTCDate(from.getUTCDate() + 6);
    return { from: iso(from), to: iso(to) };
  }
  if (period === 'month') {
    const from = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1, 12));
    const to = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0, 12));
    return { from: iso(from), to: iso(to) };
  }
  if (period === 'year') return { from: `${d.getUTCFullYear()}-01-01`, to: `${d.getUTCFullYear()}-12-31` };
  return { from: date, to: date };
}
function shiftPeriod(period, date, dir) {
  const d = utc(date);
  if (period === 'day') d.setUTCDate(d.getUTCDate() + dir);
  else if (period === 'week') d.setUTCDate(d.getUTCDate() + 7 * dir);
  else if (period === 'month') { d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() + dir); }
  else d.setUTCFullYear(d.getUTCFullYear() + dir);
  return iso(d);
}
function isoWeek(date) {
  const d = utc(date); const wd = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - wd + 3);
  const firstThu = new Date(Date.UTC(d.getUTCFullYear(), 0, 4, 12));
  return 1 + Math.round(((d - firstThu) / 86400000 - 3 + ((firstThu.getUTCDay() + 6) % 7)) / 7);
}
function periodLabel(period, date) {
  const r = rangeOf(period, date); const d = utc(date);
  const short = (s) => utc(s).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', timeZone: 'UTC' });
  if (period === 'day') return fmtDate(date);
  if (period === 'week') return `KW ${isoWeek(date)} · ${short(r.from)}–${short(r.to)}`;
  if (period === 'month') return `${MONTHS_LONG[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
  return String(d.getUTCFullYear());
}

function PeriodNav({ period, date, setDate }) {
  const today = todayBerlin();
  const next = shiftPeriod(period, date, 1);
  const nextStart = rangeOf(period, next).from;
  return (
    <div className="datenav">
      <button className="btn" onClick={() => setDate(shiftPeriod(period, date, -1))} aria-label="zurück">◀</button>
      <label className="datenav-label">
        <span>{periodLabel(period, date)}</span>
        <input type="date" value={date} max={today} onChange={(e) => e.target.value && setDate(e.target.value)} />
      </label>
      <button className="btn" onClick={() => setDate(next > today ? today : next)} disabled={nextStart > today} aria-label="weiter">▶</button>
      {rangeOf(period, today).from !== rangeOf(period, date).from && <button className="btn ghost small" onClick={() => setDate(today)}>Aktuell</button>}
    </div>
  );
}

const SUM_KEYS = ['data_hours', 'pv_kwh', 'use_kwh', 'grid_in_kwh', 'feed_kwh', 'bat_in_kwh', 'bat_out_kwh', 'pv_house_kwh', 'pv_heat_kwh', 'pv_car_kwh', 'pv_bat_kwh',
  'bat_house_kwh', 'bat_heat_kwh', 'bat_car_kwh', 'heat_kwh', 'heat_sun_kwh', 'heat_bat_kwh', 'heat_grid_kwh', 'car_kwh', 'car_sun_kwh', 'car_bat_kwh', 'car_grid_kwh',
  'house_kwh', 'house_grid_kwh', 'heat_p1_kwh', 'heat_p2_kwh', 'heat_p3_kwh', 'heat_p4_kwh', 'heat_p5_kwh',
  'heat_grid_p1_kwh', 'heat_grid_p2_kwh', 'heat_grid_p3_kwh', 'heat_grid_p4_kwh', 'heat_grid_p5_kwh', 'bat_empty_h'];

function aggregate(days) {
  const t = Object.fromEntries(SUM_KEYS.map((k) => [k, days.reduce((s, d) => s + (Number(d[k]) || 0), 0)]));
  const outs = days.map((d) => n(d.outdoor_avg)).filter((v) => v != null);
  t.outdoor_avg = outs.length ? outs.reduce((a, b) => a + b, 0) / outs.length : null;
  t.outdoor_min = days.reduce((m, d) => (d.outdoor_min != null && (m == null || Number(d.outdoor_min) < m) ? Number(d.outdoor_min) : m), null);
  t.outdoor_max = days.reduce((m, d) => (d.outdoor_max != null && (m == null || Number(d.outdoor_max) > m) ? Number(d.outdoor_max) : m), null);
  t.days = days.length;
  t.empty_days = days.filter((d) => Number(d.bat_empty_h) >= 1).length;
  t.car_measured = days.some((d) => d.car_measured);
  t.autarky = t.use_kwh > 0 ? Math.round(100 * (1 - t.grid_in_kwh / t.use_kwh)) : null;
  t.self_use = selfUsePct(t.pv_kwh, t.feed_kwh);
  return t;
}

// Tage → Balken (Tag bzw. Monat beim Jahr)
function toBars(period, days, range) {
  if (period === 'year') {
    return MONTHS.map((m, i) => {
      const md = days.filter((d) => utc(String(d.day).slice(0, 10)).getUTCMonth() === i);
      return md.length ? { label: m, ...aggregate(md), hasData: true } : { label: m, hasData: false };
    });
  }
  const out = [];
  for (let s = range.from; s <= range.to; s = shiftPeriod('day', s, 1)) {
    const d = days.find((x) => String(x.day).slice(0, 10) === s);
    const dt = utc(s);
    const label = period === 'week'
      ? dt.toLocaleDateString('de-DE', { weekday: 'short', timeZone: 'UTC' })
      : String(dt.getUTCDate());
    out.push(d ? { label, ...aggregate([d]), hasData: true } : { label, hasData: false });
  }
  return out;
}

const barTip = { formatter: (v, name) => (/Außen/.test(name) ? `${num(v, 1)} °C` : /Stunden/.test(name) ? `${num(v, 1)} h` : `${num(v, 1)} kWh`) };
const r1 = (v) => (v == null ? null : Math.round(v * 10) / 10);

function PeriodChart({ data, bars, line, lineUnit = '°', height = 230 }) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <ComposedChart data={data} margin={{ top: 12, right: line ? 4 : 8, bottom: 0, left: -6 }}>
        <CartesianGrid stroke="var(--grid)" vertical={false} />
        <XAxis dataKey="label" stroke="var(--muted)" fontSize={11} interval="preserveStartEnd" minTickGap={4} />
        <YAxis yAxisId="a" stroke="var(--muted)" fontSize={12} width={44} allowDecimals={false} />
        {line && <YAxis yAxisId="l" orientation="right" stroke={line.color} fontSize={12} unit={lineUnit} width={38} allowDecimals={false} />}
        <Tooltip {...barTip} />
        {bars.map((b) => (
          <Bar key={b.k} yAxisId="a" stackId="s" dataKey={(d) => r1(d[b.k])} name={b.label} fill={b.color} isAnimationActive={false} />
        ))}
        {line && <Line yAxisId="l" dataKey={(d) => r1(d[line.k])} name={line.label} stroke={line.color} strokeWidth={2} dot={{ r: 2 }} connectNulls isAnimationActive={false} />}
      </ComposedChart>
    </ResponsiveContainer>
  );
}

const Legend2 = ({ items }) => (
  <div className="srclegend">{items.map((i) => <span key={i.label}><i style={{ background: i.color }} />{i.label}</span>)}</div>
);

function PeriodView({ period, date }) {
  const range = rangeOf(period, date);
  const q = useRpc('muc_range_days', { p_from: range.from, p_to: range.to }, [range.from, range.to]);
  if (q.error) return <div className="alert">{q.error}{/muc_range_days/.test(q.error) ? ' – bitte supabase/migration-003-zeitraeume.sql ausführen.' : ''}</div>;
  if (q.loading) return <div className="muted">Lade Auswertung …</div>;
  const days = q.data || [];
  if (days.length === 0) return <div className="card muted">Für diesen Zeitraum gibt es noch keine Messwerte. Die Aufzeichnung läuft seit dem 22.10.2026.</div>;

  const T = aggregate(days);
  const bars = toBars(period, days, range);
  const totalDays = Math.round((utc(range.to) - utc(range.from)) / 86400000) + 1;
  const perDay = (v) => kwh(v / Math.max(1, T.days));
  const offDayGrid = T.heat_grid_p1_kwh + T.heat_grid_p2_kwh + T.heat_grid_p4_kwh + T.heat_grid_p5_kwh;
  const offDayHeat = T.heat_p1_kwh + T.heat_p2_kwh + T.heat_p4_kwh + T.heat_p5_kwh;

  const ins = [];
  if (T.heat_grid_kwh >= 1) ins.push({ tone: 'rose', title: `Wärmepumpe: ${kwh(T.heat_grid_kwh)} aus dem Netz (Ø ${perDay(T.heat_grid_kwh)} pro Tag)`, text: `${Math.round((100 * offDayGrid) / Math.max(T.heat_grid_kwh, 0.01))} % davon außerhalb 9–16 Uhr. Heizzeit und Warmwasser in die Sonnenstunden verschieben.` });
  if (T.pv_kwh > 5 && T.heat_p3_kwh < offDayHeat * 0.5) ins.push({ tone: 'sun', title: 'Geheizt wird überwiegend ohne Sonne', text: `9–16 Uhr: ${kwh(T.heat_p3_kwh)}, übrige Zeit: ${kwh(offDayHeat)}.` });
  if (T.car_bat_kwh >= 0.5) ins.push({ tone: 'rose', title: `Auto hat ${kwh(T.car_bat_kwh)} aus der Hausbatterie geladen`, text: 'In evcc die Entladung der Hausbatterie für das Fahrzeug sperren.' });
  if (T.car_grid_kwh >= 0.5) ins.push({ tone: 'sun', title: `Auto hat ${kwh(T.car_grid_kwh)} aus dem Netz geladen`, text: 'Mindestladestrom bzw. Lademodus in evcc prüfen.' });
  if (T.empty_days > 0) ins.push({ tone: 'cool', title: `Batterie an ${T.empty_days} von ${T.days} Tagen leer`, text: `Zusammen ${num(T.bat_empty_h, 1, ' h')} ohne Speicher. Entladen an Heizung ${kwh(T.bat_heat_kwh)}, Haus ${kwh(T.bat_house_kwh)}, Auto ${kwh(T.bat_car_kwh)}.` });
  const suPer = selfUseInsight(T.self_use, T.feed_kwh, T.heat_grid_kwh);
  if (suPer) ins.push(suPer);
  else if (T.feed_kwh >= 2 && T.heat_grid_kwh >= 2) ins.push({ tone: 'green', title: `${kwh(T.feed_kwh)} eingespeist`, text: 'Im selben Zeitraum wurde aus dem Netz geheizt – Potenzial für mittägliches Vorheizen.' });
  if (ins.length === 0) ins.push({ tone: 'green', title: 'Keine Auffälligkeiten', text: 'Der Zeitraum lief weitgehend mit eigenem Strom.' });

  const unit = period === 'year' ? 'Monat' : 'Tag';
  return (
    <div className="stack">
      {T.days < totalDays && <div className="notice-warn">Daten für {T.days} von {totalDays} Tagen{period !== 'year' ? '' : ''} – Summen gelten für die erfassten Tage.</div>}

      <section className="kpis">
        <div className="card tile"><div className="eyebrow">PV</div><div className="tile-value">{kwh(T.pv_kwh)}</div><div className="muted small">Ø {perDay(T.pv_kwh)}/Tag · eingespeist {kwh(T.feed_kwh)}</div></div>
        <SelfUseTiles pv={T.pv_kwh} feed={T.feed_kwh} use={T.use_kwh} gridIn={T.grid_in_kwh} pvHouse={T.pv_house_kwh} pvHeat={T.pv_heat_kwh} pvCar={T.pv_car_kwh} pvBat={T.pv_bat_kwh} />
        <div className="card tile"><div className="eyebrow">Verbrauch</div><div className="tile-value">{kwh(T.use_kwh)}</div><div className="muted small">Ø {perDay(T.use_kwh)}/Tag · Heizung {kwh(T.heat_kwh)}</div></div>
        <div className="card tile"><div className="eyebrow">Netzbezug</div><div className={`tile-value ${T.grid_in_kwh / Math.max(1, T.days) > 3 ? 'warn-text' : ''}`}>{kwh(T.grid_in_kwh)}</div><div className="muted small">davon Heizung {kwh(T.heat_grid_kwh)}</div></div>
        <div className="card tile"><div className="eyebrow">Außen</div><div className="tile-value">{T.outdoor_avg != null ? `Ø ${num(T.outdoor_avg, 1, ' °C')}` : '–'}</div><div className="muted small">{T.outdoor_min != null ? `${num(T.outdoor_min, 1)} … ${num(T.outdoor_max, 1)} °C` : 'noch nicht erfasst'}</div></div>
      </section>

      <section className="card">
        <div className="chart-title">Das Wichtigste</div>
        <div className="insights">{ins.map((i) => <Insight key={i.title} tone={i.tone} title={i.title}>{i.text}</Insight>)}</div>
      </section>

      <Section nr="1" title="PV-Anlage" question={`Wohin ging der Sonnenstrom? (kWh je ${unit})`}>
        <SelfUseFacts pv={T.pv_kwh} feed={T.feed_kwh} use={T.use_kwh} gridIn={T.grid_in_kwh} />
        <SourceBar parts={[
          { k: 'h', label: 'Haus', color: F.house, v: T.pv_house_kwh }, { k: 'w', label: 'Heizung', color: F.heat, v: T.pv_heat_kwh },
          { k: 'c', label: 'Auto', color: F.car, v: T.pv_car_kwh }, { k: 'b', label: 'Batterie geladen', color: F.batIn, v: T.pv_bat_kwh },
          { k: 'f', label: 'Eingespeist', color: F.feed, v: T.feed_kwh },
        ]} />
        <PeriodChart data={bars} bars={[
          { k: 'pv_house_kwh', label: 'Haus', color: F.house }, { k: 'pv_heat_kwh', label: 'Heizung', color: F.heat },
          { k: 'pv_car_kwh', label: 'Auto', color: F.car }, { k: 'pv_bat_kwh', label: 'Batterie geladen', color: F.batIn },
          { k: 'feed_kwh', label: 'Eingespeist', color: F.feed },
        ]} />
        <div className="chart-title">Eigenverbrauch und Autarkie je {unit}</div>
        <PctChart data={bars} />
        <Legend2 items={[{ label: 'Eigenverbrauch (PV selbst genutzt)', color: F.feed }, { label: 'Autarkie (Verbrauch ohne Netz)', color: C.bat }]} />
      </Section>

      <Section nr="2" title="Batterie" question={`Wer hat sie geleert – und wie oft war sie leer? (kWh je ${unit})`}>
        <div className="facts">
          <span>geladen <strong>{kwh(T.pv_bat_kwh)}</strong> · entladen <strong>{kwh(T.bat_out_kwh)}</strong></span>
          <span>leer an <strong>{T.empty_days}</strong> von {T.days} Tagen</span>
        </div>
        <SourceBar parts={[
          { k: 'w', label: 'Heizung', color: F.heat, v: T.bat_heat_kwh }, { k: 'h', label: 'Haus', color: F.house, v: T.bat_house_kwh },
          { k: 'c', label: 'Auto', color: F.car, v: T.bat_car_kwh },
        ]} />
        <PeriodChart data={bars} line={{ k: 'bat_empty_h', label: 'Stunden leer', color: F.bat }} lineUnit=" h" bars={[
          { k: 'bat_heat_kwh', label: 'an Heizung', color: F.heat }, { k: 'bat_house_kwh', label: 'an Haus', color: F.house },
          { k: 'bat_car_kwh', label: 'an Auto', color: F.car },
        ]} />
        <Legend2 items={[{ label: 'Balken: Entladung je Verbraucher', color: F.heat }, { label: 'Linie: Stunden mit leerer Batterie', color: F.bat }]} />
      </Section>

      <Section nr="3" title="Wärmepumpe" question={`Wie viel wurde geheizt – womit, und hängt es an der Außentemperatur? (kWh je ${unit})`}>
        <SourceBar parts={[
          { k: 's', label: 'Sonne', color: F.sun, v: T.heat_sun_kwh }, { k: 'b', label: 'Batterie', color: F.bat, v: T.heat_bat_kwh },
          { k: 'g', label: 'Netz', color: F.grid, v: T.heat_grid_kwh },
        ]} />
        <PeriodChart data={bars} line={{ k: 'outdoor_avg', label: 'Außen Ø', color: F.feed }} bars={[
          { k: 'heat_sun_kwh', label: 'aus Sonne', color: F.sun }, { k: 'heat_bat_kwh', label: 'aus Batterie', color: F.bat },
          { k: 'heat_grid_kwh', label: 'aus Netz', color: F.grid },
        ]} />
        <Legend2 items={[{ label: 'Sonne', color: F.sun }, { label: 'Batterie', color: F.bat }, { label: 'Netz', color: F.grid }, { label: 'Außentemperatur Ø (rechte Achse)', color: F.feed }]} />
        <table className="ptable">
          <thead><tr><th>Tageszeit</th><th>Heizstrom</th><th>Ø je Tag</th><th>davon Netz</th></tr></thead>
          <tbody>
            {[['Nacht 0–6', 1], ['Morgen 6–9', 2], ['Tag 9–16', 3], ['Abend 16–20', 4], ['Nacht 20–24', 5]].map(([l, p]) => (
              <tr key={p}>
                <td>{l}</td><td>{kwh(T[`heat_p${p}_kwh`])}</td><td>{perDay(T[`heat_p${p}_kwh`])}</td>
                <td className={T[`heat_grid_p${p}_kwh`] / Math.max(1, T.days) >= 0.5 ? 'warn-text' : ''}>{kwh(T[`heat_grid_p${p}_kwh`])}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="muted small">Heizstrom geschätzt (Verbrauch − Auto − Grundlast), bis die Wärmepumpe selbst gemessen wird.</div>
      </Section>

      <Section nr="4" title="Auto" question={`Woher kam der Ladestrom? (kWh je ${unit})`}>
        {!T.car_measured ? <div className="muted small">Im Zeitraum wurde die Auto-Ladeleistung noch nicht erfasst.</div>
          : T.car_kwh < 0.1 ? <div className="muted small">Im Zeitraum nicht geladen.</div> : (
            <>
              <div className="facts"><span>geladen <strong>{kwh(T.car_kwh)}</strong></span></div>
              <SourceBar parts={[
                { k: 's', label: 'Sonne', color: F.sun, v: T.car_sun_kwh }, { k: 'b', label: 'Hausbatterie', color: F.bat, v: T.car_bat_kwh },
                { k: 'g', label: 'Netz', color: F.grid, v: T.car_grid_kwh },
              ]} />
              <PeriodChart data={bars} height={190} bars={[
                { k: 'car_sun_kwh', label: 'aus Sonne', color: F.sun }, { k: 'car_bat_kwh', label: 'aus Hausbatterie', color: F.bat },
                { k: 'car_grid_kwh', label: 'aus Netz', color: F.grid },
              ]} />
            </>
          )}
      </Section>
    </div>
  );
}

// Räume über einen Zeitraum
function aggregateRoom(rows) {
  const w = rows.reduce((s, r) => s + (Number(r.data_hours) || 0), 0);
  const wavg = (k) => (w > 0 ? rows.reduce((s, r) => s + (Number(r[k]) || 0) * (Number(r.data_hours) || 0), 0) / w : null);
  const sum = (k) => rows.reduce((s, r) => s + (Number(r[k]) || 0), 0);
  const avg = (k) => { const v = rows.map((r) => n(r[k])).filter((x) => x != null); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
  return {
    data_hours: w || null, temp_avg: wavg('temp_avg'), setpoint_avg: wavg('setpoint_avg'), dev_avg: wavg('dev_avg'),
    temp_min: rows.reduce((m, r) => (r.temp_min != null && (m == null || Number(r.temp_min) < m) ? Number(r.temp_min) : m), null),
    temp_max: rows.reduce((m, r) => (r.temp_max != null && (m == null || Number(r.temp_max) > m) ? Number(r.temp_max) : m), null),
    cold_h: sum('cold_h'), warm_h: sum('warm_h'), valve_h: sum('valve_h'), valve_pv_h: sum('valve_pv_h'), valve_bat_h: sum('valve_bat_h'), valve_grid_h: sum('valve_grid_h'),
    valve_switches: sum('valve_switches'), heat_rate_kph: avg('heat_rate_kph'), cool_rate_kph: avg('cool_rate_kph'),
  };
}

function PeriodRoomsView({ period, date, rooms }) {
  const range = rangeOf(period, date);
  const q = useRpc('muc_range_rooms', { p_from: range.from, p_to: range.to }, [range.from, range.to]);
  const [roomId, setRoomId] = useState(rooms[0]?.id);
  if (q.error) return <div className="alert">{q.error}{/muc_range_rooms/.test(q.error) ? ' – bitte supabase/migration-003-zeitraeume.sql ausführen.' : ''}</div>;
  if (q.loading) return <div className="muted">Lade Raumauswertung …</div>;
  const all = q.data || [];
  const stats = rooms.map((ro) => ({ room_id: ro.id, name: ro.name, ...aggregateRoom(all.filter((r) => r.room_id === ro.id)) }));
  const room = stats.find((r) => r.room_id === roomId);
  const mine = all.filter((r) => r.room_id === roomId);
  const groups = period === 'year'
    ? MONTHS.map((m, i) => ({ label: m, rows: mine.filter((r) => utc(String(r.day).slice(0, 10)).getUTCMonth() === i) }))
    : (() => { const g = []; for (let s = range.from; s <= range.to; s = shiftPeriod('day', s, 1)) {
      const dt = utc(s);
      g.push({ label: period === 'week' ? dt.toLocaleDateString('de-DE', { weekday: 'short', timeZone: 'UTC' }) : String(dt.getUTCDate()), rows: mine.filter((r) => String(r.day).slice(0, 10) === s) });
    } return g; })();
  const data = groups.map((g) => {
    const a = aggregateRoom(g.rows);
    return { label: g.label, sun: r1(a.valve_pv_h), bat: r1(a.valve_bat_h), grid: r1(a.valve_grid_h), temp: a.data_hours ? r1(a.temp_avg) : null, set: a.data_hours ? r1(a.setpoint_avg) : null };
  });

  return (
    <div className="stack">
      <div className="roomstats">
        {stats.map((r) => <RoomStatCard key={r.room_id} r={r} selected={r.room_id === roomId} onSelect={() => setRoomId(r.room_id)} />)}
      </div>
      <section className="card chart">
        <div className="chart-title">{room?.name}: Ventil-offen-Stunden und Temperatur je {period === 'year' ? 'Monat' : 'Tag'}</div>
        <ResponsiveContainer width="100%" height={250}>
          <ComposedChart data={data} margin={{ top: 12, right: 4, bottom: 0, left: -14 }}>
            <CartesianGrid stroke="var(--grid)" vertical={false} />
            <XAxis dataKey="label" stroke="var(--muted)" fontSize={11} interval="preserveStartEnd" minTickGap={4} />
            <YAxis yAxisId="a" stroke="var(--muted)" fontSize={12} unit=" h" width={50} />
            <YAxis yAxisId="t" orientation="right" stroke={C.temp} fontSize={12} unit="°" width={40} domain={[(m) => Math.floor(m - 1), (m) => Math.ceil(m + 1)]} allowDecimals={false} />
            <Tooltip formatter={(v, name) => (/Ø/.test(name) ? `${num(v, 1)} °C` : `${num(v, 1)} h`)} />
            <Bar yAxisId="a" stackId="v" dataKey="sun" name="Ventil offen – Sonne" fill={F.sun} isAnimationActive={false} />
            <Bar yAxisId="a" stackId="v" dataKey="bat" name="Ventil offen – Batterie" fill={F.bat} isAnimationActive={false} />
            <Bar yAxisId="a" stackId="v" dataKey="grid" name="Ventil offen – Netz" fill={F.grid} isAnimationActive={false} />
            <Line yAxisId="t" dataKey="temp" name="Ø Ist" stroke={C.temp} strokeWidth={2} dot={{ r: 2 }} connectNulls isAnimationActive={false} />
            <Line yAxisId="t" dataKey="set" name="Ø Soll" stroke={C.set} strokeDasharray="5 3" strokeWidth={2} dot={false} connectNulls isAnimationActive={false} />
          </ComposedChart>
        </ResponsiveContainer>
        <Legend2 items={[{ label: 'Ventil offen bei Sonne', color: F.sun }, { label: '… Batterie', color: F.bat }, { label: '… Netz', color: F.grid }, { label: 'Ø Ist', color: C.temp }, { label: 'Ø Soll', color: C.set }]} />
      </section>
    </div>
  );
}

/* ------------------------------ Prognose ------------------------------ */
// Stufe A der vorausschauenden Steuerung: Wie gut trifft die FENECON-Prognose?
const HZ = { 1: 'in 1 h', 3: 'in 3 h', 6: 'in 6 h', 12: 'in 12 h', 24: 'in 24 h', 36: 'in 36 h' };
const NEED_DAYS = 10;
const kW = (w) => (w == null ? '–' : `${(Number(w) / 1000).toLocaleString('de-DE', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} kW`);
const shortDay = (d) => utc(String(d).slice(0, 10)).toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit', timeZone: 'UTC' }).replace('.,', '');
const k1 = (w) => (w == null ? '–' : (Number(w) / 1000).toLocaleString('de-DE', { minimumFractionDigits: 1, maximumFractionDigits: 1 }));

function forecastVerdict(acc) {
  const ref = acc.find((a) => a.horizon_h === 6) || acc.find((a) => a.horizon_h === 3);
  const days = Math.max(0, ...acc.map((a) => a.days || 0));
  if (!ref || days < NEED_DAYS) {
    return {
      tone: 'cool', title: `Noch zu wenige Tage: ${days} von ${NEED_DAYS}`,
      text: 'Die Prognose wird seit dem 23.10.2026 gespeichert. Ein Urteil ist ab etwa 10 Tagen mit Sonne und Wolken aussagekräftig. Bis dahin steuert die App ohne Prognose.',
    };
  }
  const pct = Number(ref.mae_pct);
  const bias = ref.real_avg_w ? Math.round((100 * ref.bias_w) / ref.real_avg_w) : 0;
  const tend = Math.abs(bias) >= 10 ? ` Tendenz: FENECON ${bias > 0 ? 'überschätzt' : 'unterschätzt'} die PV im Mittel um ${Math.abs(bias)} %.` : '';
  if (pct <= 30) return { tone: 'green', title: `Treffsicher genug für die Steuerung (Abweichung ${pct} %)`, text: `Für ${HZ[ref.horizon_h]} liegt die Prognose im Mittel ${pct} % daneben.${tend} Sie kann morgens für Entscheidungen genutzt werden (z. B. „nicht aus Batterie heizen, mittags kommt Sonne“).` };
  if (pct <= 50) return { tone: 'sun', title: `Nur grob brauchbar (Abweichung ${pct} %)`, text: `Für ${HZ[ref.horizon_h]} liegt die Prognose im Mittel ${pct} % daneben.${tend} Nur für eindeutige Tage nutzen – sehr sonnig oder sehr trüb.` };
  return { tone: 'rose', title: `Zu ungenau für die Steuerung (Abweichung ${pct} %)`, text: `Für ${HZ[ref.horizon_h]} liegt die Prognose im Mittel ${pct} % daneben.${tend} Die Steuerung sollte sich nicht darauf verlassen.` };
}

function ForecastView({ period, date }) {
  const range = period === 'day' ? { from: shiftDate(date, -13), to: date } : rangeOf(period, date);
  const acc = useRpc('muc_forecast_accuracy', { p_from: range.from, p_to: range.to }, [range.from, range.to]);
  const ctx = useRpc('muc_range_context', { p_from: range.from, p_to: range.to }, [range.from, range.to]);
  const err = acc.error || ctx.error;
  if (err) return <div className="alert">{err}{/muc_forecast_accuracy|muc_range_context/.test(err) ? ' – bitte supabase/migration-006-tagesprotokoll.sql ausführen.' : ''}</div>;
  if (acc.loading || ctx.loading) return <div className="muted">Lade Prognose-Auswertung …</div>;
  const rows = acc.data || [];
  const days = (ctx.data || []).filter((d) => d.fc_noon_w != null || d.fc_prev_noon_w != null || d.real_noon_w != null);
  if (rows.length === 0 && days.length === 0) return <div className="card muted">Für diesen Zeitraum gibt es noch keine gespeicherte Prognose (Aufzeichnung seit 23.10.2026).</div>;
  const v = forecastVerdict(rows);
  const chart = days.map((d) => ({
    label: shortDay(d.day),
    real: d.real_noon_w == null ? null : d.real_noon_w / 1000,
    fc: d.fc_noon_w == null ? null : d.fc_noon_w / 1000,
    prev: d.fc_prev_noon_w == null ? null : d.fc_prev_noon_w / 1000,
  }));
  return (
    <div className="stack">
      {period === 'day' && <div className="muted small">Zeitraum: die letzten 14 Tage bis {fmtDate(date)}.</div>}
      <section className="card">
        <div className="chart-title">Urteil</div>
        <div className="insights"><Insight tone={v.tone} title={v.title}>{v.text}</Insight></div>
      </section>

      <Section nr="1" title="Treffsicherheit" question="Wie weit liegt die PV-Prognose daneben – je nachdem, wie weit sie vorausschaut?">
        {rows.length === 0 ? <div className="muted small">Noch keine Messwerte zu den vorhergesagten Zeitpunkten.</div> : (
          <table className="ptable fc-table">
            <thead><tr><th>Vorhersage</th><th className="hide-sm">Tage</th><th>Ø Prognose kW</th><th>Ø gemessen kW</th><th>Ø Abweichung</th><th>Tendenz</th></tr></thead>
            <tbody>
              {rows.map((a) => {
                const b = a.real_avg_w ? Math.round((100 * a.bias_w) / a.real_avg_w) : 0;
                return (
                  <tr key={a.horizon_h}>
                    <td>{HZ[a.horizon_h]}</td>
                    <td className="hide-sm">{a.days}</td>
                    <td>{k1(a.fc_avg_w)}</td>
                    <td>{k1(a.real_avg_w)}</td>
                    <td className={Number(a.mae_pct) > 50 ? 'warn-text' : ''}><span className="hide-sm">{kW(a.mae_w)} · </span>{a.mae_pct ?? '–'} %</td>
                    <td title={Math.abs(b) < 10 ? 'Prognose im Mittel passend' : b > 0 ? 'Prognose im Mittel zu hoch' : 'Prognose im Mittel zu niedrig'}>{Math.abs(b) < 10 ? 'passt' : b > 0 ? `+${b} %` : `${b} %`}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        <div className="muted small">Tendenz: + = Prognose im Mittel zu hoch, − = zu niedrig. Verglichen wird jede gespeicherte Prognose (alle 15 min) mit der gemessenen PV-Leistung zum vorhergesagten Zeitpunkt. Nachtstunden zählen nicht. Für die Entscheidungen am Morgen zählt vor allem „in 3 h“ und „in 6 h“.</div>
      </Section>

      <Section nr="2" title="Mittag: Prognose gegen Messung" question="Was war für 12 Uhr vorhergesagt – und was kam?">
        <ResponsiveContainer width="100%" height={230}>
          <ComposedChart data={chart} margin={{ top: 12, right: 8, bottom: 0, left: -6 }}>
            <CartesianGrid stroke="var(--grid)" vertical={false} />
            <XAxis dataKey="label" stroke="var(--muted)" fontSize={11} interval="preserveStartEnd" minTickGap={4} />
            <YAxis stroke="var(--muted)" fontSize={12} unit=" kW" width={56} allowDecimals={false} />
            <Tooltip formatter={(val) => `${Number(val).toLocaleString('de-DE', { maximumFractionDigits: 1 })} kW`} />
            <Bar dataKey="real" name="gemessen 12 Uhr" fill={F.sun} maxBarSize={44} isAnimationActive={false} />
            <Line dataKey="fc" name="Prognose am Morgen (6 Uhr)" stroke={F.bat} strokeWidth={2} dot={{ r: 3 }} connectNulls={false} isAnimationActive={false} />
            <Line dataKey="prev" name="Prognose vom Vortag (12 Uhr)" stroke={F.car} strokeWidth={1.5} strokeDasharray="5 3" dot={{ r: 2 }} connectNulls={false} isAnimationActive={false} />
          </ComposedChart>
        </ResponsiveContainer>
        <Legend2 items={[{ label: 'gemessen 12 Uhr', color: F.sun }, { label: 'Prognose am Morgen', color: F.bat }, { label: 'Prognose vom Vortag', color: F.car }]} />
        <table className="ptable fc-table">
          <thead><tr><th>Tag</th><th>Morgens kW</th><th>Vortag kW</th><th>gemessen kW</th><th className="hide-sm">PV Tag kWh</th><th>Heizung Netz kWh</th></tr></thead>
          <tbody>
            {days.map((d) => (
              <tr key={String(d.day)}>
                <td>{shortDay(d.day)}{d.source === 'nachgetragen' ? <span className="muted"> *</span> : ''}</td>
                <td>{k1(d.fc_noon_w)}</td>
                <td>{k1(d.fc_prev_noon_w)}</td>
                <td>{k1(d.real_noon_w)}</td>
                <td className="hide-sm">{num(d.pv_kwh, 1)}</td>
                <td className={Number(d.heat_grid_kwh) >= 2 ? 'warn-text' : ''}>{num(d.heat_grid_kwh, 1)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="muted small">* nachgetragen aus den gespeicherten Prognosen (ohne Einstellungen des Tages). Ab Collector 0.6 hält das Tagesprotokoll jeden Morgen Prognose, Einstellungen und Heizplan fest – die Grundlage für die Mustererkennung (Stufe B).</div>
      </Section>
    </div>
  );
}

export default function Analyse({ settings, rooms }) {
  const [period, setPeriod] = useState('day');
  const [view, setView] = useState('energy');
  const [date, setDate] = useState(todayBerlin());
  const active = rooms.filter((r) => r.enabled);
  const P = [['day', 'Tag'], ['week', 'Woche'], ['month', 'Monat'], ['year', 'Jahr']];
  return (
    <div className="stack">
      <div className="toolbar analyse-bar">
        <div className="seg seg-4">
          {P.map(([k, l]) => <button key={k} className={period === k ? 'seg-btn active' : 'seg-btn'} onClick={() => setPeriod(k)}>{l}</button>)}
        </div>
        <div className="seg seg-3">
          {[['energy', 'Energie'], ['rooms', 'Räume'], ['forecast', 'Prognose']].map(([k, l]) => (
            <button key={k} className={view === k ? 'seg-btn active' : 'seg-btn'} onClick={() => setView(k)}>{l}</button>
          ))}
        </div>
      </div>
      <PeriodNav period={period} date={date} setDate={setDate} />
      {view === 'forecast' ? <ForecastView period={period} date={date} /> : period === 'day'
        ? (view === 'energy' ? <DayView date={date} settings={settings} /> : <RoomsView date={date} settings={settings} rooms={active} />)
        : (view === 'energy' ? <PeriodView period={period} date={date} /> : <PeriodRoomsView period={period} date={date} rooms={active} />)}
    </div>
  );
}
