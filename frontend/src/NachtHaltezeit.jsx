// Einstellungen → „Nacht und Haltezeit“ (24.11.2026, Collector 0.13, migration-016)
// Übernommen aus Heizung Venediger: Haus › Verteilung „Nachts früh abschalten“ (FIX-NACHT-NUR-MIN-2026-11-17)
// und Einstellungen › Haltezeiten (HaltezeitenCard.tsx, FIX-HIN-UND-HER-STUFE-A-2026-11-16).
// Unterschiede durch die Heizart: München schließt Ventile (Loxone) statt Thermostate auszuschalten; die Haltezeit
// lernt, wie lange die Wärmepumpe braucht, bis sie auf einen geöffneten Kreis anspringt. Doku: doc/NACHT-UND-HALTEZEIT-2026-11-24.md
import { useEffect, useState } from 'react';
import { supabase } from './supabase.js';
import { Klappkarte } from './Klapp.jsx';

const num = (v, d = 1) => (v == null ? '–' : Number(v).toLocaleString('de-DE', { minimumFractionDigits: d, maximumFractionDigits: d }));
const stand = (ts) => (ts ? new Date(ts).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Berlin' }) : '–');
const tagKurz = (d) => new Date(`${d}T12:00:00`).toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit' });

export default function NachtHaltezeit({ settings, rooms, saveHouse, busy }) {
  const [tage, setTage] = useState([]);
  const [naechte, setNaechte] = useState([]);
  const [fehlt, setFehlt] = useState(false);
  const [vorgabe, setVorgabe] = useState(settings.halte_min_vorgabe == null ? '' : String(settings.halte_min_vorgabe));
  const [spitze, setSpitze] = useState(settings.nacht_spitze_c == null ? '0,1' : num(settings.nacht_spitze_c));

  useEffect(() => {
    (async () => {
      const { data, error } = await supabase.rpc('muc_hin_und_her_tage', { p_tage: 7 });
      if (error && /muc_hin_und_her_tage|PGRST202/.test(error.message)) { setFehlt(true); return; }
      setTage(data || []);
      const { data: n } = await supabase.from('muc_nacht_haus').select('*').order('night', { ascending: false }).limit(10);
      setNaechte(n || []);
    })();
  }, []);

  if (fehlt || settings.nacht_frueh_aus === undefined) {
    return (
      <Klappkarte id="einstellungen-nacht-halte" titel="Nacht und Haltezeit" standardAuf={false}>
        <div className="alert">Bitte zuerst <strong>supabase/migration-016-nacht-haltezeit.sql</strong> in Supabase ausführen.</div>
      </Klappkarte>
    );
  }

  const gelernt = settings.halte_min_gelernt ?? 15;
  const wirksam = settings.halte_min_vorgabe ?? gelernt;
  const zahl = (s) => (String(s).trim() === '' ? null : Number(String(s).replace(',', '.')));
  const v = zahl(vorgabe);
  const sp = zahl(spitze);
  const vOk = v == null || (Number.isFinite(v) && v >= 0 && v <= 60);
  const spOk = sp != null && Number.isFinite(sp) && sp >= 0 && sp <= 1;
  const heute = tage.length ? tage[tage.length - 1] : null;
  const mitUeberlauf = rooms.filter((r) => r.enabled);

  return (
    <Klappkarte id="einstellungen-nacht-halte" titel="Nacht und Haltezeit" sub="nachts nur Untergrenze, kein Hin und Her"
      sum={`früh zu ${settings.nacht_frueh_aus ? 'an' : 'aus'} · Haltezeit ${wirksam} min${heute ? ` · Hin und Her heute ${num(heute.anteil)} %` : ''}`}
      standardAuf={false}>
      <p className="muted small">
        Grundsatz (wie Venediger): <strong>Ohne Sonne nur die Untergrenze halten, nie den Estrich laden.</strong> Den Estrich
        laden wir tagsüber mit PV-Überschuss.
      </p>

      <div className="switch-row">
        <div>
          <div><strong>Ohne Sonne früh zu</strong></div>
          <div className="muted small">
            Nachts, abends und am Wartetag: Ist ein Ventil offen und erreicht der Raum mit seinem gemessenen Überlauf die
            Untergrenze + {num(settings.nacht_spitze_c, 1)} °C, setzt die App den Sollwert unter das Ist – Loxone schließt das
            Ventil. Nie unter der Untergrenze. Danach 20 min Ruhe, außer der Raum fällt unter die Untergrenze.
          </div>
        </div>
        <button className={`toggle ${settings.nacht_frueh_aus ? 'on' : ''}`} disabled={busy}
          onClick={() => saveHouse({ nacht_frueh_aus: !settings.nacht_frueh_aus, ...(settings.nacht_frueh_aus ? {} : { nacht_frueh_aus_seit: new Date().toISOString() }) })}>
          {settings.nacht_frueh_aus ? 'An' : 'Aus'}
        </button>
      </div>

      <div className="fields">
        <label className="field">
          <span>Ohne Sonne höchstens Untergrenze +</span>
          <span className="field-input"><input inputMode="decimal" value={spitze} onChange={(e) => setSpitze(e.target.value)} /><span className="unit">°C</span></span>
        </label>
        <label className="field">
          <span>Haltezeit (leer = automatisch, 0 = aus)</span>
          <span className="field-input"><input inputMode="numeric" placeholder={`automatisch (${gelernt})`} value={vorgabe} onChange={(e) => setVorgabe(e.target.value)} /><span className="unit">min</span></span>
        </label>
      </div>
      <p className="muted small">
        <strong>Haltezeit gelernt: {gelernt} min</strong> – so lange braucht die Wärmepumpe im Mittel, bis sie auf einen
        geöffneten Kreis anspringt ({settings.halte_min_basis ?? 0} Messungen, 14 Tage, Stand {stand(settings.halte_min_stand)}).
        Wer einen Kreis bekommt, behält ihn mindestens so lange; ein gerade geschlossenes Ventil gilt so lange noch als belegt.
        Räume unter der Untergrenze gehen weiter vor, die Netzgrenze gilt immer. {settings.halte_min_vorgabe != null && <>Aktiv: eigene Vorgabe {settings.halte_min_vorgabe} min.</>}
      </p>
      {(!vOk || !spOk) && <div className="alert">Haltezeit 0–60 min oder leer, „höchstens Untergrenze +“ 0–1 °C.</div>}
      <button className="btn primary" disabled={busy || !vOk || !spOk}
        onClick={() => saveHouse({ halte_min_vorgabe: v == null ? null : Math.round(v), nacht_spitze_c: Math.round(sp * 100) / 100 })}>
        Speichern
      </button>

      <div className="eyebrow" style={{ marginTop: 16 }}>Gemessener Überlauf je Raum (7 Tage, ohne Sonne)</div>
      <table className="ptable">
        <thead><tr><th>Raum</th><th>Untergrenze</th><th>Überlauf</th><th>Abschaltungen</th></tr></thead>
        <tbody>{mitUeberlauf.map((r) => (
          <tr key={r.id}>
            <td>{r.name}</td><td>{num(r.temp_night)} °C</td>
            <td>{r.ueberlauf_c == null ? <span className="muted">– (wie bisher)</span> : `${num(r.ueberlauf_c, 2)} °C`}</td>
            <td className="muted">{r.ueberlauf_n ?? 0}</td>
          </tr>
        ))}</tbody>
      </table>
      <p className="muted small">Überlauf = so weit steigt der Raum nach „Ventil zu“ noch. Unter 3 Abschaltungen gilt für den Raum die alte Regel.</p>

      {tage.length > 0 && (
        <>
          <div className="eyebrow" style={{ marginTop: 16 }}>Hin und Her (Befehl A → B → A innerhalb 15 min), Ziel unter 2 %</div>
          <table className="ptable">
            <thead><tr><th>Tag</th><th>Befehle</th><th>Hin und Her</th><th>Anteil</th><th>früh zu</th></tr></thead>
            <tbody>{tage.map((t) => (
              <tr key={t.tag}>
                <td>{tagKurz(t.tag)}</td><td>{t.befehle}</td><td>{t.hin_und_her}</td>
                <td className={Number(t.anteil) < 2 ? 'good-text' : ''}>{num(t.anteil)} %</td><td>{t.frueh_zu}</td>
              </tr>
            ))}</tbody>
          </table>
        </>
      )}

      {naechte.length > 0 && (
        <>
          <div className="eyebrow" style={{ marginTop: 16 }}>Nächte ({settings.night_start}–{settings.morning_start}) – Erfolgskontrolle</div>
          <table className="ptable">
            <thead><tr><th>Nacht</th><th>Wärmepumpe</th><th>aus Netz</th><th>je Heizgradtag</th><th>Räume nachgeheizt</th><th>Spitze über Untergrenze</th><th>früh zu</th></tr></thead>
            <tbody>{naechte.map((n) => (
              <tr key={n.night}>
                <td>{tagKurz(n.night)}{n.frueh_aus_an ? ' ✓' : ''}</td>
                <td>{num(n.heat_kwh)} kWh</td><td>{num(n.heat_grid_kwh)} kWh</td><td>{num(n.kwh_je_hgt, 2)} kWh</td>
                <td>{n.rooms_heated ?? '–'}</td><td>{n.peak_avg == null ? '–' : `${num(n.peak_avg, 2)} °C`}</td><td>{n.frueh_zu ?? 0}</td>
              </tr>
            ))}</tbody>
          </table>
          <p className="muted small">✓ = Nacht mit „früh zu“. Die KI vergleicht ab 3 solchen Nächten mit den Nächten davor (Tab KI, Rückblick).</p>
        </>
      )}
    </Klappkarte>
  );
}
