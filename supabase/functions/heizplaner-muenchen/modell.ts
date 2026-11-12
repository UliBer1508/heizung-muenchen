// KOPIE aus Heizung Venediger – nicht für München umgeschrieben (Grundregel doc/KONZEPT.md, Uli 12.11.2026).
// Herkunft: UliBer1508/smartfox-insight-ai-selfhosted · supabase/functions/heizplaner/modell.ts · Commit bf8d3a7
// Inhalt unverändert. Was München anders braucht (Daten, Räume, Zeiten), steht in index.ts.
// Wird das Modell in Venediger verbessert, diese Datei bewusst neu kopieren und den Commit oben anpassen.
//
// Heizplaner – Rechenkern (06.11.2026, doc/KONZEPT-PLANER-2026-11-06.md)
//
// Reine Funktionen ohne Datenbank, damit sie lokal mit echten Daten getestet werden können.
//   1. Raummodell   – je Raum gelernt: Auskühlen nach draußen (k), Aufheizen (g, über den Estrich verzögert τ),
//                     Sonne (s), innere Wärme/Nachbarräume (c). 15-Minuten-Schritte.
//   2. PV-Modell    – je Stunde des Tages gelernt aus Strahlung (direkt/diffus) → echte PV (inkl. Bergschatten),
//                     tagsüber an der gerade gemessenen PV nachgeführt.
//   3. Batterie     – Laden aus Überschuss, Entladen bei Bedarf, sonst Netz (Fronius „0 W Netz“).
//   4. Planer       – sucht für 24 h je Raum und halbe Stunde „heizen ja/nein“, sodass
//                     Netzstrom + Komfort-Abweichung möglichst klein werden (gierige Verbesserung).

export const DT_H = 0.25;            // 15 Minuten
export const SLOTS = 96;             // 24 h
export const BLOCK = 2;              // Entscheidung je 30 min (2 Slots)

// ---------------------------------------------------------------- 1. Raummodell
export interface RaumParam { k: number; g: number; s: number; c: number; tau: number }
export interface Fenster { T0: number; hist: number[]; h: number[]; tout: number[]; pvkw: number[]; tIst: (number | null)[] }

const alphaOf = (tau: number) => (tau > 1e-3 ? 1 - Math.exp(-DT_H / tau) : 1);

/** Estrich-Zustand (0…1) aus der Heizgeschichte (älteste zuerst). */
export function estrichAus(hist: number[], tau: number): number {
  const a = alphaOf(tau);
  let S = 0;
  for (const h of hist) S += (h - S) * a;
  return S;
}

/** Ein Schritt: neue Temperatur und neuer Estrich-Zustand. */
export function schritt(p: RaumParam, T: number, S: number, h: number, tout: number, pvkw: number, a: number): [number, number] {
  const Tn = T + DT_H * (-p.k * (T - tout) + p.g * S + p.s * pvkw + p.c);
  return [Tn, S + (h - S) * a];
}

/** Mittlerer quadratischer Fehler der Simulation an vollen Stunden. */
export function simFehler(p: RaumParam, wins: Fenster[]): number {
  if (p.k < 0 || p.g < 0 || p.k > 0.2 || p.g > 3) return 1e9;
  const a = alphaOf(p.tau);
  let se = 0, n = 0;
  for (const w of wins) {
    let S = estrichAus(w.hist, p.tau);
    let T = w.T0;
    for (let i = 0; i < w.h.length; i++) {
      [T, S] = schritt(p, T, S, w.h[i], w.tout[i], w.pvkw[i], a);
      const ist = w.tIst[i];
      if (ist != null && (i + 1) % 4 === 0) { se += (T - ist) ** 2; n++; }
    }
  }
  return n ? se / n : 1e9;
}

