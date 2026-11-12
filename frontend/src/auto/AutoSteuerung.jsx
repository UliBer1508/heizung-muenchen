// Tab „Auto-Steuerung“ (12.11.2026) – erster Tab, vor der Übersicht, wie in Heizung Venediger.
// Uli: „Ich will eine Auto-Steuerung auch in München – die Analyse, wie sie ist, und zusätzlich die Auto-Steuerung.“
//      „In Venediger haben wir Steuerung und Planung in diesem Teil.“
// ÜBERNOMMEN aus Heizung Venediger (src/components/ki/AutoSteuerung.tsx, Commit bf8d3a7):
//   1 Verlauf und Wirkung · 2 Steuerung (Modus + Eingriffe) · 3 Plan
// Die Eingriffe sind vorhandene Einstellungen an einem Platz – keine neuen Werte. Unterschied zu Venediger:
// München begrenzt ohne Sonne die Zahl der Kreise (Netzgrenze), Venediger die Leistung in Watt.
import { useMemo, useState } from 'react';
import { supabase } from '../supabase.js';
import { useAufZu } from '../Klapp.jsx';
import Verlauf from './Verlauf.jsx';
import Plan from './Plan.jsx';
import { num } from './teile.jsx';

function Abschnitt({ id, nr, titel, frage, children }) {
  const [auf, umschalten] = useAufZu(id);
  return (
    <section className="card qsec auto">
      <button type="button" className="qsec-toggle" onClick={umschalten} aria-expanded={auf}>
        <span className="qsec-nr auto-nr">{nr}</span>
        <div>
          <div className="chart-title">{titel}</div>
          <div className="muted small">{frage}</div>
        </div>
        <span className={`collapse-chev ${auf ? 'open' : ''}`} aria-hidden="true">▶</span>
      </button>
      {auf && children}
    </section>
  );
}

const MODI = [['aus', 'Aus'], ['schatten', 'Schatten'], ['steuern', 'Steuern']];
const REGLER = [
  { k: 'planer_gewicht_ziel', def: 0.6, min: 0.1, max: 3, step: 0.1, l: 'Sparsamer ↔ wärmer', links: 'sparsamer', rechts: 'wärmer',
    text: (v) => `1 °C·h unter Ziel ist dir ${num(v)} kWh Netzstrom wert. Höher = wärmer, mehr Netz.` },
  { k: 'max_grid_circuits', def: 6, min: 1, max: 15, step: 1, l: 'Netzgrenze ohne Sonne', links: '1 Kreis', rechts: '15 Kreise',
    text: (v) => `${num(v, 0)} ${Number(v) === 1 ? 'Kreis darf' : 'Kreise dürfen'} gleichzeitig aus Batterie/Netz heizen. Gilt auch sofort für die heutige Steuerung.` },
  { k: 'planer_sicherheit_abstand', def: 1.5, min: 0, max: 3, step: 0.5, l: 'Sicherheit unter Untergrenze', links: '0 °C', rechts: '3 °C',
    text: (v) => `Kein Raum fällt mehr als ${num(v)} °C unter seine Untergrenze.` },
];

