// KI – alles zu Entscheidende an einem Platz (05.11.2026, nach dem Venediger-Vorbild „KI › Zu entscheiden“)
// Die KI misst und schlägt vor, geschrieben wird nur über muc_ki_decide() nach „Ja“.
import { useCallback, useEffect, useState } from 'react';
import { supabase } from './supabase.js';
import { fmtDateTime, fmtT, fmtTime } from './lib.js';

const num = (v, d = 1) => (v == null ? '–' : Number(v).toLocaleString('de-DE', { minimumFractionDigits: d, maximumFractionDigits: d }));
const PARAM = { temp_night: 'Absenk', temp_pv: 'PV-Laden' };
const STATUS = {
  genehmigt: { label: 'Übernommen', tone: 'green' },
  geaendert: { label: 'Mit eigenem Wert übernommen', tone: 'green' },
  abgelehnt: { label: 'Abgelehnt', tone: 'neutral' },
  erledigt: { label: 'Erledigt', tone: 'neutral' },
  veraltet: { label: 'Veraltet', tone: 'neutral' },
};

export function useKiOpen(intervalMs = 60000) {
  const [open, setOpen] = useState({ suggestions: 0, hints: [] });
  const load = useCallback(async () => {
    const { data, error } = await supabase.from('muc_ki_suggestions').select('id, kind, title').eq('status', 'offen');
    if (error || !data) return; // Migration 007 fehlt – kein Fehler in der App
    setOpen({
      suggestions: data.filter((d) => d.kind === 'vorschlag' || d.kind === 'ruecknahme').length,
      hints: data.filter((d) => d.kind === 'hinweis'),
    });
  }, []);
  useEffect(() => {
    load();
    const t = setInterval(load, intervalMs);
    return () => clearInterval(t);
  }, [load, intervalMs]);
  return { ...open, reload: load };
}

function Suggestion({ s, roomName, onDone }) {
  const [mode, setMode] = useState(null); // 'wert' | 'nein'
  const [value, setValue] = useState(s.new_value != null ? String(s.new_value).replace('.', ',') : '');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);

  const decide = async (action) => {
    setBusy(true);
    setMsg(null);
    const v = action === 'wert' ? Number(String(value).replace(',', '.')) : null;
    const { data, error } = await supabase.rpc('muc_ki_decide', { p_id: s.id, p_action: action, p_value: v, p_note: note || null });
    setBusy(false);
    if (error) { setMsg({ err: true, t: error.message }); return; }
    setMsg({ err: !data?.ok, t: data?.msg });
    if (data?.ok) setTimeout(onDone, 1200);
  };

  const isHint = s.kind === 'hinweis';
  return (
    <div className={`ki-item ${isHint ? 'tone-rose' : s.kind === 'ruecknahme' ? 'tone-sun' : 'tone-cool'}`}>
      <div className="ki-title">{s.title}</div>
      {s.what && (
        <div className="ki-row"><span className="ki-label">Was sich ändert</span><span>{s.what}</span></div>
      )}
      {s.why && (
        <div className="ki-row"><span className="ki-label">{isHint ? 'Was los ist' : 'Warum'}</span><span>{s.why}</span></div>
      )}
      {s.effect && (
        <div className="ki-row"><span className="ki-label">{isHint ? 'Was tun' : 'Was es bringt – und kostet'}</span><span>{s.effect}</span></div>
      )}
      {!isHint && s.days != null && (
        <div className="muted small">Grundlage: {s.days} {s.rule === 'absenk_fehlt' ? 'Nächte' : 'Tage'} · {roomName}</div>
      )}
      {isHint && <div className="muted small">seit {fmtDateTime(s.created_at)}</div>}

      {mode === 'wert' && (
        <div className="ki-input">
          <label>{PARAM[s.param]}
            <span className="field-input"><input inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value)} /><span className="unit">°C</span></span>
          </label>
        </div>
      )}
      {mode === 'nein' && !isHint && (
        <div className="ki-input">
          <label>Grund (optional)
            <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="z. B. im Bad bewusst gleich" />
          </label>
        </div>
      )}

      <div className="ki-actions">
        {isHint ? (
          <button className="btn small" disabled={busy} onClick={() => decide('nein')}>Gesehen, ausblenden</button>
        ) : mode === null ? (
          <>
            <button className="btn primary small" disabled={busy} onClick={() => decide('ja')}>Ja, übernehmen</button>
            <button className="btn small" disabled={busy} onClick={() => setMode('wert')}>Anderer Wert</button>
            <button className="btn ghost small" disabled={busy} onClick={() => setMode('nein')}>Nein</button>
          </>
        ) : mode === 'wert' ? (
          <>
            <button className="btn primary small" disabled={busy} onClick={() => decide('wert')}>Diesen Wert übernehmen</button>
            <button className="btn ghost small" disabled={busy} onClick={() => setMode(null)}>Abbrechen</button>
          </>
        ) : (
          <>
            <button className="btn primary small" disabled={busy} onClick={() => decide('nein')}>Ablehnen</button>
            <button className="btn ghost small" disabled={busy} onClick={() => setMode(null)}>Abbrechen</button>
          </>
        )}
      </div>
      {msg && <div className={msg.err ? 'alert' : 'notice'}>{msg.t}</div>}
    </div>
  );
}

