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
function DayView({ date, settings }) {
  const k = useRpc('muc_day_kpis', { p_date: date }, [date]);
  const e = useRpc('muc_day_energy', { p_date: date }, [date]);
  const kp = k.data?.[0];
  const rows = useMemo(() => (e.data || []).map((r) => ({
    h: hourOf(r.bucket),
    pv: r.pv_w / 1000, use: r.consumption_w / 1000, heat: r.heat_w / 1000, car: r.car_w / 1000,
    grid: r.grid_in_w / 1000, soc: r.soc, out: n(r.outdoor_c),
  })), [e.data]);

  if (k.error || e.error) return <div className="alert">{k.error || e.error}</div>;
  if (k.loading || e.loading) return <div className="muted">Lade Auswertung …</div>;
  if (!kp || kp.data_hours == null) return <div className="card muted">Für diesen Tag gibt es keine Messwerte.</div>;

  const nightShare = kp.grid_in_kwh > 0 ? Math.round((100 * kp.grid_in_night_kwh) / kp.grid_in_kwh) : 0;
  const tiles = [
    { l: 'Netzbezug', v: kwh(kp.grid_in_kwh), s: `davon nachts ${kwh(kp.grid_in_night_kwh)} (${nightShare} %)`, warn: kp.grid_in_night_kwh > 3 },
    { l: 'PV-Erzeugung', v: kwh(kp.pv_kwh), s: `Eigenverbrauch ${num(kp.self_use_pct, 0, ' %')}` },
    { l: 'Autarkie', v: num(kp.autarky_pct, 0, ' %'), s: `Einspeisung ${kwh(kp.grid_out_kwh)}` },
    { l: 'Heizstrom (geschätzt)', v: kwh(kp.heat_kwh), s: `Auto ${kp.car_measured ? kwh(kp.car_kwh) : 'nicht gemessen'}`, accent: true },
    { l: 'Batterie leer', v: num(kp.bat_empty_h, 1, ' h'), s: kp.bat_empty_from ? `erstmals ${hm(hourOf(kp.bat_empty_from))} Uhr` : `min. ${kp.soc_min} %`, warn: kp.bat_empty_h > 2 },
    { l: 'Außentemperatur', v: kp.outdoor_avg != null ? `Ø ${num(kp.outdoor_avg, 1, ' °C')}` : '–', s: kp.outdoor_min != null ? `${num(kp.outdoor_min, 1)} … ${num(kp.outdoor_max, 1)} °C` : 'noch nicht erfasst' },
  ];

  return (
    <div className="stack">
      {kp.data_hours < 20 && <div className="notice-warn">Unvollständiger Tag: nur {num(kp.data_hours, 1)} Stunden Messwerte.</div>}
      <section className="kpis">
        {tiles.map((t) => (
          <div key={t.l} className={`card tile ${t.accent ? 'accent' : ''}`}>
            <div className="eyebrow">{t.l}</div>
            <div className={`tile-value ${t.warn ? 'warn-text' : ''}`}>{t.v}</div>
            <div className="muted small">{t.s}</div>
          </div>
        ))}
      </section>

      <section className="card">
        <div className="chart-title">Woher kam der Heizstrom?</div>
        <SourceBar parts={SRC.map((s) => ({ ...s, v: n(kp[`heat_${s.k}_kwh`]) }))} />
        <p className="muted small explain">
          Geschätzt: Hausverbrauch − Auto − Grundlast ({kp.baseload_w} W). Genaue Werte, sobald die Wärmepumpe selbst gemessen wird.
          {!kp.car_measured && ' An diesem Tag wurde das Auto noch nicht erfasst – Ladestrom steckt in der Schätzung.'}
        </p>
      </section>

      <section className="card chart">
        <div className="chart-title">Strom über den Tag <span className="muted small">(Nacht hinterlegt)</span></div>
        <ResponsiveContainer width="100%" height={270}>
          <ComposedChart data={rows} margin={{ top: 8, right: 8, bottom: 0, left: -14 }}>
            <CartesianGrid stroke="var(--grid)" vertical={false} />
            {xAxis}
            <YAxis yAxisId="a" tickFormatter={(v) => `${v}`} stroke="var(--muted)" fontSize={12} unit=" kW" width={58} />
            {nightAreas(settings)}
            <Tooltip labelFormatter={(h) => `${hm(h)} Uhr`} formatter={(v) => `${Number(v).toFixed(2)} kW`} />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            <Area yAxisId="a" dataKey="pv" name="PV" stroke={C.pv} fill={C.pv} fillOpacity={0.2} strokeWidth={1.5} isAnimationActive={false} />
            <Area yAxisId="a" dataKey="heat" name="Heizung (geschätzt)" stroke={C.heat} fill={C.heat} fillOpacity={0.25} strokeWidth={1.5} isAnimationActive={false} />
            <Line yAxisId="a" dataKey="car" name="Auto" stroke={C.car} strokeDasharray="4 3" dot={false} strokeWidth={1.5} isAnimationActive={false} />
            <Line yAxisId="a" dataKey="grid" name="Netzbezug" stroke={C.grid} dot={false} strokeWidth={2} isAnimationActive={false} />
          </ComposedChart>
        </ResponsiveContainer>
      </section>

      <section className="card chart">
        <div className="chart-title">Batterie und Außentemperatur</div>
        <ResponsiveContainer width="100%" height={210}>
          <ComposedChart data={rows} margin={{ top: 8, right: 4, bottom: 0, left: -6 }}>
            <CartesianGrid stroke="var(--grid)" vertical={false} />
            {xAxis}
            <YAxis yAxisId="a" domain={[0, 100]} ticks={[0, 25, 50, 75, 100]} unit="%" stroke="var(--muted)" fontSize={12} width={50} />
            <YAxis yAxisId="t" orientation="right" unit="°" stroke="var(--muted)" fontSize={12} width={36} domain={['dataMin - 2', 'dataMax + 2']} allowDecimals={false} />
            {nightAreas(settings)}
            <Tooltip labelFormatter={(h) => `${hm(h)} Uhr`} formatter={(v, name) => (name === 'Batterie' ? `${v} %` : `${v} °C`)} />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            <Area yAxisId="a" dataKey="soc" name="Batterie" stroke={C.bat} fill={C.bat} fillOpacity={0.12} strokeWidth={1.5} isAnimationActive={false} />
            <Line yAxisId="t" dataKey="out" name="Außen" stroke={C.outdoor} dot={false} strokeWidth={1.5} isAnimationActive={false} connectNulls />
          </ComposedChart>
        </ResponsiveContainer>
      </section>
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
