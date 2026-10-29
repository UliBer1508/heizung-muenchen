// Heizung München – Alexa-Skill (Supabase Edge Function)
//
// Alexa → diese Function → muc_-Tabellen → Collector setzt es in Loxone um.
// Alexa schaltet also NIE direkt in Loxone, sondern nutzt dieselbe Übersteuerung
// (override_temp / override_until) wie die App. Dadurch kann die Automatik den
// Sprachbefehl nicht überschreiben und alles steht im Protokoll.
//
// Geheimnisse (Supabase → Edge Functions → Secrets):
//   ALEXA_SKILL_ID   Skill-ID aus der Alexa Developer Console (amzn1.ask.skill.…) – Pflicht
//   ALEXA_USER_IDS   optional: erlaubte Alexa-Benutzer, durch Komma getrennt
// SUPABASE_URL und SUPABASE_SERVICE_ROLE_KEY stellt Supabase automatisch bereit.
//
// Bereitstellen OHNE JWT-Prüfung (Alexa schickt keinen Supabase-Token):
//   supabase functions deploy alexa-heizung --no-verify-jwt

import { createClient } from 'npm:@supabase/supabase-js@2';

const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
  auth: { persistSession: false },
});
const SKILL_ID = Deno.env.get('ALEXA_SKILL_ID') ?? '';
const USER_IDS = (Deno.env.get('ALEXA_USER_IDS') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const TZ = 'Europe/Berlin';
const DEFAULT_HOURS = 2;
const MAX_HOURS = 12;

// ----------------------------------------------------------------- Raumerkennung
//
// Alexa liefert den Raum so, wie er gesprochen wurde („Bad im Keller“, „oben im Bad“,
// „Schlafzimmer von Luis“). Hier wird das auf einen Eintrag in muc_rooms abgebildet –
// ohne feste Liste, damit neue oder umbenannte Räume automatisch funktionieren.

type Room = { id: string; name: string; enabled?: boolean };

// Wörter, die gesprochen anders heißen als im Raumnamen
const SYNONYMS: Record<string, string> = {
  keller: 'kg', kellergeschoss: 'kg', untergeschoss: 'kg', souterrain: 'kg',
  erdgeschoss: 'eg', parterre: 'eg',
  obergeschoss: 'og', 'ersten stock': 'og', 'erster stock': 'og', 'erste stock': 'og',
  dachgeschoss: 'dg', dach: 'dg', 'zweiten stock': 'dg', 'zweiter stock': 'dg', dachboden: 'dg',
  badezimmer: 'bad', bäder: 'bad',
  schlafzimmer: 'schlaf', schlafen: 'schlaf',
  wohnzimmer: 'wohn', wohnen: 'wohn',
  esszimmer: 'ess', essbereich: 'ess', essen: 'ess',
  küche: 'kueche', kueche: 'kueche',
  büro: 'buero', arbeitszimmer: 'buero',
  toilette: 'wc', klo: 'wc', gästeklo: 'wc', gäste: 'wc',
  flur: 'eingang', diele: 'eingang', windfang: 'eingang',
  ankleidezimmer: 'ankleide', ankleide: 'ankleide',
  louis: 'luis', luiz: 'luis', lewis: 'luis',
};
const FLOORS = new Set(['kg', 'eg', 'og', 'dg']);
// Füllwörter, die beim Vergleich nicht zählen
const STOP = new Set(['im', 'in', 'der', 'die', 'das', 'den', 'dem', 'von', 'vom', 'zimmer', 'raum', 'und', 'am', 'beim', 'unser', 'unsere', 'unserem', 'mein', 'meinem', 'kleines', 'kleine', 'großes', 'grosse']);

function norm(s: string): string {
  let t = ` ${s.toLowerCase().replace(/[\/(),.\-]/g, ' ').replace(/\s+/g, ' ').trim()} `;
  // mehrteilige Synonyme zuerst
  for (const [k, v] of Object.entries(SYNONYMS).sort((a, b) => b[0].length - a[0].length)) {
    if (k.includes(' ')) t = t.replaceAll(` ${k} `, ` ${v} `);
  }
  return t.trim();
}

function tokens(s: string): string[] {
  return norm(s)
    .split(' ')
    .map((w) => SYNONYMS[w] ?? w)
    .map((w) => w.replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss'))
    .filter((w) => w && !STOP.has(w));
}

// zwei Wörter gelten als gleich, wenn eines mit dem anderen beginnt (schlaf ↔ schlafzimmer)
const same = (a: string, b: string) => a === b || (a.length >= 3 && b.length >= 3 && (a.startsWith(b) || b.startsWith(a)));

type Match = { room: Room } | { ambiguous: Room[] } | { none: true };

function matchRoom(spoken: string, rooms: Room[]): Match {
  const said = tokens(spoken);
  if (said.length === 0) return { none: true };
  const saidFloor = said.find((w) => FLOORS.has(w));
  const saidWords = said.filter((w) => !FLOORS.has(w));

  const scored = rooms
    .filter((r) => r.enabled !== false)
    .map((r) => {
      const rt = tokens(r.name);
      const floor = rt.find((w) => FLOORS.has(w));
      const words = rt.filter((w) => !FLOORS.has(w));
      if (saidFloor && floor && saidFloor !== floor) return { r, score: -1 };
      const hits = saidWords.filter((w) => words.some((x) => same(w, x))).length;
      const misses = saidWords.length - hits;
      if (hits === 0 && !(saidFloor && saidWords.length === 0)) return { r, score: -1 };
      // Treffer zählen, gesagte Wörter ohne Treffer kosten, überzählige Raumwörter kosten wenig
      const score = hits * 10 - misses * 6 - (words.length - hits) + (saidFloor && floor === saidFloor ? 5 : 0);
      return { r, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);

  if (scored.length === 0) return { none: true };
  const best = scored.filter((x) => x.score === scored[0].score).map((x) => x.r);
  return best.length === 1 ? { room: best[0] } : { ambiguous: best };
}

// ----------------------------------------------------------------- Sprachausgabe
const num = (v: number | null | undefined, d = 1) =>
  v == null ? 'unbekannt' : Number(v).toLocaleString('de-DE', { maximumFractionDigits: d });
const grad = (v: number | null | undefined) => (v == null ? 'unbekannt' : `${num(v)} Grad`);
const kw = (w: number | null | undefined) =>
  w == null ? 'unbekannt' : Math.abs(w) < 1000 ? `${Math.round(Math.abs(w))} Watt` : `${num(Math.abs(w) / 1000)} Kilowatt`;
const kwh = (v: number | null | undefined) => (v == null ? 'unbekannt' : `${num(v)} Kilowattstunden`);
const uhr = (ts: string) => new Date(ts).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', timeZone: TZ });
const today = () => new Date().toLocaleDateString('sv-SE', { timeZone: TZ }); // YYYY-MM-DD

const HOUSE_MODE: Record<string, string> = {
  NACHT: 'Nachtabsenkung', MORGEN: 'Morgenbetrieb', TAG: 'Tagbetrieb', ABEND: 'Abendbetrieb',
  PV_1: 'PV-Stufe 1', PV_2: 'PV-Stufe 2', PV_3: 'PV-Stufe 3', BATTERIE_VOLL: 'Batterie voll',
};
const ROOM_MODE: Record<string, string> = {
  NORMAL: 'Normalbetrieb', ABSENK: 'Absenkung', PV: 'Aufheizen mit Sonnenstrom', VOLL: 'volles Aufheizen', OVERRIDE: 'manuell',
};

// askRoom: Rückfrage nach dem Raum – der Befehl wird gemerkt und mit der Antwort fortgesetzt
type Reply = { text: string; end?: boolean; card?: string; askRoom?: boolean; attrs?: Record<string, unknown> };

function respond({ text, end = true, card, attrs }: Reply) {
  return Response.json({
    version: '1.0',
    ...(attrs ? { sessionAttributes: attrs } : {}),
    response: {
      outputSpeech: { type: 'PlainText', text },
      ...(card ? { card: { type: 'Simple', title: 'Heizung München', content: card } } : {}),
      ...(end ? {} : { reprompt: { outputSpeech: { type: 'PlainText', text: 'Was möchtest du wissen?' } } }),
      shouldEndSession: end,
    },
  });
}

// Raumnamen so, wie Alexa sie gut vorlesen kann: „EG Küche/Essbereich“ → „EG Küche und Essbereich“
function say(name: string) {
  const parts = name.replace(/\s*\(.*?\)\s*/g, ' ').trim().split('/').map((p) => p.trim());
  return parts.length > 1 ? `${parts.slice(0, -1).join(', ')} und ${parts.at(-1)}` : parts[0];
}

// ----------------------------------------------------------------- Daten
async function loadRooms(): Promise<Room[] & Record<string, any>[]> {
  const { data, error } = await db.from('muc_rooms').select('*').order('sort');
  if (error) throw error;
  return data;
}
async function settings() {
  const { data, error } = await db.from('muc_settings').select('automation_enabled, dry_run').eq('id', 1).single();
  if (error) throw error;
  return data;
}

// Raum aus dem Slot holen – zuerst Alexas eigene Zuordnung, dann eigene Erkennung
async function resolveRoom(slot: any): Promise<{ room?: any; reply?: Reply }> {
  const rooms = await loadRooms();
  const spoken: string = slot?.value ?? '';
  const er = slot?.resolutions?.resolutionsPerAuthority?.find((a: any) => a.status?.code === 'ER_SUCCESS_MATCH');
  const erName: string | undefined = er?.values?.[0]?.value?.name;
  const exact = erName && rooms.find((r) => r.name.toLowerCase() === erName.toLowerCase());
  if (exact) return { room: exact };
  // Alexa hat einen Raum aus der Liste erkannt („Elternbad“ → „OG Eltern Bad“) → diesen Namen zuordnen
  const viaEr = erName ? matchRoom(erName, rooms) : null;
  if (viaEr && 'room' in viaEr) return { room: viaEr.room };
  if (!spoken) return { reply: { text: 'Welchen Raum meinst du?', end: false, askRoom: true } };
  const m = matchRoom(spoken, rooms);
  if ('room' in m) return { room: m.room };
  if ('ambiguous' in m) {
    const list = m.ambiguous.slice(0, 4).map((r) => say(r.name));
    return { reply: { text: `Meinst du ${list.slice(0, -1).join(', ')} oder ${list.at(-1)}?`, end: false, askRoom: true } };
  }
  return { reply: { text: `Einen Raum „${spoken}“ kenne ich nicht. Welchen Raum meinst du?`, end: false, askRoom: true } };
}

async function log(room_id: string | null, target: number | null, reason: string) {
  await db.from('muc_decisions').insert({ kind: 'alexa', room_id, mode: room_id ? 'OVERRIDE' : null, target, reason });
}

function warnings(s: { automation_enabled: boolean; dry_run: boolean }) {
  if (!s.automation_enabled) return ' Achtung: Die Automatik ist aus, deshalb wird gerade nichts an Loxone übertragen.';
  if (s.dry_run) return ' Achtung: Der Testmodus ist an, es wird nichts geschaltet.';
  return '';
}

// ----------------------------------------------------------------- Intents
async function energie(): Promise<Reply> {
  const [{ data: e }, { data: k }] = await Promise.all([
    db.from('muc_energy_readings').select('*').order('ts', { ascending: false }).limit(1).maybeSingle(),
    db.rpc('muc_day_kpis', { p_date: today() }),
  ]);
  const kp = Array.isArray(k) ? k[0] : null;
  const parts: string[] = [];
  if (e) {
    parts.push(`Die Sonne liefert gerade ${kw(e.pv_w)}, der Akku steht bei ${e.soc ?? 'unbekannt'} Prozent.`);
    if (e.grid_w > 50) parts.push(`Aus dem Netz kommen ${kw(e.grid_w)}.`);
    else if (e.grid_w < -50) parts.push(`Eingespeist werden ${kw(e.grid_w)}.`);
  }
  if (kp?.pv_kwh != null) {
    const pv = Number(kp.pv_kwh), feed = Number(kp.grid_out_kwh ?? 0);
    const self = pv > 0.1 ? Math.round(100 * (1 - feed / pv)) : null;
    parts.push(self != null
      ? `Heute ${kwh(pv)} Sonnenstrom, davon ${self} Prozent selbst genutzt.`
      : 'Heute gab es noch keinen Sonnenstrom.');
    if (kp.autarky_pct != null) parts.push(`Die Autarkie liegt bei ${Math.round(Number(kp.autarky_pct))} Prozent.`);
    if (Number(kp.heat_grid_kwh) >= 1) parts.push(`Die Wärmepumpe hat ${kwh(Number(kp.heat_grid_kwh))} aus dem Netz gezogen.`);
  }
  if (!parts.length) return { text: 'Ich habe noch keine Energiedaten.' };
  return { text: parts.join(' '), card: parts.join('\n') };
}

async function status(): Promise<Reply> {
  const [{ data: st }, s, rooms] = await Promise.all([
    db.from('muc_collector_status').select('*').eq('id', 1).single(),
    settings(),
    loadRooms(),
  ]);
  const age = st?.last_seen ? Math.round((Date.now() - new Date(st.last_seen).getTime()) / 60000) : null;
  const parts: string[] = [];
  if (age == null || age > 5) parts.push(`Achtung, der Collector hat sich seit ${age ?? 'langem'} Minuten nicht gemeldet.`);
  parts.push(`Die Heizung läuft im Modus ${HOUSE_MODE[st?.house_mode] ?? st?.house_mode ?? 'unbekannt'}.`);
  const manual = rooms.filter((r: any) => r.override_until && new Date(r.override_until) > new Date());
  if (manual.length) parts.push(`Manuell gestellt: ${manual.map((r: any) => `${say(r.name)} auf ${grad(r.override_temp)} bis ${uhr(r.override_until)}`).join(', ')}.`);
  return { text: parts.join(' ') + warnings(s) };
}

async function raumTemp(slots: any): Promise<Reply> {
  const { room, reply } = await resolveRoom(slots?.raum);
  if (reply) return reply;
  const { data: r } = await db.from('muc_room_readings').select('*').eq('room_id', room.id)
    .order('ts', { ascending: false }).limit(1).maybeSingle();
  if (!r) return { text: `Für ${say(room.name)} habe ich noch keine Messwerte.` };
  let t = `Im ${say(room.name)} sind es ${grad(r.temp)}. Soll ${grad(r.target ?? r.setpoint)}`;
  t += r.mode ? `, ${ROOM_MODE[r.mode] ?? r.mode}` : '';
  t += r.valve ? ', das Ventil ist offen.' : ', das Ventil ist zu.';
  if (r.mode === 'OVERRIDE' && room.override_until) t += ` Manuell bis ${uhr(room.override_until)}.`;
  return { text: t };
}

// ISO-8601-Dauer von Alexa (PT2H, PT90M, P1D …) → Stunden
function hoursOf(iso?: string): number | null {
  if (!iso) return null;
  const m = iso.match(/^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?)?$/);
  if (!m) return null;
  const h = (Number(m[1] ?? 0) * 24) + Number(m[2] ?? 0) + Number(m[3] ?? 0) / 60;
  return h > 0 ? h : null;
}

async function raumStellen(slots: any): Promise<Reply> {
  const { room, reply } = await resolveRoom(slots?.raum);
  if (reply) return reply;
  const s = await settings();
  const lo = Math.max(5, Number(room.min_temp ?? 5));
  const hi = Math.min(26, Number(room.max_temp ?? 26));
  const asked = slots?.temperatur?.value != null && slots.temperatur.value !== '?' ? Number(slots.temperatur.value) : null;
  // ohne Temperatur: „warm machen“ = PV-Temperatur des Raums
  const wanted = asked ?? Number(room.temp_pv ?? room.temp_normal ?? 22);
  const clamped = Math.min(hi, Math.max(lo, wanted));
  const target = Math.round(clamped * 2) / 2;
  const hours = Math.min(MAX_HOURS, hoursOf(slots?.dauer?.value) ?? DEFAULT_HOURS);
  const until = new Date(Date.now() + hours * 3600000).toISOString();

  const { error } = await db.from('muc_rooms').update({ override_temp: target, override_until: until }).eq('id', room.id);
  if (error) throw error;
  await log(room.id, target, `Alexa: ${room.name} auf ${num(target)} °C bis ${uhr(until)}`);

  let t = `Okay, ${say(room.name)} auf ${grad(target)} bis ${uhr(until)} Uhr.`;
  if (asked != null && clamped !== asked) {
    t += asked > target ? ` Mehr als ${grad(hi)} ist für diesen Raum nicht erlaubt.` : ` Weniger als ${grad(lo)} ist für diesen Raum nicht erlaubt.`;
  }
  return { text: t + warnings(s) };
}

async function raumAutomatik(slots: any): Promise<Reply> {
  const { room, reply } = await resolveRoom(slots?.raum);
  if (reply) return reply;
  if (!room.override_until || new Date(room.override_until) <= new Date()) {
    return { text: `${say(room.name)} läuft bereits automatisch.` };
  }
  const { error } = await db.from('muc_rooms').update({ override_temp: null, override_until: null }).eq('id', room.id);
  if (error) throw error;
  await log(room.id, null, `Alexa: Übersteuerung ${room.name} beendet`);
  return { text: `Okay, ${say(room.name)} läuft wieder automatisch.` };
}

async function alleAutomatik(): Promise<Reply> {
  const rooms = await loadRooms();
  const manual = rooms.filter((r: any) => r.override_until && new Date(r.override_until) > new Date());
  if (!manual.length) return { text: 'Es ist kein Raum manuell gestellt.' };
  const { error } = await db.from('muc_rooms').update({ override_temp: null, override_until: null })
    .in('id', manual.map((r) => r.id));
  if (error) throw error;
  await log(null, null, `Alexa: alle Übersteuerungen beendet (${manual.map((r) => r.name).join(', ')})`);
  return { text: `Okay, ${manual.length === 1 ? 'ein Raum läuft' : `${manual.length} Räume laufen`} wieder automatisch.` };
}

async function automatik(slots: any): Promise<Reply> {
  const v = (slots?.schalter?.resolutions?.resolutionsPerAuthority?.[0]?.values?.[0]?.value?.id
    ?? slots?.schalter?.value ?? '').toString().toLowerCase();
  const on = ['an', 'ein', 'einschalten', 'aktivieren', 'on'].includes(v) ? true
    : ['aus', 'ausschalten', 'deaktivieren', 'off', 'stopp'].includes(v) ? false : null;
  if (on == null) {
    const s = await settings();
    return { text: `Die Automatik ist ${s.automation_enabled ? 'an' : 'aus'}.${s.dry_run ? ' Der Testmodus ist an.' : ''}` };
  }
  const { error } = await db.from('muc_settings').update({ automation_enabled: on }).eq('id', 1);
  if (error) throw error;
  await log(null, null, `Alexa: Automatik ${on ? 'eingeschaltet' : 'ausgeschaltet'}`);
  return { text: on ? 'Okay, die Automatik ist wieder an.' : 'Okay, die Automatik ist aus. Loxone regelt jetzt mit den eigenen Werten.' };
}

const HELP = 'Du kannst zum Beispiel fragen: Wie hoch ist der Eigenverbrauch? Wie warm ist es im Bad im Keller? '
  + 'Oder sagen: Stelle das Wohnzimmer für zwei Stunden auf zweiundzwanzig Grad. Oder: Wohnzimmer wieder automatisch.';

// ----------------------------------------------------------------- Prüfung & Ablauf
function check(body: any): string | null {
  const appId = body?.session?.application?.applicationId ?? body?.context?.System?.application?.applicationId;
  if (!SKILL_ID) return 'ALEXA_SKILL_ID ist nicht gesetzt';
  if (appId !== SKILL_ID) return `falsche Skill-ID ${appId}`;
  const ts = Date.parse(body?.request?.timestamp ?? '');
  if (!ts || Math.abs(Date.now() - ts) > 150_000) return 'Zeitstempel zu alt';
  const user = body?.session?.user?.userId ?? body?.context?.System?.user?.userId;
  if (USER_IDS.length && !USER_IDS.includes(user)) return `unbekannter Benutzer ${user}`;
  return null;
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('Heizung München – Alexa-Endpunkt', { status: 200 });
  let body: any;
  try { body = await req.json(); } catch { return new Response('bad request', { status: 400 }); }

  const denied = check(body);
  if (denied) {
    console.warn('abgelehnt:', denied);
    return new Response('forbidden', { status: 403 });
  }

  const r = body.request;
  try {
    if (r.type === 'LaunchRequest') {
      // Benutzer-ID für ALEXA_USER_IDS (optional) – steht dann in den Function-Logs
      console.log('Alexa-Benutzer:', body.session?.user?.userId);
      return respond({ text: `Heizung München. ${HELP}`, end: false });
    }
    if (r.type === 'SessionEndedRequest') return Response.json({ version: '1.0', response: {} });
    if (r.type !== 'IntentRequest') return respond({ text: 'Das habe ich nicht verstanden.' });

    let name: string = r.intent?.name;
    let slots = r.intent?.slots ?? {};
    // Antwort auf „Meinst du KG Bad oder DG Bad?“ – gemerkten Befehl mit dem genannten Raum fortsetzen
    const pending = body.session?.attributes?.pending;
    if (name === 'RaumNurIntent') {
      if (pending?.intent) { name = pending.intent; slots = { ...pending.slots, raum: slots.raum }; }
      else name = 'RaumTemperaturIntent';
    }
    const run = async (): Promise<Reply> => {
      switch (name) {
        case 'EnergieIntent': return energie();
        case 'StatusIntent': return status();
        case 'RaumTemperaturIntent': return raumTemp(slots);
        case 'RaumStellenIntent': return raumStellen(slots);
        case 'RaumAutomatikIntent': return raumAutomatik(slots);
        case 'AlleAutomatikIntent': return alleAutomatik();
        case 'AutomatikIntent': return automatik(slots);
        case 'AMAZON.HelpIntent': return { text: HELP, end: false };
        case 'AMAZON.CancelIntent':
        case 'AMAZON.StopIntent': return { text: 'Okay.' };
        default: return { text: `Das habe ich nicht verstanden. ${HELP}`, end: false };
      }
    };
    const out = await run();
    if (out.askRoom) out.attrs = { pending: { intent: name, slots } };
    return respond(out);
  } catch (e) {
    console.error(e);
    return respond({ text: 'Da ist etwas schiefgegangen. Ich komme gerade nicht an die Heizungsdaten.' });
  }
});
