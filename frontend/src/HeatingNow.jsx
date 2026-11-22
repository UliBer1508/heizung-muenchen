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

// 22.11.2026 (Uli: „Warum gibt es nicht Woche, Monat, Jahr?“): Heizstrom auch für die laufende Woche, den Monat und
// das Jahr – Tageswerte bis gestern (muc_heizstrom_seit, migration-015) plus heute live (muc_day_kpis).
const ZR = [['heute', 'Heute'], ['woche', 'Woche'], ['monat', 'Monat'], ['jahr', 'Jahr']];
function zrBeginn(z) {
  const t = todayBerlin();
  if (z === 'monat') return `${t.slice(0, 8)}01`;
  if (z === 'jahr') return `${t.slice(0, 5)}01-01`;
  const d = new Date(`${t}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}
const dmy = (iso) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}.`;
function useHeatPeriod(z, today) {
  const [k, setK] = useState(null);
  const von = z === 'heute' ? null : zrBeginn(z);
  useEffect(() => {
    let alive = true;
    if (!von) { setK(null); return undefined; }
    setK(undefined);
    supabase.rpc('muc_heizstrom_seit', { p_von: von }).then(({ data, error }) => {
      if (alive) setK(error ? { fehler: error.message } : data);
    });
    return () => { alive = false; };
  }, [von]);
  if (!von) return { von: null, w: today, tage: 1 };
  if (!k || k.fehler) return { von, w: null, fehler: k?.fehler, tage: 0 };
  const add = (f) => Number(k[f] ?? 0) + Number(today?.[f] ?? 0);
  return {
    von, tage: Number(k.tage ?? 0) + (today ? 1 : 0), ab: k.von,
    w: { heat_kwh: add('heat_kwh'), heat_pv_kwh: add('heat_pv_kwh'), heat_bat_kwh: add('heat_bat_kwh'), heat_grid_kwh: add('heat_grid_kwh') },
  };
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
  const [zr, setZr] = useState('heute');
  const per = useHeatPeriod(zr, today);
  const zrName = { heute: 'heute', woche: 'diese Woche', monat: 'diesen Monat', jahr: 'dieses Jahr' }[zr];
  const zrSeit = zr === 'heute' ? 'seit 0:00'
    : per.ab ? `seit ${dmy(per.ab)}${per.ab > per.von ? ` (Daten erst ab ${dmy(per.ab)})` : ''} · ${per.tage} ${per.tage === 1 ? 'Tag' : 'Tage'}`
      : `seit ${dmy(per.von)}`;

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
          <div className="eyebrow">Heizstrom {zrName}</div>
          <div className="tile-value">{per.fehler ? '–' : kwh(per.w?.heat_kwh)}</div>
          <div className="muted small">{per.fehler ? 'Bitte supabase/migration-015-wo-stehen-wir.sql ausführen.' : `geschätzt, ${zrSeit}`}</div>
          <div className="seg seg-4 heat-zr" role="group" aria-label="Zeitraum Heizstrom">
            {ZR.map(([k, l]) => (
              <button key={k} type="button" className={zr === k ? 'seg-btn active' : 'seg-btn'} aria-pressed={zr === k} onClick={() => setZr(k)}>{l}</button>
            ))}
          </div>
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

      {per.w?.heat_kwh != null && (
        <div className="heatnow-foot muted small">
          {zr === 'heute' ? 'Heute' : `${zrName[0].toUpperCase()}${zrName.slice(1)}`} {kwh(per.w.heat_kwh)} Heizstrom: Sonne {kwh(per.w.heat_pv_kwh)} · Akku {kwh(per.w.heat_bat_kwh)} · Netz {kwh(per.w.heat_grid_kwh)}.
          {zr !== 'heute' && ' Tage bis gestern aus den gespeicherten Tageswerten, heute live.'}
          {' '}Die Wärmepumpe wird nicht gemessen – Schätzung aus Verbrauch − Auto − Grundlast {fmtW(base)} (Einstellung „Grundlast Haus“).
        </div>
      )}
    </section>
  );
}
