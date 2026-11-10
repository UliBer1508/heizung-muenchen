// Heizung jetzt (München) – Gegenstück zur Karte „Heizung jetzt“ in Heizung Venediger (10.11.2026).
// Unterschied: In München heizt eine Wärmepumpe über Wasser-FBH mit einem Ventil je Raum.
// Ein offener Kreis hat keine eigene Leistung, und die Wärmepumpe wird (noch) nicht gemessen.
// Darum: Kreise offen statt „laut Thermostaten“, Wärmepumpe GESCHÄTZT = Verbrauch − Auto − Grundlast
// (gleiche Formel wie muc_energy_rows / Analyse), Heizstrom heute aus muc_day_kpis.
// Nur lesend – keine Änderung an der Steuerung.
import { useEffect, useMemo, useState } from 'react';
import { supabase } from './supabase.js';
import { fmtW, fmtTime } from './lib.js';

const kwh = (v) => (v == null ? '–' : `${Number(v).toLocaleString('de-DE', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} kWh`);
const todayBerlin = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Berlin' });

const SRC = [
  { k: 'sun', label: 'Sonne', color: 'var(--sun)' },
  { k: 'bat', label: 'Akku', color: 'var(--cool)' },
  { k: 'grid', label: 'Netz', color: 'var(--rose)' },
];

function Bar({ parts, unit }) {
  const total = parts.reduce((s, p) => s + (p.v || 0), 0);
  if (!total) return null;
  return (
    <div>
      <div className="srcbar" role="img" aria-label={parts.map((p) => `${p.label} ${Math.round((100 * (p.v || 0)) / total)} %`).join(', ')}>
        {parts.map((p) => (p.v > 0 ? <span key={p.k} style={{ width: `${(100 * p.v) / total}%`, background: p.color }} /> : null))}
      </div>
      <div className="srclegend">
        {parts.map((p) => (
          <span key={p.k}><i style={{ background: p.color }} />{p.label} <strong>{unit(p.v)}</strong></span>
        ))}
      </div>
    </div>
  );
}

