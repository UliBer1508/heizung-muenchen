// Auto-Steuerung › Plan – 12.11.2026, Stand Venediger 24.11.2026 (Modus-Etikett, Plan-Prüfung, Gegenrechnung „Wärme ausgeglichen“)
// ÜBERNOMMEN aus Heizung Venediger (src/components/ki/PlanerView.tsx + RaumModellView.tsx, Commit af244ae).
// Zeigt, was der Planer (Edge Function heizplaner-muenchen) plant – bei „KI steuert“ setzt der Collector das um:
//   1. Plan der nächsten 24 h: PV-Vorhersage, geplante Heizung, Netzbezug + Batterie
//   2. Jetzt: je Raum Planer vs. heutige Steuerung (Collector) – „heizt“ = Ventil offen
//   3. Zeitleiste je Raum (halbe Stunden)
//   4. Gegenrechnung der Vortage: heutige Steuerung vs. Planer bei gleicher Sonne
//   5. Raummodell: was der Planer über jeden Raum gelernt hat
import { Fragment, useEffect, useMemo, useState } from 'react';
import { Area, CartesianGrid, ComposedChart, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { supabase } from '../supabase.js';
import { ACHSE, Kachel, TIP, hm, num, tagKurz } from './teile.jsx';

function usePlaner() {
  const [plan, setPlan] = useState(null);
  const [vergleich, setVergleich] = useState([]);
  const [modell, setModell] = useState([]);
  const [fehler, setFehler] = useState(null);
  useEffect(() => {
    let alive = true;
    const load = async () => {
      const [p, v, m] = await Promise.all([
        supabase.from('muc_heizplan').select('*').order('erstellt_at', { ascending: false }).limit(1),
        supabase.from('muc_heizplan_vergleich').select('*').order('tag', { ascending: false }).limit(7),
        supabase.from('muc_heizmodell').select('*'),
      ]);
      if (!alive) return;
      if (p.error) setFehler(/muc_heizplan/.test(p.error.message) ? 'Bitte supabase/migration-014-auto-steuerung.sql ausführen.' : p.error.message);
      setPlan((p.data ?? [])[0] ?? null);
      setVergleich(v.data ?? []);
      setModell(m.data ?? []);
    };
    load();
    const id = setInterval(() => { if (document.visibilityState === 'visible') load(); }, 5 * 60_000);
    return () => { alive = false; clearInterval(id); };
  }, []);
  return { plan, vergleich, modell, fehler };
}

function PlanChart({ plan }) {
  const data = useMemo(() => plan.pv.map((_, i) => ({
    t: hm((plan.start + i * 900) * 1000),
    pv: Math.round(plan.pv[i] / 100) / 10, heiz: Math.round(plan.heiz[i] / 100) / 10, netz: Math.round(plan.netz[i] / 100) / 10,
    bat: plan.bat[i],
  })), [plan]);
  return (
    <div>
      <div className="chart-title">Leistung in den nächsten 24 h (kW)</div>
      <div className="auto-chart">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -16 }}>
            <CartesianGrid stroke="var(--grid)" strokeDasharray="2 4" vertical={false} />
            <XAxis dataKey="t" interval={11} tick={ACHSE} tickLine={false} axisLine={false} />
            <YAxis tick={ACHSE} tickLine={false} axisLine={false} />
            <Tooltip {...TIP} formatter={(v, n) => [`${num(v)} kW`, n]} cursor={{ stroke: 'var(--muted)', strokeWidth: 1 }} />
            <Legend wrapperStyle={{ fontSize: 12 }} iconType="plainline" />
            <Area type="stepAfter" dataKey="pv" name="PV-Vorhersage" stroke="var(--c-pv)" strokeWidth={2} fill="var(--c-pv)" fillOpacity={0.12} dot={false} isAnimationActive={false} />
            <Line type="stepAfter" dataKey="heiz" name="Wärmepumpe (geplant)" stroke="var(--c-heiz)" strokeWidth={2} dot={false} isAnimationActive={false} />
            <Line type="stepAfter" dataKey="netz" name="Netzbezug" stroke="var(--c-netz)" strokeWidth={2} dot={false} isAnimationActive={false} />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      <div className="chart-title" style={{ marginTop: 12 }}>Batterie-Ladung (kWh)</div>
      <div className="auto-chart klein">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: -16 }}>
            <CartesianGrid stroke="var(--grid)" strokeDasharray="2 4" vertical={false} />
            <XAxis dataKey="t" interval={11} tick={ACHSE} tickLine={false} axisLine={false} />
            <YAxis tick={ACHSE} tickLine={false} axisLine={false} domain={[0, 'dataMax']} />
            <Tooltip {...TIP} formatter={(v) => [`${num(v)} kWh`, 'Batterie']} cursor={{ stroke: 'var(--muted)', strokeWidth: 1 }} />
            <Line type="monotone" dataKey="bat" name="Batterie" stroke="var(--c-bat)" strokeWidth={2} dot={false} isAnimationActive={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

function Zeitleiste({ plan }) {
  const blocks = Math.ceil(plan.pv.length / 2);
  const labels = Array.from({ length: blocks }, (_, b) => hm((plan.start + b * 1800) * 1000));
  return (
    <div className="plan-wrap">
      <div className="chart-title">Wann heizt welcher Raum? (je Kästchen eine halbe Stunde)</div>
      <table className="auto-zeitleiste">
        <tbody>
          {plan.raeume.map((r) => (
            <tr key={r.id}>
              <td className="muted">{r.name}</td>
              {Array.from({ length: blocks }, (_, b) => {
                const an = r.h[b * 2] === '1';
                const t = r.t[Math.min(r.t.length - 1, b * 2 + 1)];
                return <td key={b} title={`${r.name} · ${labels[b]} · ${an ? 'heizt' : 'aus'} · ${num(t)} °C`} className={an ? 'kast an' : 'kast'} />;
              })}
            </tr>
          ))}
          <tr>
            <td />
            {labels.map((l, b) => <td key={b} className="zeit">{b % 4 === 0 ? l.slice(0, 2) : ''}</td>)}
          </tr>
        </tbody>
      </table>
    </div>
  );
}

// Abfall in h Stunden ohne Heizen ab T bei Außentemperatur a: Ziel ist T∞ = a + c/k (wie Venediger RaumModellView).
// Neues Modell (param.v = 2, zwei Speicher): Raumluft und Estrich kühlen gemeinsam aus, also langsamer (k / (1 + r)).
const abfall = (p, t, a, h = 10) => {
  if (!p || !(p.k > 0)) return null;
  const tInf = a + (p.c || 0) / p.k;
  const rate = p.v === 2 ? p.k / (1 + (p.r ?? 0)) : p.k;
  return (t - tInf) * (1 - Math.exp(-rate * h));
};
const aufheizen = (p) => (p ? (p.v === 2 ? p.auf ?? null : p.g) : null);

function RaumModell({ modell, rooms }) {
  const prio = new Map(rooms.map((r) => [r.id, (r.priority ?? 9) * 100 + (r.sort ?? 0)]));
  const liste = [...modell].sort((x, y) => (prio.get(x.room_id) ?? 999) - (prio.get(y.room_id) ?? 999));
  const normal = (id) => Number(rooms.find((r) => r.id === id)?.temp_normal ?? 21);
  const gelernt = modell.map((m) => m.gelernt_at).filter(Boolean).sort().pop();
  return (
    <div className="stack">
      <div className="muted small">
        Das Raummodell lernt jede Nacht um 3 Uhr aus den letzten 30 Tagen je Raum: wie schnell er nach draußen auskühlt,
        wie schnell er bei offenem Ventil wärmer wird (über den Estrich verzögert), wie viel die Sonne bringt und wie viel Wärme
        aus Nachbarräumen kommt. Räume mit wenig Heizdaten lehnen sich an die anderen an.
        {gelernt && ` Zuletzt gelernt ${new Date(gelernt).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}.`}
      </div>
      {liste.length === 0 ? <div className="muted small">Noch kein Raummodell gelernt (der Planer lernt täglich um 3 Uhr).</div> : (
        <div className="plan-wrap">
          <table className="ptable">
            <thead>
              <tr><th>Raum</th><th>−10 h bei 0 °C</th><th>−10 h bei −10 °C</th><th>Aufheizen</th><th>Strom je Kreis</th><th>Fehler 12 h</th></tr>
            </thead>
            <tbody>
              {liste.map((m) => {
                const t = normal(m.room_id);
                const a0 = abfall(m.param, t, 0), a10 = abfall(m.param, t, -10);
                const gut = m.fehler_12h != null && m.gleich_12h != null && Number(m.fehler_12h) < Number(m.gleich_12h);
                return (
                  <tr key={m.room_id}>
                    <td>{m.raum}{m.prior && <span className="muted small" title={`nur ${num(m.heiz_std)} h Heizdaten – an die anderen Räume angelehnt`}> · angelehnt</span>}</td>
                    <td>{a0 == null ? '–' : `${num(a0)} °C`}</td>
                    <td>{a10 == null ? '–' : `${num(a10)} °C`}</td>
                    <td>{aufheizen(m.param) == null ? '–' : `${num(aufheizen(m.param), 2)} °C/h`}</td>
                    <td>{m.p_w == null ? '–' : `${num(m.p_w, 0)} W`}</td>
                    <td title={`Modell ${num(m.fehler_12h)} °C · „bleibt gleich“ ${num(m.gleich_12h)} °C`}>
                      {m.fehler_12h == null ? '–' : `${num(m.fehler_12h)} °C`}{m.gleich_12h != null && <span className={gut ? 'good-text' : 'muted'}> ({num(m.gleich_12h)})</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div className="muted small plan-help">
            „−10 h“: so viel kühlt der Raum in 10 Stunden ohne Heizen ab Normal aus. „Aufheizen“: so schnell wird er bei offenem Ventil wärmer.
            „Strom je Kreis“: so viel Strom braucht die Wärmepumpe für diesen Raum (gemessen aus den Heizläufen, sonst 400 W).
            „Fehler 12 h“: mittlere Abweichung der Vorhersage über 12 Stunden, in Klammern „Temperatur bleibt gleich“ – grün, wenn das Modell besser ist.
          </div>
        </div>
      )}
    </div>
  );
}

export default function Plan({ rooms }) {
  const { plan, vergleich, modell, fehler } = usePlaner();
  const [modellAuf, setModellAuf] = useState(false);
  if (fehler) return <div className="alert">{fehler}</div>;
  if (!plan) {
    return (
      <div className="muted small">
        Noch kein Plan. Der Planer rechnet alle 15 Minuten, sobald die Edge Function <span className="mono">heizplaner-muenchen</span> deployt
        ist und der Collector 0.12 läuft (doc/INBETRIEBNAHME.md, Abschnitt 16).
      </div>
    );
  }
  const alt = Date.now() - new Date(plan.erstellt_at).getTime() > 40 * 60_000;
  const uneinig = plan.jetzt.filter((j) => j.auto && !j.manuell && j.pruefung_ok !== false && j.plan_heizt !== j.steuerung_heizt).length;
  const auffaellig = plan.jetzt.filter((j) => j.pruefung_ok === false).length;
  const v0 = vergleich[0];

  return (
    <div className="stack">
      <div className="auto-kopf">
        <div className="small">
          {/* Venediger 13./16.11.2026: Etikett nach dem Modus, mit dem der Plan gerechnet wurde */}
          <span className={`pill ${plan.modus === 'steuern' ? 'green' : 'neutral'}`}>
            {plan.modus === 'steuern' ? 'KI steuert' : plan.modus === 'aus' ? 'Planer (Regeln)' : 'KI rechnet mit · steuert nicht'}
          </span>{' '}
          {auffaellig > 0 && <strong className="warn-text">{auffaellig} {auffaellig === 1 ? 'Raum' : 'Räume'} auffällig → Regel-Steuerung · </strong>}
          Plan von {hm(new Date(plan.erstellt_at).getTime())}{alt && <strong className="warn-text"> · veraltet</strong>}
        </div>
        <div className="muted small">PV nachgeführt ×{num(plan.nachfuehrung, 2)}</div>
      </div>
      <section className="kpis kpis-4">
        <Kachel k="PV 24 h" v={`${num(plan.pv_kwh)} kWh`} s="Vorhersage" />
        <Kachel k="Heizen" v={`${num(plan.heiz_kwh)} kWh`} s="geplant (Wärmepumpe)" />
        <Kachel k="Netz" v={`${num(plan.netz_kwh)} kWh`} s="geplant" />
        <Kachel k="unter Ziel" v={`${num(plan.unter_ziel_gradstd)} °C·h`} s={`unter Untergrenze ${num(plan.unter_grenze_gradstd)}`} />
      </section>
      <PlanChart plan={plan.plan} />

      <div>
        <div className="chart-title">Jetzt: KI und Regel-Steuerung <span className="muted small">· {uneinig > 0 ? `${uneinig} ${uneinig === 1 ? 'Raum' : 'Räume'} verschieden` : 'einig'}</span></div>
        <div className="plan-wrap">
          <table className="ptable auto-links">
            <thead><tr><th>Raum</th><th>Ist</th><th>KI</th><th>Jetzt</th><th>KI als Nächstes</th></tr></thead>
            <tbody>
              {plan.jetzt.map((j) => {
                const geprueft = j.pruefung_ok !== false;
                const anders = j.auto && !j.manuell && geprueft && j.plan_heizt !== j.steuerung_heizt;
                return (
                  <Fragment key={j.room_id}>
                    <tr className={anders ? 'auto-anders' : !geprueft ? 'auto-auffaellig' : ''}>
                      <td>{j.name}</td>
                      <td>{num(j.t)} °C</td>
                      <td>{j.plan_heizt ? 'heizt' : '–'}</td>
                      <td>{j.manuell ? 'manuell' : !j.auto ? 'Automatik aus' : j.steuerung_heizt ? 'heizt' : '–'}{!geprueft && <span className="warn-text small"> · Regel-Steuerung</span>}</td>
                      <td className="muted">
                        {j.plan_heizt ? (j.bis ? `heizt bis ${hm(new Date(j.bis).getTime())}` : 'heizt durch') : j.naechst_an ? `heizt ab ${hm(new Date(j.naechst_an).getTime())}` : 'heizt in 24 h nicht'}
                        {` · ${num(j.t_min)}–${num(j.t_max)} °C`}
                      </td>
                    </tr>
                    {(!geprueft || j.hinweis) && (
                      <tr className={!geprueft ? 'auto-auffaellig' : ''}>
                        <td colSpan={5} className="muted small">
                          {!geprueft && <>Prüfung: {(j.pruefung ?? []).join(' · ')}</>}
                          {j.hinweis && <>{!geprueft ? ' · ' : ''}Hinweis: {j.hinweis}</>}
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
        <div className="muted small">„heizt“ = Ventil offen. „Jetzt“ = was der Collector gerade macht (Regel-Steuerung, bei „KI steuert“ nach Plan).
          Jeder Plan wird je Raum gegen die Messwerte geprüft – heizt er länger als nötig, aus dem Netz über das Ziel oder übersteuerst du den Raum oft, steuert die Regel-Steuerung diesen Raum (mindestens 2 h).</div>
      </div>

      <Zeitleiste plan={plan.plan} />

      <div>
        <div className="chart-title">Gegenrechnung: Was hätte der Planer an den letzten Tagen gemacht?</div>
        <div className="muted small">Gleiche Sonne, gleiches Wetter, gleiche Temperaturen um Mitternacht. Beide im selben Raummodell gerechnet; „unter Ziel“ = Grad·Stunden unter dem Ziel des Raums, summiert über alle Räume. „Wärme ausgeglichen“: Netz des Planers abzüglich der Wärme, die er am Tagesende mehr im Estrich hat als die Steuerung (oder zuzüglich, wenn weniger).</div>
        {vergleich.length === 0 ? <div className="muted small">Noch keine Gegenrechnung – kommt jede Nacht um 03:00.</div> : (
          <div className="plan-wrap">
            <table className="ptable auto-links">
              <thead><tr><th>Tag</th><th>Netz gemessen</th><th>Heutige Steuerung</th><th>Planer</th><th>Planer, Wärme ausgeglichen</th></tr></thead>
              <tbody>
                {vergleich.map((v) => (
                  <tr key={v.tag}>
                    <td>{tagKurz(v.tag)}</td>
                    <td>{num(v.netz_gemessen_kwh)} kWh</td>
                    <td>{num(v.steuerung?.heiz_kwh)} kWh Heizen · {num(v.steuerung?.netz_kwh)} Netz<br /><span className="muted small">unter Ziel {num(v.steuerung?.unter_ziel_gradstd, 0)} · unter Untergrenze {num(v.steuerung?.unter_grenze_gradstd, 0)} °C·h</span></td>
                    <td>{num(v.planer?.heiz_kwh)} kWh Heizen · {num(v.planer?.netz_kwh)} Netz<br /><span className="muted small">unter Ziel {num(v.planer?.unter_ziel_gradstd, 0)} · unter Untergrenze {num(v.planer?.unter_grenze_gradstd, 0)} °C·h</span></td>
                    <td>{v.planer?.netz_bereinigt_kwh != null
                      ? <>{num(v.planer.netz_bereinigt_kwh)} kWh Netz<br /><span className="muted small">statt {num(v.steuerung?.netz_kwh)} kWh · Estrich am Abend {num((v.planer.waerme_kwh ?? 0) - (v.steuerung?.waerme_kwh ?? 0))} kWh {((v.planer.waerme_kwh ?? 0) - (v.steuerung?.waerme_kwh ?? 0)) >= 0 ? 'wärmer' : 'kühler'}</span></>
                      : v.planer_gleich ? <>{num(v.planer_gleich.netz_kwh)} kWh Netz<br /><span className="muted small">statt {num(v.steuerung?.netz_kwh)} kWh (alte Rechnung)</span></> : '–'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {v0 && <div className="muted small">Modellprüfung {tagKurz(v0.tag)}: Mit der echten Heizung nachgerechnet weicht das Raummodell im Mittel {num(v0.modell_abw, 2)} °C von den gemessenen Temperaturen ab.</div>}
      </div>

      <div className="auto-details">
        <button type="button" className="collapse-head" onClick={() => setModellAuf((x) => !x)} aria-expanded={modellAuf}>
          <span className="chart-title" style={{ marginBottom: 0 }}>Was der Planer über jeden Raum gelernt hat</span>
          <span className="collapse-sum" />
          <span className={`collapse-chev ${modellAuf ? 'open' : ''}`} aria-hidden="true">▶</span>
        </button>
        {modellAuf && <RaumModell modell={modell} rooms={rooms} />}
      </div>
    </div>
  );
}
