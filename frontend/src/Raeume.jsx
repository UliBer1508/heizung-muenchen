// Räume in den Einstellungen – Aufbau wie Heizung Venediger (src/components/settings/RoomsSection.tsx), Optik München.
// 25.11.2026 (Uli): Modell Venediger – nur noch drei Temperaturen je Raum:
//   Min    = temp_night  – nie darunter, Tag und Nacht (früher „Untergrenze“)
//   Normal = temp_normal – Ziel tagsüber, ohne Sonne auch aus dem Netz
//   PV-Max = temp_pv     – bis hierhin mit PV-Überschuss (Estrich als Speicher), auch bei voller Batterie nicht höher
// temp_full („Batterie voll“) wird weder angezeigt noch geschrieben; der Collector nutzt ihn ab 0.15 nicht mehr.
// Jede Karte speichert nur ihre eigenen, geänderten Felder (Min, Normal, PV-Max, gesteuert).
import { useEffect, useState } from 'react';
import { supabase } from './supabase.js';
import { Klappkarte } from './Klapp.jsx';

const TEMP_MIN = 5;
const TEMP_MAX = 26;

export const TEMPS = [
  { k: 'temp_night', l: 'Min', cls: 'min', hint: 'Darf nie unterschritten werden – Tag und Nacht' },
  { k: 'temp_normal', l: 'Normal', cls: 'normal', hint: 'Ziel tagsüber, ohne Sonne auch aus dem Netz' },
  { k: 'temp_pv', l: 'PV-Max', cls: 'pvmax', hint: 'Bis hierhin mit PV-Überschuss, der Estrich speichert' },
];

const deg = (v) => (v == null ? '–' : `${Number(v).toLocaleString('de-DE', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} °C`);
const zahl = (v) => (v === '' || v == null ? null : Number(String(v).replace(',', '.')));
const dur = (min) => (min < 60 ? `${Math.round(min)} min` : `${Math.floor(min / 60)} h ${String(Math.round(min % 60)).padStart(2, '0')} min`);

// Kleine Symbole wie in Venediger (Schild, Blatt, Sonne)
function Icon({ name }) {
  const p = { width: 14, height: 14, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true };
  if (name === 'min') return <svg {...p}><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" /></svg>;
  if (name === 'normal') return <svg {...p}><path d="M11 20A7 7 0 0 1 9.8 6.1C15.5 5 17 4.5 19 2c1 2 2 4.2 2 8 0 5.5-4.8 10-10 10Z" /><path d="M2 21c0-3 1.9-5.4 5.1-6" /></svg>;
  return <svg {...p}><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></svg>;
}

function pruefen(v) {
  const errs = [];
  for (const t of TEMPS) {
    const n = zahl(v[t.k]);
    if (n == null || Number.isNaN(n)) errs.push(`${t.l}: bitte einen Wert eintragen`);
    else if (n < TEMP_MIN || n > TEMP_MAX) errs.push(`${t.l}: zwischen ${TEMP_MIN} und ${TEMP_MAX} °C`);
  }
  if (!errs.length) {
    if (zahl(v.temp_night) > zahl(v.temp_normal)) errs.push('Min darf nicht wärmer sein als Normal');
    if (zahl(v.temp_normal) > zahl(v.temp_pv)) errs.push('Normal darf nicht wärmer sein als PV-Max');
  }
  return errs;
}

