// Auto-Steuerung › 1 „Wo stehen wir?“ (22.11.2026) – doc/WO-STEHEN-WIR.md
// Uli: „Hier haben wir doch das gleiche Problem wie in Venediger: Von wann sind die Daten, sind diese aktuell, warum gibt
// es nicht Woche, Monat, Jahr?“ → „umsetzen wie beschrieben“.
// ÜBERNOMMEN aus Heizung Venediger (src/components/ki/OptimierungView.tsx, Commit 0e1c6c6): Zeitraum Woche/Monat/Jahr
// mit ◀ ▶, Vergleich mit der Vorperiode je Tag (nur wenn sie Daten hat), Ampeln, Ziel kWh je Heizgradtag, KI-Vorschläge,
// Verlauf je Woche/Monat, „Stand … Uhr“, neu laden alle 10 min und beim Zurückkehren in den Tab.
// Unterschiede zu Venediger, weil München es verlangt:
//   - Heizstrom ist GESCHÄTZT (Verbrauch − Auto − Grundlast), bis die Wärmepumpe am LAN hängt.
//   - Euro nur, wenn ein Strompreis eingetragen ist (Einstellungen › Strompreis); sonst kWh.
//   - „Min“ = Untergrenze je Raum; nachts = Nachtzeit aus den Einstellungen.
//   - Kein Abgleich mit einer Stromrechnung; Ziel kWh je Heizgradtag ohne Vorgabe – Uli setzt es selbst.
// 25.11.2026 (Uli: „Die Heizung München sollte so aussehen wie Venediger“): Aufbau 1:1 wie OptimierungView –
//   1 Wo stehen wir? · 2 Wohin wollen wir? (Zielbalken) · 3 Wie kommen wir dahin? (Vorschläge mit Übernehmen/Ablehnen,
//   „So optimiert die Steuerung“) · Kommen wir voran? (Verlauf). Ohne Abgleich Stromrechnung (gibt es in München nicht).
// Daten: muc_wo_stehen_wir / muc_wo_stehen_wir_verlauf (supabase/migration-015-wo-stehen-wir.sql).
import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../supabase.js';
import { bereich, heuteOrt, plusTage, verschieben } from './zeit.js';
import KiGegenRegeln from './KiGegenRegeln.jsx';
import ModellGuete from './ModellGuete.jsx';

const n = (v, d = 0) => (v == null || !Number.isFinite(Number(v)) ? '–'
  : Number(v).toLocaleString('de-DE', { minimumFractionDigits: d, maximumFractionDigits: d }));
