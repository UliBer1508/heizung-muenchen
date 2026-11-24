// „Wo stehen wir?“ › KI gegen Regeln – darf die KI steuern? (24.11.2026)
// ÜBERNOMMEN aus Heizung Venediger (src/components/ki/KiGegenRegeln.tsx, Commit af244ae; dort 16.11.2026,
// Uli: „Zeige mir die Gegenrechnung jeden Morgen in Wo stehen wir an.“). Gestaltung mit den Klassen der Münchner App.
// Unterschied zu Venediger: ohne die Spalten EMHASS und HiGHS (in München nicht eingebaut,
// doc/EMHASS-HIGHS-BEWERTUNG-2026-11-24.md).
// Daten: muc_heizplan_vergleich (heizplaner-muenchen aktion „vergleich“, täglich ~03:00 für den Vortag, echte PV, Start Mitternacht).
// Bereit für „KI steuert“, wenn 3 Tage in Folge (davon mindestens ein Sonnentag = Wartetag) gilt:
//   1. KI braucht weniger Netz als tatsächlich gesteuert (bereinigt um gespeicherte Wärme)
//   2. kein Raum öfter unter der Untergrenze als tatsächlich
//   3. an Sonnentagen kein Netz-Heizen über die Untergrenze
// Nur Tage, die mit Regel-Rahmen gerechnet sind (planer.regeln), zählen.
import { useEffect, useState } from 'react';
import { supabase } from '../supabase.js';
import { num, tagKurz } from './teile.jsx';

export const UNTER_MIN_TOLERANZ = 0.5;   // °C·h – Rundung/Modellrauschen
export const TAGE_IN_FOLGE = 3;

export function pruefeTag(z) {
  const st = z.steuerung ?? {}, pl = z.planer ?? {};
  const netzKi = Number(pl.netz_bereinigt_kwh ?? pl.netz_kwh), netzIst = Number(st.netz_kwh);
  const netz = Number.isFinite(netzKi) && Number.isFinite(netzIst) && netzKi <= netzIst;
  const min = Number(pl.unter_grenze_gradstd ?? 0) <= Number(st.unter_grenze_gradstd ?? 0) + UNTER_MIN_TOLERANZ;
  const sonne = pl.sonnentag !== true || Number(pl.netz_ueber_min_h ?? 0) === 0;
  return { netz, min, sonne, ok: netz && min && sonne, zaehlt: pl.regeln === true, netzKi, netzIst };
}

/** Tage in Folge (vom jüngsten an), die alle drei Bedingungen erfüllen, und ob ein Sonnentag dabei ist. */
export function bereitschaft(zeilen) {
  let folge = 0, sonnentag = false;
  for (const z of zeilen) {                       // jüngster zuerst
    const p = pruefeTag(z);
    if (!p.zaehlt || !p.ok) break;
    folge++; if (z.planer?.sonnentag) sonnentag = true;
  }
  return { folge, sonnentag, bereit: folge >= TAGE_IN_FOLGE && sonnentag };
}

const Haken = ({ ok, label }) => (
  <span className={ok ? 'good-text' : 'warn-text'} aria-label={`${label}: ${ok ? 'erfüllt' : 'nicht erfüllt'}`}>{ok ? '✓' : '✗'}</span>
);

