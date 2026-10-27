import { useState } from 'react';
import { supabase } from './supabase.js';
import { PRIO_LABEL } from './lib.js';

const HOUSE_FIELDS = [
  { group: 'Tagesablauf', fields: [
    { k: 'morning_start', l: 'Morgen ab (Aufstehen)', type: 'time' },
    { k: 'morning_end', l: 'Morgen bis', type: 'time' },
    { k: 'evening_start', l: 'Abend ab', type: 'time' },
    { k: 'night_start', l: 'Nacht ab', type: 'time' },
  ] },
  { group: 'PV-Überschuss (Stufen)', fields: [
    { k: 'surplus_on_w', l: 'Stufe 1 ein ab Überschuss', unit: 'W', step: 100 },
    { k: 'stage_up_w', l: 'Nächste Stufe, wenn noch übrig', unit: 'W', step: 100 },
    { k: 'surplus_off_w', l: 'Stufe zurück, wenn weniger übrig', unit: 'W', step: 100 },
    { k: 'pv_min_soc', l: 'Batterieladung zählt ab', unit: '% SoC', step: 5 },
    { k: 'hold_minutes', l: 'Mindestdauer je Stufe', unit: 'min', step: 5 },
    { k: 'average_minutes', l: 'Glättung der Messwerte', unit: 'min', step: 1 },
  ] },
  { group: 'Batterie', fields: [
    { k: 'reserve_soc', l: 'Abends heizen nur ab Akku', unit: '% SoC', step: 5 },
    { k: 'full_soc', l: '„Voll“ ab', unit: '% SoC', step: 1 },
    { k: 'full_export_w', l: 'und Einspeisung ab', unit: 'W', step: 500 },
  ] },
  { group: 'Analyse', fields: [
    { k: 'baseload_w', l: 'Grundlast Haus (ohne Heizung/Auto)', unit: 'W', step: 50 },
  ] },
];

const ROOM_FIELDS = [
  { k: 'temp_night', l: 'Absenk (Nacht / nicht heizen)' },
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

const PLAN_FLAGS = [
  { k: 'heat_morning', l: 'Morgens' },
  { k: 'heat_day', l: 'Tagsüber' },
  { k: 'heat_evening', l: 'Abends' },
];

function Heizplan({ rooms, reload, setMsg }) {
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
  const prio1 = plan.filter((r) => r.pv_prio === 1).length;
  const summary = `${plan.length} Räume · morgens ${count('heat_morning')} · tagsüber ${count('heat_day')} · abends ${count('heat_evening')} · PV Prio 1: ${prio1}`;
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
        <span className="section-title">Heizplan</span>
        <span className={`collapse-sum ${dirty ? 'warn-text' : ''}`}>{dirty ? 'Nicht gespeicherte Änderungen' : open ? '' : summary}</span>
        <span className={`collapse-chev ${open ? 'open' : ''}`} aria-hidden="true">▶</span>
      </button>
      {open && <>
      <div className="muted small">
        Haken = der Raum wird in dieser Tageszeit auf <strong>Normal</strong> gehalten, sonst auf seinem <strong>Absenkwert</strong>.
        Nachts sind alle Räume abgesenkt. <strong>PV-Priorität</strong>: Bei Überschuss laden zuerst die Räume mit Prio 1 den Estrich,
        bei mehr Überschuss Prio 2, dann Prio 3. „nie“ = dieser Raum wird nicht mit PV aufgeheizt.
      </div>
      <div className="plan-wrap">
        <table className="plan-table">
          <thead>
            <tr>
              <th>Raum</th>
              {PLAN_FLAGS.map((f) => <th key={f.k}>{f.l}</th>)}
              <th>PV-Priorität</th>
            </tr>
          </thead>
          <tbody>
            {plan.map((r) => (
              <tr key={r.id}>
                <td>{r.name}</td>
                {PLAN_FLAGS.map((f) => (
                  <td key={f.k} className="c">
                    <input type="checkbox" aria-label={`${r.name} ${f.l}`} checked={r[f.k]} onChange={(e) => set(r.id, f.k, e.target.checked)} />
                  </td>
                ))}
                <td className="c">
                  <select value={r.pv_prio} onChange={(e) => set(r.id, 'pv_prio', Number(e.target.value))} aria-label={`${r.name} PV-Priorität`}>
                    {[1, 2, 3, 0].map((p) => <option key={p} value={p}>{PRIO_LABEL[p]}</option>)}
                  </select>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <button className="btn primary" disabled={busy || !dirty} onClick={save}>{busy ? 'Speichert …' : 'Heizplan speichern'}</button>
      </>}
    </section>
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

      <section className="card">
        <div className="section-title">Betrieb</div>
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
      </section>

      {data.rooms.length > 0 && data.rooms[0].pv_prio === undefined ? (
        <div className="alert">Für den Heizplan bitte zuerst <strong>supabase/migration-005-raumprofile.sql</strong> in Supabase ausführen.</div>
      ) : (
        <Heizplan rooms={data.rooms} reload={reload} setMsg={setMsg} />
      )}

      <section className="card">
        <div className="section-title">Haus</div>
        {HOUSE_FIELDS.map((g) => (
          <div key={g.group} className="field-group">
            <div className="eyebrow">{g.group}</div>
            <div className="fields">
              {g.fields.map((f) => <Field key={f.k} f={f} value={s[f.k]} onChange={(v) => setS({ ...s, [f.k]: v })} />)}
            </div>
          </div>
        ))}
        <button className="btn primary" disabled={busy} onClick={() => saveHouse()}>Haus-Einstellungen speichern</button>
      </section>

      {rooms.map((r) => (
        <section key={r.id} className="card">
          <div className="section-title">{r.name}</div>
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
        </section>
      ))}
    </div>
  );
}
