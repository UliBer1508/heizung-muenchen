// Meine Heizung – Alexa-Skill für München und Venediger (Supabase Edge Function)
//
// Beide Häuser liegen im selben Supabase-Projekt:
//   München    muc_-Tabellen  – Collector auf dem Münchner Mini-PC setzt es in Loxone um
//   Venediger  rooms, energy_readings … – pv-automation + lokaler Tuya-Dienst bzw. Tuya-Cloud
//
// Alexa schaltet NIE direkt, sondern schreibt auf denselben Wegen wie die jeweilige App:
//   München    muc_rooms.override_temp / override_until (+ Protokoll in muc_decisions)
//   Venediger  wie useTuyaControl: thermostat_commands (lokal) bzw. tuya-control/set-temp (Cloud)
//              + rooms.manual_override_until / target_temp; Anwesenheit in presence_periods
//
// Welches Haus? 1. „… in Venediger / in München / in beiden Häusern“
//               2. sonst das Haus, in dem das Echo steht (ALEXA_VEN_DEVICES)
//               3. sonst München. Ein Raum, den es nur im anderen Haus gibt, wird dort gefunden.
//
// Geheimnisse (Supabase → Edge Functions → Secrets):
//   ALEXA_SKILL_ID     Skill-ID aus der Alexa Developer Console (amzn1.ask.skill.…) – Pflicht
//   ALEXA_USER_IDS     optional: erlaubte Alexa-Benutzer, durch Komma getrennt
//   ALEXA_VEN_DEVICES  optional: Geräte-IDs der Echos in Venediger, durch Komma getrennt
//                      (stehen nach einer Anfrage in den Logs als „Alexa-Gerät: …“)
// SUPABASE_URL und SUPABASE_SERVICE_ROLE_KEY stellt Supabase automatisch bereit.
//
// Bereitstellen OHNE JWT-Prüfung (Alexa schickt keinen Supabase-Token):
//   supabase functions deploy alexa-heizung --no-verify-jwt

import { createClient } from 'npm:@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
const list = (name: string) => (Deno.env.get(name) ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const SKILL_ID = (Deno.env.get('ALEXA_SKILL_ID') ?? '').trim();
const USER_IDS = list('ALEXA_USER_IDS');
const VEN_DEVICES = list('ALEXA_VEN_DEVICES');
const TZ = 'Europe/Berlin'; // gleich wie Europe/Vienna
const DEFAULT_HOURS = 2;
const MAX_HOURS = 12;
const HARD_MIN = 5;
const HARD_MAX = 26;

type House = 'muc' | 'ven';
const HOUSE_NAME: Record<House, string> = { muc: 'München', ven: 'Venediger' };
const other = (h: House): House => (h === 'muc' ? 'ven' : 'muc');

// ----------------------------------------------------------------- Raumerkennung
//
// Alexa liefert den Raum so, wie er gesprochen wurde („Bad im Keller“, „Zimmer von Luis“).
// Hier wird das auf einen Raum des Hauses abgebildet – ohne feste Liste, damit neue oder
// umbenannte Räume automatisch funktionieren.

type Room = { id: string; name: string; enabled?: boolean } & Record<string, any>;

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
  louis: 'luis', luiz: 'luis', lewis: 'luis', lucas: 'luca', luka: 'luca',
  kinderbad: 'kinder bad', haustüre: 'haustür', eingangstür: 'haustür',
};
const FLOORS = new Set(['kg', 'eg', 'og', 'dg']);
// Füllwörter, die beim Vergleich nicht zählen
const STOP = new Set(['im', 'in', 'der', 'die', 'das', 'den', 'dem', 'von', 'vom', 'zimmer', 'raum', 'und', 'am', 'an', 'beim', 'bei', 'unser', 'unsere', 'unserem', 'mein', 'meinem', 'kleines', 'kleine', 'großes', 'grosse']);

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
    .flatMap((w) => (SYNONYMS[w] ?? w).split(' '))
    .map((w) => w.replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss'))
    .filter((w) => w && !STOP.has(w));
}

// zwei Wörter gelten als gleich, wenn eines mit dem anderen beginnt (schlaf ↔ schlafzimmer)
const same = (a: string, b: string) => a === b || (a.length >= 3 && b.length >= 3 && (a.startsWith(b) || b.startsWith(a)));

