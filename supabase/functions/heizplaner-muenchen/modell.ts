// KOPIE aus Heizung Venediger – nicht für München umgeschrieben (Grundregel doc/KONZEPT.md, Uli 12.11.2026).
// Herkunft: UliBer1508/smartfox-insight-ai-selfhosted · supabase/functions/heizplaner/modell.ts · Commit b9444bb (13.11.2026)
// Inhalt unverändert. Was München anders braucht (Daten, Räume, Zeiten), steht in rechnen.ts (MÜNCHEN:) und index.ts.
// Wird das Modell in Venediger verbessert, diese Datei bewusst neu kopieren und den Commit oben anpassen.
//
// Heizplaner – Rechenkern (06.11.2026, neu 13.11.2026: doc/FIX-PLANER-MODELL-2026-11-13.md)
//
// Reine Funktionen ohne Datenbank, damit sie mit echten Daten geprüft werden können.
//   1. Raummodell   – je Raum gelernt, zwei Wärmespeicher: Estrich (S) und Raumluft (T), 15-Minuten-Schritte.
//                     Wärme kommt aus der Heizung in den Estrich, vom Estrich in den Raum und geht nach draußen (k).
//                     Sonne (s), kleine innere Wärme (c).
//   2. PV-Modell    – je Stunde des Tages gelernt aus Strahlung (direkt/diffus) → echte PV (inkl. Bergschatten),
//                     tagsüber an der gerade gemessenen PV nachgeführt.
//   3. Batterie     – Laden aus Überschuss, Entladen bei Bedarf, sonst Netz (Fronius „0 W Netz“).
//   4. Planer       – sucht für 24 h je Raum und halbe Stunde „heizen ja/nein“, sodass
//                     Netzstrom + Komfort-Abweichung möglichst klein werden (gierige Verbesserung).
//                     Die im Haus gespeicherte Wärme am Planende zählt mit (wie die Restladung der Batterie).
//
// Warum zwei Speicher (13.11.2026): Das alte Modell hatte nur die Raumluft und eine feste „innere Wärme“ c. Gelernt
// wurden in Summe ~8 kW innere Wärme bei 240 W Grundlast – in Wahrheit Wärme aus dem Estrich und aus beheizten
// Nachbarräumen. Heizte der Planer weniger, blieb diese Wärme im Modell trotzdem da, und er hätte das Haus auskühlen lassen.
// Geprüft 13.11.2026 mit 14 Tagen Messwerten: neu zusammen ~2,2 kW Verlust bei 18 °C Unterschied (gemessen ~40 kWh Heizen
// am Tag), innere Wärme ~60 W; Fehler nach 12 h in 9 von 12 Räumen kleiner als beim alten Modell.
// Bewusst ohne Kopplung an die Nachbarräume: Mit dem gemessenen Mittel der anderen Räume als Eingang „lernte“ das Modell,
// dass die Räume kaum nach draußen verlieren und einfach den anderen folgen (k an der Untergrenze) – im Plan wäre das Haus
// dann nie ausgekühlt.

export const DT_H = 0.25;            // 15 Minuten
export const SLOTS = 96;             // 24 h
export const BLOCK = 2;              // Entscheidung je 30 min (2 Slots)

// ---------------------------------------------------------------- 1. Raummodell
/**
 *   dS/dt = g·h − u·(S − T)                                          Estrich (°C)
 *   dT/dt = r·u·(S − T) − k·(T − T_außen) + s·PV_kW + c                Raumluft (°C)
 * h: heizt 0…1 · g: Aufheizen des Estrichs beim Heizen (°C/h) · u: Austausch Estrich→Raum (1/h)
 * r: Estrich-Wärmespeicher / Luft-Wärmespeicher · k: nach draußen (1/h)
 * s: Sonne (°C/h je kW PV) · c: innere Wärme (°C/h, klein)
 */
export interface RaumParam { v: 2; k: number; g: number; u: number; r: number; s: number; c: number }

