// heizplaner-muenchen (12.11.2026, neues Raummodell 13.11.2026) – Planer der Auto-Steuerung München,
// doc/AUTO-STEUERUNG-2026-11-12.md, doc/FIX-PLANER-MODELL-UND-KI-PRUEFUNGEN-2026-11-13.md
//
// ÜBERNOMMEN aus Heizung Venediger (Grundregel doc/KONZEPT.md): UliBer1508/smartfox-insight-ai-selfhosted ·
// supabase/functions/heizplaner/ · Commit b9444bb (13.11.2026). modell.ts ist eine unveränderte Kopie, rechnen.ts eine
// Kopie mit „MÜNCHEN:“-Stellen. Hier nur, was München anders hat:
//   * Daten aus muc_heizplaner_daten (muc_*-Tabellen), Ergebnisse in muc_heizmodell / muc_heizplan / muc_heizplan_vergleich
//   * Wetter (Strahlung, Temperatur) direkt von Open-Meteo, Ortszeit Europe/Berlin
//   * „nicht steuerbar“ = Ventil hängt (muc_rooms.ventil_haengt_seit, gesetzt von der KI-Prüfung, migration-015):
//     solche Räume plant der Planer nicht und lernt ihr Modell nicht (ein Ventil, das nie zugeht, sagt nichts darüber,
//     wie schnell der Raum warm wird)
//
// SCHATTENBETRIEB: Der Planer steuert nichts. Er schreibt seinen Plan in muc_heizplan und rechnet jeden Tag nach,
// was er an Stelle der heutigen Steuerung (Collector) gemacht hätte (muc_heizplan_vergleich). Steuern erst nach Ulis Freigabe.
//
// Aufrufe (POST, Body oder Query `aktion`) – angestoßen vom Collector auf dem Mini-PC (collector/src/planer.js):
//   planen            – alle 15 min
//   lernen  raum=<id> – Raummodell eines Raums lernen (03:00, je Raum ein Aufruf wegen der Rechenzeit-Grenze)
//   pv_lernen         – PV-Vorhersage je Stunde lernen (03:00)
//   vergleich tag=…   – Gegenrechnung eines Tages (Standard: gestern)
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';
import { PLAN_AUFBEWAHREN_TAGE, lerneAus, leistung, planAus, pvLernenAus, vergleichAus, type Daten } from './rechnen.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const TZ = 'Europe/Berlin';
// MÜNCHEN: Standort für Open-Meteo (wie der Collector, WEATHER_LAT/LON)
const LAT = Number(Deno.env.get('MUC_LAT') ?? 48.14), LON = Number(Deno.env.get('MUC_LON') ?? 11.58);

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

/** MÜNCHEN: Räume mit hängendem Ventil (KI-Prüfung, migration-015). Spalte fehlt → keine. */
async function ventilHaengt(sb: any): Promise<Set<string>> {
  const { data, error } = await sb.from('muc_rooms').select('id, ventil_haengt_seit');
  if (error) return new Set();
  return new Set(((data ?? []) as any[]).filter(x => x.ventil_haengt_seit).map(x => x.id));
}

// ---------------------------------------------------------------- Aktionen
async function planen(sb: any) {
  const d = await datenLaden(sb, 2);
  if ((d.settings?.planer_modus ?? 'schatten') === 'aus') return { ok: true, aus: true };
  const { zeile, antwort } = planAus(d, await ventilHaengt(sb));
  const { error: insErr } = await sb.from('muc_heizplan').insert(zeile);
  if (insErr) throw new Error(`muc_heizplan: ${insErr.message}`);
  await sb.from('muc_heizplan').delete().lt('erstellt_at', new Date(Date.now() - PLAN_AUFBEWAHREN_TAGE * 86400000).toISOString());
  return antwort;
}

async function lernen(sb: any, raumId: string, tage: number) {
  const d = await datenLaden(sb, tage);
  const r = d.raeume.find((x: any) => x.id === raumId);
  if ((await ventilHaengt(sb)).has(raumId)) return { ok: false, raum: r?.name ?? raumId, grund: 'Ventil hängt – Modell wird nicht gelernt' };
  const erg = lerneAus(d, raumId, tage);
  if (!erg.ok) return erg;
  const zeile = { ...erg.zeile, p_w: leistung(r) };   // MÜNCHEN: Leistung je Kreis zur Anzeige
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
  const d = await datenLaden(sb, 3);
  const zeile = vergleichAus(d, tag, await ventilHaengt(sb));
  if (!zeile.ok) return zeile;
  const { ok: _ok, ...daten } = zeile;
  const { error: upErr } = await sb.from('muc_heizplan_vergleich').upsert(daten, { onConflict: 'tag' });
  if (upErr) throw new Error(`muc_heizplan_vergleich: ${upErr.message}`);
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