/** Fehler nach `idx` Schritten (Mittel |Abweichung|) und Vergleich „Temperatur bleibt gleich“. */
export function prognoseFehler(p: RaumParam, wins: Fenster[], idx: number): { modell: number; gleich: number; n: number } {
  const a = alphaOf(p.tau);
  let em = 0, eg = 0, n = 0;
  for (const w of wins) {
    if (w.h.length <= idx || w.tIst[idx] == null) continue;
    let S = estrichAus(w.hist, p.tau);
    let T = w.T0;
    for (let i = 0; i <= idx; i++) [T, S] = schritt(p, T, S, w.h[i], w.tout[i], w.pvkw[i], a);
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

/**
 * Lernt die Raumparameter aus Simulationsfenstern (24 h). Räume mit wenig Heizdaten werden zu
 * `prior` (Median der gut gemessenen Räume) hingezogen – Gewicht `pw`.
 */
export function lerneRaum(wins: Fenster[], prior: RaumParam | null, pw: number, taus = [0, 1, 2]): RaumParam {
  let best: { p: RaumParam; v: number } | null = null;
  for (const tau of taus) {
    const f = (q: number[]) => {
      const p = { k: q[0], g: q[1], s: q[2], c: q[3], tau };
      let e = simFehler(p, wins);
      if (prior && pw > 0) e += pw * (((p.k - prior.k) / 0.005) ** 2 + ((p.g - prior.g) / 0.3) ** 2 + ((p.c - prior.c) / 0.1) ** 2);
      return e;
    };
    const r = nelderMead(f, [0.006, 0.4, 0, 0.05], [0.004, 0.3, 0.02, 0.05]);
    if (!best || r.v < best.v) best = { p: { k: r.x[0], g: r.x[1], s: r.x[2], c: r.x[3], tau }, v: r.v };
  }
  return best!.p;
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
  fest: (0 | 1 | null)[];                         // je Slot festgelegt (manuell) oder frei
}
export interface PlanSlot { pv: number; base: number; tout: number; pvkw: number; capW: number }
export interface Batterie { eKwh: number; capKwh: number; minKwh: number; maxLadenW: number; maxEntladenW: number; eta: number }
export interface Gewichte { ziel: number; unter: number; sicher: number; ueber: number; einspeiseFaktor: number; batterieRest: number }

export interface Ergebnis {
  heizen: number[][];             // [raum][slot] 0/1
  temp: number[][];               // [raum][slot] Temperatur am Slot-Ende
  netzW: number[]; einspeisW: number[]; batKwh: number[]; heizW: number[];
  netzKwh: number; einspeisKwh: number; heizKwh: number; komfortGradStd: number; unterGradStd: number;
  kosten: number; schritte: number;
}

function simRaum(r: PlanRaum, h: number[], slots: PlanSlot[], g: Gewichte, ab = 0, start?: { T: number; S: number }, temps?: number[]):
  { pen: number[]; T: number[]; S: number[] } {
  const a = alphaOf(r.param.tau);
  const pen = new Array(slots.length).fill(0), Tv = new Array(slots.length), Sv = new Array(slots.length);
  let T = start ? start.T : r.T0, S = start ? start.S : r.S0;
  for (let i = ab; i < slots.length; i++) {
    [T, S] = schritt(r.param, T, S, h[i], slots[i].tout, slots[i].pvkw, a);
    Tv[i] = T; Sv[i] = S;
    if (temps) temps[i] = T;
    pen[i] = DT_H * r.gewicht * (
      g.ziel * Math.max(0, r.ziel[i] - T) + g.unter * Math.max(0, r.unter[i] - T) +
      g.sicher * Math.max(0, r.sicher[i] - T) + g.ueber * Math.max(0, T - r.max[i]));
  }
  return { pen, T: Tv, S: Sv };
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
 * einschalten, die die Gesamtkosten (Netz-kWh + Komfort) am meisten senken – solange es etwas bringt
 * und die Leistungsgrenze je Slot hält. Danach ein Durchgang, der Überflüssiges wieder ausschaltet.
 */
export function plane(raeume: PlanRaum[], slots: PlanSlot[], bat: Batterie, g: Gewichte, maxSchritte = 600): Ergebnis {
  const N = slots.length, R = raeume.length, B = Math.ceil(N / BLOCK);
  const h = raeume.map(r => r.fest.map(f => (f == null ? 0 : f)));
  const heizW = new Array(N).fill(0);
  for (let i = 0; i < N; i++) for (let r = 0; r < R; r++) heizW[i] += h[r][i] * raeume[r].p;

  let rs = raeume.map((r, i) => simRaum(r, h[i], slots, g));
  let en = simEnergie(heizW, slots, bat, g);
  const penSum = (p: number[], ab: number) => { let s = 0; for (let i = ab; i < p.length; i++) s += p[i]; return s; };
  const batEnde = (e: number[]) => e[N - 1] ?? bat.eKwh;
  let kosten = en.kosten - g.batterieRest * (batEnde(en.e) - bat.eKwh) + rs.reduce((s, x) => s + penSum(x.pen, 0), 0);

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
    const e0 = i0 > 0 ? en.e[i0 - 1] : undefined;
    const ne = simEnergie(hw, slots, bat, g, i0, e0);
    const vorherEnergie = (() => { let s = 0; for (let i = i0; i < N; i++) s += DT_H / 1000 * (en.netz[i] - g.einspeiseFaktor * en.einsp[i]); return s; })();
    const d = (ne.kosten - vorherEnergie) - g.batterieRest * (batEnde(ne.e) - batEnde(en.e))
      + (penSum(nr.pen, i0) - penSum(rs[r].pen, i0));
    return { d, hn, hw, nr, ne, i0 };
  };
  const uebernehme = (r: number, x: NonNullable<ReturnType<typeof versuche>>) => {
    h[r] = x.hn;
    for (let i = 0; i < N; i++) heizW[i] = x.hw[i];
    for (let i = x.i0; i < N; i++) { rs[r].pen[i] = x.nr.pen[i]; rs[r].T[i] = x.nr.T[i]; rs[r].S[i] = x.nr.S[i]; }
    for (let i = x.i0; i < N; i++) { en.netz[i] = x.ne.netz[i]; en.einsp[i] = x.ne.einsp[i]; en.e[i] = x.ne.e[i]; }
    kosten += x.d;
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

  // Ergebnis vollständig nachrechnen
  rs = raeume.map((r, i) => simRaum(r, h[i], slots, g));
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
    kosten: en.kosten - g.batterieRest * (batEnde(en.e) - bat.eKwh) + rs.reduce((s, x) => s + penSum(x.pen, 0), 0),
    schritte,
  };
}

/** Bewertet einen vorgegebenen Heizplan (z. B. was die heutige Steuerung tatsächlich gemacht hat). */
export function bewerte(raeume: PlanRaum[], slots: PlanSlot[], bat: Batterie, g: Gewichte, heizen: number[][]): Ergebnis {
  const fixe = raeume.map((r, i) => ({ ...r, fest: heizen[i].map(v => (v >= 0.5 ? 1 : 0) as 0 | 1) }));
  return plane(fixe, slots, bat, g, 0);
}