function Steuerung({ data, reload, kiOffen, onNavigate }) {
  const s = data.settings || {};
  const [entwurf, setEntwurf] = useState({});
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const wert = (k, def) => (entwurf[k] ?? Number(s[k] ?? def));
  const geaendert = Object.keys(entwurf).filter((k) => entwurf[k] !== Number(s[k]));
  const modus = s.planer_modus ?? null;   // null = migration-014 fehlt

  const speichern = async (patch) => {
    setBusy(true); setMsg(null);
    const { error } = await supabase.from('muc_settings').update(patch).eq('id', 1);
    setBusy(false);
    if (error) { setMsg(/planer_/.test(error.message) ? 'Bitte supabase/migration-014-auto-steuerung.sql ausführen.' : error.message); return false; }
    await reload();
    return true;
  };

  const jetzt = Date.now();
  const besonders = useMemo(() => (data.rooms || []).map((r) => {
    const manuell = r.override_temp != null && r.override_until && new Date(r.override_until).getTime() > jetzt;
    const grund = !r.enabled ? 'Automatik aus' : manuell
      ? `manuell ${num(r.override_temp)} °C bis ${new Date(r.override_until).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Berlin' })}` : null;
    return { id: r.id, name: r.name, grund };
  }).filter((x) => x.grund), [data.rooms, jetzt]);

  return (
    <div className="stack">
      <div className="auto-kopf">
        <div>
          <div className="chart-title" style={{ marginBottom: 2 }}>Modus</div>
          <div className="muted small">Wer setzt die Sollwerte der Raumregler?</div>
        </div>
        <div className="seg seg-3" role="group" aria-label="Modus der Auto-Steuerung">
          {MODI.map(([m, l]) => (
            <button key={m} type="button" className={modus === m ? 'seg-btn active' : 'seg-btn'} disabled={m === 'steuern' || busy || modus == null}
              title={m === 'steuern' ? 'Noch nicht gebaut – kommt nach der Freigabe, wie in Venediger' : undefined}
              onClick={() => m !== modus && speichern({ planer_modus: m })}>{l}</button>
          ))}
        </div>
      </div>
      <div className={modus === 'aus' ? 'notice-warn' : 'notice'}>
        {modus == null && 'Die Auto-Steuerung ist noch nicht eingerichtet: supabase/migration-014-auto-steuerung.sql ausführen.'}
        {modus === 'aus' && 'Planer aus – die heutige Steuerung (Collector: Tagesmodi, Priorität, Netzgrenze) entscheidet allein.'}
        {modus === 'schatten' && 'Schattenbetrieb – der Planer rechnet alle 15 min einen Plan und schreibt auf, was er anders gemacht hätte; an den Raumreglern ändert er nichts. Die heutige Steuerung (Collector) setzt weiter die Sollwerte. So sehen wir im Vergleich, ob der Plan besser wäre, bevor er steuern darf.'}
        {modus === 'steuern' && 'Der Planer setzt die Sollwerte. Sicherheitsregeln gelten weiter; ist der Plan älter als 30 min, übernimmt die heutige Steuerung.'}
      </div>
      {s.dry_run && <div className="muted small">Hinweis: Der Collector läuft im Testmodus – auch die heutige Steuerung schreibt nichts nach Loxone.</div>}

      <div>
        <div className="chart-title">Eingreifen, wenn die Optimierung nicht passt</div>
        <div className="auto-regler-grid">
          {REGLER.map((r) => {
            const v = wert(r.k, r.def);
            return (
              <div key={r.k} className="card tile auto-regler">
                <label htmlFor={r.k} className="eyebrow">{r.l}</label>
                <input id={r.k} type="range" min={r.min} max={r.max} step={r.step} value={v} disabled={modus == null && r.k !== 'max_grid_circuits'}
                  onChange={(e) => setEntwurf((x) => ({ ...x, [r.k]: Number(e.target.value) }))} />
                <div className="auto-regler-ende muted"><span>{r.links}</span><span>{r.rechts}</span></div>
                <div className="small">{r.text(v)}</div>
              </div>
            );
          })}
        </div>
        {geaendert.length > 0 && (
          <div className="toolbar" style={{ marginTop: 8 }}>
            <button type="button" className="btn primary small" disabled={busy}
              onClick={async () => { if (await speichern(Object.fromEntries(geaendert.map((k) => [k, entwurf[k]])))) setEntwurf({}); }}>Übernehmen</button>
            <button type="button" className="btn ghost small" onClick={() => setEntwurf({})}>Verwerfen</button>
            <span className="muted small">Der nächste Plan (spätestens in 15 min) rechnet damit.</span>
          </div>
        )}
        {msg && <div className="alert" style={{ marginTop: 8 }}>{msg}</div>}
      </div>

      <div className="auto-2">
        <div className="card tile">
          <div className="chart-title">Einzelne Räume</div>
          <div className="muted small">Ein Raum kurz anders? In der Übersicht übersteuern – der Planer lässt ihn dann in Ruhe. Ganz raus: Raum in den Einstellungen abschalten.</div>
          {besonders.length > 0 && <ul className="small auto-liste">{besonders.map((b) => <li key={b.id}>{b.name}: {b.grund}</li>)}</ul>}
          <button type="button" className="btn small" style={{ marginTop: 8 }} onClick={() => onNavigate('overview')}>Zu den Räumen</button>
        </div>
        <div className="card tile">
          <div className="chart-title">KI-Vorschläge</div>
          <div className="muted small">Die KI ändert nichts selbst. Was sie vorschlägt, genehmigst oder änderst du – die Wirkung steht oben im Verlauf.</div>
          <div className="small" style={{ marginTop: 6 }}>{kiOffen > 0 ? `${kiOffen} offen` : 'nichts offen'}</div>
          <button type="button" className="btn small" style={{ marginTop: 8 }} onClick={() => onNavigate('ki')}>Zu den Vorschlägen</button>
        </div>
      </div>
    </div>
  );
}

export default function AutoSteuerung({ data, reload, kiOffen, onNavigate }) {
  return (
    <div className="stack">
      <Abschnitt id="auto-verlauf" nr={1} titel="Verlauf und Wirkung" frage="Wird es besser – Netz, Haus, Batterie, Kosten – und was haben die KI-Vorschläge bewirkt?">
        <Verlauf settings={data.settings} />
      </Abschnitt>
      <Abschnitt id="auto-steuerung" nr={2} titel="Steuerung" frage="Wer entscheidet – und wie greife ich ein?">
        <Steuerung data={data} reload={reload} kiOffen={kiOffen} onNavigate={onNavigate} />
      </Abschnitt>
      <Abschnitt id="auto-plan" nr={3} titel="Plan" frage="Was macht der Planer in den nächsten 24 Stunden?">
        <Plan rooms={data.rooms || []} />
      </Abschnitt>
    </div>
  );
}