type Match = { score: number } & ({ room: Room } | { ambiguous: Room[] } | { none: true });

function matchRoom(spoken: string, rooms: Room[]): Match {
  const said = tokens(spoken);
  if (said.length === 0) return { none: true, score: 0 };
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

  if (scored.length === 0) return { none: true, score: 0 };
  const top = scored[0].score;
  const best = scored.filter((x) => x.score === top).map((x) => x.r);
  return best.length === 1 ? { room: best[0], score: top } : { ambiguous: best, score: top };
}

// ----------------------------------------------------------------- Sprachausgabe
const num = (v: number | null | undefined, d = 1) =>
  v == null ? 'unbekannt' : Number(v).toLocaleString('de-DE', { maximumFractionDigits: d });
const grad = (v: number | null | undefined) => (v == null ? 'unbekannt' : `${num(v)} Grad`);
const kw = (w: number | null | undefined) =>
  w == null ? 'unbekannt' : Math.abs(w) < 1000 ? `${Math.round(Math.abs(w))} Watt` : `${num(Math.abs(w) / 1000)} Kilowatt`;
const kwh = (v: number | null | undefined) => (v == null ? 'unbekannt' : `${num(v)} Kilowattstunden`);
const uhr = (ts: string) => new Date(ts).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', timeZone: TZ });
const tag = (ts: string) => new Date(ts).toLocaleDateString('de-DE', { weekday: 'long', day: 'numeric', month: 'long', timeZone: TZ });
const today = () => new Date().toLocaleDateString('sv-SE', { timeZone: TZ }); // YYYY-MM-DD

// Raumnamen so, wie Alexa sie gut vorlesen kann: „EG Küche/Essbereich“ → „EG Küche und Essbereich“
function say(name: string) {
  const parts = name.replace(/\s*\(.*?\)\s*/g, ' ').trim().split('/').map((p) => p.trim());
  return parts.length > 1 ? `${parts.slice(0, -1).join(', ')} und ${parts.at(-1)}` : parts[0];
}

// Ortszeit (Europe/Berlin) → UTC-ISO, z. B. ('2026-11-02', '11:00')
function localToIso(date: string, time: string): string {
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm] = time.split(':').map(Number);
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  const asLocal = new Date(new Date(guess).toLocaleString('en-US', { timeZone: TZ })).getTime();
  const asUtc = new Date(new Date(guess).toLocaleString('en-US', { timeZone: 'UTC' })).getTime();
  return new Date(guess - (asLocal - asUtc)).toISOString();
}

const HOUSE_MODE: Record<string, string> = {
  NACHT: 'Nachtabsenkung', MORGEN: 'Morgenbetrieb', TAG: 'Tagbetrieb', ABEND: 'Abendbetrieb',
  PV_1: 'PV-Stufe 1', PV_2: 'PV-Stufe 2', PV_3: 'PV-Stufe 3', BATTERIE_VOLL: 'Batterie voll',
};
const ROOM_MODE: Record<string, string> = {
  NORMAL: 'Normalbetrieb', ABSENK: 'Absenkung', PV: 'Aufheizen mit Sonnenstrom', VOLL: 'volles Aufheizen', OVERRIDE: 'manuell',
};
const VEN_DAY_MODE: Record<string, string> = {
  wait: 'Wartetag, die Räume warten auf Sonnenstrom', grid: 'Grundheizung aus dem Netz', battery_gate: 'Batterieschutz',
};

// askRoom: Rückfrage nach dem Raum – der Befehl wird gemerkt und mit der Antwort fortgesetzt
type Reply = { text: string; end?: boolean; card?: string; askRoom?: boolean; attrs?: Record<string, unknown> };

function respond({ text, end = true, card, attrs }: Reply) {
  return Response.json({
    version: '1.0',
    ...(attrs ? { sessionAttributes: attrs } : {}),
    response: {
      outputSpeech: { type: 'PlainText', text },
      ...(card ? { card: { type: 'Simple', title: 'Meine Heizung', content: card } } : {}),
      ...(end ? {} : { reprompt: { outputSpeech: { type: 'PlainText', text: 'Was möchtest du wissen?' } } }),
      shouldEndSession: end,
    },
  });
}

