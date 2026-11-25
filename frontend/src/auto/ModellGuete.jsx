// „Wo stehen wir?“ › Lernt das Modell dazu? (25.11.2026) – ÜBERNOMMEN aus Heizung Venediger (src/components/ki/ModellGuete.tsx)
// Uli: „Lernt das Modell dazu ist wichtig.“ – Jede Nacht sagt das Modell von gestern die seither gemessenen Stunden
// 12 h voraus (nie gesehen). Maßstab „bleibt gleich“: Ist das Modell schlechter, hat es für diesen Raum noch nichts
// Brauchbares gelernt.
// Daten: muc_heizmodell_guete (migration-019, geschrieben von heizplaner-muenchen aktion „lernen“ ~03:00).
import { useEffect, useState } from 'react';
import { supabase } from '../supabase.js';

const TAGE = 14;
const n2 = (v) => (v == null || !Number.isFinite(Number(v)) ? '–'
  : Number(v).toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const mittel = (xs) => (xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length : NaN);
const dm = (iso) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}.`;

/** Kleine Verlaufslinie: Abweichung je Nacht, gestrichelt „bleibt gleich“ (Mittel). */
function Linie({ werte, gleich, gut }) {
  const W = 110, H = 22;
  const da = werte.map((v) => (v == null ? null : Number(v)));
  const mx = Math.max(gleich, ...da.filter((v) => v != null)) * 1.15 || 1;
  const x = (i) => (werte.length < 2 ? W / 2 : (i / (werte.length - 1)) * W);
  const y = (v) => H - (v / mx) * H;
  const farbe = gut ? 'var(--green)' : 'var(--sun)';
  const punkte = da.map((v, i) => (v == null ? null : `${x(i).toFixed(1)},${y(v).toFixed(1)}`)).filter(Boolean).join(' ');
  return (
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} aria-hidden="true">
      <line x1="0" x2={W} y1={y(gleich)} y2={y(gleich)} stroke="var(--muted)" strokeOpacity="0.6" strokeDasharray="3 3" strokeWidth="1" />
      {da.filter((v) => v != null).length > 1
        ? <polyline points={punkte} fill="none" strokeWidth="1.5" stroke={farbe} />
        : da.map((v, i) => (v == null ? null : <circle key={i} cx={x(i)} cy={y(v)} r="2" fill={farbe} />))}
    </svg>
  );
}

function Kachel({ label, wert, unter, ton }) {
  return (
    <div className="mg-kachel">
      <div className="muted small">{label}</div>
      <div className="mg-wert">{wert}</div>
      <div className="small" style={{ color: ton ?? 'var(--muted)' }}>{unter}</div>
    </div>
  );
}

export default function ModellGuete() {
  const [zeilen, setZeilen] = useState(null);
  const [fehler, setFehler] = useState(null);
  useEffect(() => {
    const ab = new Date(Date.now() - (2 * TAGE + 1) * 86400000).toISOString().slice(0, 10);   // + Vorwoche zum Vergleich
    supabase.from('muc_heizmodell_guete').select('tag, room_id, raum, fehler_12h, gleich_12h, n').gte('tag', ab).order('tag')
      .then(({ data, error }) => {
        if (error) setFehler(/muc_heizmodell_guete/.test(error.message) ? 'Bitte supabase/migration-019-modell-guete.sql ausführen.' : error.message);
        else { setFehler(null); setZeilen(data ?? []); }
      });
  }, []);

  const kopf = (
    <div style={{ flex: '1 1 320px' }}>
      <div className="chart-title">Lernt das Modell dazu?</div>
      <div className="muted small" style={{ marginTop: 4 }}>
        Wie genau hat das Modell von gestern die Raumtemperatur 12 h im Voraus getroffen – für Stunden, die es beim Lernen
        noch nicht kannte? Maßstab: „bleibt gleich“.
      </div>
    </div>
  );
  if (fehler) return <div className="card">{kopf}<div className="notice-warn small" style={{ marginTop: 8 }}>Vorhersage-Güte nicht ladbar: {fehler}</div></div>;
  if (!zeilen) return <div className="muted small">Lade Vorhersage-Güte …</div>;
  if (!zeilen.length) return (
    <div className="card">{kopf}
      <div className="small" style={{ marginTop: 8 }}>Noch keine Werte – die erste Prüfung läuft beim nächtlichen Lernen (~03:00).</div>
    </div>
  );

  const tage = [...new Set(zeilen.map((z) => z.tag))].sort();
  const letzter = tage[tage.length - 1];
  const fenster = tage.slice(-TAGE);
  const heute = zeilen.filter((z) => z.tag === letzter && z.fehler_12h != null && z.gleich_12h != null);
  const fM = mittel(heute.map((z) => Number(z.fehler_12h))), gM = mittel(heute.map((z) => Number(z.gleich_12h)));
  const besser = heute.filter((z) => Number(z.fehler_12h) < Number(z.gleich_12h)).length;
  // Vorwoche: Mittel der Nächte 7–13 Tage vor dem letzten Tag gegen die letzten 7 Nächte
  const tagNr = (iso) => Math.round(new Date(`${iso}T12:00:00Z`).getTime() / 86400000);
  const nL = tagNr(letzter);
  const fIn = (von, bis) => mittel(zeilen.filter((z) => z.fehler_12h != null && nL - tagNr(z.tag) >= von && nL - tagNr(z.tag) <= bis).map((z) => Number(z.fehler_12h)));
  const diese = fIn(0, 6), vorher = fIn(7, 13);
  const trend = Number.isFinite(diese) && Number.isFinite(vorher) ? diese - vorher : NaN;
  const genauer = Number.isFinite(fM) && Number.isFinite(gM) && gM > 0 ? Math.round(100 * (1 - fM / gM)) : NaN;
  const raeume = [...new Map(zeilen.map((z) => [z.room_id, z.raum ?? '–'])).entries()]
    .map(([id, name]) => {
      const h = heute.find((z) => z.room_id === id);
      const reihe = fenster.map((t) => zeilen.find((z) => z.room_id === id && z.tag === t)?.fehler_12h ?? null);
      const gl = mittel(zeilen.filter((z) => z.room_id === id && z.gleich_12h != null && fenster.includes(z.tag)).map((z) => Number(z.gleich_12h)));
      return { id, name, h, reihe, gl };
    })
    .sort((a, b) => Number(a.h?.fehler_12h ?? 9) - Number(b.h?.fehler_12h ?? 9));
  const pruefen = heute.length - besser;

  return (
    <div className="card stack">
      <div className="wsw-row wsw-zw" style={{ alignItems: 'flex-start' }}>
        {kopf}
        <span className="muted small" style={{ whiteSpace: 'nowrap' }}>geprüft {dm(letzter)}</span>
      </div>
      <div className="mg-kacheln">
        <Kachel label="Abweichung 12 h" wert={`${n2(fM)} °C`}
          unter={Number.isFinite(trend) ? `${trend <= 0 ? '−' : '+'}${n2(Math.abs(trend))} °C ggü. Vorwoche` : 'Vorwoche noch ohne Werte'}
          ton={Number.isFinite(trend) ? (trend <= 0 ? 'var(--green)' : 'var(--sun)') : undefined} />
        <Kachel label="„bleibt gleich“" wert={`${n2(gM)} °C`}
          unter={Number.isFinite(genauer) ? (genauer >= 0 ? `Modell ${genauer} % genauer` : `Modell ${-genauer} % ungenauer`) : '–'} />
        <Kachel label="Räume besser als „gleich“" wert={`${besser} von ${heute.length}`}
          unter={pruefen > 0 ? `${pruefen} ${pruefen === 1 ? 'Raum' : 'Räume'} prüfen` : 'alle besser'}
          ton={pruefen > 0 ? 'var(--sun)' : 'var(--green)'} />
      </div>
      <div style={{ overflowX: 'auto' }}>
        <table className="mg-tabelle small">
          <caption className="sr-only">Vorhersage-Güte je Raum: Abweichung nach 12 h, Vergleich bleibt gleich, Verlauf</caption>
          <thead className="muted">
            <tr><th>Raum</th><th className="r">Modell</th><th className="r">gleich</th>
              <th>{fenster.length} {fenster.length === 1 ? 'Nacht' : 'Nächte'}</th><th className="r">Stand</th></tr>
          </thead>
          <tbody>
            {raeume.map((r) => {
              const gut = r.h != null && Number(r.h.fehler_12h) < Number(r.h.gleich_12h);
              return (
                <tr key={r.id}>
                  <td>{r.name}</td>
                  <td className="r"><b>{n2(r.h?.fehler_12h)}</b></td>
                  <td className="r muted">{n2(r.h?.gleich_12h)}</td>
                  <td>{Number.isFinite(r.gl) ? <Linie werte={r.reihe} gleich={r.gl} gut={gut} /> : null}</td>
                  <td className="r">
                    {r.h == null ? <span className="muted">ohne Wert</span>
                      : <span className={`pill ${gut ? 'green' : 'sun'}`}>{gut ? 'besser' : 'prüfen'}</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="muted small">
        Geprüft jede Nacht vor dem Neu-Lernen (~03:00): Das Modell vom Vortag sagt jede Stunde seit seinem Lernen 12 h voraus
        und wird mit der gemessenen Temperatur verglichen. Linie = Abweichung je Nacht, gestrichelt = „bleibt gleich“.
        „Prüfen“: Für diesen Raum sagt das Modell schlechter voraus, als wenn man nichts vorhersagt – dort lernt es noch
        etwas Falsches. Ändert nichts an der Steuerung.
      </div>
    </div>
  );
}
