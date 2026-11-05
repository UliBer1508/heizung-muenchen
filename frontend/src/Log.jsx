import { useState } from 'react';
import { fmtDateTime, fmtT, modeMeta } from './lib.js';

const KINDS = {
  mode: 'Moduswechsel',
  write: 'Sollwert',
  sequence: 'Priorität',
  error: 'Fehler',
  alexa: 'Alexa',
  ki: 'KI',
};

export default function Log({ data }) {
  const [filter, setFilter] = useState('all');
  const roomName = Object.fromEntries(data.rooms.map((r) => [r.id, r.name]));
  const rows = data.decisions.filter((d) => filter === 'all' || d.kind === filter);
  return (
    <div className="stack">
      <div className="seg">
        {[['all', 'Alle'], ['mode', 'Modus'], ['write', 'Sollwerte'], ['sequence', 'Priorität'], ['alexa', 'Alexa'], ['ki', 'KI'], ['error', 'Fehler']].map(([k, l]) => (
          <button key={k} className={filter === k ? 'seg-btn active' : 'seg-btn'} onClick={() => setFilter(k)}>{l}</button>
        ))}
      </div>
      <section className="card log">
        {rows.length === 0 && <div className="muted">Noch keine Einträge.</div>}
        {rows.map((d) => (
          <div key={d.id} className={`log-row kind-${d.kind}`}>
            <div className="log-time">{fmtDateTime(d.ts)}</div>
            <div className="log-body">
              <div className="log-head">
                <span className="log-kind">{KINDS[d.kind] || d.kind}</span>
                {d.mode && d.kind !== 'error' && <span className={`pill ${modeMeta(d.mode).tone}`}>{modeMeta(d.mode).label}</span>}
                {d.room_id && <span>{roomName[d.room_id] || d.room_id}</span>}
                {d.target != null && <strong>{fmtT(d.target)}</strong>}
                {d.dry_run && <span className="pill rose">Test</span>}
              </div>
              {d.reason && <div className="muted small">{d.reason}</div>}
            </div>
          </div>
        ))}
      </section>
    </div>
  );
}