// ----------------------------------------------------------------- Kontext je Anfrage
type Ctx = {
  home: House;          // Haus des Echos (oder München)
  house: House | null;  // ausdrücklich genanntes Haus
  both: boolean;        // „in beiden Häusern“
};

function slotId(slot: any): string | undefined {
  const er = slot?.resolutions?.resolutionsPerAuthority?.find((a: any) => a.status?.code === 'ER_SUCCESS_MATCH');
  return er?.values?.[0]?.value?.id ?? undefined;
}

function houseFromSlot(slot: any): { house: House | null; both: boolean } {
  const id = slotId(slot);
  const v = (id ?? slot?.value ?? '').toString().toLowerCase();
  if (!v) return { house: null, both: false };
  if (/beide|alle|überall|uberall/.test(v)) return { house: null, both: true };
  if (/ven|neukirchen|österreich|oesterreich|berg|pinzgau/.test(v)) return { house: 'ven', both: false };
  if (/muc|münchen|muenchen|weidmann|stadt/.test(v)) return { house: 'muc', both: false };
  return { house: null, both: false };
}

// Ansage mit Hausnamen, wenn es nicht das Haus des Echos ist
const where = (ctx: Ctx, h: House) => (h !== ctx.home || ctx.both ? `In ${HOUSE_NAME[h]}: ` : '');

// ----------------------------------------------------------------- Daten
async function loadRooms(h: House): Promise<Room[]> {
  const { data, error } = h === 'muc'
    ? await db.from('muc_rooms').select('*').order('sort')
    : await db.from('rooms').select('*').order('priority');
  if (error) throw error;
  return data as Room[];
}
async function mucSettings() {
  const { data, error } = await db.from('muc_settings').select('automation_enabled, dry_run').eq('id', 1).single();
  if (error) throw error;
  return data;
}
async function sysSetting(key: string): Promise<any> {
  const { data } = await db.from('system_settings').select('value').eq('key', key).maybeSingle();
  return data?.value ?? null;
}

const overridden = (h: House, r: Room) => {
  const until = h === 'muc' ? r.override_until : r.manual_override_until;
  return until && new Date(until) > new Date() ? until as string : null;
};

// Raum finden – im genannten Haus, sonst im Haus des Echos und im anderen (bester Treffer gewinnt)
async function resolveRoom(slot: any, ctx: Ctx): Promise<{ house?: House; room?: Room; reply?: Reply }> {
  const spoken: string = slot?.value ?? '';
  const erName: string | undefined = slot?.resolutions?.resolutionsPerAuthority
    ?.find((a: any) => a.status?.code === 'ER_SUCCESS_MATCH')?.values?.[0]?.value?.name;
  if (!spoken && !erName) return { reply: { text: 'Welchen Raum meinst du?', end: false, askRoom: true } };

  const houses: House[] = ctx.house ? [ctx.house] : [ctx.home, other(ctx.home)];
  const rooms = new Map<House, Room[]>();
  for (const h of houses) rooms.set(h, await loadRooms(h));

  // Je Haus der beste Treffer (gesprochener Name oder Alexas Zuordnung). Das Haus des Echos hat
  // Vorrang; das andere gewinnt nur mit klar besserem Treffer (z. B. „Bad Uli“ gibt es nur in Venediger).
  const bestIn = (h: House): Match | null => {
    let b: Match | null = null;
    for (const name of [spoken, erName]) {
      if (!name) continue;
      const m = matchRoom(name, rooms.get(h)!);
      if (!('none' in m) && (!b || m.score > b.score)) b = m;
    }
    return b;
  };
  const first = bestIn(houses[0]);
  const second = houses[1] ? bestIn(houses[1]) : null;
  const best: { h: House; m: Match } | null =
    second && (!first || second.score >= first.score + 5) ? { h: houses[1], m: second }
    : first ? { h: houses[0], m: first } : null;
  if (best && 'room' in best.m) return { house: best.h, room: best.m.room };
  if (best && 'ambiguous' in best.m) {
    const names = best.m.ambiguous.slice(0, 4).map((r) => say(r.name));
    return { reply: { text: `Meinst du ${names.slice(0, -1).join(', ')} oder ${names.at(-1)}?`, end: false, askRoom: true } };
  }
  return { reply: { text: `Einen Raum „${spoken || erName}“ kenne ich nicht. Welchen Raum meinst du?`, end: false, askRoom: true } };
}