export interface Fenster {
  T0: number;
  histT: number[]; histH: number[];         // 12 h vor dem Start (älteste zuerst), für den Estrich-Zustand
  h: number[]; tout: number[]; pvkw: number[];   // je Schritt
  tIst: (number | null)[];                   // gemessene Temperatur am Schrittende
}

// Grenzen der Parameter (physikalisch sinnvoll). c ist bewusst klein: Grundlast ~240 W für das ganze Haus.
export const GRENZEN: Record<Exclude<keyof RaumParam, 'v'>, [number, number]> = {
  k: [0.0005, 0.08], g: [0.05, 4], u: [0.05, 2], r: [0.5, 20], s: [-0.05, 0.3], c: [-0.03, 0.04],
};
const SCHLUESSEL = ['k', 'g', 'u', 'r', 's', 'c'] as const;
const RU_MAX = 2.5;                  // r·u·DT < 1 für eine stabile Rechnung

export const STANDARD_PARAM: RaumParam = { v: 2, k: 0.01, g: 0.45, u: 0.25, r: 6, s: 0.08, c: 0 };

export function istV2(p: any): p is RaumParam {
  return !!p && p.v === 2 && SCHLUESSEL.every(s => Number.isFinite(Number(p[s])));
}

/** Estrich-Zustand zu Beginn: 12 h Vorgeschichte mit gemessener Raumtemperatur und Heizen nachrechnen. */
export function estrichStart(p: RaumParam, histT: number[], histH: number[], T0: number): number {
  let S = Number.isFinite(histT[0]) ? histT[0] : T0;
  for (let i = 0; i < histH.length; i++) {
    const T = Number.isFinite(histT[i]) ? histT[i] : T0;
    S += DT_H * (p.g * (histH[i] || 0) - p.u * (S - T));
  }
  return S;
}

/** Ein Schritt: neue Raumtemperatur und neuer Estrich-Zustand. */
export function schritt(p: RaumParam, T: number, S: number, h: number, tout: number, pvkw: number): [number, number] {
  const fluss = S - T;
  const Sn = S + DT_H * (p.g * h - p.u * fluss);
  const Tn = T + DT_H * (p.r * p.u * fluss - p.k * (T - tout) + p.s * pvkw + p.c);
  return [Tn, Sn];
}

/** Ohne Heizen: wohin strebt der Raum (T∞) und wie schnell (je h) – Luft und Estrich zusammen. */
export function ohneHeizen(p: RaumParam, tout: number): { tInf: number; rate: number } {
  return { tInf: tout + p.c / p.k, rate: p.k / (1 + p.r) };
}

/** Aufheizen, wenn Estrich und Raum gemeinsam warm werden (°C/h) – für die Anzeige. */
export const aufheizen = (p: RaumParam) => p.g * p.r / (1 + p.r);

/** Wärme im Raum (Estrich + Luft) gegenüber einem Bezugszustand in kWh. leistungW = Heizleistung des Raums. */
export function waermeKwh(p: RaumParam, leistungW: number, dT: number, dS: number): number {
  const capS = leistungW / Math.max(1e-6, p.g) / 1000;        // kWh je °C Estrich
  return capS * (dS + dT / p.r);
}

export function simFehler(p: RaumParam, wins: Fenster[]): number {
  let se = 0, n = 0;
  for (const w of wins) {
    let S = estrichStart(p, w.histT, w.histH, w.T0);
    let T = w.T0;
    for (let i = 0; i < w.h.length; i++) {
      [T, S] = schritt(p, T, S, w.h[i], w.tout[i], w.pvkw[i]);
      const ist = w.tIst[i];
      if (ist != null && (i + 1) % 4 === 0) { se += (T - ist) ** 2; n++; }
    }
  }
  return n ? se / n : 1e9;
}

/** Fehler nach `idx` Schritten (Mittel |Abweichung|) und Vergleich „Temperatur bleibt gleich“. */
export function prognoseFehler(p: RaumParam, wins: Fenster[], idx: number): { modell: number; gleich: number; n: number } {
  let em = 0, eg = 0, n = 0;
  for (const w of wins) {
    if (w.h.length <= idx || w.tIst[idx] == null) continue;
    let S = estrichStart(p, w.histT, w.histH, w.T0);
    let T = w.T0;
    for (let i = 0; i <= idx; i++) [T, S] = schritt(p, T, S, w.h[i], w.tout[i], w.pvkw[i]);
    em += Math.abs(T - (w.tIst[idx] as number));
    eg += Math.abs(w.T0 - (w.tIst[idx] as number));
    n++;
  }
  return { modell: n ? em / n : NaN, gleich: n ? eg / n : NaN, n };
}