const eur = (v) => `${n(v, 0)} €`;
const dm = (iso) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}.`;
const wtag = (iso) => new Date(`${iso}T12:00:00Z`).toLocaleDateString('de-DE', { weekday: 'short', timeZone: 'UTC' });
const tageZwischen = (von, bis) => Math.round((Date.parse(bis) - Date.parse(von)) / 86400000) + 1;
const VOR = { woche: 'Vorwoche', monat: 'Vormonat', jahr: 'Vorjahr' };
const MON = ['Jan', 'Feb', 'Mär', 'Apr', 'Mai', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez'];
const AMPEL = { gut: 'var(--green)', mittel: 'var(--sun)', schlecht: 'var(--rose)', neutral: 'var(--muted)' };

/** Vergleich mit der Vorperiode; jeTag: Summen je Tag vergleichen (Zeiträume verschieden lang). Weniger = besser. */
function Vgl({ jetzt, vor, tageJetzt, tageVor, name, jeTag, format, mehrBesser, nicht }) {
  if (nicht) return <div className="muted small">{name}: {nicht}</div>;
  if (vor == null || jetzt == null || !tageVor) return <div className="muted small">{name}: –</div>;
  const a = jeTag ? Number(jetzt) / Math.max(1, tageJetzt) : Number(jetzt);
  const b = jeTag ? Number(vor) / Math.max(1, tageVor) : Number(vor);
  const pct = b !== 0 ? Math.round((100 * (a - b)) / Math.abs(b)) : null;
  const gut = pct == null || pct === 0 ? null : mehrBesser ? pct > 0 : pct < 0;
  return (
    <div className="muted small">
      {name} {format(Number(vor))}
      {pct != null && (
        <span className={gut == null ? '' : `delta ${gut ? 'good' : 'bad'}`}>
          {' · '}{pct >= 200 ? `×${n(a / b, a / b < 10 ? 1 : 0)}` : `${pct > 0 ? '+' : pct < 0 ? '−' : '±'}${Math.abs(pct)} %`}{jeTag ? ' je Tag' : ''}
        </span>
      )}
    </div>
  );
}

function AmpelKarte({ ampel, label, frage, children }) {
  return (
    <div className="card wsw-karte">
      <div className="wsw-ampel" style={{ color: AMPEL[ampel] }}>
        <span className="wsw-punkt" style={{ background: AMPEL[ampel] }} aria-hidden="true" />{label}
      </div>
      <div className="wsw-frage">{frage}</div>
      <div className="muted small wsw-text">{children}</div>
    </div>
  );
}

function ZielZeile({ titel, jetzt, ziel, breite, marke, farbe, hinweis, label }) {
  return (
    <div className="wsw-ziel-zeile">
      <div className="wsw-row wsw-zw">
        <strong>{titel}</strong>
        <span>jetzt <b>{jetzt}</b> → Ziel <b>{ziel}</b></span>
      </div>
      <div className="wsw-zbalken" role="img" aria-label={label}>
        <div style={{ width: `${Math.max(0, Math.min(100, breite))}%`, background: AMPEL[farbe] }} />
        {marke != null && <i style={{ left: `${marke}%` }} />}
      </div>
      {hinweis && <div className="muted small">{hinweis}</div>}
    </div>
  );
}

function VorschlagKarte({ v, onFertig }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const entscheiden = async (action) => {
    setBusy(true); setMsg(null);
    const { data, error } = await supabase.rpc('muc_ki_decide', { p_id: v.id, p_action: action, p_value: null, p_note: null });
    setBusy(false);
    if (error || !data?.ok) { setMsg({ err: true, t: error?.message || data?.msg || 'Nicht gespeichert' }); return; }
    setMsg({ t: data.msg || (action === 'ja' ? 'Übernommen' : 'Abgelehnt') });
    setTimeout(onFertig, 1000);
  };
  return (
    <div className="wsw-vorschlag">
      <div className="wsw-row wsw-zw">
        <strong>{v.title}</strong>
        <span className="small" style={{ color: 'var(--sun)', fontWeight: 600 }}>{v.kind === 'ruecknahme' ? 'Rücknahme' : 'Neu'}</span>
      </div>
      {v.what && <div className="small"><b>Was:</b> {v.what}</div>}
      {v.why && <div className="small muted"><b style={{ color: 'var(--ink)' }}>Warum:</b> {v.why}</div>}
      {v.effect && <div className="small muted"><b style={{ color: 'var(--ink)' }}>Erwartet:</b> {v.effect}</div>}
      {msg && <div className={msg.err ? 'alert small' : 'notice small'}>{msg.t}</div>}
      <div className="wsw-row">
        <button type="button" className="btn small primary" disabled={busy} onClick={() => entscheiden('ja')}>Übernehmen</button>
        <button type="button" className="btn small" disabled={busy} onClick={() => entscheiden('nein')}>Ablehnen</button>
      </div>
    </div>
  );
}

export default function WoStehenWir({ onNavigate }) {
  const [d, setD] = useState(null);
  const [v, setV] = useState(null);
  const [verlauf, setVerlauf] = useState([]);
  const [ki, setKi] = useState({ offen: [], entschieden: [] });
  const [fehler, setFehler] = useState(null);
  const [zielEdit, setZielEdit] = useState(null);

  // Zeitraum: Woche (Mo–So), Monat, Jahr – Anker gestern (letzter voller Tag), ◀ ▶ blättern
  const gestern = plusTage(heuteOrt(), -1);
  const [periode, setPeriode] = useState('woche');
  const [anker, setAnker] = useState(gestern);
  const b = bereich(periode, anker);
  const bisEff = plusTage(b.bis, -1) < gestern ? plusTage(b.bis, -1) : gestern;
  const tageZr = Math.max(0, tageZwischen(b.von, bisEff));
  const vb = bereich(periode, verschieben(periode, anker, -1));
  const naechster = verschieben(periode, anker, 1);
  const vorErlaubt = bereich(periode, naechster).von <= gestern;
  const unvollstaendig = bisEff < plusTage(b.bis, -1);

  const laden = useCallback(async () => {
    const verlaufArg = periode === 'jahr'
      ? { p_einheit: 'monat', p_bis: bisEff, p_anzahl: Number(bisEff.slice(5, 7)) }
      : { p_einheit: 'woche', p_bis: bisEff, p_anzahl: 8 };
    const [a, vd, vl, offen, ent] = await Promise.all([
      supabase.rpc('muc_wo_stehen_wir', { p_bis: bisEff, p_tage: Math.max(1, tageZr) }),
      supabase.rpc('muc_wo_stehen_wir', { p_bis: plusTage(vb.bis, -1), p_tage: tageZwischen(vb.von, plusTage(vb.bis, -1)) }),
      supabase.rpc('muc_wo_stehen_wir_verlauf', verlaufArg),
      supabase.from('muc_ki_suggestions').select('id, kind, title, what, why, effect').in('kind', ['vorschlag', 'ruecknahme']).eq('status', 'offen')
        .order('created_at', { ascending: false }),
      supabase.from('muc_ki_suggestions').select('id, title, decided_at, effect_text').in('kind', ['vorschlag', 'ruecknahme'])
        .in('status', ['genehmigt', 'geaendert']).order('decided_at', { ascending: false }).limit(5),
    ]);
    if (a.error) {
      setFehler(/muc_wo_stehen_wir/.test(a.error.message) ? 'Bitte supabase/migration-015-wo-stehen-wir.sql ausführen.' : a.error.message);
      return;
    }
    setFehler(null); setD(a.data); setV(vd.data ?? null); setVerlauf(vl.data ?? []);
    setKi({ offen: offen.data ?? [], entschieden: ent.data ?? [] });
  }, [periode, bisEff, tageZr, vb.von, vb.bis]);

  useEffect(() => {
    laden();
    const t = setInterval(() => { if (document.visibilityState === 'visible') laden(); }, 10 * 60_000);
    const sichtbar = () => { if (document.visibilityState === 'visible') laden(); };
    document.addEventListener('visibilitychange', sichtbar);
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', sichtbar); };
  }, [laden]);

  const leiste = (
    <div className="auto-kopf">
      <div className="seg seg-3" role="group" aria-label="Zeitraum">
        {['woche', 'monat', 'jahr'].map((x) => (
          <button key={x} type="button" className={periode === x ? 'seg-btn active' : 'seg-btn'} aria-pressed={periode === x}
            onClick={() => { setPeriode(x); setAnker(gestern); }}>{{ woche: 'Woche', monat: 'Monat', jahr: 'Jahr' }[x]}</button>
        ))}
      </div>
      <div className="wsw-row">
        <button type="button" className="btn small" onClick={() => setAnker(verschieben(periode, anker, -1))} aria-label="Zeitraum zurück">◀</button>
        <span className="auto-titel small">{b.titel}</span>
        <button type="button" className="btn small" disabled={!vorErlaubt} onClick={() => vorErlaubt && setAnker(naechster)} aria-label="Zeitraum vor">▶</button>
      </div>
    </div>
  );

  if (fehler) return <div className="stack">{leiste}<div className="notice-warn">„Wo stehen wir?“ nicht ladbar: {fehler}</div></div>;
  if (!d) return <div className="muted small">Lade …</div>;
  if (!d.tage) return <div className="stack">{leiste}<div className="muted small">Für {b.titel} gibt es noch keine vollen Tage.</div></div>;

  const s = d.summe;
  const ziel = d.ziel != null ? Number(d.ziel) : null;
  const kwh = s.kwh_je_hgt != null ? Number(s.kwh_je_hgt) : null;
  const tageMin = Number(d.tage_min ?? 0), tageNormal = Number(d.tage_normal ?? 0);
  const minJeNacht = s.h_unter_min != null && tageMin > 0 ? Number(s.h_unter_min) / tageMin : null;
  const normalJeTag = s.h_unter_normal != null && tageNormal > 0 ? Number(s.h_unter_normal) / tageNormal : null;
  const mitPreis = Number(d.tage_preis ?? 0) > 0;
  const preisTeil = mitPreis && Number(d.tage_preis) < d.tage;
  const stand = d.stand ? new Date(d.stand).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Berlin' }) : null;

  const sonne = s.eigen_pct == null ? 'neutral' : s.eigen_pct >= 95 ? 'gut' : s.eigen_pct >= 80 ? 'mittel' : 'schlecht';
  const heiz = kwh == null || ziel == null ? 'neutral' : kwh <= ziel ? 'gut' : kwh <= ziel * 1.15 ? 'mittel' : 'schlecht';
  const min = minJeNacht == null ? 'neutral' : minJeNacht <= 0.5 ? 'gut' : minJeNacht <= 5 ? 'mittel' : 'schlecht';
  const planer = d.planer_modus === 'steuern' ? 'neutral' : 'mittel';

  const fazit = [];
  fazit.push(sonne === 'gut' ? 'Sonnenstrom nutzen wir fast ganz.' : sonne === 'neutral' ? 'Kaum Sonnenstrom in diesem Zeitraum.' : 'Es geht noch Sonnenstrom ins Netz – hier ist etwas zu holen.');
  if (min === 'schlecht') fazit.push('Aber das Haus hält seine Temperaturen nicht: Räume lagen oft unter Min. Zuerst muss Min sicher sein, dann wird gespart.');
  else if (ziel == null) fazit.push(`Die Heizung braucht ${n(kwh, 1)} kWh je Heizgradtag – lege unten ein Ziel fest, dann zeigt die Ampel, ob wir es schaffen.`);
  else if (heiz !== 'gut') fazit.push('Sparen geht jetzt nur noch über weniger Heizstrom aus dem Netz – das soll der Planer schaffen.');
  else fazit.push('Der Heizstrom liegt im Ziel.');

  // Balken: Netzstrom (kWh) aufgeteilt in Heizung und Rest, dazu selbst genutzter Sonnenstrom
  const pvSelbst = Math.max(0, Number(s.pv_kwh) - Number(s.einspeisung_kwh));
  const heizNetz = Number(s.heizung_netz_kwh ?? 0), restNetz = Number(s.rest_netz_kwh ?? 0);
  const gesamt = Math.max(0.1, pvSelbst + heizNetz + restNetz);
  const pct = (x) => `${((100 * x) / gesamt).toFixed(1)}%`;

  // Vorperiode – nur vergleichen, wenn sie Daten hat
  const vs = v?.summe, vTage = Number(v?.tage ?? 0), vName = VOR[periode];
  const vSoll = tageZwischen(vb.von, plusTage(vb.bis, -1));
  const vMin = vs?.h_unter_min != null && Number(v?.tage_min ?? 0) > 0 ? Number(vs.h_unter_min) / Number(v.tage_min) : null;
  const keinVgl = !vTage ? 'keine Daten' : null;
  const keinRaumVgl = keinVgl ?? (Number(v?.tage_min ?? 0) < 0.8 * vTage ? 'zu wenige Nächte – kein Vergleich' : null);
  const keinEurVgl = keinVgl ?? (!mitPreis || Number(v?.tage_preis ?? 0) < 0.8 * vTage ? 'kein Strompreis – kein Vergleich' : null);
  const vAbdeckung = v && vTage && vTage < vSoll ? `${vName}: nur ${vTage} von ${vSoll} Tagen (${dm(v.von)}–${dm(v.bis)})` : null;
  const kwhF = (x) => `${n(x, 0)} kWh`, eurF = (x) => eur(x), pctF = (x) => `${n(x)} %`, kF = (x) => n(x, 1);

  // Verlauf je Woche/Monat
  const balken = verlauf.filter((w) => w.kwh_je_hgt != null && Number(w.kwh_je_hgt) > 0.3);
  const skala = Math.max((ziel ?? 0) * 1.6, ...balken.map((w) => Number(w.kwh_je_hgt)), 1);
  const hoehe = (x) => Math.round((150 * x) / skala);
  const abschnittName = (w) => (periode === 'jahr' ? MON[Number(w.von.slice(5, 7)) - 1] : `${dm(w.von)}–${dm(w.bis)}`);

  const zielSpeichern = async () => {
    const z = Number(String(zielEdit ?? '').replace(',', '.'));
    if (!Number.isFinite(z) || z <= 0 || z > 20) { setFehler('Ziel: bitte eine Zahl zwischen 0 und 20 eingeben.'); return; }
    const { error } = await supabase.from('muc_settings').update({ ziel_kwh_je_hgt: z }).eq('id', 1);
    if (error) { setFehler(`Ziel nicht gespeichert: ${error.message}`); return; }
    setZielEdit(null); laden();
  };

  const zielBreite = kwh != null && ziel != null ? (100 * kwh) / (ziel * 1.6) : 0;
  const zielBox = zielEdit == null ? (
    <button type="button" className="wsw-link" onClick={() => setZielEdit(ziel == null ? '' : String(ziel).replace('.', ','))}>{ziel == null ? 'Ziel festlegen' : 'Ziel ändern'}</button>
  ) : (
    <span className="wsw-row">
      <label htmlFor="wsw-ziel" className="small">kWh je Heizgradtag</label>
      <input id="wsw-ziel" className="wsw-input" inputMode="decimal" value={zielEdit} onChange={(e) => setZielEdit(e.target.value)} />
      <button type="button" className="btn small primary" onClick={zielSpeichern}>Speichern</button>
      <button type="button" className="btn small ghost" onClick={() => setZielEdit(null)}>Abbrechen</button>
    </span>
  );

  return (
    <div className="stack wsw">
      {leiste}
      <div>
        <div className="eyebrow">
          {b.titel} · {d.tage} {d.tage === 1 ? 'Tag' : 'Tage'} ({dm(d.von)}–{dm(d.bis)}){unvollstaendig && ' · läuft noch, zählt bis gestern'}
          {stand && <span className="wsw-normal"> · Stand {stand} Uhr</span>}
          {vAbdeckung && <span className="wsw-normal"> · {vAbdeckung}</span>}
        </div>
        <p className="wsw-fazit">{fazit.join(' ')}</p>
      </div>

      {/* 1 Wo stehen wir? */}
      <section className="stack" aria-labelledby="wsw-wo">
        <h3 id="wsw-wo" className="wsw-h"><span className="muted">1</span> Wo stehen wir?</h3>
        <div className="card">
          <div className="chart-title">{mitPreis ? 'Was kostet uns der Strom – und was spart die PV?' : 'Woher kam der Strom – und wie viel braucht die Heizung?'}</div>
          <div className="kpis kpis-4" style={{ marginTop: 10 }}>
            {mitPreis ? (
              <>
                <div><div className="eyebrow">Ohne PV hätten wir gezahlt</div><div className="tile-value">{eur(s.ohne_pv_eur)}</div><div className="muted small">{n(s.verbrauch_kwh)} kWh Verbrauch</div><Vgl jetzt={s.ohne_pv_eur} vor={vs?.ohne_pv_eur} tageJetzt={d.tage} tageVor={vTage} name={vName} jeTag format={eurF} nicht={keinEurVgl} /></div>
                <div><div className="eyebrow">PV hat gespart</div><div className="tile-value" style={{ color: 'var(--green)' }}>− {eur(s.pv_ersparnis_eur)}</div><div className="muted small">{n(pvSelbst)} kWh selbst genutzt</div><Vgl jetzt={s.pv_ersparnis_eur} vor={vs?.pv_ersparnis_eur} tageJetzt={d.tage} tageVor={vTage} name={vName} jeTag mehrBesser format={eurF} nicht={keinEurVgl} /></div>
                <div><div className="eyebrow">Netzstrom gezahlt</div><div className="tile-value">{eur(s.netz_eur)}</div><div className="muted small">{n(s.netz_kwh)} kWh aus dem Netz</div><Vgl jetzt={s.netz_eur} vor={vs?.netz_eur} tageJetzt={d.tage} tageVor={vTage} name={vName} jeTag format={eurF} nicht={keinEurVgl} /></div>
                <div><div className="eyebrow">davon für die Heizung</div><div className="tile-value" style={{ color: 'var(--c-heiz)' }}>{eur(s.heizung_netz_eur)}</div><div className="muted small">{n(s.heizung_netz_kwh)} kWh Heizstrom aus dem Netz (geschätzt)</div><Vgl jetzt={s.heizung_netz_eur} vor={vs?.heizung_netz_eur} tageJetzt={d.tage} tageVor={vTage} name={vName} jeTag format={eurF} nicht={keinEurVgl} /></div>
              </>
            ) : (
              <>
                <div><div className="eyebrow">Verbrauch</div><div className="tile-value">{kwhF(s.verbrauch_kwh)}</div><div className="muted small">Ø {n(Number(s.verbrauch_kwh) / d.tage, 1)} kWh je Tag</div><Vgl jetzt={s.verbrauch_kwh} vor={vs?.verbrauch_kwh} tageJetzt={d.tage} tageVor={vTage} name={vName} jeTag format={kwhF} nicht={keinVgl} /></div>
                <div><div className="eyebrow">Sonne selbst genutzt</div><div className="tile-value" style={{ color: 'var(--green)' }}>{kwhF(pvSelbst)}</div><div className="muted small">von {n(s.pv_kwh)} kWh PV</div><Vgl jetzt={pvSelbst} vor={vs ? Number(vs.pv_kwh) - Number(vs.einspeisung_kwh) : null} tageJetzt={d.tage} tageVor={vTage} name={vName} jeTag mehrBesser format={kwhF} nicht={keinVgl} /></div>
                <div><div className="eyebrow">Aus dem Netz</div><div className="tile-value">{kwhF(s.netz_kwh)}</div><div className="muted small">Ø {n(Number(s.netz_kwh) / d.tage, 1)} kWh je Tag</div><Vgl jetzt={s.netz_kwh} vor={vs?.netz_kwh} tageJetzt={d.tage} tageVor={vTage} name={vName} jeTag format={kwhF} nicht={keinVgl} /></div>
                <div><div className="eyebrow">davon für die Heizung</div><div className="tile-value" style={{ color: 'var(--c-heiz)' }}>{kwhF(s.heizung_netz_kwh)}</div><div className="muted small">Heizstrom aus dem Netz (geschätzt)</div><Vgl jetzt={s.heizung_netz_kwh} vor={vs?.heizung_netz_kwh} tageJetzt={d.tage} tageVor={vTage} name={vName} jeTag format={kwhF} nicht={keinVgl} /></div>
              </>
            )}
          </div>
          <div className="wsw-balken" role="img" aria-label={`${n(pvSelbst)} kWh Sonne selbst genutzt, ${n(restNetz)} kWh Netz für Warmwasser, Auto und Haus, ${n(heizNetz)} kWh Netz für die Heizung`}>
            <div style={{ width: pct(pvSelbst), background: 'var(--green)' }} />
            <div style={{ width: pct(restNetz), background: 'var(--c-rest)' }} />
            <div style={{ width: pct(heizNetz), background: 'var(--c-heiz)' }} />
          </div>
          <div className="srclegend muted">
            <span><i style={{ background: 'var(--green)' }} />Sonne selbst genutzt</span>
            <span><i style={{ background: 'var(--c-rest)' }} />Netz: Warmwasser, Auto, Haus ({n(restNetz)} kWh)</span>
            <span><i style={{ background: 'var(--c-heiz)' }} />Netz: Heizung – hier setzt die Steuerung an</span>
          </div>
          {!mitPreis && (
            <div className="muted small" style={{ marginTop: 8 }}>
              Euro-Beträge erscheinen, sobald ein Strompreis eingetragen ist.{' '}
              <button type="button" className="btn small" onClick={() => onNavigate('settings')}>Strompreis eintragen</button>
            </div>
          )}
          {preisTeil && <div className="muted small" style={{ marginTop: 8 }}>Strompreis gilt erst für {d.tage_preis} von {d.tage} Tagen – die Euro-Werte sind unvollständig.</div>}
          {mitPreis && s.grund_eur != null && <div className="muted small" style={{ marginTop: 8 }}>Kosten ohne Grundgebühr (in diesem Zeitraum {eur(s.grund_eur)}).</div>}
        </div>

        <div className="wsw-ampeln">
          <AmpelKarte ampel={sonne} label={sonne === 'gut' ? 'Gut' : sonne === 'neutral' ? 'Kaum Sonne' : 'Noch Potenzial'} frage="Nutzen wir den Sonnenstrom ganz?">
            {s.eigen_pct == null ? 'Keine PV-Erzeugung im Zeitraum.' : `${n(s.eigen_pct)} % des Sonnenstroms bleiben im Haus, ${n(s.einspeisung_kwh, 1)} kWh gingen ins Netz.`}
            <Vgl jetzt={s.eigen_pct} vor={vs?.eigen_pct} tageJetzt={d.tage} tageVor={vTage} name={vName} mehrBesser format={pctF} nicht={keinVgl} />
          </AmpelKarte>
          <AmpelKarte ampel={heiz} label={ziel == null ? 'Kein Ziel' : heiz === 'gut' ? 'Im Ziel' : 'Hier liegt das Potenzial'} frage="Wie viel Strom braucht die Heizung?">
            <b style={{ color: 'var(--ink)' }}>{n(kwh, 1)} kWh je Heizgradtag</b> – unser Maß, unabhängig vom Wetter.{ziel != null && ` Ziel ${n(ziel, 1)}.`}
            <span className="wsw-zeile">Heizstrom {n(s.heizung_kwh)} kWh: Netz {n(s.heizung_netz_kwh)} · Sonne {n(s.heizung_pv_kwh)} · Batterie {n(s.heizung_batt_kwh)} (geschätzt).</span>
            <Vgl jetzt={kwh} vor={vs?.kwh_je_hgt} tageJetzt={d.tage} tageVor={vTage} name={vName} format={kF} nicht={keinVgl} />
          </AmpelKarte>
          <AmpelKarte ampel={min} label={min === 'gut' ? 'Gehalten' : min === 'mittel' ? 'Fast gehalten' : min === 'neutral' ? 'Keine Raumwerte' : 'Nicht gehalten'} frage="Bleiben alle Räume über Min?">
            {minJeNacht == null ? 'Für diesen Zeitraum gibt es keine Raumwerte mehr (Raumwerte werden nach 90 Tagen gelöscht).'
              : `${n(s.h_unter_min)} Raum-Stunden unter Min (Ø ${n(minJeNacht, 1)} je Nacht), tagsüber ${n(normalJeTag)} Raum-Stunden je Tag unter Normal.`}
            <Vgl jetzt={minJeNacht} vor={vMin} tageJetzt={d.tage} tageVor={vTage} name={`${vName} Ø je Nacht`} format={kF} nicht={keinRaumVgl} />
          </AmpelKarte>
          {/* 24.11.2026: Modus-Namen wie Venediger (16.11.2026) */}
          <AmpelKarte ampel={planer} label={d.planer_modus === 'steuern' ? 'KI steuert' : d.planer_modus === 'aus' ? 'Planer (Regeln)' : 'KI rechnet mit'} frage="Wer steuert gerade?">
            {d.planer_modus === 'steuern'
              ? 'Die KI steuert – innerhalb der festen Regeln. Ob sie besser ist, zeigt die Gegenrechnung darunter.'
              : 'Die festen Regeln (Collector) steuern. Die Gegenrechnung darunter zeigt jeden Morgen, ob die KI besser wäre.'}
          </AmpelKarte>
        </div>

        {/* 24.11.2026 (wie Venediger 16.11.): Gegenrechnung jeden Morgen hier – darf die KI steuern? */}
        <KiGegenRegeln />
        {/* 25.11.2026 (wie Venediger): sehen, ob die KI über die Zeit besser vorhersagt */}
        <ModellGuete />
      </section>

      {/* 2 Wohin wollen wir? */}
      <section className="stack" aria-labelledby="wsw-wohin">
        <h3 id="wsw-wohin" className="wsw-h"><span className="muted">2</span> Wohin wollen wir?</h3>
        <div className="card wsw-ziele">
          <ZielZeile titel="Heizstrom je Heizgradtag senken" jetzt={n(kwh, 1)} ziel={ziel == null ? '–' : n(ziel, 1)}
            breite={zielBreite} marke={ziel == null ? null : 100 / 1.6} farbe={heiz === 'gut' ? 'gut' : 'mittel'}
            label={`Heizstrom je Heizgradtag: jetzt ${n(kwh, 1)}, Ziel ${ziel == null ? 'nicht festgelegt' : n(ziel, 1)}`}
            hinweis={<span className="wsw-row">
              {ziel == null ? 'Weniger ist besser. Ein Ziel ist noch nicht festgelegt – du bestimmst es selbst.' : 'Weniger ist besser, Strich = Ziel.'}
              {ziel != null && kwh != null && kwh > ziel && <> Im Ziel wären es rund {n(Number(s.heizung_kwh) * (1 - ziel / kwh))} kWh{mitPreis && s.heizung_netz_eur != null && Number(s.heizung_netz_kwh) > 0
                ? ` bzw. ${eur(Number(s.heizung_kwh) * (1 - ziel / kwh) * Number(s.heizung_netz_eur) / Number(s.heizung_netz_kwh))}` : ''} weniger in {d.tage} Tagen.</>}
              {zielBox}
            </span>} />
          <ZielZeile titel="Sonnenstrom im Haus nutzen" jetzt={`${n(s.eigen_pct)} %`} ziel="100 %"
            breite={Number(s.eigen_pct ?? 0)} farbe={sonne === 'gut' ? 'gut' : 'mittel'}
            label={`Sonnenstrom genutzt: ${n(s.eigen_pct)} Prozent, Ziel 100 Prozent`}
            hinweis={sonne === 'gut' ? 'Erreicht.' : undefined} />
          <ZielZeile titel="Kein Raum unter Min" jetzt={`${n(s.h_unter_min)} Raum-Stunden`} ziel="0"
            breite={minJeNacht != null ? Math.min(100, (100 * minJeNacht) / 12) : 0}
            farbe={min === 'gut' ? 'gut' : min === 'mittel' ? 'mittel' : 'schlecht'}
            label={`Raum-Stunden unter Min: ${n(s.h_unter_min)} in ${tageMin} Nächten, Ziel 0`}
            hinweis="Die Grenze, die nie unterschritten werden darf – Sparen darf nicht auf Kosten von Min gehen." />
        </div>
      </section>

      {/* 3 Wie kommen wir dahin? */}
      <section className="stack" aria-labelledby="wsw-wie">
        <h3 id="wsw-wie" className="wsw-h"><span className="muted">3</span> Wie kommen wir dahin?</h3>
        <div className="card stack">
          <div className="wsw-row wsw-zw">
            <strong>Was du jetzt ändern solltest – Vorschläge der KI</strong>
            <span className="muted small">Die KI ändert nichts selbst. Wirkung wird 3 Tage nach Übernahme gemessen.</span>
          </div>
          {ki.offen.length > 0
            ? ki.offen.map((v) => <VorschlagKarte key={v.id} v={v} onFertig={laden} />)
            : <div className="small">Die KI hat gerade keinen Vorschlag.</div>}
          {ki.entschieden.length > 0 && (
            <div>
              <div className="small"><strong>Haben frühere Vorschläge geholfen?</strong></div>
              <ul className="wsw-liste small">
                {ki.entschieden.map((e) => (
                  <li key={e.id}><span className="muted">{e.decided_at ? dm(e.decided_at.slice(0, 10)) : ''}</span> {e.title}{' – '}
                    <span className="muted">{e.effect_text || 'Wirkung wird nach 3 Tagen gemessen'}</span></li>
                ))}
              </ul>
            </div>
          )}
          <div><button type="button" className="btn small" onClick={() => onNavigate('ki')}>Alle Vorschläge und Hinweise</button></div>
        </div>

        <div className="card stack">
          <strong>So optimiert die Steuerung</strong>
          <div className="wsw-drei small">
            <div><div className="eyebrow">Sie weiß</div>Wie viel Sonne kommt (Prognose) und wie schnell jeder Raum auskühlt (Raummodell).</div>
            <div><div className="eyebrow">Sie hält ein</div>Nie unter Min. Normal, wenn Strom günstig da ist. Bis PV-Max nur mit Sonne.</div>
            <div><div className="eyebrow">Sie rechnet</div>Regelmäßig den Tagesplan mit dem wenigsten Netzstrom – bei Sonne Wärme in den Estrich „laden“.</div>
          </div>
          <div className="small">
            <strong>Was du drehen kannst</strong>
            <ul className="wsw-liste muted">
              <li><b style={{ color: 'var(--ink)' }}>Normal und Min je Raum</b> – je größer der Abstand, desto mehr kann der Planer verschieben. Faustwert: jedes Grad weniger spart etwa 6 % Heizstrom.</li>
              <li><b style={{ color: 'var(--ink)' }}>PV-Max je Raum</b> – wie viel Wärme bei Sonne „auf Vorrat“ in den Raum darf.</li>
              <li><b style={{ color: 'var(--ink)' }}>Steuerung „KI steuert“</b> – nur dann plant die KI selbst (Abschnitt Steuerung unten).</li>
            </ul>
            <button type="button" className="btn small" style={{ marginTop: 8 }} onClick={() => onNavigate('settings')}>Räume einstellen</button>
          </div>
        </div>
      </section>

      {/* Verlauf */}
      <section className="card" aria-labelledby="wsw-verlauf">
        <h3 id="wsw-verlauf" className="chart-title">Kommen wir voran? Heizstrom je Heizgradtag</h3>
        <div className="wsw-verlauf-kopf muted small">{periode === 'jahr' ? 'je Monat' : 'je Woche (Mo–So), letzte 8'} · niedriger ist besser{ziel != null && ` · gestrichelt = Ziel ${n(ziel, 1)}`} · darunter Netzstrom je Tag</div>
        {balken.length === 0 ? <div className="muted small">Noch keine Werte für den Verlauf.</div> : (
          <div className="wsw-verlauf" style={{ gridTemplateColumns: `repeat(${balken.length}, minmax(0, 1fr))` }}
            role="img" aria-label={`Heizstrom je Heizgradtag: ${balken.map((w) => `${abschnittName(w)} ${n(w.kwh_je_hgt, 1)}`).join(', ')}`}>
            {balken.map((w) => {
              const x = Number(w.kwh_je_hgt);
              return (
                <div key={w.von} className="wsw-spalte">
                  <span className="small"><b>{n(x, 1)}</b></span>
                  <div className="wsw-saeule-feld">
                    <div className="wsw-saeule" style={{ height: hoehe(x), background: ziel == null ? 'var(--c-heiz)' : x <= ziel ? 'var(--green)' : 'var(--sun)' }} />
                    {ziel != null && <div className="wsw-ziel" style={{ bottom: hoehe(ziel) }} aria-hidden="true" />}
                  </div>
                  <span className="muted small">{abschnittName(w)}{w.tage < (periode === 'jahr' ? 28 : 7) ? ` (${w.tage} T.)` : ''}</span>
                  <span className="small">{n(w.netz_kwh_je_tag, 1)} kWh/Tag</span>
                </div>
              );
            })}
          </div>
        )}
        {periode === 'woche' && d.tage_liste?.length > 0 && (
          <div className="muted small" style={{ marginTop: 8 }}>
            Diese {d.tage} Tage einzeln: {d.tage_liste.map((t) => `${wtag(t.tag)} ${n(t.kwh_je_hgt, 1)}`).join(' · ')}.
          </div>
        )}
      </section>
    </div>
  );
}