async function mucLog(room_id: string | null, target: number | null, reason: string) {
  await db.from('muc_decisions').insert({ kind: 'alexa', room_id, mode: room_id ? 'OVERRIDE' : null, target, reason });
}

function mucWarnings(s: { automation_enabled: boolean; dry_run: boolean }) {
  if (!s.automation_enabled) return ' Achtung: Die Automatik ist aus, deshalb wird gerade nichts an Loxone übertragen.';
  if (s.dry_run) return ' Achtung: Der Testmodus ist an, es wird nichts geschaltet.';
  return '';
}

// ----------------------------------------------------------------- Energie
async function energieMuc(): Promise<string[]> {
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
    parts.push(self != null ? `Heute ${kwh(pv)} Sonnenstrom, davon ${self} Prozent selbst genutzt.` : 'Heute gab es noch keinen Sonnenstrom.');
    if (kp.autarky_pct != null) parts.push(`Die Autarkie liegt bei ${Math.round(Number(kp.autarky_pct))} Prozent.`);
    if (Number(kp.heat_grid_kwh) >= 1) parts.push(`Die Wärmepumpe hat ${kwh(Number(kp.heat_grid_kwh))} aus dem Netz gezogen.`);
  }
  return parts;
}

// Venediger: Fronius-Werte (power_io > 0 Bezug, < 0 Einspeisung), Messwerte etwa alle 5 Minuten
async function energieVen(): Promise<string[]> {
  const since = localToIso(today(), '00:00');
  const { data, error } = await db.from('energy_readings')
    .select('timestamp, pv_power, power_io, consumption, battery_soc')
    .gte('timestamp', since).order('timestamp', { ascending: true }).range(0, 4999);
  if (error) throw error;
  const rows = data ?? [];
  const e = rows.at(-1);
  const parts: string[] = [];
  if (!e) return ['Für heute habe ich noch keine Messwerte.'];
  const age = (Date.now() - new Date(e.timestamp).getTime()) / 60000;
  if (age > 20) parts.push(`Achtung, die letzten Messwerte sind ${Math.round(age)} Minuten alt.`);
  parts.push(`Die Sonne liefert gerade ${kw(e.pv_power)}, der Akku steht bei ${e.battery_soc != null ? Math.round(e.battery_soc) : 'unbekannt'} Prozent.`);
  if (e.power_io > 50) parts.push(`Aus dem Netz kommen ${kw(e.power_io)}.`);
  else if (e.power_io < -50) parts.push(`Eingespeist werden ${kw(e.power_io)}.`);

  // Tagessummen: Leistung × Zeit bis zum nächsten Messwert (Lücken über 30 min zählen nicht)
  let pv = 0, feed = 0, gridIn = 0, use = 0;
  for (let i = 0; i < rows.length - 1; i++) {
    const h = (new Date(rows[i + 1].timestamp).getTime() - new Date(rows[i].timestamp).getTime()) / 3600000;
    if (h <= 0 || h > 0.5) continue;
    const r = rows[i];
    pv += Math.max(0, Number(r.pv_power ?? 0)) * h;
    feed += Math.max(0, -Number(r.power_io ?? 0)) * h;
    gridIn += Math.max(0, Number(r.power_io ?? 0)) * h;
    use += Math.max(0, Number(r.consumption ?? 0)) * h;
  }
  pv /= 1000; feed /= 1000; gridIn /= 1000; use /= 1000;
  if (pv > 0.1) parts.push(`Heute ${kwh(pv)} Sonnenstrom, davon ${Math.round(100 * (1 - feed / pv))} Prozent selbst genutzt.`);
  else parts.push('Heute gab es noch keinen Sonnenstrom.');
  if (use > 0.1) parts.push(`Die Autarkie liegt bei ${Math.max(0, Math.round(100 * (1 - gridIn / use)))} Prozent.`);
  return parts;
}

async function energie(ctx: Ctx): Promise<Reply> {
  const hs: House[] = ctx.both ? ['muc', 'ven'] : [ctx.house ?? ctx.home];
  const out: string[] = [];
  for (const h of hs) {
    const parts = await (h === 'muc' ? energieMuc() : energieVen());
    out.push(where(ctx, h) + parts.join(' '));
  }
  const text = out.join(' ');
  return { text, card: out.join('\n\n') };
}

