import { useEffect, useState } from 'react';
import { supabase } from './supabase.js';

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
  { k: 'heat_morning', l: 'Morgens', from: 'morning_start', to: 'morning_end' },
  { k: 'heat_day', l: 'Tagsüber', from: 'morning_end', to: 'evening_start' },
  { k: 'heat_evening', l: 'Abends', from: 'evening_start', to: 'night_start' },
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
        <strong>Haken</strong> = in dieser Tageszeit <strong>Normal</strong>, ohne Haken <strong>Absenk</strong>. Die Zahl zeigt den Sollwert, den der Raum dann bekommt.
        Abends nur, wenn der Akku ≥ {settings.reserve_soc ?? 60} % ist. Nachts ({hh(settings.night_start)}–{hh(settings.morning_start)} Uhr) sind alle Räume auf Absenk.
        <strong> Mit Sonne</strong>: Bei PV-Überschuss bekommt der Raum ab der gewählten Stufe seinen PV-Wert
        (Stufe 1 ab {((settings.surplus_on_w ?? 1500) / 1000).toLocaleString('de-DE')} kW, die nächste Stufe, wenn trotz Heizung noch genug übrig ist).
        Es gilt immer der <strong>höhere</strong> Wert. Die Temperaturen selbst stellst du unten je Raum ein.
      </div>
      <div className="plan-wrap">
        <table className="plan-table">
          <thead>
            <tr>
              <th>Raum</th>
              {PLAN_FLAGS.map((f) => (
                <th key={f.k}>{f.l}<div className="plan-time">{hh(settings[f.from])}–{hh(settings[f.to])} Uhr</div></th>
              ))}
              <th className="hide-sm">Mit Sonne<div className="plan-time">PV-Stufe</div></th>
            </tr>
          </thead>
          <tbody>
            {plan.map((r) => {
              const t = temps[r.id] || {};
              const sun = (room, tt) => (
                <>
                  <select value={room.pv_prio} onChange={(e) => set(room.id, 'pv_prio', Number(e.target.value))} aria-label={`${room.name} PV-Stufe`}>
                    {[1, 2, 3, 0].map((p) => <option key={p} value={p}>{p === 0 ? 'nie' : `ab Stufe ${p}`}</option>)}
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


// Heiz-Prioritäten (ab 0.7): Prio 1 wird zuerst geheizt. Räume mit höherer Prio warten bei der
// Temperatur, die sie gerade haben (Ventil zu), bis alle Räume davor ihren Sollwert erreicht haben.
const PRIOS = [1, 2, 3, 4];

function Reihenfolge({ data, settings, reload, setMsg }) {
  const rooms = data.rooms.filter((r) => r.enabled);
  const [prio, setPrio] = useState(() => Object.fromEntries(rooms.map((r) => [r.id, Math.min(4, r.heat_rank ?? 4)])));
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [open, setOpen] = useState(() => {
    try { return localStorage.getItem('seq-open') !== '0'; } catch { return true; }
  });
  const toggle = () => setOpen((o) => {
    try { localStorage.setItem('seq-open', o ? '0' : '1'); } catch {}
    return !o;
  });
  const set = (id, v) => { setPrio((p) => ({ ...p, [id]: v })); setDirty(true); };
  const [rates, setRates] = useState({});
  useEffect(() => {
    supabase.from('muc_heat_rate').select('*').then(({ data: rows }) => {
      if (rows) setRates(Object.fromEntries(rows.map((x) => [x.room_id, x])));
    });
  }, [data.loadedAt]);

  const save = async () => {
    setBusy(true);
    setMsg(null);
    for (const r of rooms) {
      const { error } = await supabase.from('muc_rooms').update({ heat_rank: prio[r.id] }).eq('id', r.id);
      if (error) { setMsg({ err: true, t: `${r.name}: ${error.message}` }); setBusy(false); return; }
    }
    setMsg({ t: 'Prioritäten gespeichert. Der Collector übernimmt sie innerhalb einer Minute.' });
    setDirty(false);
    await reload();
    setBusy(false);
  };
  const setMaxRooms = async (v) => {
    setBusy(true);
    const { error } = await supabase.from('muc_settings').update({ seq_max_rooms: v }).eq('id', 1);
    setMsg(error ? { err: true, t: error.message } : { t: v === 0 ? 'Alle Räume einer Prio heizen gemeinsam.' : `Höchstens ${v} ${v === 1 ? 'Raum' : 'Räume'} gleichzeitig.` });
    await reload();
    setBusy(false);
  };
  const setEnabled = async (v) => {
    setBusy(true);
    const { error } = await supabase.from('muc_settings').update({ sequence_enabled: v }).eq('id', 1);
    setMsg(error ? { err: true, t: error.message } : { t: v ? 'Heizen nach Priorität eingeschaltet.' : 'Heizen nach Priorität ausgeschaltet – alle Räume heizen gleichzeitig.' });
    await reload();
    setBusy(false);
  };

  const on = !!settings.sequence_enabled;
  const live = data.latestByRoom || {};
  const num = (v) => (v == null ? '–' : `${Number(v).toLocaleString('de-DE', { maximumFractionDigits: 1 })} °C`);
  const dur = (min) => (min < 60 ? `${Math.round(min)} min` : `${Math.floor(min / 60)} h ${String(Math.round(min % 60)).padStart(2, '0')} min`);
  const summary = on ? PRIOS.map((p) => `Prio ${p}: ${rooms.filter((r) => prio[r.id] === p).length}`).join(' · ') : 'Aus – alle Räume gleichzeitig';
  return (
    <section className="card">
      <button type="button" className="collapse-head" onClick={toggle} aria-expanded={open}>
        <span className="section-title">Raum-Prioritäten <span className="plan-sub">welche Räume zuerst warm werden</span></span>
        <span className={`collapse-sum ${dirty ? 'warn-text' : ''}`}>{dirty ? 'Nicht gespeicherte Änderungen' : open ? '' : summary}</span>
        <span className={`collapse-chev ${open ? 'open' : ''}`} aria-hidden="true">▶</span>
      </button>
      {open && <>
      <div className="switch-row">
        <div>
          <div><strong>Nach Priorität heizen</strong></div>
          <div className="muted small">
            Prio 1 wird zuerst geheizt, innerhalb einer Prio der Raum, der am schnellsten fertig ist. Wer nicht dran ist, ist in
            <strong>Warteposition</strong>: Er behält die Temperatur, die er gerade hat (Ventil zu). Ist ein Raum bis auf
            {' '}{String(settings.seq_on_delta ?? 0.3).replace('.', ',')} °C am Sollwert, kommt der nächste. Fertige Räume halten ihren Sollwert.
            Jeder Heizlauf wird gemessen – so lernt die App, wie lange jeder Raum für 1 °C braucht.
            Ändert sich {settings.seq_max_minutes ?? 180} min lang nichts, darf ein Raum mehr heizen.
          </div>
        </div>
        <button className={`toggle ${on ? 'on' : ''}`} disabled={busy} onClick={() => setEnabled(!on)}>{on ? 'An' : 'Aus'}</button>
      </div>
      <div className="switch-row">
        <div>
          <div><strong>Gleichzeitig heizen</strong></div>
          <div className="muted small">Wie viele Räume gleichzeitig Wärme bekommen. Mit 1 misst die App jeden Raum für sich am genauesten.</div>
        </div>
        <select value={settings.seq_max_rooms ?? 1} disabled={busy} onChange={(e) => setMaxRooms(Number(e.target.value))} aria-label="Räume gleichzeitig">
          {[1, 2, 3, 4].map((k) => <option key={k} value={k}>{k} {k === 1 ? 'Raum' : 'Räume'}</option>)}
          <option value={0}>ganze Prio</option>
        </select>
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
        <Heizplan rooms={data.rooms} settings={s} reload={reload} setMsg={setMsg} />
      )}

      {data.rooms.length > 0 && data.rooms[0].heat_rank === undefined ? (
        <div className="alert">Für die Raum-Prioritäten bitte zuerst <strong>supabase/migration-008-reihenfolge.sql</strong> in Supabase ausführen.</div>
      ) : (
        <Reihenfolge key={data.rooms.map((r) => `${r.id}:${r.heat_rank}:${r.enabled}`).join('|')} data={data} settings={data.settings} reload={reload} setMsg={setMsg} />
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
