// heizplaner-muenchen (12.11.2026, neues Raummodell 13.11.2026, Stand Venediger 24.11.2026) – Planer der Auto-Steuerung München
// doc/AUTO-STEUERUNG-2026-11-12.md, doc/PLANER-WIE-VENEDIGER-2026-11-24.md, doc/ABGLEICH-VENEDIGER.md
//
// ÜBERNOMMEN aus Heizung Venediger (Grundregel doc/KONZEPT.md): UliBer1508/smartfox-insight-ai-selfhosted ·
// supabase/functions/heizplaner/index.ts · Commit af244ae. modell.ts, pruefung.ts und _shared/heizregeln.ts sind Kopien,
// rechnen.ts und diese Datei haben „MÜNCHEN:“-Stellen:
//   * Daten aus muc_heizplaner_daten (muc_*-Tabellen), Ergebnisse in muc_heizmodell / muc_heizplan / muc_heizplan_vergleich
//   * Wetter (Strahlung, Temperatur) direkt von Open-Meteo, Ortszeit Europe/Berlin
//   * Stand der Plan-Prüfung in muc_settings.planer_pruefung, Protokoll in muc_decisions (kind 'planer'),
//     Hinweise unter KI › Zu entscheiden in muc_ki_suggestions (kind 'info', rule 'planer_pruefung')
//   * keine Abwesenheit; kein EMHASS/HiGHS (Prüfung 24.11.2026: doc/EMHASS-HIGHS-BEWERTUNG-2026-11-24.md – „jetzt noch nicht“)
//
// Modus (muc_settings.planer_modus): „aus“ = Planer (Regeln) – nur der Collector entscheidet; „schatten“ = KI rechnet mit –
// der Planer schreibt seinen Plan nur auf; „steuern“ = KI steuert – der Collector setzt die Sollwerte nach dem jüngsten Plan
// (≤ 30 min alt, collector/src/plan.js), innerhalb der festen Regeln. Den Modus schaltet nur Uli.
//
// Aufrufe (POST, Body oder Query `aktion`) – MÜNCHEN: angestoßen vom Collector auf dem Mini-PC (collector/src/planer.js):
//   planen            – alle 15 min
//   lernen  raum=<id> – Raummodell eines Raums lernen (03:00, je Raum ein Aufruf wegen der Rechenzeit-Grenze)
//   pv_lernen         – PV-Vorhersage je Stunde lernen (03:00)
//   vergleich tag=…   – Gegenrechnung eines Tages (Standard: gestern)
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';
import { PLAN_AUFBEWAHREN_TAGE, TZ, lerneAus, leistung, planAus, pvLernenAus, vergleichAus, type Daten } from './rechnen.ts';
import type { PruefStand, RaumPruefung } from './pruefung.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-planer-token',
};
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
// MÜNCHEN: Standort für Open-Meteo (wie der Collector, WEATHER_LAT/LON)
const LAT = Number(Deno.env.get('MUC_LAT') ?? 48.14), LON = Number(Deno.env.get('MUC_LON') ?? 11.58);

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
}
async function authorize(req: Request): Promise<boolean> {
  // MÜNCHEN: Aufruf aus der Datenbank (pg_net, z. B. Lernen sofort anstoßen) mit Token aus muc_intern (nur service_role lesbar)
  const tok = req.headers.get('x-planer-token');
  if (tok) {
    const { data } = await createClient(SUPABASE_URL, SERVICE_KEY).from('muc_intern').select('value').eq('key', 'planer_token').maybeSingle();
    return !!data?.value && data.value === tok;
  }
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

/** MÜNCHEN: „nicht steuerbar“ = Ventil hängt (Spalte optional). Fehlt die Spalte, gibt es keine solchen Räume. */
async function ventilHaengt(sb: any): Promise<Set<string>> {
  const { data, error } = await sb.from('muc_rooms').select('id, ventil_haengt_seit');
  if (error) return new Set();
  return new Set(((data ?? []) as any[]).filter(x => x.ventil_haengt_seit).map(x => x.id));
}

const heuteOrt = () => new Date().toLocaleDateString('sv-SE', { timeZone: TZ });
const name = (d: any, id: string) => (d.raeume ?? []).find((r: any) => r.id === id)?.name ?? id;

// ---------------------------------------------------------------- Aktionen
async function planen(sb: any) {
  const d = await datenLaden(sb, 2);
  if ((d.settings?.planer_modus ?? 'schatten') === 'aus') return { ok: true, aus: true };
  const { zeile, antwort, pruefung, stand } = planAus(d, await ventilHaengt(sb));
  const { error: insErr } = await sb.from('muc_heizplan').insert(zeile);
  if (insErr) throw new Error(`muc_heizplan: ${insErr.message}`);
  await sb.from('muc_heizplan').delete().lt('erstellt_at', new Date(Date.now() - PLAN_AUFBEWAHREN_TAGE * 86400000).toISOString());
  await pruefungMelden(sb, d, pruefung, stand);
  return { ...antwort, auffaellig: Object.entries(pruefung).filter(([, p]) => !p.ok).map(([id, p]) => `${name(d, id)}: ${p.gruende.join('; ')}`) };
}

/**
 * Plan-Prüfung (Venediger 13.11.2026, doc/PLANER-WIE-VENEDIGER-2026-11-24.md): Stand merken, Wechsel ins Protokoll,
 * Hinweise nach KI › Zu entscheiden. Der Modus (aus/schatten/steuern) wird NIE geändert – den schaltet nur Uli.
 * Fehler hier dürfen den Plan nicht verhindern.
 */
async function pruefungMelden(sb: any, d: any, pruefung: Record<string, RaumPruefung>, stand: PruefStand) {
  try {
    const vorher: PruefStand = d.pruefung?.stand ?? {};
    const steuert = (d.settings?.planer_modus ?? 'schatten') === 'steuern';
    const wer = steuert ? 'Regel-Steuerung übernimmt diesen Raum' : 'bei „KI steuert“ übernähme die Regel-Steuerung';
    const protokoll: any[] = [];
    for (const [id, p] of Object.entries(pruefung)) {
      const neu = !p.ok && !vorher[id], frei = p.ok && !!vorher[id];
      // MÜNCHEN: Protokoll in muc_decisions (App › Protokoll), kind 'planer'
      if (neu) protokoll.push({ kind: 'planer', room_id: id, mode: null, reason: `Planer-Prüfung: auffällig → ${wer} – ${p.gruende.join(' · ')}`, dry_run: false });
      if (frei) protokoll.push({ kind: 'planer', room_id: id, mode: null, reason: `Planer-Prüfung: wieder unauffällig → KI plant den Raum (vorher: ${(vorher[id].gruende ?? []).join(' · ')})`, dry_run: false });
    }
    if (protokoll.length) await sb.from('muc_decisions').insert(protokoll);
    // MÜNCHEN: Stand in muc_settings.planer_pruefung (migration-018)
    await sb.from('muc_settings').update({ planer_pruefung: { stand, at: new Date().toISOString(),
      raeume: Object.fromEntries(Object.entries(pruefung).map(([id, p]) => [id, { ok: p.ok, gruende: p.gruende, hinweis: p.hinweis ?? null, geplant_h: p.geplant_h, erlaubt_h: p.erlaubt_h }])) } }).eq('id', 1);
    // Hinweise und neue Sperren als Info unter KI › Zu entscheiden – je Raum und Tag nur einmal
    const tag = heuteOrt();
    const { data: schon } = await sb.from('muc_ki_suggestions').select('room_id, title').eq('rule', 'planer_pruefung').eq('day', tag);
    const gibt = new Set(((schon ?? []) as any[]).map(x => `${x.room_id}|${x.title}`));
    const zeilen: any[] = [];
    for (const [id, p] of Object.entries(pruefung)) {
      const raum = name(d, id);
      if (!p.ok && !p.arten.every(a => a === 'wartezeit')) {
        const title = `${raum}: Plan passt nicht – Regel-Steuerung übernimmt`;
        if (!gibt.has(`${id}|${title}`)) zeilen.push({ day: tag, kind: 'info', rule: 'planer_pruefung', room_id: id, title,
          what: steuert ? 'Die KI steuert diesen Raum vorerst nicht, die Regel-Steuerung übernimmt (mindestens 2 h, bis der Plan wieder passt).'
                        : 'Bei „KI steuert“ würde die Regel-Steuerung diesen Raum übernehmen (mindestens 2 h, bis der Plan wieder passt).',
          why: p.gruende.join(' · '), evidence: { geplant_h: p.geplant_h, erlaubt_h: p.erlaubt_h, arten: p.arten }, status: 'offen' });
      }
      if (p.hinweis) {
        const title = `${raum}: erreicht sein Ziel nicht`;
        if (!gibt.has(`${id}|${title}`)) zeilen.push({ day: tag, kind: 'info', rule: 'planer_pruefung', room_id: id, title,
          what: 'Bitte prüfen: Ventil, Lage des Fühlers oder Normal-Wert dieses Raums.', why: p.hinweis, status: 'offen' });
      }
    }
    if (zeilen.length) await sb.from('muc_ki_suggestions').insert(zeilen);
  } catch (e) {
    console.error('pruefungMelden:', e);
  }
}

async function lernen(sb: any, raumId: string, tage: number) {
  const d = await datenLaden(sb, tage);
  const r = d.raeume.find((x: any) => x.id === raumId);
  if ((await ventilHaengt(sb)).has(raumId)) return { ok: false, raum: r?.name ?? raumId, grund: 'Ventil hängt – Modell wird nicht gelernt' };
  const erg = lerneAus(d, raumId, tage);
  if (!erg.ok) return erg;
  const zeile = { ...erg.zeile, p_w: leistung(r) };   // MÜNCHEN: Leistung je Kreis mit speichern
  const { error: upErr } = await sb.from('muc_heizmodell').upsert(zeile, { onConflict: 'room_id' });
  if (upErr) throw new Error(`muc_heizmodell: ${upErr.message}`);
  return { ok: true, ...zeile, fenster: erg.fenster };
}

async function pvLernen(sb: any, tage: number) {
  const d = await datenLaden(sb, tage);
  const coef = pvLernenAus(d);
  // MÜNCHEN: in muc_settings.planer_pv_modell statt system_settings
  const { error } = await sb.from('muc_settings').update({ planer_pv_modell: { coef, tage, gelernt_at: new Date().toISOString() } }).eq('id', 1);
  if (error) throw new Error(`muc_settings: ${error.message}`);
  return { ok: true, stunden: Object.keys(coef).length };
}

async function vergleich(sb: any, tag: string) {
  // Venediger 22.11.2026: so viele Tage laden, wie der Tag zurückliegt (vorher fest 3 → ältere Tage ließen sich nicht neu rechnen)
  const tage = Math.min(14, Math.max(3, Math.round((Date.parse(heuteOrt()) - Date.parse(tag)) / 86400000) + 2));
  const d = await datenLaden(sb, tage);
  const zeile = vergleichAus(d, tag, await ventilHaengt(sb));
  if (!zeile.ok) return zeile;
  const { ok: _ok, ...daten } = zeile;
  const { error: upErr } = await sb.from('muc_heizplan_vergleich').upsert(daten, { onConflict: 'tag' });
  if (upErr) throw new Error(`muc_heizplan_vergleich: ${upErr.message}`);
  // Tagesprüfung (Venediger 13.11.2026): braucht der Planer mehr Netz als die Steuerung, ohne wärmer zu sein → Hinweis
  try {
    const pl = zeile.planer, st = zeile.steuerung;
    const netzPl = Number(pl?.netz_bereinigt_kwh ?? pl?.netz_kwh), netzSt = Number(st?.netz_kwh);
    if (Number.isFinite(netzPl) && Number.isFinite(netzSt) && netzPl > netzSt * 1.1 + 1
        && Number(pl?.unter_ziel_gradstd) >= Number(st?.unter_ziel_gradstd) * 0.9) {
      const heute = heuteOrt();
      await sb.from('muc_ki_suggestions').delete().eq('rule', 'planer_pruefung').eq('day', heute).is('room_id', null);
      await sb.from('muc_ki_suggestions').insert({ day: heute, kind: 'info', rule: 'planer_pruefung', status: 'offen',
        title: `KI am ${tag}: mehr Netzstrom als die Regel-Steuerung`,
        what: 'Der Modus bleibt, wie du ihn eingestellt hast. Prüfen, ob die KI steuern soll.',
        why: `Gegenrechnung ${tag}: KI ${netzPl.toFixed(1)} kWh Netz, Regel-Steuerung ${netzSt.toFixed(1)} kWh – bei nicht besserem Komfort.`,
        evidence: { planer: pl, steuerung: st } });
    }
  } catch (e) { console.error('Tagesprüfung:', e); }
  return zeile;
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
