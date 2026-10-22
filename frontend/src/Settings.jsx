import { useState } from 'react';
import { supabase } from './supabase.js';

const HOUSE_FIELDS = [
  { group: 'Zeiten', fields: [
    { k: 'night_start', l: 'Nacht ab', type: 'time' },
    { k: 'night_end', l: 'Nacht bis', type: 'time' },
    { k: 'evening_start', l: 'Abend-Schutz ab', type: 'time' },
  ] },
  { group: 'PV-Überschuss', fields: [
    { k: 'surplus_on_w', l: 'PV-Laden ein ab', unit: 'W', step: 100 },
    { k: 'surplus_off_w', l: 'PV-Laden aus unter', unit: 'W', step: 100 },
    { k: 'pv_min_soc', l: 'Batterieladung zählt ab', unit: '% SoC', step: 5 },
    { k: 'hold_minutes', l: 'Mindestdauer je Modus', unit: 'min', step: 5 },
    { k: 'average_minutes', l: 'Glättung der Messwerte', unit: 'min', step: 1 },
  ] },
  { group: 'Batterie', fields: [
    { k: 'reserve_soc', l: 'Abendreserve', unit: '% SoC', step: 5 },
    { k: 'full_soc', l: '„Voll“ ab', unit: '% SoC', step: 1 },
    { k: 'full_export_w', l: 'und Einspeisung ab', unit: 'W', step: 500 },
  ] },
];

const ROOM_FIELDS = [
  { k: 'temp_night', l: 'Nacht / Abend-Schutz' },
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
