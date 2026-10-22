import { useEffect, useState } from 'react';
import {
  ResponsiveContainer, ComposedChart, Line, Area, XAxis, YAxis, Tooltip, CartesianGrid, Legend,
} from 'recharts';
import { supabase } from './supabase.js';

const RANGES = [
  { h: 6, label: '6 h' },
  { h: 24, label: '24 h' },
  { h: 72, label: '3 Tage' },
  { h: 168, label: '7 Tage' },
];

const C = {
  temp: '#c2410c',
  setpoint: '#1d4ed8',
  pv: '#d9a400',
  surplus: '#16a34a',
  soc: '#64748b',
  valve: '#c2410c',
};

export default function History({ rooms }) {
  const [hours, setHours] = useState(24);
  const [roomId, setRoomId] = useState(rooms[0]?.id);
  const [rows, setRows] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!roomId) return;
    let cancel = false;
    setRows(null);
    supabase.rpc('history', { p_hours: hours, p_room: roomId }).then(({ data, error }) => {
      if (cancel) return;
      if (error) setError(error.message);
      else {
        setError(null);
        setRows(
          data.map((r) => ({
            t: new Date(r.bucket).getTime(),
            temp: r.temp == null ? null : Number(r.temp),
            setpoint: r.setpoint == null ? null : Number(r.setpoint),
            valve: r.valve == null ? null : Math.round(Number(r.valve) * 100),
            pv: r.pv_w == null ? null : r.pv_w / 1000,
            surplus: r.surplus_w == null ? null : r.surplus_w / 1000,
            soc: r.soc,
          })),
        );
      }
    });
    return () => {
      cancel = true;
    };
  }, [hours, roomId]);

  const tick = (t) =>
    new Date(t).toLocaleString('de-DE', hours > 24
      ? { weekday: 'short', hour: '2-digit', timeZone: 'Europe/Berlin' }
      : { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Berlin' });
  const tip = (t) => new Date(t).toLocaleString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Berlin' });

  return (
    <div className="stack">
      <div className="toolbar">
        <select value={roomId} onChange={(e) => setRoomId(e.target.value)}>
          {rooms.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
        </select>
        <div className="seg">
          {RANGES.map((r) => (
            <button key={r.h} className={hours === r.h ? 'seg-btn active' : 'seg-btn'} onClick={() => setHours(r.h)}>{r.label}</button>
          ))}
        </div>
      </div>
      {error && <div className="alert">{error}</div>}
      {!rows && !error && <div className="muted">Lade Verlauf …</div>}
      {rows && rows.length === 0 && <div className="card muted">Noch keine Messwerte in diesem Zeitraum.</div>}
      {rows && rows.length > 0 && (
        <>
          <section className="card chart">
            <div className="chart-title">Raum: Temperatur, Sollwert und Ventil</div>
            <ResponsiveContainer width="100%" height={280}>
              <ComposedChart data={rows} margin={{ top: 8, right: 8, bottom: 0, left: -12 }}>
                <CartesianGrid stroke="var(--grid)" vertical={false} />
                <XAxis dataKey="t" type="number" domain={['dataMin', 'dataMax']} tickFormatter={tick} stroke="var(--muted)" fontSize={12} />
                <YAxis yAxisId="t" domain={['dataMin - 1', 'dataMax + 1']} tickFormatter={(v) => `${Math.round(v)}°`} stroke="var(--muted)" fontSize={12} />
                <YAxis yAxisId="v" orientation="right" domain={[0, 100]} hide />
                <Tooltip labelFormatter={tip} formatter={(v, n) => (n === 'Ventil offen' ? `${v} %` : `${v} °C`)} />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                <Area yAxisId="v" dataKey="valve" name="Ventil offen" type="stepAfter" fill={C.valve} fillOpacity={0.1} stroke="none" isAnimationActive={false} />
                <Line yAxisId="t" dataKey="temp" name="Ist" stroke={C.temp} strokeWidth={2} dot={false} isAnimationActive={false} connectNulls />
                <Line yAxisId="t" dataKey="setpoint" name="Soll" type="stepAfter" stroke={C.setpoint} strokeWidth={2} strokeDasharray="5 3" dot={false} isAnimationActive={false} connectNulls />
              </ComposedChart>
            </ResponsiveContainer>
          </section>
          <section className="card chart">
            <div className="chart-title">Energie: PV, Überschuss und Batterie</div>
            <ResponsiveContainer width="100%" height={240}>
              <ComposedChart data={rows} margin={{ top: 8, right: 8, bottom: 0, left: -12 }}>
                <CartesianGrid stroke="var(--grid)" vertical={false} />
                <XAxis dataKey="t" type="number" domain={['dataMin', 'dataMax']} tickFormatter={tick} stroke="var(--muted)" fontSize={12} />
                <YAxis yAxisId="kw" tickFormatter={(v) => `${v} kW`} stroke="var(--muted)" fontSize={12} />
                <YAxis yAxisId="soc" orientation="right" domain={[0, 100]} tickFormatter={(v) => `${v}%`} stroke="var(--muted)" fontSize={12} />
                <Tooltip labelFormatter={tip} formatter={(v, n) => (n === 'Batterie' ? `${v} %` : `${Number(v).toFixed(2)} kW`)} />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                <Area yAxisId="kw" dataKey="pv" name="PV" fill={C.pv} fillOpacity={0.18} stroke={C.pv} strokeWidth={1.5} isAnimationActive={false} connectNulls />
                <Line yAxisId="kw" dataKey="surplus" name="Überschuss" stroke={C.surplus} strokeWidth={2} dot={false} isAnimationActive={false} connectNulls />
                <Line yAxisId="soc" dataKey="soc" name="Batterie" stroke={C.soc} strokeWidth={1.5} dot={false} isAnimationActive={false} connectNulls />
              </ComposedChart>
            </ResponsiveContainer>
          </section>
        </>
      )}
    </div>
  );
}
