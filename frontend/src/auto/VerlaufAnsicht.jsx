// Auto-Steuerung › Verlauf und Wirkung (12.11.2026) – reine Anzeige, Laden in Verlauf.jsx.
// ÜBERNOMMEN aus Heizung Venediger (src/components/ki/VerlaufAnsicht.tsx, Commit bf8d3a7): gleicher Aufbau, gleiche
// Kacheln, gleiche Grafiken, gleiche Wirkungstabelle. Geändert nur, was München anders hat:
//   * Gestaltung mit den Klassen der Münchner App (card, tile, seg, ptable …)
//   * Verbrauch = Wärmepumpe (inkl. Warmwasser) · Auto (evcc, gemessen) · Haus; Batterie 10 kWh aus den Einstellungen
//   * „Haus unter Ziel“ statt „unter Eco“ (Ziel je Raum nach Profil); Netz bei leerer Batterie = Ladestand ≤ 5 %
// Daten: muc_energie_stunde / muc_energie_tag (migration-014), KI-Marken aus muc_ki_suggestions.
import { useMemo } from 'react';
import { Area, CartesianGrid, ComposedChart, Legend, Line, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { ACHSE, Kachel, TIP, TZ, num } from './teile.jsx';

const MONATE = ['Jan', 'Feb', 'Mär', 'Apr', 'Mai', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez'];
const n0 = (x) => Number(x ?? 0);
export const tagLokal = (ms) => new Date(ms).toLocaleDateString('sv-SE', { timeZone: TZ });
const stundeLokal = (ms) => Number(new Date(ms).toLocaleTimeString('en-GB', { hour: '2-digit', hourCycle: 'h23', timeZone: TZ }));
const tm = (iso) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}.`;
const mittel = (xs) => { const v = xs.filter((x) => x != null).map(Number); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };

/** Summen eines Zeitraums aus Tageswerten. */
function summen(t) {
  const s = (k) => t.reduce((a, d) => a + n0(d[k]), 0);
  const ziel = t.filter((d) => d.raum_h_unter_ziel != null);
  const plan = t.filter((d) => d.planer_netz_kwh != null);
  const kosten = t.filter((d) => d.netz_kosten_eur != null);
  return {
    pv: s('pv_kwh'), verbr: s('verbrauch_kwh'), heiz: s('heizung_kwh'), auto: s('auto_kwh'), haus: s('haus_kwh'),
    netz: s('netz_kwh'), einsp: s('einspeisung_kwh'), lad: s('batt_laden_kwh'), ent: s('batt_entladen_kwh'), leer: s('netz_batt_leer_kwh'),
    kosten: s('netz_kosten_eur'), erloes: s('einspeise_erloes_eur'), mitPreis: kosten.length,
    ziel: ziel.length ? ziel.reduce((a, d) => a + n0(d.raum_h_unter_ziel), 0) / ziel.length : null,
    planNetz: plan.reduce((a, d) => a + n0(d.planer_netz_kwh), 0), planIst: plan.reduce((a, d) => a + n0(d.netz_kwh), 0), planTage: plan.length,
    tage: t.reduce((a, d) => a + Math.min(24, d.stunden) / 24, 0),   // halbe Tage (heute) zählen anteilig
  };
}

/** Unterschied zur Vergleichsperiode als Text, „besser“ je nach Richtung. */
function delta(a, b, wenigerBesser, einheit = '%') {
  if (a == null || b == null || b === 0) return null;
  const p = (a - b) / Math.abs(b) * 100;
  const gut = wenigerBesser ? p < 0 : p > 0;
  return { text: `${p > 0 ? '+' : ''}${num(p, 0)} ${einheit}`, gut };
}

const VOR = { tag: 'Vortag', woche: 'Vorwoche', monat: 'Vormonat', jahr: 'Vorjahr' };

export function VerlaufAnsicht(p) {
  const { periode, vergleich, battKwh } = p;
  const stuendlich = periode === 'tag' || periode === 'woche';
  const s = useMemo(() => summen(p.tage), [p.tage]);
  const sv = useMemo(() => (vergleich === 'aus' ? null : summen(p.vglTage)), [p.vglTage, vergleich]);
  const vglName = vergleich === 'vorjahr' ? 'Vorjahr' : VOR[periode];
  // Vergleich je Tag (Mittel), damit unterschiedlich lange oder unvollständige Zeiträume vergleichbar sind.
  const d = (a, b, weniger, schonJeTag = false) =>
    (sv && b != null && sv.tage > 0 && s.tage > 0 ? delta(a == null ? null : schonJeTag ? a : a / s.tage, schonJeTag ? b : b / sv.tage, weniger) : null);

  // Punkte der Grafik: Tag/Woche je Stunde, Monat je Tag, Jahr je Monat – immer der ganze Zeitraum.
  const punkte = useMemo(() => {
    const leer = { pv: null, heiz: null, rest: null, verbr: null, netz: null, bat: null, lad: null, ent: null, kosten: null, ziel: null, plan: null,
      vglNetz: null, vglPv: null, vglKosten: null, vglZiel: null };
    if (stuendlich) {
      const n = Math.round((p.bisMs - p.vonMs) / 3600_000);
      const pos = (x, von) => Math.round((Date.parse(x.stunde) - von) / 3600_000);
      const pts = Array.from({ length: n }, (_, i) => {
        const ms = p.vonMs + i * 3600_000;
        const wt = new Date(ms).toLocaleDateString('de-DE', { weekday: 'short', timeZone: TZ }).replace('.', '');
        return { i, ms, label: periode === 'tag' ? `${String(stundeLokal(ms)).padStart(2, '0')}:00` : `${wt} ${String(stundeLokal(ms)).padStart(2, '0')}`, ...leer };
      });
      p.stunden.forEach((x) => {
        const pt = pts[pos(x, p.vonMs)];
        if (!pt) return;
        Object.assign(pt, { pv: n0(x.pv_kwh), heiz: n0(x.heizung_kwh), rest: n0(x.auto_kwh) + n0(x.haus_kwh),
          verbr: n0(x.verbrauch_kwh), netz: n0(x.netz_kwh), bat: x.soc_ende == null ? null : Math.round(x.soc_ende * battKwh) / 100 });
      });
      if (p.vglStunden.length && p.vglVonMs != null) p.vglStunden.forEach((x) => {
        const pt = pts[pos(x, p.vglVonMs)];
        if (pt) Object.assign(pt, { vglNetz: n0(x.netz_kwh), vglPv: n0(x.pv_kwh) });
      });
      return pts;
    }
    const jahr = periode === 'jahr';
    const vonTag = tagLokal(p.vonMs);
    const n = jahr ? 12 : Math.round((p.bisMs - p.vonMs) / 86400_000);
    const pts = Array.from({ length: n }, (_, i) => {
      const ms = jahr ? Date.parse(`${vonTag.slice(0, 4)}-${String(i + 1).padStart(2, '0')}-15T12:00:00Z`) : p.vonMs + i * 86400_000 + 12 * 3600_000;
      return { i, ms, label: jahr ? MONATE[i] : tm(tagLokal(ms)), ...leer };
    });
    const posT = (tag) => (jahr ? Number(tag.slice(5, 7)) - 1 : Number(tag.slice(8, 10)) - 1);
    const gruppen = (t) => { const m = new Map(); t.forEach((x) => m.set(posT(x.tag), [...(m.get(posT(x.tag)) ?? []), x])); return m; };
    gruppen(p.tage).forEach((rows, i) => {
      const su = summen(rows), pt = pts[i];
      if (pt) Object.assign(pt, { pv: su.pv, heiz: su.heiz, rest: su.auto + su.haus, verbr: su.verbr, netz: su.netz, lad: su.lad, ent: su.ent,
        kosten: su.mitPreis ? su.kosten : null, ziel: su.ziel, plan: su.planTage ? su.planNetz : null });
    });
    gruppen(p.vglTage).forEach((rows, i) => {
      const su = summen(rows), pt = pts[i];
      if (pt) Object.assign(pt, { vglNetz: su.netz, vglPv: su.pv, vglKosten: su.mitPreis ? su.kosten : null, vglZiel: su.ziel });
    });
    return pts;
  }, [p.stunden, p.vglStunden, p.tage, p.vglTage, p.vonMs, p.bisMs, p.vglVonMs, periode, stuendlich, battKwh]);

  // KI-Marken: nächster Punkt je Genehmigung (Genehmigungen innerhalb eines Punktes teilen sich die Marke)
  const nummeriert = p.vorschlaege.map((x, i) => ({ ...x, n: i + 1 }));
  const imZeitraum = nummeriert.filter((x) => x.ts * 1000 >= p.vonMs && x.ts * 1000 < p.bisMs);
  const marken = useMemo(() => {
    const m = new Map();
    imZeitraum.forEach((x) => {
      let best = 0, bestD = Infinity;
      punkte.forEach((pt) => { const dd = Math.abs(pt.ms - x.ts * 1000); if (dd < bestD) { bestD = dd; best = pt.i; } });
      m.set(best, [...(m.get(best) ?? []), x.n]);
    });
    return [...m.entries()].map(([i, n]) => ({ i, n }));
  }, [imZeitraum, punkte]);
  const markenLinien = (oben) => marken.map((m) => (
    <ReferenceLine key={m.n.join('+')} x={m.i} stroke="var(--c-ki)" strokeDasharray="4 3" strokeWidth={1.5}
      label={oben ? { value: `▼${m.n.join('+')}`, position: 'top', fill: 'var(--c-ki)', fontSize: 12, fontWeight: 700 } : undefined} />
  ));
  const tickJede = periode === 'tag' ? 2 : periode === 'woche' ? 11 : periode === 'monat' ? 2 : 0;
  const xAchse = <XAxis dataKey="i" type="number" domain={[-0.5, Math.max(0, punkte.length - 0.5)]} ticks={punkte.filter((_, i) => i % (tickJede + 1) === 0).map((x) => x.i)}
    tickFormatter={(i) => punkte[i]?.label ?? ''} tick={ACHSE} tickLine={false} axisLine={false} />;
  const tipLabel = (i) => punkte[i]?.label ?? '';
  const einheit = stuendlich ? 'kW' : 'kWh';

  // Wirkung je KI-Vorschlag: 3 Tage vorher → 3 Tage nachher (Genehmigungstag zählt nicht) – unabhängig vom Zeitraum
  const wirkung = nummeriert.map((x) => {
    const d0 = tagLokal(x.ts * 1000);
    const i = p.alleTage.findIndex((t) => t.tag === d0);
    const vor = i < 0 ? [] : p.alleTage.slice(Math.max(0, i - 3), i);
    const nach = i < 0 ? [] : p.alleTage.slice(i + 1, i + 4).filter((t) => t.stunden >= 23);
    const gleich = nummeriert.find((y) => y.n < x.n && tagLokal(y.ts * 1000) === d0);
    const w = (f) => [mittel(vor.map(f)), mittel(nach.map(f))];
    return { ...x, nTage: nach.length, gleich: gleich?.n ?? null, netz: w((t) => t.netz_kwh), ziel: w((t) => t.raum_h_unter_ziel), leer: w((t) => t.netz_batt_leer_kwh), kosten: w((t) => t.netz_kosten_eur) };
  }).filter((x) => x.ts * 1000 < p.bisMs).reverse();
  const pfeil = ([a, b], e, dz = 1) => (a == null || b == null ? '–' : `${num(a, dz)} → ${num(b, dz)} ${e}`);
  const besser = ([a, b]) => (a == null || b == null ? null : b < a);
  const farbe = (x) => (x == null ? '' : x ? 'good-text' : 'bad-text');

  const Knopf = ({ an, onClick, children }) => (
    <button type="button" onClick={onClick} aria-pressed={an} className={an ? 'seg-btn active' : 'seg-btn'}>{children}</button>
  );
  const preisFehlt = s.mitPreis === 0;

  return (
    <div className="stack">
      <div className="toolbar auto-bar">
        <div className="seg" role="group" aria-label="Zeitraum">
          {['tag', 'woche', 'monat', 'jahr'].map((x) => <Knopf key={x} an={periode === x} onClick={() => p.setPeriode(x)}>{{ tag: 'Tag', woche: 'Woche', monat: 'Monat', jahr: 'Jahr' }[x]}</Knopf>)}
        </div>
        <div className="datenav">
          <button type="button" className="btn" onClick={p.zurueck} aria-label="Zeitraum zurück">◀</button>
          <span className="datenav-label auto-titel">{p.titel}</span>
          <button type="button" className="btn" onClick={p.vor ?? undefined} disabled={!p.vor} aria-label="Zeitraum vor">▶</button>
        </div>
        <div className="seg" role="group" aria-label="Vergleich">
          <Knopf an={vergleich === 'vor'} onClick={() => p.setVergleich('vor')}>{VOR[periode]}</Knopf>
          {periode !== 'jahr' && <Knopf an={vergleich === 'vorjahr'} onClick={() => p.setVergleich('vorjahr')}>Vorjahr</Knopf>}
          <Knopf an={vergleich === 'aus'} onClick={() => p.setVergleich('aus')}>aus</Knopf>
        </div>
      </div>
      {sv && <div className="muted small">Vergleich mit {p.vglTitel}{sv.tage === 0 ? ` – dafür gibt es noch keine Daten (Ablage seit ${p.ersterTag ? tm(p.ersterTag) + p.ersterTag.slice(0, 4) : '–'})` : sv.tage < s.tage ? ` – dort nur ${num(sv.tage, 0)} Tage vorhanden` : ''}. Prozent = Unterschied je Tag. Grau gestrichelt in den Grafiken.</div>}

      <section className="kpis kpis-4">
        <Kachel k="PV" v={`${num(s.pv, 0)} kWh`} s={`Eigennutzung ${num(s.pv ? (s.pv - s.einsp) / s.pv * 100 : null)} % · ${num(s.einsp)} kWh eingespeist`} d={d(s.pv, sv?.pv, false)} vglName={vglName} />
        <Kachel k="Verbrauch" v={`${num(s.verbr, 0)} kWh`} s={`Wärmepumpe ${num(s.heiz, 0)} · Auto ${num(s.auto, 0)} · Haus ${num(s.haus, 0)}`} d={d(s.verbr, sv?.verbr, true)} vglName={vglName} />
        <Kachel k="Netz" v={`${num(s.netz, 0)} kWh`} s={`Autarkie ${num(s.verbr ? (s.verbr - s.netz) / s.verbr * 100 : null, 0)} %`} d={d(s.netz, sv?.netz, true)} vglName={vglName} />
        <Kachel k="Kosten Netz" v={preisFehlt ? '–' : `${num(s.kosten, 2)} €`} s={preisFehlt ? 'Strompreis fehlt – Einstellungen › Strompreis' : `Einspeisung +${num(s.erloes, 2)} € · netto ${num(s.kosten - s.erloes, 2)} €`} d={preisFehlt ? null : d(s.kosten, sv?.mitPreis ? sv.kosten : null, true)} vglName={vglName} />
        <Kachel k="Batterie" v={`${num(s.lad, 0)} / ${num(s.ent, 0)} kWh`} s={`geladen / entladen · ${num(s.lad / battKwh)} Vollzyklen`} d={d(s.ent, sv?.ent, false)} vglName={vglName} />
        <Kachel k="Netz bei leerer Batterie" v={`${num(s.leer, 0)} kWh`} s="Ladestand ≤ 5 %" d={d(s.leer, sv?.leer, true)} vglName={vglName} />
        <Kachel k="Haus unter Ziel" v={s.ziel == null ? '–' : `${num(s.ziel, 0)} Raum-h`} s="je Tag, 08–22 Uhr" d={d(s.ziel, sv?.ziel, true, true)} vglName={vglName} />
        <Kachel k="Planer bei gleicher Sonne" v={s.planTage ? `${num(s.planNetz, 0)} statt ${num(s.planIst, 0)} kWh` : '–'} s={s.planTage ? `${s.planTage} Tage mit Gegenrechnung · ${num(s.planIst ? (s.planNetz - s.planIst) / s.planIst * 100 : null, 0)} %` : 'noch keine Gegenrechnung'} />
      </section>

      <div>
        <div className="chart-title">{stuendlich ? 'Leistung (kW, Stundenmittel)' : periode === 'monat' ? 'Energie je Tag (kWh)' : 'Energie je Monat (kWh)'}</div>
        <div className="auto-chart">
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={punkte} margin={{ top: 18, right: 8, bottom: 0, left: -16 }}>
              <CartesianGrid stroke="var(--grid)" strokeDasharray="2 4" vertical={false} />
              {xAchse}
              <YAxis tick={ACHSE} tickLine={false} axisLine={false} />
              <Tooltip {...TIP} labelFormatter={tipLabel} formatter={(x, n) => [`${num(x)} ${einheit}`, n]} cursor={{ stroke: 'var(--muted)', strokeWidth: 1 }} />
              <Legend wrapperStyle={{ fontSize: 12 }} iconType="plainline" />
              <Area type="stepAfter" dataKey="pv" name="PV-Produktion" stroke="var(--c-pv)" strokeWidth={1.5} fill="var(--c-pv)" fillOpacity={0.12} dot={false} isAnimationActive={false} />
              <Line type="stepAfter" dataKey="heiz" name="Wärmepumpe" stroke="var(--c-heiz)" strokeWidth={1.5} dot={false} isAnimationActive={false} />
              <Line type="stepAfter" dataKey="rest" name="Auto und Haus" stroke="var(--c-rest)" strokeWidth={1.5} dot={false} isAnimationActive={false} />
              <Line type="stepAfter" dataKey="netz" name="Netzbezug" stroke="var(--c-netz)" strokeWidth={1.5} dot={false} isAnimationActive={false} />
              {sv && <Line type="stepAfter" dataKey="vglNetz" name={`Netz ${vglName}`} stroke="var(--muted)" strokeDasharray="4 3" strokeWidth={1.5} dot={false} isAnimationActive={false} />}
              {sv && <Line type="stepAfter" dataKey="vglPv" name={`PV ${vglName}`} stroke="var(--c-pv)" strokeOpacity={0.5} strokeDasharray="4 3" strokeWidth={1.5} dot={false} isAnimationActive={false} />}
              {markenLinien(true)}
            </ComposedChart>
          </ResponsiveContainer>
        </div>
        <div className="muted small">Wärmepumpe (mit Warmwasser) = Verbrauch − Auto − Grundlast, bis die Wärmepumpe eigens gemessen wird. <span style={{ color: 'var(--c-ki)', fontWeight: 700 }}>▼</span> = KI-Vorschlag genehmigt.</div>
      </div>

      <div>
        <div className="chart-title">{stuendlich ? 'Batterie-Ladung (kWh)' : 'Batterie: geladen und entladen (kWh)'}</div>
        <div className="auto-chart klein">
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={punkte} margin={{ top: 4, right: 8, bottom: 0, left: -16 }}>
              <CartesianGrid stroke="var(--grid)" strokeDasharray="2 4" vertical={false} />
              {xAchse}
              <YAxis tick={ACHSE} tickLine={false} axisLine={false} domain={stuendlich ? [0, battKwh] : [0, 'dataMax']} />
              <Tooltip {...TIP} labelFormatter={tipLabel} formatter={(x, n) => [`${num(x)} kWh`, n]} />
              {stuendlich
                ? <Line type="monotone" dataKey="bat" name="Batterie" stroke="var(--c-bat)" strokeWidth={2} dot={false} connectNulls isAnimationActive={false} />
                : [<Line key="l" type="stepAfter" dataKey="lad" name="geladen" stroke="var(--c-bat)" strokeWidth={2} dot={false} isAnimationActive={false} />,
                   <Line key="e" type="stepAfter" dataKey="ent" name="entladen" stroke="var(--c-bat)" strokeOpacity={0.5} strokeDasharray="4 3" strokeWidth={2} dot={false} isAnimationActive={false} />]}
              {markenLinien(false)}
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      </div>

      {!stuendlich && (
        <div className="auto-2">
          <div>
            <div className="chart-title">Netzkosten (€) und Planer bei gleicher Sonne (kWh)</div>
            <div className="auto-chart mittel">
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={punkte} margin={{ top: 8, right: 8, bottom: 0, left: -16 }}>
                  <CartesianGrid stroke="var(--grid)" strokeDasharray="2 4" vertical={false} />
                  {xAchse}
                  <YAxis tick={ACHSE} tickLine={false} axisLine={false} />
                  <Tooltip {...TIP} labelFormatter={tipLabel} formatter={(x, n) => [n.includes('€') ? `${num(x, 2)} €` : `${num(x)} kWh`, n]} />
                  <Legend wrapperStyle={{ fontSize: 12 }} iconType="plainline" />
                  <Line type="stepAfter" dataKey="kosten" name="Kosten €" stroke="var(--c-netz)" strokeWidth={2} dot={false} isAnimationActive={false} />
                  {sv && <Line type="stepAfter" dataKey="vglKosten" name={`Kosten € ${vglName}`} stroke="var(--muted)" strokeDasharray="4 3" strokeWidth={1.5} dot={false} isAnimationActive={false} />}
                  <Line type="stepAfter" dataKey="netz" name="Netz kWh" stroke="var(--c-netz)" strokeOpacity={0.35} strokeWidth={1.5} dot={false} isAnimationActive={false} />
                  <Line type="stepAfter" dataKey="plan" name="Planer kWh" stroke="var(--c-netz)" strokeOpacity={0.35} strokeDasharray="2 3" strokeWidth={1.5} dot={false} connectNulls={false} isAnimationActive={false} />
                  {markenLinien(false)}
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          </div>
          <div>
            <div className="chart-title">Haus: Raum-Stunden unter Ziel je Tag</div>
            <div className="auto-chart mittel">
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={punkte} margin={{ top: 8, right: 8, bottom: 0, left: -16 }}>
                  <CartesianGrid stroke="var(--grid)" strokeDasharray="2 4" vertical={false} />
                  {xAchse}
                  <YAxis tick={ACHSE} tickLine={false} axisLine={false} />
                  <Tooltip {...TIP} labelFormatter={tipLabel} formatter={(x, n) => [`${num(x, 0)} Raum-h`, n]} />
                  <Legend wrapperStyle={{ fontSize: 12 }} iconType="plainline" />
                  <Line type="stepAfter" dataKey="ziel" name="unter Ziel" stroke="var(--ink)" strokeWidth={2} dot={false} connectNulls isAnimationActive={false} />
                  {sv && <Line type="stepAfter" dataKey="vglZiel" name={vglName} stroke="var(--muted)" strokeDasharray="4 3" strokeWidth={1.5} dot={false} connectNulls isAnimationActive={false} />}
                  {markenLinien(false)}
                </ComposedChart>
              </ResponsiveContainer>
            </div>
            <div className="muted small">Weniger ist besser. Ziel je Raum: morgens/tagsüber angehakt = Normal, sonst Untergrenze.</div>
          </div>
        </div>
      )}

      <div>
        <div className="chart-title">KI-Vorschläge: genehmigt und Wirkung (3 Tage vorher → 3 Tage nachher)</div>
        {wirkung.length === 0 ? <div className="muted small">Bis zu diesem Zeitraum wurde kein Vorschlag genehmigt.</div> : (
          <div className="plan-wrap">
            <table className="ptable auto-wirkung">
              <thead>
                <tr><th>Nr.</th><th>genehmigt</th><th>Vorschlag</th><th>Netz je Tag</th><th>Kosten je Tag</th><th>Haus unter Ziel</th><th>Netz bei leerer Batterie</th><th>Urteil</th></tr>
              </thead>
              <tbody>
                {wirkung.map((w) => {
                  const b = [besser(w.netz), besser(w.ziel), besser(w.leer)];
                  const urteil = w.nTage === 0 ? 'zu früh' : w.gleich ? `nicht trennbar von Nr. ${w.gleich}` : w.nTage < 3 ? `vorläufig (${w.nTage} von 3 Tagen)`
                    : b.filter((x) => x === true).length >= 2 ? 'besser' : b.filter((x) => x === false).length >= 2 ? 'schlechter' : 'gemischt';
                  return (
                    <tr key={w.n}>
                      <td style={{ color: 'var(--c-ki)', fontWeight: 700 }}>▼{w.n}</td>
                      <td>{new Date(w.ts * 1000).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: TZ })}</td>
                      <td>{w.titel}<br /><span className="muted mono">{w.wert}</span></td>
                      <td className={farbe(b[0])}>{pfeil(w.netz, 'kWh')}</td>
                      <td className={farbe(besser(w.kosten))}>{pfeil(w.kosten, '€', 2)}</td>
                      <td className={farbe(b[1])}>{pfeil(w.ziel, 'h', 0)}</td>
                      <td className={farbe(b[2])}>{pfeil(w.leer, 'kWh')}</td>
                      <td className="muted">{urteil}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <div className="muted small">Grün = besser, rot = schlechter. Vorher/nachher hängt auch am Wetter – die Gegenrechnung des Planers (Netz bei gleicher Sonne) ist der fairere Vergleich.</div>
      </div>
    </div>
  );
}