function RaumKarte({ room, live, rate, reload, setMsg }) {
  const [draft, setDraft] = useState({});
  const [errs, setErrs] = useState([]);
  const [busy, setBusy] = useState(false);
  const [technik, setTechnik] = useState(false);

  const wert = (k) => (k in draft ? draft[k] : room[k]);
  const set = (k, v) => { setDraft((d) => ({ ...d, [k]: v })); setErrs([]); };
  const gleich = (k) => (k === 'enabled' ? Boolean(draft[k]) === Boolean(room[k]) : zahl(draft[k]) === (room[k] == null ? null : Number(room[k])));
  const geaendert = Object.keys(draft).filter((k) => !gleich(k));

  const speichern = async () => {
    const merged = { ...room, ...draft };
    const e = pruefen(merged);
    if (e.length) { setErrs(e); return; }
    const patch = Object.fromEntries(geaendert.map((k) => [k, k === 'enabled' ? Boolean(draft[k]) : zahl(draft[k])]));
    setBusy(true);
    setMsg(null);
    const { error } = await supabase.from('muc_rooms').update(patch).eq('id', room.id);
    if (error) setMsg({ err: true, t: `${room.name}: ${error.message}` });
    else { setMsg({ t: `${room.name} gespeichert. Der Collector übernimmt es innerhalb einer Minute.` }); setDraft({}); }
    await reload();
    setBusy(false);
  };

  const gesteuert = Boolean(wert('enabled'));
  const pvJa = Number(room.pv_prio) > 0;
  const rateNum = rate?.rate_c_per_h != null ? Number(rate.rate_c_per_h) : null;

  return (
    <div className="rk">
      <div className="rk-kopf">
        <div className="rk-titel">
          <div className="rk-name">{room.name}</div>
          <div className="muted small">Jetzt {deg(live?.temp)} · Soll {deg(live?.target)}</div>
        </div>
        <div className="rk-badges">
          <span className="pill neutral" title="Heiz-Priorität (ändern unter „Raum-Prioritäten“)">P{room.priority ?? '–'}</span>
          {!gesteuert && <span className="pill sun">Automatik aus</span>}
          {pvJa ? <span className="pill green">PV laden</span> : <span className="pill neutral">kein PV</span>}
        </div>
      </div>

      <div>
        <div className="eyebrow">Temperaturen</div>
        <div className="rk-temps">
          {TEMPS.map((t) => (
            <label key={t.k} className="rk-temp">
              <span className={`rk-temp-l ${t.cls}`} title={t.hint}><Icon name={t.cls} />{t.l}</span>
              <span className="field-input">
                <input type="number" inputMode="decimal" step={0.5} min={TEMP_MIN} max={TEMP_MAX}
                  aria-label={`${t.l} ${room.name}`}
                  className={errs.length && zahl(wert(t.k)) == null ? 'err' : ''}
                  value={wert(t.k) == null ? '' : String(wert(t.k))}
                  onChange={(e) => set(t.k, e.target.value)} />
                <span className="unit">°C</span>
              </span>
            </label>
          ))}
        </div>
        <p className="muted small rk-hilfe">
          <strong>Min</strong> darf nie unterschritten werden, auch nachts. <strong>Normal</strong> ist das Ziel tagsüber.
          <strong> PV-Max</strong>: bis hierhin wird mit Sonnen-Überschuss geheizt (Estrich als Speicher).
        </p>
      </div>

      <div className="rk-box">
        <div className="rk-zeile">
          <div>
            <div className="small"><strong>Automatik</strong></div>
            <div className="muted small">Raum wird von der App gesteuert (Min, Normal, PV-Max)</div>
          </div>
          <button type="button" className={`toggle ${gesteuert ? 'on' : ''}`} aria-pressed={gesteuert}
            aria-label={`Automatik ${room.name}`} onClick={() => set('enabled', !gesteuert)}>{gesteuert ? 'An' : 'Aus'}</button>
        </div>
        {!gesteuert && (
          <div className="rk-zeile warn-text small">
            Automatik aus: Die App setzt für diesen Raum keine Sollwerte mehr – auch nicht, um Min zu halten. Loxone behält den letzten Sollwert.
          </div>
        )}
      </div>

      <div className="muted small rk-akku">
        {pvJa
          ? 'Mit Sonnen-Überschuss heizt dieser Raum höchstens bis PV-Max. Bei voller Batterie dürfen alle PV-Räume gleichzeitig auf PV-Max – höher nicht.'
          : 'Dieser Raum wird nie mit PV-Überschuss geladen (Heizplan › „Mit Sonne“: nie) – er hält Min bzw. Normal.'}
      </div>

      <button type="button" className="rk-technik-kopf" onClick={() => setTechnik((x) => !x)} aria-expanded={technik}>
        <span>Technik &amp; Lernwerte</span>
        <span className={`collapse-chev ${technik ? 'open' : ''}`} aria-hidden="true">▶</span>
      </button>
      {technik && (
        <div className="rk-technik muted small">
          <div className="mono">Loxone-Fühler „{room.loxone_temp_name || '–'}“</div>
          <div className="mono">Loxone-Sollwert „{room.loxone_setpoint_name || '–'}“</div>
          <div className="mono">Loxone-Ventil „{room.loxone_valve_name || '–'}“</div>
          <div>Aufheizen: {rateNum ? <>1 °C in ca. {dur(60 / rateNum)} · {rate.source === 'gemessen' ? `gemessen (${rate.runs} Läufe)` : 'Startwert aus Verlauf'}</> : 'noch unbekannt'}</div>
          <div>Priorität ändern: Abschnitt <strong>Raum-Prioritäten</strong>. Mit Sonne laden ja/nie: <strong>Heizplan</strong>.</div>
        </div>
      )}

      {errs.length > 0 && <div className="alert small">{errs.map((e) => <div key={e}>{e}</div>)}</div>}

      <div className="rk-aktion">
        <button className="btn primary" onClick={speichern} disabled={busy || geaendert.length === 0}>
          {busy ? 'Speichert …' : `${room.name} speichern`}
        </button>
        {geaendert.length > 0 && <button className="btn ghost" disabled={busy} onClick={() => { setDraft({}); setErrs([]); }}>Verwerfen</button>}
      </div>
    </div>
  );
}

export default function Raeume({ data, reload, setMsg }) {
  const [rates, setRates] = useState({});
  useEffect(() => {
    supabase.from('muc_heat_rate').select('*').then(({ data: rows }) => {
      if (rows) setRates(Object.fromEntries(rows.map((x) => [x.room_id, x])));
    });
  }, [data.loadedAt]);
  const live = data.latestByRoom || {};
  const aus = data.rooms.filter((r) => !r.enabled).length;
  return (
    <Klappkarte id="einstellungen-raeume" titel="Räume" sub="Min · Normal · PV-Max je Raum"
      sum={`${data.rooms.length} Räume${aus ? ` · ${aus} ohne Automatik` : ''}`}>
      <p className="muted small">Jede Karte speichert nur ihre eigenen Änderungen. Sollwert und Ist-Temperatur setzt weiterhin die Automatik.</p>
      <div className="rk-legende small">
        <div><span className="rk-temp-l min"><Icon name="min" />Min:</span> nie darunter – Tag und Nacht</div>
        <div><span className="rk-temp-l normal"><Icon name="normal" />Normal:</span> Ziel tagsüber, ohne Sonne auch aus dem Netz</div>
        <div><span className="rk-temp-l pvmax"><Icon name="pvmax" />PV-Max:</span> nur mit Sonnen-Überschuss, der Estrich speichert</div>
      </div>
      <div className="rk-grid">
        {data.rooms.map((r) => (
          <RaumKarte key={r.id} room={r} live={live[r.id]} rate={rates[r.id]} reload={reload} setMsg={setMsg} />
        ))}
      </div>
    </Klappkarte>
  );
}