// Seit wann ist das Ventil offen? = letzte Messung mit Ventil zu (Messung jede Minute, also auf ~1 min genau)
function useOpenSince(openIds) {
  const key = openIds.slice().sort().join(',');
  const [since, setSince] = useState({});
  useEffect(() => {
    let alive = true;
    const load = async () => {
      const from = new Date(Date.now() - 24 * 3600e3).toISOString();
      const res = await Promise.all(openIds.map((id) =>
        supabase.from('muc_room_readings').select('ts').eq('room_id', id).neq('valve', 1)
          .gte('ts', from).order('ts', { ascending: false }).limit(1)));
      if (!alive) return;
      const m = {};
      openIds.forEach((id, i) => { m[id] = res[i].error ? undefined : (res[i].data?.[0]?.ts ?? null); });
      setSince(m);
    };
    if (openIds.length) load(); else setSince({});
    const t = setInterval(() => { if (openIds.length) load(); }, 5 * 60e3);
    return () => { alive = false; clearInterval(t); };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  return since;
}

function useHeatToday(energyTs) {
  const [k, setK] = useState(null);
  // alle 5 min bzw. bei neuer Energiemessung höchstens alle 5 min neu
  const slot = energyTs ? Math.floor(new Date(energyTs).getTime() / (5 * 60e3)) : 0;
  useEffect(() => {
    let alive = true;
    supabase.rpc('muc_day_kpis', { p_date: todayBerlin() }).then(({ data, error }) => {
      if (alive && !error) setK(Array.isArray(data) ? data[0] : data);
    });
    return () => { alive = false; };
  }, [slot]);
  return k;
}

export default function HeatingNow({ data }) {
  const { energy: e, settings, rooms, latestByRoom } = data;
  const base = settings?.baseload_w ?? 350;
  const cap = settings?.max_grid_circuits ?? 6;

  const open = useMemo(
    () => rooms.filter((r) => r.enabled && latestByRoom[r.id]?.valve === 1),
    [rooms, latestByRoom],
  );
  const since = useOpenSince(open.map((r) => r.id));
  const today = useHeatToday(e?.ts);

  // Wärmepumpe jetzt (geschätzt) und Herkunft – gleiche Rechnung wie muc_energy_rows
  const cons = e?.consumption_w ?? null;
  const car = e?.car_w ?? 0;
  const wp = cons == null ? null : Math.max(0, cons - car - base);
  let src = null;
  if (wp != null && cons > 0) {
    const gridIn = Math.max(0, e.grid_w ?? 0);
    const batOut = Math.max(0, e.battery_w ?? 0);
    const fBat = Math.min(1, batOut / cons);
    const fGrid = Math.min(1, gridIn / cons);
    const fSun = Math.max(0, 1 - (gridIn + batOut) / cons);
    src = { sun: wp * fSun, bat: wp * fBat, grid: wp * fGrid };
  }

  const check = wp == null ? null
    : open.length === 0 && wp > 800
      ? { ok: false, t: `Kein Kreis offen, trotzdem ${fmtW(wp)} über der Grundlast – vermutlich Warmwasser der Wärmepumpe oder ein anderer Verbraucher.` }
      : open.length > 0 && wp < 300
        ? { ok: true, t: 'Kreise offen, die Wärmepumpe läuft gerade nicht – sie schaltet nach Vorlauftemperatur, das ist normal.' }
        : { ok: true, t: open.length ? 'Kreise offen und Wärmepumpe läuft – passt zusammen.' : 'Kein Kreis offen, Wärmepumpe aus.' };

  return (
    <section className="card heatnow">
      <div className="heatnow-head">
        <div className="eyebrow">Heizung jetzt</div>
        <div className="muted small">Stand {fmtTime(e?.ts)}</div>
      </div>

      <div className="kpis">
        <div>
          <div className="eyebrow">Wärmepumpe (geschätzt)</div>
          <div className="tile-value">{fmtW(wp)}</div>
          <div className="muted small">Verbrauch {fmtW(cons)}{car > 50 ? ` − Auto ${fmtW(car)}` : ''} − Grundlast {fmtW(base)}</div>
        </div>
        <div>
          <div className="eyebrow">Kreise offen</div>
          <div className="tile-value">{open.length} von {cap}</div>
          <div className="muted small">Netzgrenze {cap} Kreise · mit Überschuss mehr</div>
        </div>
        <div>
          <div className="eyebrow">Heizstrom heute</div>
          <div className="tile-value">{kwh(today?.heat_kwh)}</div>
          <div className="muted small">geschätzt, seit 0:00</div>
        </div>
      </div>

      {src && wp > 0 && <Bar parts={SRC.map((s) => ({ ...s, v: src[s.k] }))} unit={fmtW} />}

      {check && (
        <div className={check.ok ? 'heatnow-check' : 'notice-warn'}>{check.ok ? '✓ ' : ''}{check.t}</div>
      )}

      {open.length > 0 && (
        <div className="heatnow-list">
          {open.map((r) => (
            <div key={r.id}>
              <span className="heatnow-flame" aria-hidden>●</span>
              <strong>{r.name}</strong>
              <span className="muted"> · {since[r.id] === undefined ? '' : since[r.id] === null ? 'seit über 24 h offen' : `offen seit ${fmtTime(since[r.id])}`}</span>
            </div>
          ))}
        </div>
      )}

      {today?.heat_kwh != null && (
        <div className="heatnow-foot muted small">
          Heute {kwh(today.heat_kwh)} Heizstrom: Sonne {kwh(today.heat_pv_kwh)} · Akku {kwh(today.heat_bat_kwh)} · Netz {kwh(today.heat_grid_kwh)}.
          {' '}Die Wärmepumpe wird nicht gemessen – Schätzung aus Verbrauch − Auto − Grundlast {fmtW(base)} (Einstellung „Grundlast Haus“).
        </div>
      )}
    </section>
  );
}
