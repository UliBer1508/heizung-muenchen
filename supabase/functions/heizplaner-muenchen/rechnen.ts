// Heizplaner München – Daten aufbereiten, lernen, planen, gegenrechnen (ohne Datenbank-Zugriff).
//
// ÜBERNOMMEN aus Heizung Venediger (Grundregel doc/KONZEPT.md): UliBer1508/smartfox-insight-ai-selfhosted ·
// supabase/functions/heizplaner/rechnen.ts · Commit b9444bb (13.11.2026, doc/FIX-PLANER-MODELL-2026-11-13.md dort).
// Geändert ist nur, was München anders hat – jede Stelle ist mit „MÜNCHEN:“ markiert:
//   * Ortszeit Europe/Berlin; Preise aus muc_prices; Batterie FENECON 10 kWh / 5 kW
//   * Ziel je Raum nach München-Profil (Tagesphasen wie der Collector), Höchstwert = PV-Wert, Priorität 1–4
//   * Leistung je Raum = Strom der Wärmepumpe je offenem Kreis; Leistungsgrenze = Netzgrenze (Kreise) × Leistung
//   * „nicht steuerbar“ heißt in München: Ventil hängt (muc_rooms.ventil_haengt_seit, KI-Prüfung migration-015)
//   * keine Abwesenheit (München hat keinen Belegungskalender)
import {
  BLOCK, SLOTS, STANDARD_PARAM, aufheizen, bewerte, estrichStart, istV2, lernePv, lerneRaum, nachfuehrFaktor, plane,
  prognoseFehler, pvVorhersage,
  type Batterie, type Fenster, type Gewichte, type PlanRaum, type PlanSlot, type PvModell, type RaumParam,
} from './modell.ts';

export const PLAN_AUFBEWAHREN_TAGE = 3;

