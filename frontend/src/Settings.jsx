import { useState } from 'react';
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


// Heiz-Reihenfolge (ab 0.7): Rang 1 wird zuerst geheizt, die nächsten Räume warten mit
// Absenkwert (Ventil zu), bis die vorderen ihren Sollwert erreicht haben.
function toGroups(rooms) {
  const list = rooms.filter((r) => r.enabled)
    .sort((a, b) => (a.heat_rank ?? 999) - (b.heat_rank ?? 999) || (a.sort ?? 0) - (b.sort ?? 0));
  return list.map((r, i) => ({
    id: r.id, name: r.name,
    together: i > 0 && r.heat_rank != null && r.heat_rank === list[i - 1].heat_rank,
  }));
}
function ranksOf(list) {
  let rank = 0;
  return list.map((r, i) => { if (i === 0 || !r.together) rank += 1; return { ...r, rank }; });
}

function Reihenfolge({ data, settings, reload, setMsg }) {
  const [list, setList] = useState(() => toGroups(data.rooms));
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [open, setOpen] = useState(() => {
    try { return localStorage.getItem('seq-open') !== '0'; } catch { return true; }
  });
  const toggle = () => setOpen((o) => {
    try { localStorage.setItem('seq-open', o ? '0' : '1'); } catch {}
    return !o;
  });
  const ranked = ranksOf(list);
  const move = (i, d) => {
    const j = i + d;
    if (j < 0 || j >= list.length) return;
    const next = [...list];
    [next[i], next[j]] = [next[j], next[i]];
    next[0] = { ...next[0], together: false };
    setList(next);
    setDirty(true);
  };
  const setTogether = (i, v) => { setList((l) => l.map((r, k) => (k === i ? { ...r, together: v } : r))); setDirty(true); };

  const save = async () => {
    setBusy(true);
    setMsg(null);
    for (const r of ranked) {
      const { error } = await supabase.from('muc_rooms').update({ heat_rank: r.rank }).eq('id', r.id);
      if (error) { setMsg({ err: true, t: `${r.name}: ${error.message}` }); setBusy(false); return; }
    }
    setMsg({ t: 'Reihenfolge gespeichert. Der Collector übernimmt sie innerhalb einer Minute.' });
    setDirty(false);
    await reload();
    setBusy(false);
  };
  const setEnabled = async (v) => {
    setBusy(true);
    const { error } = await supabase.from('muc_settings').update({ sequence_enabled: v }).eq('id', 1);
    setMsg(error ? { err: true, t: error.message } : { t: v ? 'Heiz-Reihenfolge eingeschaltet.' : 'Heiz-Reihenfolge ausgeschaltet – alle Räume heizen gleichzeitig.' });
    await reload();
    setBusy(false);
  };

  const on = !!settings.sequence_enabled;
  const live = data.latestByRoom || {};
  const summary = on ? `An · ${ranked.length ? ranked[ranked.length - 1].rank : 0} Ränge` : 'Aus – alle Räume gleichzeitig';
  return (
    <section className="card">
      <button type="button" className="collapse-head" onClick={toggle} aria-expanded={open}>
        <span className="section-title">Heiz-Reihenfolge <span className="plan-sub">welcher Raum zuerst warm wird</span></span>
        <span className={`collapse-sum ${dirty ? 'warn-text' : ''}`}>{dirty ? 'Nicht gespeicherte Änderungen' : open ? '' : summary}</span>
        <span className={`collapse-chev ${open ? 'open' : ''}`} aria-hidden="true">▶</span>
      </button>
      {open && <>
      <div className="switch-row">
        <div>
          <div><strong>Nach Reihenfolge heizen</strong></div>
          <div className="muted small">
            Rang 1 bekommt die Wärme zuerst. Räume weiter unten bleiben auf ihrem Absenkwert (Ventil zu), bis alle Räume davor
            ihren Sollwert bis auf {String(settings.seq_on_delta ?? 0.3).replace('.', ',')} °C erreicht haben. Fertige Räume halten ihren Wert.
            Kommt ein Rang {settings.seq_max_minutes ?? 180} min lang nicht ans Ziel, darf zusätzlich der nächste.
          </div>
        </div>
        <button className={`toggle ${on ? 'on' : ''}`} disabled={busy} onClick={() => setEnabled(!on)}>{on ? 'An' : 'Aus'}</button>
      </div>
      {data.status?.sequence_info && <div className="notice small">Jetzt: {data.status.sequence_info}</div>}
      <ol className="seq-list">
        {ranked.map((r, i) => {
          const rr = live[r.id];
          return (
            <li key={r.id} className={r.together ? 'seq-row together' : 'seq-row'}>
              <span className="seq-rank">{r.together ? '' : r.rank}</span>
              <span className="seq-name">
                {r.name}
                {rr && <span className="muted small"> · {rr.temp != null ? `${Number(rr.temp).toLocaleString('de-DE', { maximumFractionDigits: 1 })} °C` : '–'} → {rr.target != null ? `${Number(rr.target).toLocaleString('de-DE')} °C` : '–'}{rr.mode === 'WARTET' ? ' · wartet' : ''}</span>}
              </span>
              {i > 0 && (
                <label className="seq-tog small" title="Gleicher Rang wie der Raum darüber – beide werden gemeinsam geheizt">
                  <input type="checkbox" checked={r.together} onChange={(e) => setTogether(i, e.target.checked)} /> mit oben
                </label>
              )}
              <span className="seq-btns">
                <button type="button" className="btn small" disabled={i === 0} onClick={() => move(i, -1)} aria-label={`${r.name} nach oben`}>▲</button>
                <button type="button" className="btn small" disabled={i === ranked.length - 1} onClick={() => move(i, 1)} aria-label={`${r.name} nach unten`}>▼</button>
              </span>
            </li>
          );
        })}
      </ol>
      <div className="muted small">„mit oben“ = gleicher Rang wie der Raum darüber, beide heizen gemeinsam. Nachts gilt weiter: alle Räume auf Absenk.</div>
      <button className="btn primary" disabled={busy || !dirty} onClick={save}>{busy ? 'Speichert …' : 'Reihenfolge speichern'}</button>
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
        <div className="alert">Für die Heiz-Reihenfolge bitte zuerst <strong>supabase/migration-008-reihenfolge.sql</strong> in Supabase ausführen.</div>
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