export function nelderMead(f: (x: number[]) => number, x0: number[], step: number[], iters = 250): { x: number[]; v: number } {
  const n = x0.length;
  let pts: number[][] = [x0.slice()];
  for (let i = 0; i < n; i++) { const p = x0.slice(); p[i] += step[i]; pts.push(p); }
  let vals = pts.map(f);
  for (let it = 0; it < iters; it++) {
    const o = vals.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]).map(x => x[1]);
    pts = o.map(i => pts[i]); vals = o.map(i => vals[i]);
    const c = new Array(n).fill(0);
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) c[j] += pts[i][j] / n;
    const lin = (t: number) => c.map((cj, j) => cj + t * (cj - pts[n][j]));
    const xr = lin(1), fr = f(xr);
    if (fr < vals[0]) {
      const xe = lin(2), fe = f(xe);
      if (fe < fr) { pts[n] = xe; vals[n] = fe; } else { pts[n] = xr; vals[n] = fr; }
    } else if (fr < vals[n - 1]) { pts[n] = xr; vals[n] = fr; }
    else {
      const xc = lin(-0.5), fc = f(xc);
      if (fc < vals[n]) { pts[n] = xc; vals[n] = fc; }
      else { pts = pts.map(p => p.map((pj, j) => pts[0][j] + 0.5 * (pj - pts[0][j]))); vals = pts.map(f); }
    }
  }
  let bi = 0; for (let i = 1; i < vals.length; i++) if (vals[i] < vals[bi]) bi = i;
  return { x: pts[bi], v: vals[bi] };
}

// Suche in einem unbeschränkten Raum, Parameter über eine S-Kurve in ihre Grenzen abgebildet.
const sig = (x: number) => 1 / (1 + Math.exp(-x));
const zuParam = (x: number[]): RaumParam => {
  const p: any = { v: 2 };
  SCHLUESSEL.forEach((s, i) => { const [lo, hi] = GRENZEN[s]; p[s] = lo + (hi - lo) * sig(x[i]); });
  return p as RaumParam;
};
const vonParam = (p: RaumParam): number[] => SCHLUESSEL.map(s => {
  const [lo, hi] = GRENZEN[s];
  const q = Math.min(0.999, Math.max(0.001, (p[s] - lo) / (hi - lo)));
  return Math.log(q / (1 - q));
});

/**
 * Lernt die Raumparameter aus Simulationsfenstern (24 h). Räume mit wenig Heizdaten werden zu
 * `prior` (Median der gut gemessenen Räume) hingezogen – Gewicht `pw`.
 */
export function lerneRaum(wins: Fenster[], prior: RaumParam | null, pw: number, iters = 400): RaumParam {
  const f = (x: number[]) => {
    const p = zuParam(x);
    let e = simFehler(p, wins);
    if (p.r * p.u > RU_MAX) e += 10 * (p.r * p.u - RU_MAX);
    if (prior && pw > 0) {
      e += pw * (((p.k - prior.k) / 0.005) ** 2 + (Math.log(p.g / prior.g) / 0.5) ** 2
        + (Math.log(p.u / prior.u) / 0.7) ** 2 + (Math.log(p.r / prior.r) / 0.7) ** 2 + ((p.c - prior.c) / 0.02) ** 2);
    }
    return e;
  };
  const starts: RaumParam[] = [STANDARD_PARAM, { ...STANDARD_PARAM, u: 1, r: 2, g: 0.6 }];
  if (prior) starts.push(prior);
  let best: { x: number[]; v: number } | null = null;
  for (const s0 of starts) {
    const r = nelderMead(f, vonParam(s0), new Array(SCHLUESSEL.length).fill(0.8), iters);
    if (!best || r.v < best.v) best = r;
  }
  return zuParam(best!.x);
}