// ---------------------------------------------------------------- Zeit (MÜNCHEN: Ortszeit Europe/Berlin)
const TZ = 'Europe/Berlin';   // MÜNCHEN
const FMT = new Intl.DateTimeFormat('sv-SE', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
export const wall = (ep: number) => FMT.format(new Date(ep * 1000)).replace(',', '');     // „YYYY-MM-DD HH:MM“
export const wkey = (ep: number) => wall(ep).slice(0, 13);
const minuten = (hhmm: string | null | undefined, fb: string) => { const [h, m] = String(hhmm || fb).split(':').map(Number); return h * 60 + (m || 0); };
/** Epoch-Sekunden von Mitternacht (Ortszeit) eines Tages. */
export function mitternacht(tag: string): number {
  let ep = Date.UTC(Number(tag.slice(0, 4)), Number(tag.slice(5, 7)) - 1, Number(tag.slice(8, 10))) / 1000 - 3 * 3600;
  for (let i = 0; i < 24 && wall(ep) !== `${tag} 00:00`; i++) ep += 900;
  return ep;
}

// ---------------------------------------------------------------- Daten aufbereiten
export interface Daten {
  jetzt: number; settings: any; preis: { grid_ct: number; feed_ct: number } | null; raeume: any[];   // MÜNCHEN: preis
  modell: Record<string, { param: RaumParam; heiz_std: number; prior: boolean }> | null;
  pv_modell: { coef: PvModell } | null;
  energie15: [number, number, number, number, number][];
  samples15: Record<string, [number, number, number][]> | null;
  wetter: [string, number, number, number][];
  pv_h: [string, number][];
}
export function aufbereiten(d: Daten) {
  const wet = new Map<string, { dir: number; dif: number; t: number }>((d.wetter ?? []).map(w => [w[0], { dir: Number(w[1]) || 0, dif: Number(w[2]) || 0, t: Number(w[3]) }]));
  const e15 = new Map<number, number[]>((d.energie15 ?? []).map(r => [Number(r[0]), r.map(Number)]));
  const pvIst = new Map<string, number>((d.pv_h ?? []).map(r => [r[0], Number(r[1])]));
  const smp = new Map<string, Map<number, { t: number; h: number }>>();
  for (const [rid, arr] of Object.entries(d.samples15 ?? {})) smp.set(rid, new Map(arr.map(a => [Number(a[0]), { t: Number(a[1]), h: Number(a[2]) }])));
  return { wet, e15, pvIst, smp };
}
export type Aufb = ReturnType<typeof aufbereiten>;

export function fensterFuer(a: Aufb, rid: string, alleH: number, laengeH: number): Fenster[] {
  const m = a.smp.get(rid);
  if (!m) return [];
  const out: Fenster[] = [];
  for (const t0 of [...m.keys()].sort((x, y) => x - y)) {
    if (t0 % (alleH * 3600) !== 0) continue;
    const st = Array.from({ length: laengeH * 4 }, (_, i) => t0 + 900 * i);
    if (!st.every(x => m.has(x) && a.e15.has(x) && a.wet.has(wkey(x)))) continue;
    const T0 = m.get(t0)!.t;
    const hz = Array.from({ length: 48 }, (_, i) => t0 - 900 * (48 - i));
    out.push({
      T0,
      histT: hz.map(x => m.get(x)?.t ?? T0), histH: hz.map(x => m.get(x)?.h ?? 0),
      h: st.map(x => m.get(x)!.h), tout: st.map(x => a.wet.get(wkey(x))!.t),
      pvkw: st.map(x => a.e15.get(x)![2] / 1000),
      tIst: st.map(x => m.get(x + 900)?.t ?? null),
    });
  }
  return out;
}

// MÜNCHEN: Preise aus muc_prices (Einstellungen › Strompreis)
export function gewichte(s: any, preis: Daten['preis']): Gewichte {
  const buy = Number(preis?.grid_ct) || 30, feed = Number(preis?.feed_ct) || 8;
  return { ziel: Number(s?.planer_gewicht_ziel ?? 0.6), unter: Number(s?.planer_gewicht_unter ?? 2), sicher: 30, ueber: 0.2,
           einspeiseFaktor: Math.min(1, feed / buy), batterieRest: 0.9,
           // 13.11.2026: Wärme im Estrich am Planende zählt wie Restladung der Batterie – sonst „spart“ der Plan, indem er
           // den Wärmespeicher des Hauses leert (Gegenrechnung 12.11.: 12,8 statt 40,9 kWh Heizen bei wärmeren Räumen).
           waermeRest: 0.9 };
}

// MÜNCHEN: Leistung je Kreis (W) – gemessen aus den Heizläufen, sonst Standardwert
export const P_STANDARD = 400;   // W je offenem Kreis, bis genug Heizläufe gemessen sind (Aufheizläufe zeigen 250–550 W)
export const leistung = (r: any) => (Number(r.p_n) >= 2 && Number(r.p) > 0 ? Math.min(2000, Math.max(150, Number(r.p))) : P_STANDARD);
const imFenster = (m: number, s: number, e: number) => (s === e ? false : s < e ? m >= s && m < e : m >= s || m < e);

/** Räume und Slots für einen Plan ab `start` aufbauen. pvVon(ep) liefert die PV je Slot (W). */
export function baue(d: Daten, a: Aufb, start: number, pvVon: (ep: number, i: number) => number,
              T0: (r: any) => number | null, festVon?: (r: any, ep: number, i: number) => 0 | 1 | null) {
  const s = d.settings ?? {};
  // MÜNCHEN: Tagesphasen wie der Collector (Nacht → Morgen → Tag → Abend), Ziel je Raum nach Profil
  const ns = minuten(s.night_start, '22:00'), ms = minuten(s.morning_start, '06:00'), me = minuten(s.morning_end, '09:00'),
        es = minuten(s.evening_start, '17:00');
  const base = Number(s.baseload_w) || 350;
  const pMittel = (() => { const p = d.raeume.map(leistung).sort((x, y) => x - y); return p.length ? p[Math.floor(p.length / 2)] : P_STANDARD; })();
  const cap = Math.max(1, Number(s.max_grid_circuits ?? 6)) * pMittel;   // MÜNCHEN: Netzgrenze in Kreisen
  const abst = Number(s.planer_sicherheit_abstand ?? 1.5);
  const eps = Array.from({ length: SLOTS }, (_, i) => start + 900 * i);
  const minOf = (ep: number) => { const w = wall(ep); return Number(w.slice(11, 13)) * 60 + Number(w.slice(14, 16)); };
  const phase = eps.map(ep => { const m = minOf(ep);
    return imFenster(m, ns, ms) ? 'nacht' : imFenster(m, ms, me) ? 'morgen' : imFenster(m, es, ns) ? 'abend' : 'tag'; });
  const nacht = phase.map(p => p === 'nacht');
  const slots: PlanSlot[] = eps.map((ep, i) => {
    const pv = pvVon(ep, i);
    return { pv, base, tout: a.wet.get(wkey(ep))?.t ?? 3, pvkw: pv / 1000, capW: cap + Math.max(0, pv - base) };
  });
  const raeume: PlanRaum[] = [];
  for (const r of d.raeume) {
    const t0 = T0(r);
    if (t0 == null || !Number.isFinite(t0)) continue;
    const gespeichert = d.modell?.[r.id]?.param;
    const param: RaumParam = istV2(gespeichert) ? gespeichert : STANDARD_PARAM;   // altes Modell → bis zum nächsten Lernen Standard
    const m = a.smp.get(r.id);
    const hz = Array.from({ length: 48 }, (_, i) => start - 900 * (48 - i));
    const S0 = estrichStart(param, hz.map(x => m?.get(x)?.t ?? t0), hz.map(x => m?.get(x)?.h ?? 0), t0);
    const normal = Number(r.normal ?? 21);
    const unter = Number(r.unter ?? normal - 1);
    const ziel = phase.map(p => ((p === 'morgen' && r.morgens) || (p === 'tag' && r.tags) ? normal : unter));
    const hoechst = Number(r.pv_prio) > 0 ? Math.max(normal, Number(r.pv ?? normal + 1)) : normal + 0.5;
    raeume.push({
      id: r.id, name: r.name, p: leistung(r), T0: t0, S0, param,
      ziel, unter: eps.map(() => unter), sicher: eps.map(() => unter - abst), max: eps.map(() => hoechst),
      gewicht: 1 + (4 - Math.min(4, Math.max(1, Number(r.prio) || 4))) / 4,   // MÜNCHEN: Prio 1–4
      fest: eps.map((ep, i) => (festVon ? festVon(r, ep, i) : null)),
    });
  }
  return { slots, raeume, eps, nacht };
}

// MÜNCHEN: FENECON (battery_kwh, 5 kW Laden/Entladen)
export function batterieVon(d: Daten, socProzent: number): Batterie {
  const cap = Number(d.settings?.battery_kwh) || 10;
  return { eKwh: cap * socProzent / 100, capKwh: cap, minKwh: cap * 0.05, maxLadenW: 5000, maxEntladenW: 5000, eta: 0.95 };
}
export const letzterSoc = (a: Aufb, bis: number) => { let best = -1, soc = 50; for (const [k, v] of a.e15) if (k <= bis && k > best) { best = k; soc = v[3]; } return soc; };
export const r1 = (x: number) => Math.round(x * 10) / 10;

/** Plan rechnen ohne Schreiben (auch für die Prüfung). MÜNCHEN: nichtSteuerbar = Räume mit hängendem Ventil, keine Abwesenheit. */
export function planAus(d: Daten, nichtSteuerbar: Set<string>) {
  const a = aufbereiten(d);
  const start = Math.floor(d.jetzt / 900) * 900;
  const pvm: PvModell = d.pv_modell?.coef ?? lernePv(a.pvIst, a.wet);

  // Nachführung an der gemessenen PV der letzten 2 vollen Stunden
  let ist2 = 0, vor2 = 0;
  for (let hh = 1; hh <= 2; hh++) {
    const ep = start - hh * 3600;
    const k = wkey(ep);
    const werte = [0, 1, 2, 3].map(q => a.e15.get(Math.floor(ep / 3600) * 3600 + q * 900)?.[2]).filter(v => v != null) as number[];
    if (werte.length) ist2 += werte.reduce((s, v) => s + v, 0) / werte.length;
    vor2 += pvVorhersage(pvm, k, a.wet.get(k));
  }
  const f = nachfuehrFaktor(ist2, vor2);
  const pvVon = (ep: number, i: number) => pvVorhersage(pvm, wkey(ep), a.wet.get(wkey(ep))) * (1 + (f - 1) * Math.max(0, 1 - (i * 0.25) / 4));

  const jetztMs = d.jetzt * 1000;
  const fest = (r: any, ep: number) => {
    if (r.auto === false) return (ep === start && r.heizt) ? 1 : 0;                                        // Automatik aus: nicht planen
    if (nichtSteuerbar.has(r.id)) return r.heizt ? 1 : 0;                                                  // MÜNCHEN: Ventil hängt
    if (r.manuell_bis && new Date(r.manuell_bis).getTime() > ep * 1000) return r.heizt ? 1 : 0;          // manuell: so lassen
    return null;
  };
  const { slots, raeume, eps } = baue(d, a, start, pvVon, r => (r.t == null ? null : Number(r.t)), fest);
  const bat = batterieVon(d, letzterSoc(a, d.jetzt));
  const g = gewichte(d.settings, d.preis);
  const erg = plane(raeume, slots, bat, g);

  const jetzt = raeume.map((r, i) => {
    const room = d.raeume.find((x: any) => x.id === r.id);
    const planHeizt = erg.heizen[i][0] === 1;
    // nächster Heizbeginn / Heizende im Plan
    const naechstAn = erg.heizen[i].findIndex(v => v === 1);
    const naechstAus = planHeizt ? erg.heizen[i].findIndex(v => v === 0) : -1;
    return {
      room_id: r.id, name: r.name, t: r.T0, plan_heizt: planHeizt, steuerung_heizt: !!room?.heizt,
      manuell: !!(room?.manuell_bis && new Date(room.manuell_bis).getTime() > jetztMs), auto: room?.auto !== false,
      nicht_steuerbar: nichtSteuerbar.has(r.id), ziel: r1(r.ziel[0]), unter: r1(r.unter[0]),
      naechst_an: naechstAn >= 0 ? new Date(eps[naechstAn] * 1000).toISOString() : null,
      bis: naechstAus > 0 ? new Date(eps[naechstAus] * 1000).toISOString() : null,
      t_min: r1(Math.min(...erg.temp[i])), t_max: r1(Math.max(...erg.temp[i])),
    };
  });
  const plan = {
    start, slot_min: 15, block: BLOCK,
    pv: slots.map(s => Math.round(s.pv)), heiz: erg.heizW.map(Math.round), netz: erg.netzW.map(Math.round),
    einsp: erg.einspeisW.map(Math.round), bat: erg.batKwh.map(r1), tout: slots.map(s => r1(s.tout)),
    raeume: raeume.map((r, i) => ({ id: r.id, name: r.name, p: r.p, h: erg.heizen[i].join(''), t: erg.temp[i].map(r1),
      ziel: r.ziel.map(r1), unter: r1(r.unter[0]),
      // m2: Raummodell der neuen Form gelernt (13.11.2026)
      m2: istV2(d.modell?.[r.id]?.param) })),
    gewichte: g, batterie_start: r1(bat.eKwh), schritte: erg.schritte, waerme_kwh: r1(erg.waermeKwh),
  };
  const pvKwh = slots.reduce((s, x) => s + x.pv, 0) / 4000;
  const zeile = {
    start_at: new Date(start * 1000).toISOString(), modus: d.settings?.planer_modus ?? 'schatten', plan, jetzt,
    pv_kwh: r1(pvKwh), heiz_kwh: r1(erg.heizKwh), netz_kwh: r1(erg.netzKwh), einspeis_kwh: r1(erg.einspeisKwh),
    unter_ziel_gradstd: r1(erg.komfortGradStd), unter_grenze_gradstd: r1(erg.unterGradStd), nachfuehrung: Math.round(f * 100) / 100,
  };
  const antwort = { ok: true, start: wall(start), pv_kwh: r1(pvKwh), heiz_kwh: r1(erg.heizKwh), netz_kwh: r1(erg.netzKwh),
           waerme_kwh: r1(erg.waermeKwh), nachfuehrung: f,
           jetzt: jetzt.filter(j => j.plan_heizt || j.steuerung_heizt).map(j => `${j.name}: Planer ${j.plan_heizt ? 'heizt' : '–'}, Steuerung ${j.steuerung_heizt ? 'heizt' : '–'}`) };
  return { zeile, antwort, erg, raeume };
}

/** Lernen ohne Schreiben (auch für die Prüfung „pruefen“). */
export function lerneAus(d: Daten, raumId: string, tage: number, priorVon?: Record<string, RaumParam>) {
  const a = aufbereiten(d);
  const r = d.raeume.find((x: any) => x.id === raumId);
  if (!r) throw new Error(`Raum ${raumId} unbekannt`);
  const wins = fensterFuer(a, raumId, 6, 24);
  if (wins.length < 4) return { ok: false as const, raum: r.name, grund: `zu wenig Daten (${wins.length} Fenster)` };
  const heizStd = [...(a.smp.get(raumId)?.values() ?? [])].reduce((s, x) => s + x.h, 0) / 4;
  // Prior: Median der Räume mit viel eigener Heizerfahrung (gespeicherte Modelle der neuen Form)
  const quelle: [string, { param: RaumParam; heiz_std: number; prior: boolean }][] = priorVon
    ? Object.entries(priorVon).map(([id, p]) => [id, { param: p, heiz_std: 99, prior: false }])
    : Object.entries(d.modell ?? {}) as any;
  const gute = quelle.filter(([id, m]) => id !== raumId && !m.prior && Number(m.heiz_std) >= 15 && istV2(m.param)).map(([, m]) => m.param);
  const med = (xs: number[]) => { const s = [...xs].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
  const prior: RaumParam = gute.length >= 2
    ? { v: 2, k: med(gute.map(p => p.k)), g: med(gute.map(p => p.g)), u: med(gute.map(p => p.u)),
        r: med(gute.map(p => p.r)), s: 0, c: med(gute.map(p => p.c)) }
    : STANDARD_PARAM;
  const pw = heizStd >= 15 ? 0 : heizStd >= 3 ? 0.02 : 0.2;
  const p = lerneRaum(wins, prior, pw);
  const fe = prognoseFehler(p, fensterFuer(a, raumId, 3, 12), 47);
  const rund = (x: number, n: number) => +x.toFixed(n);
  const zeile = {
    room_id: raumId, raum: r.name,
    param: { v: 2 as const, k: rund(p.k, 5), g: rund(p.g, 4), u: rund(p.u, 4), r: rund(p.r, 3), s: rund(p.s, 4), c: rund(p.c, 4),
             // zur Anzeige: Aufheizen von Estrich + Raum zusammen (°C/h)
             auf: rund(aufheizen(p), 3) },
    fehler_12h: Number.isFinite(fe.modell) ? +fe.modell.toFixed(2) : null, gleich_12h: Number.isFinite(fe.gleich) ? +fe.gleich.toFixed(2) : null,
    heiz_std: +heizStd.toFixed(1), prior: pw > 0, tage, gelernt_at: new Date().toISOString(),
  };
  return { ok: true as const, zeile, fenster: wins.length };
}

/** Gegenrechnung eines Tages ohne Schreiben. */
export function vergleichAus(d: Daten, tag: string, nichtSteuerbar: Set<string>): any {
  const a = aufbereiten(d);
  const g0 = mitternacht(tag);
  const pvEcht = (ep: number) => a.e15.get(ep)?.[2] ?? 0;
  const T0 = (r: any) => a.smp.get(r.id)?.get(g0)?.t ?? null;
  // Räume, deren Ventil hängt (MÜNCHEN): auch im Plan so, wie sie wirklich geheizt haben
  const fest = (r: any, ep: number) => (nichtSteuerbar.has(r.id) ? ((a.smp.get(r.id)?.get(ep)?.h ?? 0) >= 0.5 ? 1 : 0) : null);
  const b = baue(d, a, g0, pvEcht, T0, fest);
  if (b.raeume.length === 0) return { ok: false, grund: 'keine Temperaturen um Mitternacht' };
  const bat = batterieVon(d, letzterSoc(a, g0));
  const g = gewichte(d.settings, d.preis);
  const heizIst = b.raeume.map(r => b.eps.map(ep => a.smp.get(r.id)?.get(ep)?.h ?? 0));
  const eIst = bewerte(b.raeume, b.slots, bat, g, heizIst);
  const ePlan = plane(b.raeume, b.slots, bat, g);
  // Modellprüfung: Simulation mit echter Heizung gegen gemessene Temperaturen
  let abw = 0, n = 0;
  b.raeume.forEach((r, i) => b.eps.forEach((ep, j) => { const t = a.smp.get(r.id)?.get(ep + 900)?.t; if (t != null) { abw += Math.abs(eIst.temp[i][j] - t); n++; } }));
  const netzGem = b.eps.reduce((s, ep) => s + Math.max(0, a.e15.get(ep)?.[4] ?? 0), 0) / 4000;
  // waerme_kwh: gespeicherte Wärme am Tagesende gegenüber Mitternacht (Estrich + Luft). Ein Plan, der weniger heizt,
  // aber den Speicher leert, ist nicht besser – deshalb steht die Wärme dabei (13.11.2026).
  const kurz = (e: any) => ({ heiz_kwh: r1(e.heizKwh), netz_kwh: r1(e.netzKwh), einspeis_kwh: r1(e.einspeisKwh),
    unter_ziel_gradstd: r1(e.komfortGradStd), unter_grenze_gradstd: r1(e.unterGradStd), waerme_kwh: r1(e.waermeKwh) });
  // Fairer Vergleich (13.11.2026): Netz des Planers, bereinigt um die Wärme, die er am Tagesende mehr (oder weniger) im
  // Haus gespeichert hat als die Steuerung. Die frühere Spalte „Planer bei gleichem Komfort“ (Komfort-Gewicht skaliert)
  // entfällt: Mit dem Wert der Restwärme leerte sie den Estrich und war nicht mehr vergleichbar.
  const planer = { ...kurz(ePlan), netz_bereinigt_kwh: r1(ePlan.netzKwh - (ePlan.waermeKwh - eIst.waermeKwh)) };
  return { ok: true, tag, netz_gemessen_kwh: r1(netzGem), steuerung: kurz(eIst), planer,
    planer_gleich: null,
    modell_abw: n ? Math.round(abw / n * 100) / 100 : null, erstellt_at: new Date().toISOString() };
}


/** PV-Vorhersage je Stunde lernen – nur vergangene Stunden mit gemessener PV. */
export function pvLernenAus(d: Daten): PvModell {
  const a = aufbereiten(d);
  return lernePv(a.pvIst, new Map([...a.wet].filter(([k]) => a.pvIst.has(k))));
}