// ----------------------------------------------------------------- Status
async function statusMuc(): Promise<string> {
  const [{ data: st }, s, rooms] = await Promise.all([
    db.from('muc_collector_status').select('*').eq('id', 1).single(),
    mucSettings(),
    loadRooms('muc'),
  ]);
  const age = st?.last_seen ? Math.round((Date.now() - new Date(st.last_seen).getTime()) / 60000) : null;
  const parts: string[] = [];
  if (age == null || age > 5) parts.push(`Achtung, der Collector hat sich seit ${age ?? 'langem'} Minuten nicht gemeldet.`);
  parts.push(`Die Heizung läuft im Modus ${HOUSE_MODE[st?.house_mode] ?? st?.house_mode ?? 'unbekannt'}.`);
  const manual = rooms.filter((r) => overridden('muc', r));
  if (manual.length) parts.push(`Manuell gestellt: ${manual.map((r) => `${say(r.name)} auf ${grad(r.override_temp)} bis ${uhr(r.override_until)}`).join(', ')}.`);
  return parts.join(' ') + mucWarnings(s);
}

async function statusVen(): Promise<string> {
  const [mode, rooms, presence] = await Promise.all([sysSetting('heating_day_mode'), loadRooms('ven'), presenceState()]);
  const parts: string[] = [];
  if (mode?.computed_at && Date.now() - new Date(mode.computed_at).getTime() > 30 * 60000) {
    parts.push('Achtung, die Automatik hat seit über einer halben Stunde nichts berechnet.');
  }
  if (presence) parts.push(presence.away ? 'Das Haus gilt als leer.' : `Ihr seid da bis ${tag(presence.until!)}, ${uhr(presence.until!)} Uhr.`);
  if (mode?.mode) parts.push(`Tagesmodus: ${VEN_DAY_MODE[mode.mode] ?? mode.mode}.`);
  const heating = rooms.filter((r) => r.is_heating);
  parts.push(heating.length ? `Es heizen gerade ${heating.length === 1 ? 'ein Raum' : `${heating.length} Räume`}: ${heating.map((r) => say(r.name)).join(', ')}.` : 'Gerade heizt kein Raum.');
  const manual = rooms.filter((r) => overridden('ven', r));
  if (manual.length) parts.push(`Manuell gestellt: ${manual.map((r) => `${say(r.name)} auf ${grad(r.target_temp)} bis ${uhr(r.manual_override_until)}`).join(', ')}.`);
  return parts.join(' ');
}

async function status(ctx: Ctx): Promise<Reply> {
  const hs: House[] = ctx.both ? ['muc', 'ven'] : [ctx.house ?? ctx.home];
  const out: string[] = [];
  for (const h of hs) out.push(where(ctx, h) + await (h === 'muc' ? statusMuc() : statusVen()));
  return { text: out.join(' ') };
}