// ---------------------------------------------------------------- 2. PV-Modell
export type PvModell = Record<number, [number, number]>;   // Stunde → [a·direkt, b·diffus]

/** Lernt je Stunde des Tages PV ≈ a·direkt + b·diffus (W). Keys: „YYYY-MM-DD HH“ Wiener Ortszeit. */
export function lernePv(pvIst: Map<string, number>, wetter: Map<string, { dir: number; dif: number }>): PvModell {
  const m: PvModell = {};
  for (let h = 0; h < 24; h++) {
    let sxx = 0, sxy = 0, syy = 0, sxz = 0, syz = 0, n = 0;
    for (const [k, w] of wetter) {
      if (Number(k.slice(11, 13)) !== h) continue;
      const z = pvIst.get(k);
      if (z == null) continue;
      sxx += w.dir * w.dir; sxy += w.dir * w.dif; syy += w.dif * w.dif; sxz += w.dir * z; syz += w.dif * z; n++;
    }
    const det = sxx * syy - sxy * sxy;
    if (n < 3 || Math.abs(det) < 1e-6) { m[h] = [0, 0]; continue; }
    let a = (sxz * syy - syz * sxy) / det, b = (syz * sxx - sxz * sxy) / det;
    if (a < 0) { a = 0; b = syy > 0 ? Math.max(0, syz / syy) : 0; }
    if (b < 0) { b = 0; a = sxx > 0 ? Math.max(0, sxz / sxx) : 0; }
    m[h] = [a, b];
  }
  return m;
}

export function pvVorhersage(m: PvModell, key: string, w: { dir: number; dif: number } | undefined): number {
  if (!w) return 0;
  const c = m[Number(key.slice(11, 13))] ?? [0, 0];
  return Math.max(0, c[0] * w.dir + c[1] * w.dif);
}

/** Nachführung: Verhältnis gemessen/vorhergesagt der letzten 2 h (nur wenn genug Sonne), klingt über 4 h ab. */
export function nachfuehrFaktor(ist2h: number, vorh2h: number): number {
  if (vorh2h < 800 && ist2h < 800) return 1;          // morgens/abends zu wenig, Bergschatten → nicht nachführen
  return Math.min(3, Math.max(0.3, (ist2h + 200) / (vorh2h + 200)));
}

// ---------------------------------------------------------------- 3./4. Planer
export interface PlanRaum {
  id: string; name: string; p: number;            // Leistung W
  T0: number; S0: number; param: RaumParam;
  ziel: number[]; unter: number[]; sicher: number[]; max: number[];   // je Slot (°C)
  gewicht: number;                                // Faktor aus Priorität
  fest: (0 | 1 | null)[];                         // je Slot festgelegt (manuell, nicht steuerbar) oder frei
}
export interface PlanSlot { pv: number; base: number; tout: number; pvkw: number; capW: number }
export interface Batterie { eKwh: number; capKwh: number; minKwh: number; maxLadenW: number; maxEntladenW: number; eta: number }
export interface Gewichte {
  ziel: number; unter: number; sicher: number; ueber: number; einspeiseFaktor: number; batterieRest: number;
  waermeRest: number;   // Wert der im Haus gespeicherten Wärme am Planende je kWh (wie Batterie-Restladung)
}

export interface Ergebnis {
  heizen: number[][];             // [raum][slot] 0/1
  temp: number[][];               // [raum][slot] Raumtemperatur am Slot-Ende
  netzW: number[]; einspeisW: number[]; batKwh: number[]; heizW: number[];
  netzKwh: number; einspeisKwh: number; heizKwh: number; komfortGradStd: number; unterGradStd: number;
  waermeKwh: number;              // gespeicherte Wärme am Planende gegenüber dem Start (Estrich + Luft, alle Räume)
  kosten: number; schritte: number;
}

interface Sim { pen: number[]; T: number[]; S: number[]; ende: number }

