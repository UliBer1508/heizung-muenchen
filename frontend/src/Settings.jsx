import { useEffect, useState } from 'react';
import { supabase } from './supabase.js';
import { Klappkarte } from './Klapp.jsx';
import Datensicherung from './Datensicherung.jsx';

const HOUSE_FIELDS = [
  { group: 'Tagesablauf', fields: [
    { k: 'morning_start', l: 'Morgen ab (Aufstehen)', type: 'time' },
    { k: 'morning_end', l: 'Morgen bis', type: 'time' },
    { k: 'evening_start', l: 'Abend ab', type: 'time' },
    { k: 'night_start', l: 'Nacht ab', type: 'time' },
  ] },
  { group: 'Mit PV-Überschuss (Modell a)', fields: [
    { k: 'surplus_on_w', l: 'Überschuss-Heizen ein ab', unit: 'W', step: 100 },
    { k: 'stage_up_w', l: 'Je so viel übrig: ein Raum mehr', unit: 'W', step: 100 },
    { k: 'surplus_off_w', l: 'Ein Raum weniger, wenn weniger übrig', unit: 'W', step: 100 },
    { k: 'pv_min_soc', l: 'Batterieladung zählt ab', unit: '% SoC', step: 5 },
    { k: 'hold_minutes', l: 'Mindestdauer je Änderung', unit: 'min', step: 5 },
    { k: 'average_minutes', l: 'Glättung der Messwerte', unit: 'min', step: 1 },
  ] },
  { group: 'Ohne PV-Überschuss (Modell b)', fields: [
    { k: 'max_grid_circuits', l: 'Netzgrenze: Kreise gleichzeitig', unit: 'Kreise', step: 1 },
    { k: 'wait_min_kwh', l: 'Wartetag ab erwartetem Überschuss (0 = nie)', unit: 'kWh', step: 1 },
    { k: 'wait_boost_min', l: 'Wer so lange wartet, ist zuerst dran', unit: 'min', step: 15 },
  ] },
  { group: 'Batterie', fields: [
    { k: 'battery_kwh', l: 'Akku-Kapazität', unit: 'kWh', step: 1 },
    { k: 'full_soc', l: '„Voll“ ab', unit: '% SoC', step: 1 },
    { k: 'full_export_w', l: 'und Einspeisung ab', unit: 'W', step: 500 },
  ] },
  { group: 'Analyse', fields: [
    { k: 'baseload_w', l: 'Grundlast Haus (ohne Heizung/Auto)', unit: 'W', step: 50 },
  ] },
];

const ROOM_FIELDS = [
  { k: 'temp_night', l: 'Untergrenze (nachts, abends, Wartetag)' },
  { k: 'temp_normal', l: 'Normal' },
  { k: 'temp_pv', l: 'PV-Laden' },
  { k: 'temp_full', l: 'Batterie voll' },
];

function Field({ f, value, onChange }) {
  return (
    <label className="field">
      <span>{f.l}</span>
      <span className="field-input">
        <input
          type={f.type || 'number'}
          step={f.step}
          value={value ?? ''}
          onChange={(e) => onChange(f.type === 'time' ? e.target.value : e.target.value === '' ? null : Number(e.target.value))}
        />
        {f.unit && <span className="unit">{f.unit}</span>}
      </span>
    </label>
  );
}

// Abends gilt seit 0.11 dasselbe wie nachts (Untergrenze) – deshalb nur noch morgens und tagsüber.
const PLAN_FLAGS = [
  { k: 'heat_morning', l: 'Morgens', from: 'morning_start', to: 'morning_end' },
  { k: 'heat_day', l: 'Tagsüber', from: 'morning_end', to: 'evening_start' },
];

const deg = (v) => (v == null ? '–' : `${Number(v).toLocaleString('de-DE', { maximumFractionDigits: 1 })} °C`);
const hh = (t) => (t ? String(t).slice(0, 5).replace(/^0/, '').replace(':00', '') : '?');