// ----------------------------------------------------------------- Räume
async function raumTemp(slots: any, ctx: Ctx): Promise<Reply> {
  const { house, room, reply } = await resolveRoom(slots?.raum, ctx);
  if (reply) return reply;
  const pre = where(ctx, house!);
  if (house === 'muc') {
    const { data: r } = await db.from('muc_room_readings').select('*').eq('room_id', room!.id)
      .order('ts', { ascending: false }).limit(1).maybeSingle();
    if (!r) return { text: `${pre}Für ${say(room!.name)} habe ich noch keine Messwerte.` };
    let t = `${pre}Im ${say(room!.name)} sind es ${grad(r.temp)}. Soll ${grad(r.target ?? r.setpoint)}`;
    t += r.mode ? `, ${ROOM_MODE[r.mode] ?? r.mode}` : '';
    t += r.valve ? ', das Ventil ist offen.' : ', das Ventil ist zu.';
    const ov = overridden('muc', room!);
    if (ov) t += ` Manuell bis ${uhr(ov)}.`;
    return { text: t };
  }
  const r = room!;
  if (r.current_temp == null) return { text: `${pre}Für ${say(r.name)} habe ich keine Temperatur.` };
  let t = `${pre}Im ${say(r.name)} sind es ${grad(r.current_temp)}. Soll ${grad(r.target_temp)}`;
  t += r.is_heating ? ', es wird gerade geheizt.' : ', es wird gerade nicht geheizt.';
  const ov = overridden('ven', r);
  if (ov) t += ` Manuell bis ${uhr(ov)}.`;
  if (r.last_thermostat_sync && Date.now() - new Date(r.last_thermostat_sync).getTime() > 30 * 60000) {
    t += ' Achtung, das Thermostat hat sich länger nicht gemeldet.';
  }
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

// Venediger: Temperatur auf demselben Weg wie die App (useTuyaControl.setTemperature)
async function venSetTemp(room: Room, temp: number, until: string) {
  const mode = (await sysSetting('tuya_control_mode'))?.mode ?? 'cloud';
  if (mode === 'local') {
    const { error } = await db.from('thermostat_commands').insert({ room_id: room.id, command: 'set_temp', value: temp, status: 'pending' });
    if (error) throw error;
  } else {
    if (!room.tuya_device_id) throw new Error(`Raum ${room.name} hat kein Thermostat`);
    const res = await fetch(`${SUPABASE_URL}/functions/v1/tuya-control/set-temp`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${SERVICE_KEY}`, apikey: SERVICE_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId: room.tuya_device_id, temperature: temp, roomId: room.id }),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok || !j?.success) throw new Error(`tuya-control: ${j?.error ?? res.status}`);
  }
  const { error } = await db.from('rooms').update({ manual_override_until: until, target_temp: temp }).eq('id', room.id);
  if (error) throw error;
}

async function raumStellen(slots: any, ctx: Ctx): Promise<Reply> {
  const { house, room, reply } = await resolveRoom(slots?.raum, ctx);
  if (reply) return reply;
  const r = room!;
  const pre = where(ctx, house!);
  const lo = Math.max(HARD_MIN, Number(r.min_temp ?? HARD_MIN));
  const hi = Math.min(HARD_MAX, Number(r.max_temp ?? HARD_MAX));
  const asked = slots?.temperatur?.value != null && slots.temperatur.value !== '?' ? Number(slots.temperatur.value) : null;
  // ohne Temperatur: „warm machen“ = PV- bzw. Komforttemperatur des Raums
  const fallback = house === 'muc' ? (r.temp_pv ?? r.temp_normal) : r.comfort_temp;
  const wanted = asked ?? Number(fallback ?? 22);
  const clamped = Math.min(hi, Math.max(lo, wanted));
  const target = Math.round(clamped * 2) / 2;
  const hours = Math.min(MAX_HOURS, hoursOf(slots?.dauer?.value) ?? DEFAULT_HOURS);
  const until = new Date(Date.now() + hours * 3600000).toISOString();

  let warn = '';
  if (house === 'muc') {
    const s = await mucSettings();
    const { error } = await db.from('muc_rooms').update({ override_temp: target, override_until: until }).eq('id', r.id);
    if (error) throw error;
    await mucLog(r.id, target, `Alexa: ${r.name} auf ${num(target)} °C bis ${uhr(until)}`);
    warn = mucWarnings(s);
  } else {
    await venSetTemp(r, target, until);
  }

  let t = `${pre}Okay, ${say(r.name)} auf ${grad(target)} bis ${uhr(until)} Uhr.`;
  if (asked != null && clamped !== asked) {
    t += asked > clamped ? ` Mehr als ${grad(hi)} ist für diesen Raum nicht erlaubt.` : ` Weniger als ${grad(lo)} ist für diesen Raum nicht erlaubt.`;
  }
  return { text: t + warn };
}

async function clearOverride(h: House, ids: string[]) {
  const { error } = h === 'muc'
    ? await db.from('muc_rooms').update({ override_temp: null, override_until: null }).in('id', ids)
    : await db.from('rooms').update({ manual_override_until: null }).in('id', ids);
  if (error) throw error;
}

async function raumAutomatik(slots: any, ctx: Ctx): Promise<Reply> {
  const { house, room, reply } = await resolveRoom(slots?.raum, ctx);
  if (reply) return reply;
  const pre = where(ctx, house!);
  if (!overridden(house!, room!)) return { text: `${pre}${say(room!.name)} läuft bereits automatisch.` };
  await clearOverride(house!, [room!.id]);
  if (house === 'muc') await mucLog(room!.id, null, `Alexa: Übersteuerung ${room!.name} beendet`);
  return { text: `${pre}Okay, ${say(room!.name)} läuft wieder automatisch.` };
}

async function alleAutomatik(ctx: Ctx): Promise<Reply> {
  const hs: House[] = ctx.both ? ['muc', 'ven'] : [ctx.house ?? ctx.home];
  const out: string[] = [];
  for (const h of hs) {
    const manual = (await loadRooms(h)).filter((r) => overridden(h, r));
    if (!manual.length) { out.push(`${where(ctx, h)}Es ist kein Raum manuell gestellt.`); continue; }
    await clearOverride(h, manual.map((r) => r.id));
    if (h === 'muc') await mucLog(null, null, `Alexa: alle Übersteuerungen beendet (${manual.map((r) => r.name).join(', ')})`);
    out.push(`${where(ctx, h)}Okay, ${manual.length === 1 ? 'ein Raum läuft' : `${manual.length} Räume laufen`} wieder automatisch.`);
  }
  return { text: out.join(' ') };
}

async function automatik(slots: any, ctx: Ctx): Promise<Reply> {
  if ((ctx.house ?? 'muc') === 'ven') {
    return { text: 'Für Venediger gibt es keinen Hauptschalter. Die Automatik stellst du dort je Raum in der App ein.' };
  }
  const v = (slotId(slots?.schalter) ?? slots?.schalter?.value ?? '').toString().toLowerCase();
  const on = ['an', 'ein', 'einschalten', 'aktivieren', 'on'].includes(v) ? true
    : ['aus', 'ausschalten', 'deaktivieren', 'off', 'stopp'].includes(v) ? false : null;
  if (on == null) {
    const s = await mucSettings();
    return { text: `In München ist die Automatik ${s.automation_enabled ? 'an' : 'aus'}.${s.dry_run ? ' Der Testmodus ist an.' : ''}` };
  }
  const { error } = await db.from('muc_settings').update({ automation_enabled: on }).eq('id', 1);
  if (error) throw error;
  await mucLog(null, null, `Alexa: Automatik ${on ? 'eingeschaltet' : 'ausgeschaltet'}`);
  return { text: on ? 'Okay, die Automatik in München ist wieder an.' : 'Okay, die Automatik in München ist aus. Loxone regelt jetzt mit den eigenen Werten.' };
}

// ----------------------------------------------------------------- Anwesenheit (nur Venediger)
// Gleiche Regel wie die App (usePresence.computePresence) und pv-automation.
async function presenceState(): Promise<{ away: boolean; until: string | null; next: string | null } | null> {
  const { data: hs } = await db.from('heating_settings').select('presence_control_enabled, presence_lead_hours').limit(1).maybeSingle();
  if (hs && hs.presence_control_enabled === false) return null;
  const lead = Math.max(0, Math.min(72, Number(hs?.presence_lead_hours ?? 6) || 0));
  const now = Date.now();
  const { data, error } = await db.from('presence_periods').select('start_at, end_at')
    .gt('end_at', new Date(now).toISOString()).order('start_at');
  if (error) return null;
  const open = data ?? [];
  const active = open.filter((p) => new Date(p.start_at).getTime() - lead * 3600000 <= now);
  if (active.length) return { away: false, until: active.map((p) => p.end_at).sort().at(-1)!, next: null };
  return { away: true, until: null, next: open[0]?.start_at ?? null };
}

async function presenceTimes() {
  const { data } = await db.from('heating_settings').select('presence_departure_time').limit(1).maybeSingle();
  return { departure: (data?.presence_departure_time ?? '11:00').toString().slice(0, 5) };
}

// nächster Sonntag (heute ausgenommen) als YYYY-MM-DD
function nextSunday(): string {
  const d = new Date(today() + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + ((7 - d.getUTCDay()) % 7 || 7));
  return d.toISOString().slice(0, 10);
}

async function ankunft(slots: any): Promise<Reply> {
  const bisSlot: string | undefined = slots?.bis?.value;
  const { departure } = await presenceTimes();
  let endIso: string;
  if (bisSlot && /^\d{4}-\d{2}-\d{2}$/.test(bisSlot)) endIso = localToIso(bisSlot, departure);
  else endIso = localToIso(nextSunday(), '18:00'); // wie der Schnellschalter in der App
  if (new Date(endIso).getTime() <= Date.now() + 15 * 60000) {
    return { text: 'Das Abreisedatum liegt in der Vergangenheit. Sag zum Beispiel: Ich bin da bis Sonntag.', end: false };
  }
  const { error } = await db.from('presence_periods').insert({
    start_at: new Date().toISOString(), end_at: endIso, note: 'Alexa', source: 'quick',
  });
  if (error) throw error;
  return { text: `Okay, in Venediger bist du eingetragen bis ${tag(endIso)}, ${uhr(endIso)} Uhr. Die Heizung arbeitet ab jetzt wie bei Anwesenheit.` };
}

async function abreise(): Promise<Reply> {
  const nowIso = new Date().toISOString();
  const { data, error } = await db.from('presence_periods').select('id')
    .lt('start_at', nowIso).gt('end_at', nowIso);
  if (error) throw error;
  if (!data?.length) {
    const st = await presenceState();
    return { text: st?.away === false ? 'Gerade läuft nur der Vorlauf vor einer geplanten Ankunft, den habe ich nicht geändert.' : 'In Venediger ist ohnehin niemand eingetragen.' };
  }
  const { error: e2 } = await db.from('presence_periods').update({ end_at: nowIso, updated_at: nowIso }).in('id', data.map((p) => p.id));
  if (e2) throw e2;
  return { text: 'Okay, in Venediger ausgetragen. Das Haus gilt jetzt als leer, es wird nur noch mit Sonnenstrom geheizt.' };
}

async function anwesenheitAbfrage(): Promise<Reply> {
  const st = await presenceState();
  if (!st) return { text: 'Die Anwesenheitssteuerung in Venediger ist ausgeschaltet.' };
  if (!st.away) return { text: `In Venediger seid ihr eingetragen bis ${tag(st.until!)}, ${uhr(st.until!)} Uhr.` };
  return { text: st.next ? `Venediger ist gerade leer. Die nächste Ankunft ist am ${tag(st.next)}.` : 'Venediger ist gerade leer, und es ist keine Ankunft eingetragen.' };
}

const HELP = 'Du kannst zum Beispiel fragen: Wie hoch ist der Eigenverbrauch? Wie warm ist es im Wohnzimmer in Venediger? '
  + 'Oder sagen: Stelle das Bad im Keller für zwei Stunden auf dreiundzwanzig Grad. Oder: Ich bin da bis Sonntag.';

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
  if (req.method !== 'POST') return new Response('Meine Heizung – Alexa-Endpunkt (München und Venediger)', { status: 200 });
  let body: any;
  try { body = await req.json(); } catch { return new Response('bad request', { status: 400 }); }

  const denied = check(body);
  if (denied) {
    console.warn('abgelehnt:', denied);
    return new Response('forbidden', { status: 403 });
  }

  const r = body.request;
  const deviceId: string = body?.context?.System?.device?.deviceId ?? '';
  try {
    if (r.type === 'LaunchRequest') {
      // IDs für ALEXA_USER_IDS / ALEXA_VEN_DEVICES – stehen dann in den Function-Logs
      console.log('Alexa-Benutzer:', body.session?.user?.userId);
      console.log('Alexa-Gerät:', deviceId);
      return respond({ text: `Meine Heizung. ${HELP}`, end: false });
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
    const home: House = VEN_DEVICES.includes(deviceId) ? 'ven' : 'muc';
    const ctx: Ctx = { home, ...houseFromSlot(slots.haus) };

    const run = async (): Promise<Reply> => {
      switch (name) {
        case 'EnergieIntent': return energie(ctx);
        case 'StatusIntent': return status(ctx);
        case 'RaumTemperaturIntent': return raumTemp(slots, ctx);
        case 'RaumStellenIntent': return raumStellen(slots, ctx);
        case 'RaumAutomatikIntent': return raumAutomatik(slots, ctx);
        case 'AlleAutomatikIntent': return alleAutomatik(ctx);
        case 'AutomatikIntent': return automatik(slots, ctx);
        case 'AnkunftIntent': return ankunft(slots);
        case 'AbreiseIntent': return abreise();
        case 'AnwesenheitIntent': return anwesenheitAbfrage();
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