function simRaum(r: PlanRaum, h: number[], slots: PlanSlot[], g: Gewichte, ab = 0, start?: { T: number; S: number }): Sim {
  const N = slots.length;
  const pen = new Array(N).fill(0), Tv = new Array(N), Sv = new Array(N);
  let T = start ? start.T : r.T0, S = start ? start.S : r.S0;
  for (let i = ab; i < N; i++) {
    [T, S] = schritt(r.param, T, S, h[i], slots[i].tout, slots[i].pvkw);
    Tv[i] = T; Sv[i] = S;
    pen[i] = DT_H * r.gewicht * (
      g.ziel * Math.max(0, r.ziel[i] - T) + g.unter * Math.max(0, r.unter[i] - T) +
      g.sicher * Math.max(0, r.sicher[i] - T) + g.ueber * Math.max(0, T - r.max[i]));
  }
  const ende = waermeKwh(r.param, r.p, T - r.T0, S - r.S0);
  return { pen, T: Tv, S: Sv, ende };
}

function simEnergie(heizW: number[], slots: PlanSlot[], b: Batterie, g: Gewichte, ab = 0, e0?: number):
  { kosten: number; netz: number[]; einsp: number[]; e: number[] } {
  const netz = new Array(slots.length).fill(0), einsp = new Array(slots.length).fill(0), ev = new Array(slots.length).fill(0);
  let e = e0 ?? b.eKwh, kosten = 0;
  for (let i = ab; i < slots.length; i++) {
    const net = slots[i].pv - slots[i].base - heizW[i];
    if (net >= 0) {
      const lad = Math.min(net, b.maxLadenW, Math.max(0, (b.capKwh - e) / DT_H / b.eta * 1000));
      e += lad * DT_H * b.eta / 1000;
      einsp[i] = net - lad;
    } else {
      const bed = -net;
      const ent = Math.min(bed, b.maxEntladenW, Math.max(0, (e - b.minKwh) / DT_H * b.eta * 1000));
      e -= ent * DT_H / b.eta / 1000;
      netz[i] = bed - ent;
    }
    ev[i] = e;
    kosten += DT_H / 1000 * (netz[i] - g.einspeiseFaktor * einsp[i]);
  }
  return { kosten, netz, einsp, e: ev };
}

/**
 * Gierige Verbesserung: Start ohne Heizen (außer fest), dann jeweils die halbe Stunde und den Raum
 * einschalten, die die Gesamtkosten (Netz-kWh + Komfort − Wert der Restwärme und Restladung) am meisten senken –
 * solange es etwas bringt und die Leistungsgrenze je Slot hält. Danach ein Durchgang, der Überflüssiges wieder ausschaltet.
 */