function Outlook({ outlook, model }) {
  if (!outlook?.length) return null;
  const first = outlook[0];
  const started = first.night_from && new Date(first.night_from) <= new Date();
  const byId = Object.fromEntries((model || []).map((m) => [m.room_id, m]));
  return (
    <section className="card">
      <div className="section-title">Raummodell <span className="plan-sub">wie schnell kühlt jeder Raum aus?</span></div>
      <p className="muted small">
        Gelernt aus den Nächten ohne Heizen (Ventil zu oder Wärmepumpe aus). Gerechnet wird vorsichtig (die schnelleren 25 % der Nächte).
        Heute Nacht {fmtTime(first.night_from)}–{fmtTime(first.night_to)} Uhr, außen erwartet {fmtT(first.outdoor_fc)}.
        {started
          ? ' Spalte „morgen früh“: so warm ist der Raum ohne Heizen voraussichtlich bei Tagesbeginn.'
          : ' Spalte „' + fmtTime(first.night_from) + ' nötig“: so warm muss der Raum bei Nachtbeginn sein, damit er bis morgen früh ohne Heizen über Absenk bleibt.'}
      </p>
      <div className="plan-wrap">
        <table className="ptable ki-table">
          <thead>
            <tr>
              <th>Raum</th>
              <th className="hide-sm">Nächte</th>
              <th>kühlt/Nacht</th>
              <th className="hide-sm">nachgeheizt (7 N.)</th>
              <th>jetzt</th>
              <th>Absenk</th>
              <th>{started ? 'morgen früh' : `${fmtTime(first.night_from)} nötig`}</th>
            </tr>
          </thead>
          <tbody>
            {outlook.map((o) => {
              const m = byId[o.room_id] || {};
              const val = started ? o.predicted_morning : o.need_at_night_start;
              const ok = started ? o.ok : (o.temp_now != null && val != null ? Number(o.temp_now) >= Number(val) : null);
              return (
                <tr key={o.room_id}>
                  <td>{o.name}</td>
                  <td className="hide-sm">{o.nights || '–'}</td>
                  <td>{m.drop_med != null ? `${num(m.drop_med)}°` : '–'}</td>
                  <td className="hide-sm">{m.nights7 ? `${m.heated7} von ${m.nights7}` : '–'}</td>
                  <td>{o.temp_now != null ? num(o.temp_now) : '–'}</td>
                  <td>{num(o.temp_night)}</td>
                  <td className={ok === false ? 'warn-text' : ''}>
                    {o.nights < 3 ? <span className="muted small">lernt noch</span> : val != null ? `${num(val)}°` : '–'}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="muted small">„kühlt/Nacht“ = gemessener Median der letzten Nächte (Nacht = {fmtTime(first.night_from)}–{fmtTime(first.night_to)} Uhr). Rot = reicht nicht ohne Nachheizen.</p>
    </section>
  );
}

export default function Ki({ rooms, onChanged }) {
  const [state, setState] = useState({ loading: true });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const [showDone, setShowDone] = useState(false);
  const roomName = Object.fromEntries(rooms.map((r) => [r.id, r.name]));

  const load = useCallback(async () => {
    const [sug, runs, outlook, model] = await Promise.all([
      supabase.from('muc_ki_suggestions').select('*').order('created_at', { ascending: false }).limit(150),
      supabase.from('muc_ki_runs').select('*').order('day', { ascending: false }).limit(1),
      supabase.rpc('muc_room_outlook'),
      supabase.rpc('muc_room_model'),
    ]);
    if (sug.error) { setState({ loading: false, error: sug.error.message }); return; }
    setState({ loading: false, sug: sug.data, run: runs.data?.[0] || null, outlook: outlook.data || [], model: model.data || [] });
  }, []);
  useEffect(() => { load(); }, [load]);

  const done = () => { load(); onChanged?.(); };

  const runNow = async () => {
    setBusy(true);
    setMsg(null);
    const { error } = await supabase.rpc('muc_ki_run_now');
    setBusy(false);
    if (error) setMsg({ err: true, t: error.message });
    await load();
    onChanged?.();
  };

  if (state.loading) return <div className="muted">Lade …</div>;
  if (state.error) {
    return (
      <div className="alert">
        KI-Daten fehlen ({state.error}). Bitte <code>supabase/migration-007-ki.sql</code> im Supabase SQL-Editor ausführen.
      </div>
    );
  }

  const open = state.sug.filter((s) => s.status === 'offen');
  const hints = open.filter((s) => s.kind === 'hinweis');
  const decide = open.filter((s) => s.kind === 'vorschlag' || s.kind === 'ruecknahme')
    .sort((a, b) => (a.kind === 'ruecknahme' ? -1 : 0) - (b.kind === 'ruecknahme' ? -1 : 0));
  const weekAgo = Date.now() - 7 * 86400000;
  const infos = state.sug.filter((s) => s.kind === 'info' && new Date(s.created_at).getTime() > weekAgo);
  const reports = state.sug.filter((s) => s.effect_text && s.kind !== 'hinweis' && new Date(s.effect_at).getTime() > weekAgo);
  const history = state.sug.filter((s) => s.status !== 'offen' && s.kind !== 'info');

  return (
    <div className="stack">
      {hints.length > 0 && (
        <section className="card">
          <div className="section-title">Hinweise <span className="plan-sub">sofort, ohne auf morgen zu warten</span></div>
          <div className="ki-list">
            {hints.map((s) => <Suggestion key={s.id} s={s} roomName={roomName[s.room_id]} onDone={done} />)}
          </div>
        </section>
      )}

      <section className="card">
        <div className="ki-head">
          <div>
            <div className="section-title">Zu entscheiden ({decide.length})</div>
            <div className="muted small">Die KI ändert nichts selbst. Erst nach „Ja“ wird der Wert geschrieben, nach 3 Tagen kommt ein Wirkungsbericht.</div>
          </div>
          <button className="btn small" disabled={busy} onClick={runNow}>{busy ? 'Analysiere …' : 'Neu analysieren'}</button>
        </div>
        {msg && <div className={msg.err ? 'alert' : 'notice'}>{msg.t}</div>}
        {state.run && (
          <div className="ki-review">
            <div className="eyebrow">Rückblick · {fmtDateTime(state.run.created_at)}</div>
            <div className="small">{state.run.summary}</div>
          </div>
        )}
        {decide.length === 0
          ? <div className="muted">Alles im Rahmen – nichts zu entscheiden.</div>
          : <div className="ki-list">{decide.map((s) => <Suggestion key={s.id} s={s} roomName={roomName[s.room_id]} onDone={done} />)}</div>}
      </section>

      {(reports.length > 0 || infos.length > 0) && (
        <section className="card">
          <div className="section-title">Zur Info <span className="plan-sub">nichts zu tun</span></div>
          <div className="insights">
            {reports.map((s) => (
              <div key={`r${s.id}`} className={`insight ${/schlechter/.test(s.effect_text) ? 'tone-rose' : 'tone-green'}`}>
                <div className="insight-title">Wirkungsbericht</div>
                <div className="small">{s.effect_text}</div>
              </div>
            ))}
            {infos.map((s) => (
              <div key={s.id} className="insight tone-cool">
                <div className="insight-title">{s.title}</div>
                <div className="small">{s.why}</div>
              </div>
            ))}
          </div>
        </section>
      )}

      <Outlook outlook={state.outlook} model={state.model} />

      {history.length > 0 && (
        <section className="card">
          <button type="button" className="collapse-head" onClick={() => setShowDone((v) => !v)} aria-expanded={showDone}>
            <span className="section-title">Verlauf</span>
            <span className="collapse-sum">{showDone ? '' : `${history.length} ${history.length === 1 ? 'Eintrag' : 'Einträge'}`}</span>
            <span className={`collapse-chev ${showDone ? 'open' : ''}`} aria-hidden="true">▶</span>
          </button>
          {showDone && (
            <div className="log">
              {history.map((s) => (
                <div key={s.id} className="log-row">
                  <div className="log-time">{fmtDateTime(s.decided_at || s.created_at)}</div>
                  <div className="log-body">
                    <div className="log-head">
                      <span className={`pill ${STATUS[s.status]?.tone || 'neutral'}`}>{STATUS[s.status]?.label || s.status}</span>
                      <span>{s.title}</span>
                      {s.decided_value != null && <strong>{fmtT(s.decided_value)}</strong>}
                    </div>
                    {(s.note || s.effect_text) && <div className="muted small">{[s.note, s.effect_text].filter(Boolean).join(' · ')}</div>}
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      )}
    </div>
  );
}