export default function KiGegenRegeln() {
  const [zeilen, setZeilen] = useState(null);
  const [fehler, setFehler] = useState(null);
  useEffect(() => {
    const laden = () => supabase.from('muc_heizplan_vergleich').select('tag, netz_gemessen_kwh, steuerung, planer')
      .order('tag', { ascending: false }).limit(7)
      .then(({ data, error }) => { if (error) setFehler(error.message); else { setFehler(null); setZeilen(data ?? []); } });
    laden();
    const t = setInterval(() => { if (document.visibilityState === 'visible') laden(); }, 10 * 60_000);
    const sichtbar = () => { if (document.visibilityState === 'visible') laden(); };
    document.addEventListener('visibilitychange', sichtbar);
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', sichtbar); };
  }, []);

  if (fehler) return <div className="alert">Gegenrechnung nicht ladbar: {fehler}</div>;
  if (!zeilen) return <div className="muted small">Lade Gegenrechnung …</div>;
  if (!zeilen.length) return <div className="muted small">Noch keine Gegenrechnung vorhanden – kommt jede Nacht um 03:00.</div>;

  const b = bereitschaft(zeilen);
  const gestern = zeilen[0];
  const pg = pruefeTag(gestern);
  const farbe = b.bereit ? 'var(--green)' : b.folge > 0 ? 'var(--sun)' : 'var(--rose)';
  const satz = b.bereit
    ? `Bereit: ${b.folge} Tage in Folge war die KI besser als die tatsächliche Steuerung, mit Sonnentag. Du kannst auf „KI steuert“ schalten.`
    : b.folge > 0
      ? b.folge >= TAGE_IN_FOLGE
        ? `Noch nicht bereit: ${b.folge} Tage in Folge war die KI mindestens gleich gut – es fehlt noch ein Sonnentag, an dem sie sich beweist.`
        : `Noch nicht bereit: ${b.folge} von ${TAGE_IN_FOLGE} Tagen in Folge erfüllt${b.sonnentag ? '' : ', und es fehlt noch ein Sonnentag'}.`
      : pg.zaehlt
        ? 'Noch nicht bereit: Gestern war die KI nicht besser als die tatsächliche Steuerung.'
        : 'Noch nicht bereit: Die Tage sind noch ohne Regel-Rahmen gerechnet (ab dem ersten Tag nach dem Einspielen von migration-018).';

  return (
    <div className="card">
      <div className="wsw-row" style={{ alignItems: 'flex-start', gap: 10 }}>
        <span aria-hidden="true" style={{ marginTop: 6, width: 12, height: 12, borderRadius: 999, background: farbe, flexShrink: 0 }} />
        <div>
          <div className="chart-title">KI gegen tatsächliche Steuerung – darf die KI steuern?</div>
          <div className="small">{satz}</div>
          <div className="muted small">
            Gegenrechnung vom {tagKurz(gestern.tag)}: tatsächlich {num(pg.netzIst)} kWh Netz, KI {num(pg.netzKi)} kWh
            {Number.isFinite(pg.netzKi) && Number.isFinite(pg.netzIst) ? ` (${pg.netzKi <= pg.netzIst ? '−' : '+'}${num(Math.abs(pg.netzKi - pg.netzIst))} kWh)` : ''}.
            {' '}Bedingungen: weniger Netz <Haken ok={pg.netz} label="weniger Netz" /> · nicht öfter unter der Untergrenze <Haken ok={pg.min} label="Untergrenze" /> · an Sonnentagen kein Netz über der Untergrenze <Haken ok={pg.sonne} label="Sonnentag" />
          </div>
        </div>
      </div>
      <div className="plan-wrap">
        <table className="ptable auto-links">
          <caption className="sr-only">Gegenrechnung der letzten Tage: Netzstrom und Untergrenze, tatsächlich gegen KI</caption>
          <thead><tr><th>Tag</th><th>Sonne</th><th>Netz tatsächlich</th><th>Netz KI</th><th>unter Untergrenze tats. / KI</th><th>besser?</th></tr></thead>
          <tbody>
            {zeilen.map((z) => { const p = pruefeTag(z); return (
              <tr key={z.tag}>
                <td>{tagKurz(z.tag)}</td>
                <td>{z.planer?.sonnentag == null ? '–' : z.planer.sonnentag ? 'Sonnentag' : 'wenig'}</td>
                <td>{num(p.netzIst)} kWh</td>
                <td>{num(p.netzKi)} kWh</td>
                <td>{num(z.steuerung?.unter_grenze_gradstd)} / {num(z.planer?.unter_grenze_gradstd)} °C·h</td>
                <td>{p.zaehlt ? <Haken ok={p.ok} label={`${z.tag} besser`} /> : <span className="muted small">ohne Regeln</span>}</td>
              </tr>); })}
          </tbody>
        </table>
      </div>
      <div className="muted small">
        Gerechnet jede Nacht für den Vortag mit der echten PV. „Netz KI“ ist bereinigt um die Wärme, die die KI am Tagesende
        mehr oder weniger im Estrich gespeichert hätte. „Tatsächlich“ ist, was die Steuerung an dem Tag wirklich gemacht hat
        (bei „KI rechnet mit“ die Regeln des Collectors). „Sonnentag“ = Wartetag wie im Collector (erwarteter Überschuss ≥ Einstellung
        „Wartetag ab“). Den Modus schaltest nur du.
      </div>
    </div>
  );
}