export function plane(raeume: PlanRaum[], slots: PlanSlot[], bat: Batterie, g: Gewichte, maxSchritte = 600): Ergebnis {
  const N = slots.length, R = raeume.length, B = Math.ceil(N / BLOCK);
  const h = raeume.map(r => r.fest.map(f => (f == null ? 0 : f)));
  const heizW = new Array(N).fill(0);
  for (let i = 0; i < N; i++) for (let r = 0; r < R; r++) heizW[i] += h[r][i] * raeume[r].p;
  const rs: Sim[] = raeume.map((r, i) => simRaum(r, h[i], slots, g));
  let en = simEnergie(heizW, slots, bat, g);
  const penSum = (p: number[], ab: number) => { let s = 0; for (let i = ab; i < p.length; i++) s += p[i]; return s; };
  const batEnde = (e: number[]) => e[N - 1] ?? bat.eKwh;
  const gesamt = () => en.kosten - g.batterieRest * (batEnde(en.e) - bat.eKwh)
    + rs.reduce((s, x) => s + penSum(x.pen, 0) - g.waermeRest * x.ende, 0);

  const versuche = (r: number, blk: number, an: 0 | 1) => {
    const i0 = blk * BLOCK, i1 = Math.min(N, i0 + BLOCK);
    const hn = h[r].slice();
    for (let i = i0; i < i1; i++) { if (raeume[r].fest[i] != null) return null; hn[i] = an; }
    const hw = heizW.slice();
    for (let i = i0; i < i1; i++) {
      hw[i] += (an - h[r][i]) * raeume[r].p;
      if (an === 1 && hw[i] > slots[i].capW + 1) return null;
    }
    const start = i0 > 0 ? { T: rs[r].T[i0 - 1], S: rs[r].S[i0 - 1] } : undefined;
    const nr = simRaum(raeume[r], hn, slots, g, i0, start);
    for (let i = 0; i < i0; i++) { nr.T[i] = rs[r].T[i]; nr.S[i] = rs[r].S[i]; nr.pen[i] = rs[r].pen[i]; }
    const e0 = i0 > 0 ? en.e[i0 - 1] : undefined;
    const ne = simEnergie(hw, slots, bat, g, i0, e0);
    const vorherEnergie = (() => { let s = 0; for (let i = i0; i < N; i++) s += DT_H / 1000 * (en.netz[i] - g.einspeiseFaktor * en.einsp[i]); return s; })();
    const d = (ne.kosten - vorherEnergie) - g.batterieRest * (batEnde(ne.e) - batEnde(en.e))
      + (penSum(nr.pen, i0) - penSum(rs[r].pen, i0)) - g.waermeRest * (nr.ende - rs[r].ende);
    return { d, hn, hw, nr, ne, i0 };
  };
  const uebernehme = (r: number, x: NonNullable<ReturnType<typeof versuche>>) => {
    h[r] = x.hn;
    for (let i = 0; i < N; i++) heizW[i] = x.hw[i];
    rs[r] = x.nr;
    for (let i = x.i0; i < N; i++) { en.netz[i] = x.ne.netz[i]; en.einsp[i] = x.ne.einsp[i]; en.e[i] = x.ne.e[i]; }
  };

  let schritte = 0;
  while (schritte < maxSchritte) {
    let best: { r: number; x: NonNullable<ReturnType<typeof versuche>> } | null = null;
    for (let r = 0; r < R; r++) for (let blk = 0; blk < B; blk++) {
      if (h[r][blk * BLOCK] === 1) continue;
      const x = versuche(r, blk, 1);
      if (x && x.d < -1e-4 && (!best || x.d < best.x.d)) best = { r, x };
    }
    if (!best) break;
    uebernehme(best.r, best.x); schritte++;
  }
  // Aufräumen: Blöcke ausschalten, wenn es billiger wird
  for (let r = 0; r < R; r++) for (let blk = B - 1; blk >= 0; blk--) {
    if (h[r][blk * BLOCK] !== 1) continue;
    const x = versuche(r, blk, 0);
    if (x && x.d < -1e-4) uebernehme(r, x);
  }

  en = simEnergie(heizW, slots, bat, g);
  let komfort = 0, unterStd = 0;
  for (let r = 0; r < R; r++) for (let i = 0; i < N; i++) {
    komfort += DT_H * Math.max(0, raeume[r].ziel[i] - rs[r].T[i]);
    unterStd += DT_H * Math.max(0, raeume[r].unter[i] - rs[r].T[i]);
  }
  const sum = (a: number[]) => a.reduce((s, v) => s + v, 0) * DT_H / 1000;
  return {
    heizen: h, temp: rs.map(x => x.T), netzW: en.netz, einspeisW: en.einsp, batKwh: en.e, heizW,
    netzKwh: sum(en.netz), einspeisKwh: sum(en.einsp), heizKwh: sum(heizW),
    komfortGradStd: komfort, unterGradStd: unterStd,
    waermeKwh: rs.reduce((s, x) => s + x.ende, 0),
    kosten: gesamt(), schritte,
  };
}

/** Bewertet einen vorgegebenen Heizplan (z. B. was die heutige Steuerung tatsächlich gemacht hat). */
export function bewerte(raeume: PlanRaum[], slots: PlanSlot[], bat: Batterie, g: Gewichte, heizen: number[][]): Ergebnis {
  const fixe = raeume.map((r, i) => ({ ...r, fest: heizen[i].map(v => (v >= 0.5 ? 1 : 0) as 0 | 1) }));
  return plane(fixe, slots, bat, g, 0);
}
