// Heizung jetzt (München) – Gegenstück zur Karte „Heizung jetzt“ in Heizung Venediger (10.11.2026).
// 25.11.2026 (doc/HEIZUNG-JETZT-WIE-VENEDIGER-2026-11-25.md): gleicher Aufbau wie Venediger – drei Zahlen
// (Wärmepumpe · Kreise offen · Grenze), Prüfzeile mit Erklärung, „Woher kommt der Heizstrom?“ mit Zeitraum,
// Räume mit Begründung der Automatik, „Netzstrom sparen“. Uli 24.11.2026: beide Systeme sollen gleich sein.
// Unterschied: In München heizt eine Wärmepumpe über Wasser-FBH mit einem Ventil je Raum.
// Ein offener Kreis hat keine eigene Leistung, und die Wärmepumpe wird (noch) nicht gemessen.
// Darum: Kreise offen statt „laut Thermostaten“, Wärmepumpe GESCHÄTZT = Verbrauch − Auto − Grundlast
// (gleiche Formel wie muc_energy_rows / Analyse), Heizstrom heute aus muc_day_kpis.
// Nur lesend – keine Änderung an der Steuerung.
import { useEffect, useMemo, useState } from 'react';
import { supabase } from './supabase.js';
import { fmtW, fmtT, fmtTime, modeMeta } from './lib.js';

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
  const { energy: e, settings, rooms, latestByRoom, decisions } = data;
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

  // Wärmepumpe jetzt (geschätzt) – gleiche Rechnung wie muc_energy_rows
  const cons = e?.consumption_w ?? null;
  const car = e?.car_w ?? 0;
  const wp = cons == null ? null : Math.max(0, cons - car - base);
  const gridIn = Math.max(0, e?.grid_w ?? 0);
  const batW = e?.battery_w ?? null;   // + entladen / − laden
  const mitPv = (e?.pv_w ?? 0) > 30;

  // Begründung je offenem Kreis: letzte Entscheidung der Automatik (muc_decisions, kind 'write') der letzten 3 h
  const letzte = useMemo(() => {
    const m = {};
    const grenze = Date.now() - 3 * 3600e3;
    for (const d of decisions ?? []) {
      if (d.kind !== 'write' || !d.room_id || m[d.room_id] || new Date(d.ts).getTime() < grenze) continue;
      m[d.room_id] = d;
    }
    return m;
  }, [decisions]);
  const grund = (r) => {
    const rd = latestByRoom[r.id] ?? {};
    const ziel = rd.setpoint ?? rd.target;
    if (r.override_until && new Date(r.override_until).getTime() > Date.now())
      return { art: 'manuell', text: `Manuell bis ${fmtTime(r.override_until)}${r.override_temp != null ? ` (${fmtT(r.override_temp)})` : ''}` };
    const d = letzte[r.id];
    if (d && (d.mode === 'WARTET' || d.mode === 'AUS'))
      return { art: 'folgt_nicht', text: `Ventil offen, obwohl die Automatik um ${fmtTime(d.ts)} „${modeMeta(d.mode).label}“ geschrieben hat – folgt der Automatik (noch) nicht` };
    if (rd.temp != null && ziel != null && Number(rd.temp) >= Number(ziel))
      return { art: 'nachlauf', text: `Ziel ${fmtT(ziel)} erreicht, Kreis noch offen – Loxone schließt nach Raumregelung` };
    if (d?.reason) return { art: 'automatik', text: `${d.reason} (Befehl ${fmtTime(d.ts)})` };
    return { art: 'unbekannt', text: 'Keine Begründung der Automatik in den letzten 3 h' };
  };
  const gruende = Object.fromEntries(open.map((r) => [r.id, grund(r)]));

  // Prüfzeile – erklärt, statt zu fragen (wie erklaereAbweichung in Venediger)
  const messMs = e?.ts ? new Date(e.ts).getTime() : null;
  const alterMin = messMs ? Math.round((Date.now() - messMs) / 60e3) : null;
  const spaeter = open.filter((r) => since[r.id] && messMs && new Date(since[r.id]).getTime() > messMs);
  const zeitText = spaeter.length
    ? ` Gemessen wird nur alle paar Minuten (letzte Messung ${fmtTime(e.ts)}): ${spaeter.map((r) => `${r.name} ist erst seit ${fmtTime(since[r.id])} offen`).join(', ')} – zählt für den Vergleich noch nicht.`
    : '';
  const autoText = car > 50 ? `Auto lädt ${fmtW(car)}, ist schon abgezogen.` : 'Auto lädt nicht.';
  const nebenbei = [];
  if (car > 50) nebenbei.push(`Auto lädt ${fmtW(car)} (schon abgezogen)`);
  if (batW != null && batW < -100) nebenbei.push(`Batterie lädt ${fmtW(-batW)}`);
  if (batW != null && batW > 100) nebenbei.push(`Batterie gibt ${fmtW(batW)} ab`);
  const check = wp == null ? null
    : alterMin != null && alterMin > 7
      ? { ok: false, t: `Die letzte Energiemessung ist ${alterMin} min alt – kein Vergleich möglich. Läuft der Collector?` }
      : open.length === 0 && wp > 800
        ? { ok: false, t: `Kein Kreis offen, trotzdem ${fmtW(wp)} über der Grundlast. ${autoText} Wahrscheinlich Warmwasser der Wärmepumpe${mitPv ? '' : ' oder ein Gerät im Haus (Herd, Backofen)'}.` }
        : open.length > 0 && wp < 300
          ? { ok: true, t: `Kreise offen, die Wärmepumpe läuft gerade nicht – sie schaltet nach Vorlauftemperatur, das ist normal.${zeitText}` }
          : { ok: true, t: `${open.length ? 'Kreise offen und Wärmepumpe läuft – passt zusammen.' : 'Kein Kreis offen, Wärmepumpe aus.'}${zeitText}` };

  // Netzstrom sparen – nur Hinweise, ändert nichts
  const tipps = [];
  const nach = open.filter((r) => gruende[r.id]?.art === 'nachlauf');
  if (gridIn > 200 && nach.length)
    tipps.push(`${nach.map((r) => r.name).join(', ')} ${nach.length === 1 ? 'ist' : 'sind'} über dem Ziel und noch offen, während Strom aus dem Netz kommt. Ursache ist die Raumregelung in Loxone (Schaltdifferenz).`);
  const folgt = open.filter((r) => gruende[r.id]?.art === 'folgt_nicht');
  if (folgt.length)
    tipps.push(`${folgt.map((r) => r.name).join(', ')}: Ventil folgt der Automatik nicht. In Loxone prüfen, ob der Raum auf manuell steht.`);
  if (open.length > cap && !mitPv)
    tipps.push(`${open.length} Kreise offen, Netzgrenze ${cap} – ohne Sonne mehr Kreise als vorgesehen.`);

  const w = per.w;
  const parts = w ? [
    { ...SRC[0], v: Number(w.heat_pv_kwh ?? 0) },
    { ...SRC[1], v: Number(w.heat_bat_kwh ?? 0) },
    { ...SRC[2], v: Number(w.heat_grid_kwh ?? 0) },
  ] : [];

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
          <div className="tile-value">{open.length}</div>
          <div className="muted small">{open.length === 1 ? 'Ventil offen' : 'Ventile offen'} · ohne eigene Leistung</div>
        </div>
        <div>
          <div className="eyebrow">Grenze</div>
          <div className="tile-value">{cap} Kreise</div>
          <div className="muted small">ohne Sonne · mit Überschuss mehr · belegt {open.length}</div>
        </div>
      </div>

      {check && (
        <div className={check.ok ? 'heatnow-check' : 'notice-warn'}>{check.ok ? '✓ ' : '⚠ '}{check.t}{nebenbei.length ? ` ${nebenbei.join(' · ')}.` : ''}</div>
      )}

      <div className="heatnow-src">
        <div className="heatnow-src-head">
          <div>
            <div className="eyebrow">Woher kommt der Heizstrom?</div>
            <div className="heatnow-src-total">{per.fehler ? '–' : kwh(w?.heat_kwh)} <span className="muted small">{per.fehler ? 'Bitte supabase/migration-015-wo-stehen-wir.sql ausführen.' : `${zrName} · ${zrSeit}`}</span></div>
          </div>
          <div className="seg seg-4 heat-zr" role="group" aria-label="Zeitraum Heizstrom">
            {ZR.map(([k, l]) => (
              <button key={k} type="button" className={zr === k ? 'seg-btn active' : 'seg-btn'} aria-pressed={zr === k} onClick={() => setZr(k)}>{l}</button>
            ))}
          </div>
        </div>
        {w?.heat_kwh > 0 && <Bar parts={parts} unit={kwh} />}
      </div>

      {open.length > 0 && (
        <div className="heatnow-list">
          {open.map((r) => {
            const rd = latestByRoom[r.id] ?? {};
            const g = gruende[r.id];
            return (
              <div key={r.id}>
                <div>
                  <span className="heatnow-flame" aria-hidden>●</span>
                  <strong>{r.name}</strong>
                  <span className="muted">
                    {since[r.id] === undefined ? '' : since[r.id] === null ? ' · seit über 24 h offen' : ` · offen seit ${fmtTime(since[r.id])}`}
                    {rd.temp != null ? ` · ${fmtT(rd.temp)}` : ''}
                  </span>
                </div>
                <div className={`heatnow-why small ${g?.art === 'folgt_nicht' ? 'warn' : 'muted'}`}>{g?.text}</div>
              </div>
            );
          })}
        </div>
      )}

      {tipps.length > 0 && (
        <div className="notice-warn">
          <strong>Netzstrom sparen</strong>
          <ul className="heatnow-tipps">{tipps.map((t, i) => <li key={i}>{t}</li>)}</ul>
          <div className="small">Nur Hinweise – die Karte ändert keine Einstellung.</div>
        </div>
      )}

      {w?.heat_kwh != null && (
        <div className="heatnow-foot muted small">
          Herkunft anteilig aus Netzbezug, Batterie-Entladung und Sonne.
          {zr !== 'heute' && ' Tage bis gestern aus den gespeicherten Tageswerten, heute live.'}
          {' '}Die Wärmepumpe wird nicht gemessen – Schätzung aus Verbrauch − Auto − Grundlast {fmtW(base)} (Einstellung „Grundlast Haus“).
        </div>
      )}
    </section>
  );
}