function Heizplan({ rooms, settings, reload, setMsg }) {
  const temps = Object.fromEntries(rooms.map((r) => [r.id, r]));
  const [plan, setPlan] = useState(() => rooms.map((r) => ({
    id: r.id, name: r.name, heat_morning: !!r.heat_morning, heat_day: !!r.heat_day,
    heat_evening: !!r.heat_evening, pv_prio: r.pv_prio ?? 2,
  })));
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [open, setOpen] = useState(() => {
    try { return localStorage.getItem('plan-open') === '1'; } catch { return false; }
  });
  const toggle = () => setOpen((o) => {
    try { localStorage.setItem('plan-open', o ? '0' : '1'); } catch {}
    return !o;
  });
  const count = (k) => plan.filter((r) => r[k]).length;
  const pv = plan.filter((r) => r.pv_prio > 0).length;
  const summary = `${plan.length} Räume · morgens ${count('heat_morning')} · tagsüber ${count('heat_day')} · mit PV laden ${pv}`;
  const set = (id, k, v) => { setPlan((p) => p.map((r) => (r.id === id ? { ...r, [k]: v } : r))); setDirty(true); };

  const save = async () => {
    setBusy(true);
    setMsg(null);
    for (const r of plan) {
      const { id, name, ...patch } = r;
      const { error } = await supabase.from('muc_rooms').update(patch).eq('id', id);
      if (error) { setMsg({ err: true, t: `${name}: ${error.message}` }); setBusy(false); return; }
    }
    setMsg({ t: 'Heizplan gespeichert. Der Collector übernimmt ihn innerhalb einer Minute.' });
    setDirty(false);
    await reload();
    setBusy(false);
  };

  return (
    <section className="card">
      <button type="button" className="collapse-head" onClick={toggle} aria-expanded={open}>
        <span className="section-title">Heizplan <span className="plan-sub">Raum-Sollwerte je Tageszeit</span></span>
        <span className={`collapse-sum ${dirty ? 'warn-text' : ''}`}>{dirty ? 'Nicht gespeicherte Änderungen' : open ? '' : summary}</span>
        <span className={`collapse-chev ${open ? 'open' : ''}`} aria-hidden="true">▶</span>
      </button>
      {open && <>
      <div className="notice-warn small">
        Die <strong>Wärmepumpe</strong> heizt nach ihrem eigenen Zeitprogramm. Dieser Plan legt fest, <strong>welche Räume</strong> dabei
        Wärme bekommen – über die Sollwerte der Loxone-Raumregler. Wann geheizt wird, ist erst steuerbar, wenn die Wärmepumpe am LAN hängt.
      </div>
      <div className="muted small plan-help">
        <strong>Haken</strong> = an einem Tag <strong>ohne PV-Überschuss</strong> in dieser Tageszeit auf <strong>Normal</strong>, nach Priorität,
        höchstens {settings.max_grid_circuits ?? 6} Kreise gleichzeitig (Netzgrenze). Ohne Haken hält der Raum seine <strong>Untergrenze</strong>.
        Abends ({hh(settings.evening_start)}–{hh(settings.night_start)} Uhr) und nachts gilt für alle Räume die Untergrenze, ebenso an einem
        <strong> Wartetag</strong> (laut Prognose kommt heute noch Überschuss).
        <strong> Mit Sonne</strong>: Bei PV-Überschuss werden die Räume nach Priorität auf ihren PV-Wert geheizt – so viele, wie der Überschuss trägt.
        Die Temperaturen stellst du unten je Raum ein.
      </div>
      <div className="plan-wrap">
        <table className="plan-table">
          <thead>
            <tr>
              <th>Raum</th>
              {PLAN_FLAGS.map((f) => (
                <th key={f.k}>{f.l}<div className="plan-time">{hh(settings[f.from])}–{hh(settings[f.to])} Uhr</div></th>
              ))}
              <th className="hide-sm">Mit Sonne<div className="plan-time">PV-Wert laden</div></th>
            </tr>
          </thead>
          <tbody>
            {plan.map((r) => {
              const t = temps[r.id] || {};
              const sun = (room, tt) => (
                <>
                  <select value={room.pv_prio > 0 ? 1 : 0} onChange={(e) => set(room.id, 'pv_prio', Number(e.target.value) > 0 ? Math.max(1, room.pv_prio || 1) : 0)} aria-label={`${room.name} mit PV laden`}>
                    <option value={1}>ja</option>
                    <option value={0}>nie</option>
                  </select>
                  <div className="plan-t on sun">{room.pv_prio > 0 ? <>{deg(tt.temp_pv)} · voll {deg(tt.temp_full)}</> : 'kein PV'}</div>
                </>
              );
              return (
                <tr key={r.id}>
                  <td>{r.name}<div className="show-sm plan-sun-sm">☀ {sun(r, t)}</div></td>
                  {PLAN_FLAGS.map((f) => (
                    <td key={f.k} className="c">
                      <label className="plan-cell">
                        <input type="checkbox" aria-label={`${r.name} ${f.l}`} checked={r[f.k]} onChange={(e) => set(r.id, f.k, e.target.checked)} />
                        <span className={r[f.k] ? 'plan-t on' : 'plan-t'}>{deg(r[f.k] ? t.temp_normal : t.temp_night)}</span>
                      </label>
                    </td>
                  ))}
                  <td className="c hide-sm">{sun(r, t)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <button className="btn primary" disabled={busy || !dirty} onClick={save}>{busy ? 'Speichert …' : 'Heizplan speichern'}</button>
      </>}
    </section>
  );
}


// Raum-Prioritäten (ab 0.11 eine Priorität für beide Modelle): Prio 1, 2, 3, 4 – mehrere Räume je Prio
// (Spalte muc_rooms.priority). Mit Überschuss bekommen so viele Räume ihren PV-Wert, wie der Überschuss trägt,
// ohne Überschuss höchstens so viele wie die Netzgrenze – jeweils Prio 1 zuerst. Wer keinen Kreis bekommt,
// wartet mit Ventil zu. Jeder Heizlauf wird gemessen.
const PRIOS = [1, 2, 3, 4];

function Reihenfolge({ data, settings, reload, setMsg }) {
  const rooms = data.rooms.filter((r) => r.enabled);
  const [prio, setPrio] = useState(() => Object.fromEntries(rooms.map((r) => [r.id, r.priority ?? 2])));
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [rates, setRates] = useState({});
  const [open, setOpen] = useState(() => {
    try { return localStorage.getItem('seq-open') !== '0'; } catch { return true; }
  });
  const toggle = () => setOpen((o) => {
    try { localStorage.setItem('seq-open', o ? '0' : '1'); } catch {}
    return !o;
  });
  useEffect(() => {
    supabase.from('muc_heat_rate').select('*').then(({ data: rows }) => {
      if (rows) setRates(Object.fromEntries(rows.map((x) => [x.room_id, x])));
    });
  }, [data.loadedAt]);
  // Neue Werte aus der Datenbank übernehmen, solange nichts ungespeichert ist
  useEffect(() => {
    if (!dirty) setPrio(Object.fromEntries(rooms.map((r) => [r.id, r.priority ?? 2])));
  }, [data.loadedAt]); // eslint-disable-line react-hooks/exhaustive-deps

  const set = (id, v) => { setPrio((p) => ({ ...p, [id]: v })); setDirty(true); };
  const save = async () => {
    setBusy(true);
    setMsg(null);
    for (const r of rooms) {
      if (prio[r.id] === r.priority) continue;
      const { error } = await supabase.from('muc_rooms').update({ priority: prio[r.id] }).eq('id', r.id);
      if (error) { setMsg({ err: true, t: `${r.name}: ${error.message}` }); setBusy(false); return; }
    }
    setMsg({ t: 'Prioritäten gespeichert. Der Collector übernimmt sie innerhalb einer Minute.' });
    setDirty(false);
    await reload();
    setBusy(false);
  };

  const live = data.latestByRoom || {};
  const num = (v) => (v == null ? '–' : `${Number(v).toLocaleString('de-DE', { maximumFractionDigits: 1 })} °C`);
  const dur = (min) => (min < 60 ? `${Math.round(min)} min` : `${Math.floor(min / 60)} h ${String(Math.round(min % 60)).padStart(2, '0')} min`);
  const summary = PRIOS.map((p) => `Prio ${p}: ${rooms.filter((r) => prio[r.id] === p).length}`).join(' · ');
  return (
    <section className="card">
      <button type="button" className="collapse-head" onClick={toggle} aria-expanded={open}>
        <span className="section-title">Raum-Prioritäten <span className="plan-sub">welche Räume zuerst warm werden</span></span>
        <span className={`collapse-sum ${dirty ? 'warn-text' : ''}`}>{dirty ? 'Nicht gespeicherte Änderungen' : open ? '' : summary}</span>
        <span className={`collapse-chev ${open ? 'open' : ''}`} aria-hidden="true">▶</span>
      </button>
      {open && <>
      <div className="muted small plan-help">
        Gilt mit und ohne Sonne. <strong>Mit PV-Überschuss</strong> bekommen so viele Räume ihren PV-Wert, wie der Überschuss trägt –
        Prio 1 zuerst, alle Räume einer Prio gemeinsam, die nächste Prio, sobald genug übrig ist.
        <strong> Ohne Überschuss</strong> heizen höchstens {settings.max_grid_circuits ?? 6} Kreise gleichzeitig (Netzgrenze), ebenfalls Prio 1 zuerst.
        Wer keinen Kreis bekommt, wartet mit Ventil zu; wer länger als {settings.wait_boost_min ?? 60} min wartet, ist zuerst dran.
        Räume unter ihrer Untergrenze gehen immer vor.
      </div>
      {data.status?.sequence_info && <div className="notice small">Jetzt: {data.status.sequence_info}</div>}
      {PRIOS.map((p) => {
        const list = rooms.filter((r) => prio[r.id] === p);
        return (
          <div key={p} className="prio-group">
            <div className="eyebrow">Prio {p}{p === 1 ? ' – zuerst' : ''}</div>
            {list.length === 0 && <div className="muted small">kein Raum</div>}
            {list.map((r) => {
              const rr = live[r.id];
              const rt = rates[r.id];
              const rate = rt?.rate_c_per_h != null ? Number(rt.rate_c_per_h) : null;
              return (
                <div key={r.id} className="seq-row">
                  <span className="seq-name">
                    {r.name}
                    {rr && <span className="muted small"> · {num(rr.temp)} → {num(rr.target)}{rr.mode === 'WARTET' ? ' · wartet' : ''}</span>}
                    <div className="muted small">
                      {rate ? <>1 °C in ca. {dur(60 / rate)} · {rt.source === 'gemessen' ? `gemessen (${rt.runs} Läufe)` : 'Startwert aus Verlauf'}</> : 'Aufheizzeit noch unbekannt'}
                    </div>
                  </span>
                  <select value={prio[r.id]} onChange={(e) => set(r.id, Number(e.target.value))} aria-label={`${r.name} Priorität`}>
                    {PRIOS.map((q) => <option key={q} value={q}>Prio {q}</option>)}
                  </select>
                </div>
              );
            })}
          </div>
        );
      })}
      <button className="btn primary" disabled={busy || !dirty} onClick={save}>{busy ? 'Speichert …' : 'Prioritäten speichern'}</button>
      </>}
    </section>
  );
}

// Strompreis (12.11.2026, migration-013): Grundlage der Netzkosten in Analyse › Woche/Monat/Jahr.
// Jede Zeile gilt ab ihrem Datum bis zur nächsten. Werte brutto von der Stromrechnung.
function Strompreis({ setMsg }) {
  const [rows, setRows] = useState(null);
  const [err, setErr] = useState(null);
  const [neu, setNeu] = useState({ valid_from: '', grid_ct: '', base_eur_year: '', feed_ct: '', note: '' });
  const [busy, setBusy] = useState(false);
  const load = async () => {
    const { data, error } = await supabase.from('muc_prices').select('*').order('valid_from', { ascending: false });
    setErr(error?.message ?? null); setRows(data || []);
  };
  useEffect(() => { load(); }, []);
  const zahl = (v) => (v === '' || v == null ? null : Number(String(v).replace(',', '.')));
  const speichern = async () => {
    const z = { valid_from: neu.valid_from, grid_ct: zahl(neu.grid_ct), base_eur_year: zahl(neu.base_eur_year) ?? 0, feed_ct: zahl(neu.feed_ct) ?? 0, note: neu.note || null };
    if (!z.valid_from || z.grid_ct == null || !(z.grid_ct > 0 && z.grid_ct < 200)) { setMsg({ err: true, t: 'Bitte „gültig ab“ und einen Arbeitspreis zwischen 0 und 200 ct/kWh eingeben.' }); return; }
    setBusy(true);
    const { error } = await supabase.from('muc_prices').upsert(z, { onConflict: 'valid_from' });
    setMsg(error ? { err: true, t: error.message } : { t: `Strompreis ab ${z.valid_from} gespeichert.` });
    if (!error) setNeu({ valid_from: '', grid_ct: '', base_eur_year: '', feed_ct: '', note: '' });
    await load(); setBusy(false);
  };
  const loeschen = async (r) => {
    if (!window.confirm(`Strompreis ab ${r.valid_from} löschen?`)) return;
    const { error } = await supabase.from('muc_prices').delete().eq('id', r.id);
    if (error) setMsg({ err: true, t: error.message });
    await load();
  };
  const fmt = (v, d = 2) => (v == null ? '–' : Number(v).toLocaleString('de-DE', { minimumFractionDigits: d, maximumFractionDigits: 4 }));
  const aktuell = rows?.[0];
  return (
    <Klappkarte id="einstellungen-strompreis" titel="Strompreis" sub="für die Netzkosten in der Analyse"
      sum={aktuell ? `ab ${aktuell.valid_from}: ${fmt(aktuell.grid_ct)} ct/kWh` : 'noch kein Preis'} standardAuf={false}>
      {err && /muc_prices/.test(err) ? (
        <div className="alert">Bitte zuerst <strong>supabase/migration-013-strompreis.sql</strong> in Supabase ausführen.</div>
      ) : (
        <>
          <p className="muted small">Werte brutto (inkl. USt.) von der Stromrechnung. Arbeitspreis = alles, was je bezogener kWh anfällt (Energie, Netz, Abgaben). Grundpreis = Grund- und Messentgelte je Jahr. Ein Preis gilt ab seinem Datum bis zum nächsten.</p>
          {rows && rows.length > 0 && (
            <table className="ptable">
              <thead><tr><th>gültig ab</th><th>Arbeitspreis</th><th>Grundpreis</th><th>Einspeisung</th><th>Notiz</th><th></th></tr></thead>
              <tbody>{rows.map((r) => (
                <tr key={r.id}><td>{r.valid_from}</td><td>{fmt(r.grid_ct)} ct/kWh</td><td>{fmt(r.base_eur_year)} €/Jahr</td><td>{fmt(r.feed_ct)} ct/kWh</td><td className="muted small">{r.note || ''}</td>
                  <td><button className="btn ghost small" onClick={() => loeschen(r)}>Löschen</button></td></tr>
              ))}</tbody>
            </table>
          )}
          <div className="fields">
            <label className="field"><span>gültig ab</span><span className="field-input"><input type="date" value={neu.valid_from} onChange={(e) => setNeu({ ...neu, valid_from: e.target.value })} /></span></label>
            <label className="field"><span>Arbeitspreis brutto (ct/kWh)</span><span className="field-input"><input inputMode="decimal" value={neu.grid_ct} onChange={(e) => setNeu({ ...neu, grid_ct: e.target.value })} /></span></label>
            <label className="field"><span>Grundpreis brutto (€/Jahr)</span><span className="field-input"><input inputMode="decimal" value={neu.base_eur_year} onChange={(e) => setNeu({ ...neu, base_eur_year: e.target.value })} /></span></label>
            <label className="field"><span>Einspeisevergütung (ct/kWh)</span><span className="field-input"><input inputMode="decimal" value={neu.feed_ct} onChange={(e) => setNeu({ ...neu, feed_ct: e.target.value })} /></span></label>
            <label className="field"><span>Notiz (z. B. Tarif)</span><span className="field-input"><input value={neu.note} onChange={(e) => setNeu({ ...neu, note: e.target.value })} /></span></label>
          </div>
          <button className="btn primary" disabled={busy} onClick={speichern}>Strompreis speichern</button>
        </>
      )}
    </Klappkarte>
  );
}

export default function Settings({ data, reload }) {
  const [s, setS] = useState(data.settings);
  const [rooms, setRooms] = useState(data.rooms);
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);

  const saveHouse = async (patch = null) => {
    setBusy(true);
    setMsg(null);
    const { id, updated_at, ...rest } = patch ? { ...s, ...patch } : s;
    const { error } = await supabase.from('muc_settings').update(rest).eq('id', 1);
    if (error) setMsg({ err: true, t: error.message });
    else {
      if (patch) setS((x) => ({ ...x, ...patch }));
      setMsg({ t: 'Gespeichert. Der Collector übernimmt es innerhalb einer Minute.' });
    }
    await reload();
    setBusy(false);
  };

  const saveRoom = async (room) => {
    setBusy(true);
    setMsg(null);
    const patch = Object.fromEntries(ROOM_FIELDS.map((f) => [f.k, room[f.k]]));
    const bad = Object.values(patch).some((v) => v == null || v < 5 || v > 26);
    if (bad) {
      setMsg({ err: true, t: 'Temperaturen müssen zwischen 5 und 26 °C liegen.' });
      setBusy(false);
      return;
    }
    const { error } = await supabase.from('muc_rooms').update({ ...patch, enabled: room.enabled }).eq('id', room.id);
    setMsg(error ? { err: true, t: error.message } : { t: `${room.name} gespeichert.` });
    await reload();
    setBusy(false);
  };

  const setRoom = (id, k, v) => setRooms((rs) => rs.map((r) => (r.id === id ? { ...r, [k]: v } : r)));

  return (
    <div className="stack">
      {msg && <div className={msg.err ? 'alert' : 'notice'}>{msg.t}</div>}

      <Klappkarte id="einstellungen-betrieb" titel="Betrieb" sum={`Testmodus ${s.dry_run ? 'an' : 'aus'} · Automatik ${s.automation_enabled ? 'an' : 'aus'}`}>
        <div className="switch-row">
          <div>
            <div><strong>Testmodus</strong></div>
            <div className="muted small">Im Testmodus entscheidet die App und protokolliert, schreibt aber nichts nach Loxone.</div>
          </div>
          <button className={`toggle ${s.dry_run ? 'on' : ''}`} disabled={busy} onClick={() => {
            if (s.dry_run && !window.confirm('Testmodus beenden? Die App setzt danach die Sollwerte in Loxone.')) return;
            saveHouse({ dry_run: !s.dry_run });
          }}>{s.dry_run ? 'An' : 'Aus'}</button>
        </div>
        <div className="switch-row">
          <div>
            <div><strong>Automatik</strong></div>
            <div className="muted small">Aus: Die App misst nur noch und ändert keine Sollwerte.</div>
          </div>
          <button className={`toggle ${s.automation_enabled ? 'on' : ''}`} disabled={busy} onClick={() => saveHouse({ automation_enabled: !s.automation_enabled })}>
            {s.automation_enabled ? 'An' : 'Aus'}
          </button>
        </div>
      </Klappkarte>

      {data.rooms.length > 0 && data.rooms[0].pv_prio === undefined ? (
        <div className="alert">Für den Heizplan bitte zuerst <strong>supabase/migration-005-raumprofile.sql</strong> in Supabase ausführen.</div>
      ) : (
        <Heizplan rooms={data.rooms} settings={s} reload={reload} setMsg={setMsg} />
      )}

      {data.rooms.length > 0 && data.rooms[0].priority === undefined ? (
        <div className="alert">Für die Raum-Prioritäten bitte zuerst <strong>supabase/migration-011-prio-gruppen.sql</strong> in Supabase ausführen.</div>
      ) : (
        <Reihenfolge data={data} settings={data.settings} reload={reload} setMsg={setMsg} />
      )}

      <Klappkarte id="einstellungen-haus" titel="Haus" sub="Tagesablauf, PV, Netz, Batterie" standardAuf={false}>
        {HOUSE_FIELDS.map((g) => (
          <div key={g.group} className="field-group">
            <div className="eyebrow">{g.group}</div>
            <div className="fields">
              {g.fields.map((f) => <Field key={f.k} f={f} value={s[f.k]} onChange={(v) => setS({ ...s, [f.k]: v })} />)}
            </div>
          </div>
        ))}
        <button className="btn primary" disabled={busy} onClick={() => saveHouse()}>Haus-Einstellungen speichern</button>
      </Klappkarte>

      <Strompreis setMsg={setMsg} />

      <Datensicherung />

      {rooms.map((r) => (
        <Klappkarte key={r.id} id={`einstellungen-raum-${r.id}`} titel={r.name} standardAuf={false}
          sum={`${r.enabled ? 'gesteuert' : 'nicht gesteuert'}`}>
          <div className="eyebrow">Solltemperatur je Modus</div>
          <div className="fields">
            {ROOM_FIELDS.map((f) => (
              <Field key={f.k} f={{ ...f, unit: '°C', step: 0.5 }} value={r[f.k] == null ? null : Number(r[f.k])} onChange={(v) => setRoom(r.id, f.k, v)} />
            ))}
          </div>
          <label className="check">
            <input type="checkbox" checked={r.enabled} onChange={(e) => setRoom(r.id, 'enabled', e.target.checked)} />
            Raum wird von der App gesteuert
          </label>
          <div className="muted small mono">
            Loxone: Fühler „{r.loxone_temp_name || '–'}“ · Sollwert „{r.loxone_setpoint_name}“ · Ventil „{r.loxone_valve_name || '–'}“
          </div>
          <button className="btn primary" disabled={busy} onClick={() => saveRoom(r)}>{r.name} speichern</button>
        </Klappkarte>
      ))}
    </div>
  );
}
