// heizplaner-muenchen (12.11.2026) – Planer der Auto-Steuerung München, doc/AUTO-STEUERUNG-2026-11-12.md
//
// ÜBERNOMMEN aus Heizung Venediger (Grundregel doc/KONZEPT.md): UliBer1508/smartfox-insight-ai-selfhosted ·
// supabase/functions/heizplaner/index.ts · Commit bf8d3a7. Der Rechenkern modell.ts ist eine unveränderte Kopie.
// Hier geändert ist nur, was München anders hat – jede Stelle ist mit „MÜNCHEN:“ markiert:
//   * Daten aus muc_heizplaner_daten (muc_*-Tabellen), Ergebnisse in muc_heizmodell / muc_heizplan / muc_heizplan_vergleich
//   * Wetter (Strahlung, Temperatur) direkt von Open-Meteo, Ortszeit Europe/Berlin
//   * Ziel je Raum nach München-Profil: morgens/tagsüber angehakt → Normal, sonst Untergrenze; Höchstwert = PV-Wert
//   * „Heizen“ = Ventil offen; Leistung je Raum = Strom der Wärmepumpe je offenem Kreis (aus den Heizläufen)
//   * Leistungsgrenze ohne Sonne = Netzgrenze (Kreise) × Leistung je Kreis; Priorität 1–4
//
// SCHATTENBETRIEB: Der Planer steuert nichts. Er schreibt seinen Plan in muc_heizplan und rechnet jeden Tag nach,
// was er an Stelle der heutigen Steuerung (Collector) gemacht hätte (muc_heizplan_vergleich). Steuern erst nach Ulis Freigabe.
//
// Aufrufe (POST, Body oder Query `aktion`) – MÜNCHEN: angestoßen vom Collector auf dem Mini-PC (collector/src/planer.js):
//   planen            – alle 15 min
//   lernen  raum=<id> – Raummodell eines Raums lernen (03:00, je Raum ein Aufruf wegen der Rechenzeit-Grenze)
//   pv_lernen         – PV-Vorhersage je Stunde lernen (03:00)
//   vergleich tag=…   – Gegenrechnung eines Tages (Standard: gestern)
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';
import {
  BLOCK, SLOTS, bewerte, estrichAus, lernePv, lerneRaum, nachfuehrFaktor, plane, prognoseFehler, pvVorhersage,
  type Batterie, type Fenster, type Gewichte, type PlanRaum, type PlanSlot, type PvModell, type RaumParam,
} from './modell.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const STANDARD_PARAM: RaumParam = { k: 0.01, g: 0.4, s: 0, c: 0.12, tau: 0 };
const PLAN_AUFBEWAHREN_TAGE = 3;
// MÜNCHEN: Standort für Open-Meteo (wie der Collector, WEATHER_LAT/LON) und Batterie-Leistung FENECON
const LAT = Number(Deno.env.get('MUC_LAT') ?? 48.14), LON = Number(Deno.env.get('MUC_LON') ?? 11.58);
const BAT_MAX_W = 5000;
const P_STANDARD = 400;   // W je offenem Kreis, bis genug Heizläufe gemessen sind (Aufheizläufe zeigen 250–550 W)

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
}
async function authorize(req: Request): Promise<boolean> {
  const auth = req.headers.get('Authorization');
  if (!auth?.startsWith('Bearer ')) return false;
  const token = auth.replace('Bearer ', '');
  const known = [SERVICE_KEY, Deno.env.get('SUPABASE_ANON_KEY'), Deno.env.get('SUPABASE_PUBLISHABLE_KEY')].filter(Boolean);
  if (known.includes(token)) return true;
  try {
    const payload = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    return ['authenticated', 'service_role'].includes(payload.role || payload.aud);
  } catch { return false; }
}

// ---------------------------------------------------------------- Zeit (MÜNCHEN: Europe/Berlin)
const TZ = 'Europe/Berlin';
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
const imFenster = (m: number, s: number, e: number) => (s === e ? false : s < e ? m >= s && m < e : m >= s || m < e);

// ---------------------------------------------------------------- MÜNCHEN: Wetter von Open-Meteo
// Ergebnis wie Venediger heizplaner_daten.wetter: [„YYYY-MM-DD HH“ Ortszeit, direkt W/m², diffus W/m², °C]
async function wetterLaden(tageZurueck: number): Promise<[string, number, number, number][]> {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${LAT}&longitude=${LON}` +
    `&hourly=temperature_2m,direct_radiation,diffuse_radiation&timezone=${encodeURIComponent(TZ)}` +
    `&past_days=${Math.min(92, Math.max(1, tageZurueck))}&forecast_days=3`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`Open-Meteo ${res.status}`);
  const h = (await res.json())?.hourly;
  if (!h?.time) throw new Error('Open-Meteo: keine Stundenwerte');
  return h.time.map((t: string, i: number) => [t.replace('T', ' ').slice(0, 13), Math.round(h.direct_radiation[i] ?? 0),
    Math.round(h.diffuse_radiation[i] ?? 0), Number(h.temperature_2m[i])] as [string, number, number, number])
    .filter((w: [string, number, number, number]) => Number.isFinite(w[3]));
}

async function datenLaden(sb: any, tage: number): Promise<Daten> {
  const [{ data, error }, wetter] = await Promise.all([sb.rpc('muc_heizplaner_daten', { p_tage: tage }), wetterLaden(Math.max(tage, 30) + 1)]);
  if (error) throw new Error(`muc_heizplaner_daten: ${error.message} (migration-014 ausgeführt?)`);
  return { ...data, wetter };
}

// ---------------------------------------------------------------- Daten aufbereiten
export interface Daten {
  jetzt: number; settings: any; preis: { grid_ct: number; feed_ct: number } | null; raeume: any[];
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
type Aufb = ReturnType<typeof aufbereiten>;

function fensterFuer(a: Aufb, rid: string, alleH: number, laengeH: number): Fenster[] {
  const m = a.smp.get(rid);
  if (!m) return [];
  const out: Fenster[] = [];
  for (const t0 of [...m.keys()].sort((x, y) => x - y)) {
    if (t0 % (alleH * 3600) !== 0) continue;
    const st = Array.from({ length: laengeH * 4 }, (_, i) => t0 + 900 * i);
    if (!st.every(x => m.has(x) && a.e15.has(x) && a.wet.has(wkey(x)))) continue;
    out.push({
      T0: m.get(t0)!.t,
      hist: Array.from({ length: 48 }, (_, i) => m.get(t0 - 900 * (48 - i))?.h ?? 0),
      h: st.map(x => m.get(x)!.h), tout: st.map(x => a.wet.get(wkey(x))!.t),
      pvkw: st.map(x => a.e15.get(x)![2] / 1000), tIst: st.map(x => m.get(x + 900)?.t ?? null),
    });
  }
  return out;
}

function gewichte(d: Daten): Gewichte {
  const s = d.settings;
  // MÜNCHEN: Preise aus muc_prices (Einstellungen › Strompreis)
  const buy = Number(d.preis?.grid_ct) || 30, feed = Number(d.preis?.feed_ct) || 8;
  return { ziel: Number(s?.planer_gewicht_ziel ?? 0.6), unter: Number(s?.planer_gewicht_unter ?? 2), sicher: 30, ueber: 0.2,
           einspeiseFaktor: Math.min(1, feed / buy), batterieRest: 0.9 };
}

// MÜNCHEN: Leistung je Kreis (W) – gemessen aus den Heizläufen, sonst Standardwert
const leistung = (r: any) => (Number(r.p_n) >= 2 && Number(r.p) > 0 ? Math.min(2000, Math.max(150, Number(r.p))) : P_STANDARD);

/** Räume und Slots für einen Plan ab `start` aufbauen. pvVon(ep) liefert die PV je Slot (W). */
function baue(d: Daten, a: Aufb, start: number, pvVon: (ep: number, i: number) => number,
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
    const param = d.modell?.[r.id]?.param ?? STANDARD_PARAM;
    const m = a.smp.get(r.id);
    const S0 = estrichAus(Array.from({ length: 48 }, (_, i) => m?.get(start - 900 * (48 - i))?.h ?? 0), param.tau);
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

function batterieVon(d: Daten, socProzent: number): Batterie {
  const cap = Number(d.settings?.battery_kwh) || 10;
  return { eKwh: cap * socProzent / 100, capKwh: cap, minKwh: cap * 0.05, maxLadenW: BAT_MAX_W, maxEntladenW: BAT_MAX_W, eta: 0.95 };
}
const letzterSoc = (a: Aufb, bis: number) => { let best = -1, soc = 50; for (const [k, v] of a.e15) if (k <= bis && k > best) { best = k; soc = v[3]; } return soc; };
const r1 = (x: number) => Math.round(x * 10) / 10;

// ---------------------------------------------------------------- Aktionen
async function planen(sb: any) {
  const d = await datenLaden(sb, 2);
  if ((d.settings?.planer_modus ?? 'schatten') === 'aus') return { ok: true, aus: true };
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
    if (r.manuell_bis && new Date(r.manuell_bis).getTime() > ep * 1000) return r.heizt ? 1 : 0;          // manuell: so lassen
    return null;
  };
  const { slots, raeume, eps } = baue(d, a, start, pvVon, r => (r.t == null ? null : Number(r.t)), fest);
  const bat = batterieVon(d, letzterSoc(a, d.jetzt));
  const g = gewichte(d);
  const erg = plane(raeume, slots, bat, g);

  const jetzt = raeume.map((r, i) => {
    const room = d.raeume.find((x: any) => x.id === r.id);
    const planHeizt = erg.heizen[i][0] === 1;
    const naechstAn = erg.heizen[i].findIndex(v => v === 1);
    const naechstAus = planHeizt ? erg.heizen[i].findIndex(v => v === 0) : -1;
    return {
      room_id: r.id, name: r.name, t: r.T0, plan_heizt: planHeizt, steuerung_heizt: !!room?.heizt,
      manuell: !!(room?.manuell_bis && new Date(room.manuell_bis).getTime() > jetztMs), auto: room?.auto !== false,
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
      ziel: r.ziel.map(r1), unter: r1(r.unter[0]) })),
    gewichte: g, batterie_start: r1(bat.eKwh), schritte: erg.schritte,
  };
  const pvKwh = slots.reduce((s, x) => s + x.pv, 0) / 4000;
  const { error: insErr } = await sb.from('muc_heizplan').insert({
    start_at: new Date(start * 1000).toISOString(), modus: d.settings?.planer_modus ?? 'schatten', plan, jetzt,
    pv_kwh: r1(pvKwh), heiz_kwh: r1(erg.heizKwh), netz_kwh: r1(erg.netzKwh), einspeis_kwh: r1(erg.einspeisKwh),
    unter_ziel_gradstd: r1(erg.komfortGradStd), unter_grenze_gradstd: r1(erg.unterGradStd), nachfuehrung: Math.round(f * 100) / 100,
  });
  if (insErr) throw new Error(`muc_heizplan: ${insErr.message}`);
  await sb.from('muc_heizplan').delete().lt('erstellt_at', new Date(Date.now() - PLAN_AUFBEWAHREN_TAGE * 86400000).toISOString());
  return { ok: true, start: wall(start), pv_kwh: r1(pvKwh), heiz_kwh: r1(erg.heizKwh), netz_kwh: r1(erg.netzKwh),
           nachfuehrung: f, jetzt: jetzt.filter(j => j.plan_heizt || j.steuerung_heizt).map(j => `${j.name}: Planer ${j.plan_heizt ? 'heizt' : '–'}, Steuerung ${j.steuerung_heizt ? 'heizt' : '–'}`) };
}

async function lernen(sb: any, raumId: string, tage: number) {
  const d = await datenLaden(sb, tage);
  const a = aufbereiten(d);
  const r = d.raeume.find((x: any) => x.id === raumId);
  if (!r) throw new Error(`Raum ${raumId} unbekannt`);
  const wins = fensterFuer(a, raumId, 6, 24);
  if (wins.length < 4) return { ok: false, raum: r.name, grund: `zu wenig Daten (${wins.length} Fenster)` };
  const heizStd = [...(a.smp.get(raumId)?.values() ?? [])].reduce((s, x) => s + x.h, 0) / 4;
  const gute = Object.entries(d.modell ?? {}).filter(([id, m]: any) => id !== raumId && !m.prior && Number(m.heiz_std) >= 15).map(([, m]: any) => m.param as RaumParam);
  const med = (xs: number[]) => { const s = [...xs].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
  const prior: RaumParam = gute.length >= 2
    ? { k: med(gute.map(p => p.k)), g: med(gute.map(p => p.g)), s: 0, c: med(gute.map(p => p.c)), tau: med(gute.map(p => p.tau)) }
    : STANDARD_PARAM;
  const pw = heizStd >= 15 ? 0 : heizStd >= 3 ? 0.02 : 0.2;
  const p = lerneRaum(wins, prior, pw, [0, 1, 2]);
  const fe = prognoseFehler(p, fensterFuer(a, raumId, 3, 12), 47);
  const zeile = { room_id: raumId, raum: r.name, param: { k: +p.k.toFixed(5), g: +p.g.toFixed(4), s: +p.s.toFixed(4), c: +p.c.toFixed(4), tau: p.tau },
    fehler_12h: Number.isFinite(fe.modell) ? +fe.modell.toFixed(2) : null, gleich_12h: Number.isFinite(fe.gleich) ? +fe.gleich.toFixed(2) : null,
    heiz_std: +heizStd.toFixed(1), prior: pw > 0, tage, p_w: leistung(r), gelernt_at: new Date().toISOString() };
  const { error: upErr } = await sb.from('muc_heizmodell').upsert(zeile, { onConflict: 'room_id' });
  if (upErr) throw new Error(`muc_heizmodell: ${upErr.message}`);
  return { ok: true, ...zeile, fenster: wins.length };
}

async function pvLernen(sb: any, tage: number) {
  const d = await datenLaden(sb, tage);
  const a = aufbereiten(d);
  const coef = lernePv(a.pvIst, new Map([...a.wet].filter(([k]) => a.pvIst.has(k))));
  // MÜNCHEN: in muc_settings.planer_pv_modell statt system_settings
  const { error } = await sb.from('muc_settings').update({ planer_pv_modell: { coef, tage, gelernt_at: new Date().toISOString() } }).eq('id', 1);
  if (error) throw new Error(`muc_settings: ${error.message}`);
  return { ok: true, stunden: Object.keys(coef).length };
}

async function vergleich(sb: any, tag: string) {
  const d = await datenLaden(sb, 3);
  const a = aufbereiten(d);
  const g0 = mitternacht(tag);
  const pvEcht = (ep: number) => a.e15.get(ep)?.[2] ?? 0;
  const T0 = (r: any) => a.smp.get(r.id)?.get(g0)?.t ?? null;
  const b = baue(d, a, g0, pvEcht, T0);
  if (b.raeume.length === 0) return { ok: false, grund: 'keine Temperaturen um Mitternacht' };
  const bat = batterieVon(d, letzterSoc(a, g0));
  const g = gewichte(d);
  const heizIst = b.raeume.map(r => b.eps.map(ep => a.smp.get(r.id)?.get(ep)?.h ?? 0));
  const eIst = bewerte(b.raeume, b.slots, bat, g, heizIst);
  const ePlan = plane(b.raeume, b.slots, bat, g);
  let lo = 0.02, hi = 4, gleich: any = null;
  for (let it = 0; it < 6; it++) {
    const m = Math.sqrt(lo * hi);
    const e = plane(b.raeume, b.slots, bat, { ...g, ziel: g.ziel * m, unter: g.unter * m });
    if (e.komfortGradStd > eIst.komfortGradStd) lo = m; else { hi = m; gleich = { m, e }; }
  }
  let abw = 0, n = 0;
  b.raeume.forEach((r, i) => b.eps.forEach((ep, j) => { const t = a.smp.get(r.id)?.get(ep + 900)?.t; if (t != null) { abw += Math.abs(eIst.temp[i][j] - t); n++; } }));
  const netzGem = b.eps.reduce((s, ep) => s + Math.max(0, a.e15.get(ep)?.[4] ?? 0), 0) / 4000;
  const kurz = (e: any) => ({ heiz_kwh: r1(e.heizKwh), netz_kwh: r1(e.netzKwh), einspeis_kwh: r1(e.einspeisKwh),
    unter_ziel_gradstd: r1(e.komfortGradStd), unter_grenze_gradstd: r1(e.unterGradStd) });
  const zeile = { tag, netz_gemessen_kwh: r1(netzGem), steuerung: kurz(eIst), planer: kurz(ePlan),
    planer_gleich: gleich ? { ...kurz(gleich.e), faktor: Math.round(gleich.m * 100) / 100 } : null,
    modell_abw: n ? Math.round(abw / n * 100) / 100 : null, erstellt_at: new Date().toISOString() };
  const { error: upErr } = await sb.from('muc_heizplan_vergleich').upsert(zeile, { onConflict: 'tag' });
  if (upErr) throw new Error(`muc_heizplan_vergleich: ${upErr.message}`);
  return { ok: true, ...zeile };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });
  if (!await authorize(req)) return json({ error: 'Unauthorized' }, 401);
  try {
    const url = new URL(req.url);
    let body: any = {};
    try { body = await req.json(); } catch { /* ohne Body */ }
    const aktion = body.aktion ?? url.searchParams.get('aktion') ?? 'planen';
    const sb = createClient(SUPABASE_URL, SERVICE_KEY);
    const gestern = new Date(Date.now() - 86400000).toLocaleDateString('sv-SE', { timeZone: TZ });
    let res: unknown;
    if (aktion === 'planen') res = await planen(sb);
    else if (aktion === 'lernen') res = await lernen(sb, body.raum ?? url.searchParams.get('raum'), Number(body.tage ?? url.searchParams.get('tage')) || 30);
    else if (aktion === 'pv_lernen') res = await pvLernen(sb, Number(body.tage ?? url.searchParams.get('tage')) || 30);
    else if (aktion === 'vergleich') res = await vergleich(sb, body.tag ?? url.searchParams.get('tag') ?? gestern);
    else return json({ error: `unbekannte aktion ${aktion}` }, 400);
    console.log(`[HEIZPLANER-MUENCHEN] ${aktion}: ${JSON.stringify(res).slice(0, 400)}`);
    return json(res);
  } catch (e) {
    console.error('heizplaner-muenchen:', e);
    return json({ error: String(e) }, 500);
  }
});
