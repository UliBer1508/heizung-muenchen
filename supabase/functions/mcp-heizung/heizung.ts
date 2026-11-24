// Heizungslogik für das Alexa+-Add-on (MCP-Server „Meine Heizung“) – München und Venediger.
//
// Übernommen aus alexa-heizung/index.ts (Raumerkennung, Sprachbausteine, Schreibwege) und angepasst:
//   - Jede Antwort beginnt mit dem Haus („München: …“, „Venediger: …“).
//   - Gibt es einen Raum in beiden Häusern („Wohnzimmer“) und ist das Haus nicht genannt:
//     Lesen → beide Häuser, Schreiben → Rückfrage. Kein stiller Standard München beim Schalten.
//   - Venediger-Anwesenheit nach der Umstellung vom 01.11.2026: Einträge in presence_periods
//     bedeuten ABWESENHEIT (Venediger doc/KONZEPT-ANWESENHEIT-2026-10-28.md §9, usePresence.ts).
//
// Alexa+ schaltet nie direkt. Geschrieben wird auf denselben Wegen wie die Apps:
//   München    muc_rooms.override_temp / override_until, muc_settings.automation_enabled, Protokoll muc_decisions (Art alexa_plus)
//   Venediger  thermostat_commands (lokal) bzw. tuya-control/set-temp (Cloud) + rooms.manual_override_until / target_temp,
//              Abwesenheit in presence_periods (wie Schnellschalter awayUntil / backNow)

import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
let db: SupabaseClient = SUPABASE_URL ? createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } }) : (null as any);
let tuyaFetch: typeof fetch = (...a) => fetch(...a);
/** nur für Tests */
export function _setDb(d: any, f?: typeof fetch) { db = d; if (f) tuyaFetch = f; }
export const getDb = () => db;

export const TZ = 'Europe/Berlin'; // gleich wie Europe/Vienna
const DEFAULT_MIN = 120;
const MAX_MIN = 12 * 60;
const HARD_MIN = 5;
const HARD_MAX = 26;

export type House = 'muc' | 'ven';
export const HOUSE_NAME: Record<House, string> = { muc: 'München', ven: 'Venediger' };
const HOUSES: House[] = ['muc', 'ven'];

/** Ergebnis eines Tools: Text zum Vorlesen + strukturierte Daten. frage = Rückfrage an den Nutzer nötig. */
export type Result = { text: string; data?: unknown; frage?: boolean; fehler?: boolean };

// ----------------------------------------------------------------- Haus aus Text
export function houseOf(v: unknown): House | 'beide' | null {
  const s = String(v ?? '').toLowerCase().trim();
  if (!s) return null;
  if (/beide|alle|überall|uberall/.test(s)) return 'beide';
  if (/ven|neukirchen|österreich|oesterreich|pinzgau|salzburg|austria|^at$/.test(s)) return 'ven';
  if (/muc|münchen|muenchen|munich|weidmann|bayern|deutschland|^de$/.test(s)) return 'muc';
  return null;
}

// ----------------------------------------------------------------- Raumerkennung (wie alexa-heizung)
export type Room = { id: string; name: string; enabled?: boolean } & Record<string, any>;

const SYNONYMS: Record<string, string> = {
  keller: 'kg', kellergeschoss: 'kg', untergeschoss: 'kg', souterrain: 'kg', unten: 'kg',
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
  ulis: 'uli',
  kinderbad: 'kinder bad', haustüre: 'haustür', eingangstür: 'haustür',
};
const FLOORS = new Set(['kg', 'eg', 'og', 'dg']);
const STOP = new Set(['im', 'in', 'der', 'die', 'das', 'den', 'dem', 'von', 'vom', 'zimmer', 'raum', 'und', 'am', 'an', 'beim', 'bei',
  'unser', 'unsere', 'unserem', 'mein', 'meinem', 'meine', 'kleines', 'kleine', 'großes', 'grosse', 'temperatur', 'heizung']);

function norm(s: string): string {
  let t = ` ${s.toLowerCase().replace(/[\/(),.\-]/g, ' ').replace(/\s+/g, ' ').trim()} `;
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
const same = (a: string, b: string) => a === b || (a.length >= 3 && b.length >= 3 && (a.startsWith(b) || b.startsWith(a)));

type Match = { score: number } & ({ room: Room } | { ambiguous: Room[] } | { none: true });

/** Raum im Haus finden. Wortstellung egal: „Uli Bad“ = „Bad Uli“. */
export function matchRoom(spoken: string, rooms: Room[]): Match {
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

// ----------------------------------------------------------------- Sprachbausteine
const num = (v: number | null | undefined, d = 1) =>
  v == null || Number.isNaN(Number(v)) ? 'unbekannt' : Number(v).toLocaleString('de-DE', { maximumFractionDigits: d });
const grad = (v: number | null | undefined) => (v == null ? 'unbekannt' : `${num(v)} Grad`);
const kw = (w: number | null | undefined) =>
  w == null ? 'unbekannt' : Math.abs(w) < 1000 ? `${Math.round(Math.abs(w))} Watt` : `${num(Math.abs(w) / 1000)} Kilowatt`;
const kwh = (v: number | null | undefined) => (v == null ? 'unbekannt' : `${num(v)} Kilowattstunden`);
export const uhr = (ts: string) => new Date(ts).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', timeZone: TZ });
export const tag = (ts: string) => new Date(ts).toLocaleDateString('de-DE', { weekday: 'long', day: 'numeric', month: 'long', timeZone: TZ });
export const today = () => new Date().toLocaleDateString('sv-SE', { timeZone: TZ }); // YYYY-MM-DD
const isToday = (ts: string) => new Date(ts).toLocaleDateString('sv-SE', { timeZone: TZ }) === today();
const bisWann = (ts: string) => (isToday(ts) ? `${uhr(ts)} Uhr` : `${tag(ts)}, ${uhr(ts)} Uhr`);

export function say(name: string) {
  const parts = name.replace(/\s*\(.*?\)\s*/g, ' ').trim().split('/').map((p) => p.trim());
  return parts.length > 1 ? `${parts.slice(0, -1).join(', ')} und ${parts.at(-1)}` : parts[0];
}

/** Ortszeit (Europe/Berlin) → UTC-ISO */
export function localToIso(date: string, time: string): string {
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm] = time.split(':').map(Number);
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  const asLocal = new Date(new Date(guess).toLocaleString('en-US', { timeZone: TZ })).getTime();
  const asUtc = new Date(new Date(guess).toLocaleString('en-US', { timeZone: 'UTC' })).getTime();
  return new Date(guess - (asLocal - asUtc)).toISOString();
}

/** Zeitangabe aus dem Tool: „2026-11-28“, „2026-11-28T14:00“, „14:30“ (heute bzw. morgen), ISO mit Zone. */
export function parseWhen(v: unknown, defaultTime: string, nowMs = Date.now()): string | null {
  const s = String(v ?? '').trim();
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return localToIso(s, defaultTime);
  let m = s.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{1,2}:\d{2})(:\d{2})?$/);
  if (m) return localToIso(m[1], m[2]);
  m = s.match(/^(\d{1,2})[:.](\d{2})$/) ?? s.match(/^(\d{1,2})$/);
  if (m) {
    const t = `${m[1].padStart(2, '0')}:${m[2] ?? '00'}`;
    let iso = localToIso(today(), t);
    if (new Date(iso).getTime() <= nowMs) {
      const d = new Date(today() + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + 1);
      iso = localToIso(d.toISOString().slice(0, 10), t);
    }
    return iso;
  }
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

const HOUSE_MODE: Record<string, string> = {
  NACHT: 'Nachtabsenkung', MORGEN: 'Morgenbetrieb', TAG: 'Tagbetrieb', ABEND: 'Abendbetrieb',
  PV_1: 'PV-Stufe 1', PV_2: 'PV-Stufe 2', PV_3: 'PV-Stufe 3', BATTERIE_VOLL: 'Batterie voll',
  PV: 'Heizen mit Sonnenstrom', WARTETAG: 'Wartetag, die Räume warten auf Sonnenstrom',
};
const ROOM_MODE: Record<string, string> = {
  NORMAL: 'Normalbetrieb', ABSENK: 'Untergrenze', FRUEH_AUS: 'Untergrenze erreicht, Ventil früh zu', WARTET: 'wartet, bis ein Heizkreis frei ist',
  PV: 'Aufheizen mit Sonnenstrom', VOLL: 'volles Aufheizen', OVERRIDE: 'manuell', PV_LADEN: 'Estrich laden mit Sonnenstrom',
};
const VEN_DAY_MODE: Record<string, string> = {
  wait: 'Wartetag, die Räume warten auf Sonnenstrom', grid: 'Grundheizung aus dem Netz', battery_gate: 'Batterieschutz',
};

// ----------------------------------------------------------------- Daten
async function loadRooms(h: House): Promise<Room[]> {
  const { data, error } = h === 'muc'
    ? await db.from('muc_rooms').select('*').order('sort')
    : await db.from('rooms').select('*').order('priority');
  if (error) throw error;
  return (data ?? []) as Room[];
}
async function mucSettings(): Promise<{ automation_enabled: boolean; dry_run: boolean }> {
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
  return until && new Date(until) > new Date() ? (until as string) : null;
};
function mucWarnings(s: { automation_enabled: boolean; dry_run: boolean }) {
  if (!s.automation_enabled) return ' Achtung: Die Automatik ist aus, deshalb wird gerade nichts an Loxone übertragen.';
  if (s.dry_run) return ' Achtung: Der Testmodus ist an, es wird nichts geschaltet.';
  return '';
}
async function mucLog(room_id: string | null, target: number | null, reason: string) {
  await db.from('muc_decisions').insert({ kind: 'alexa_plus', room_id, mode: room_id ? 'OVERRIDE' : null, target, reason });
}
const housesFor = (haus: unknown): House[] => {
  const h = houseOf(haus);
  return h === 'beide' || h == null ? HOUSES : [h];
};
const prefix = (h: House) => `${HOUSE_NAME[h]}: `;

// ----------------------------------------------------------------- Raum auflösen
type Resolved =
  | { ok: true; hits: { house: House; room: Room }[] }   // ein Treffer, oder mehrere Häuser (nur beim Lesen)
  | { ok: false; result: Result };

/** Raum finden. Haus genannt → nur dort. Sonst beide Häuser; der klar bessere Treffer gewinnt. */
export async function resolveRoom(raum: unknown, haus: unknown, forWrite: boolean): Promise<Resolved> {
  const spoken = String(raum ?? '').trim();
  if (!spoken) return { ok: false, result: { text: 'Welchen Raum meinst du?', frage: true } };
  const h = houseOf(haus);
  const hs: House[] = h && h !== 'beide' ? [h] : HOUSES;
  const found: { house: House; m: Match }[] = [];
  for (const x of hs) {
    const m = matchRoom(spoken, await loadRooms(x));
    if (!('none' in m)) found.push({ house: x, m });
  }
  if (!found.length) {
    const wo = hs.length === 1 ? ` in ${HOUSE_NAME[hs[0]]}` : '';
    return { ok: false, result: { text: `Einen Raum „${spoken}“ gibt es${wo} nicht. Das Werkzeug haeuser_und_raeume listet alle Räume.`, frage: true } };
  }
  found.sort((a, b) => b.m.score - a.m.score);
  // anderes Haus klar schlechter → nur das beste
  const top = found.filter((f) => f.m.score >= found[0].m.score - 4);
  if (top.length === 1 || !forWrite) {
    const use = top; // Lesen: alle knappen Treffer (Raum in beiden Häusern → beide)
    const amb = use.find((f) => 'ambiguous' in f.m);
    if (amb && 'ambiguous' in amb.m) {
      const names = amb.m.ambiguous.slice(0, 4).map((r) => say(r.name));
      return { ok: false, result: { text: `${prefix(amb.house)}Meinst du ${names.slice(0, -1).join(', ')} oder ${names.at(-1)}?`, frage: true, data: { haus: amb.house, kandidaten: amb.m.ambiguous.map((r) => r.name) } } };
    }
    return { ok: true, hits: use.map((f) => ({ house: f.house, room: (f.m as any).room as Room })) };
  }
  // Schreiben, Raum passt in beiden Häusern gleich gut → Rückfrage
  return {
    ok: false,
    result: {
      text: `„${spoken}“ gibt es in München und in Venediger. In welchem Haus?`,
      frage: true,
      data: { kandidaten: top.map((f) => ({ haus: HOUSE_NAME[f.house], raum: 'room' in f.m ? f.m.room.name : null })) },
    },
  };
}

// ----------------------------------------------------------------- Tool: haeuser_und_raeume
export async function haeuserUndRaeume(): Promise<Result> {
  const [muc, ven, mr] = await Promise.all([
    loadRooms('muc'),
    loadRooms('ven'),
    db.from('muc_room_readings').select('room_id, ts, temp, target').gte('ts', new Date(Date.now() - 45 * 60000).toISOString())
      .order('ts', { ascending: false }).limit(300),
  ]);
  const last = new Map<string, any>();
  for (const r of mr.data ?? []) if (!last.has(r.room_id)) last.set(r.room_id, r);
  const data = {
    muenchen: muc.filter((r) => r.enabled !== false).map((r) => ({
      raum: r.name, ist: last.get(r.id)?.temp ?? null, soll: last.get(r.id)?.target ?? null,
      min: Number(r.min_temp ?? HARD_MIN), max: Number(r.max_temp ?? HARD_MAX), manuell_bis: overridden('muc', r),
    })),
    venediger: ven.map((r) => ({
      raum: r.name, ist: r.current_temp ?? null, soll: r.target_temp ?? null, heizt: !!r.is_heating,
      min: HARD_MIN, max: HARD_MAX, manuell_bis: overridden('ven', r),
    })),
  };
  const text = `München: ${data.muenchen.map((r) => say(r.raum)).join(', ')}. Venediger: ${data.venediger.map((r) => say(r.raum)).join(', ')}.`;
  return { text, data };
}

// ----------------------------------------------------------------- Tool: status
async function statusMuc(): Promise<Result> {
  const [{ data: st }, s, rooms, { data: open }] = await Promise.all([
    db.from('muc_collector_status').select('*').eq('id', 1).single(),
    mucSettings(),
    loadRooms('muc'),
    db.from('muc_ki_suggestions').select('kind, title').eq('status', 'offen'),
  ]);
  const age = st?.last_seen ? Math.round((Date.now() - new Date(st.last_seen).getTime()) / 60000) : null;
  const parts: string[] = [];
  if (age == null || age > 5) parts.push(`Achtung, der Collector hat sich seit ${age ?? 'langem'} Minuten nicht gemeldet.`);
  parts.push(`Die Heizung läuft im Modus ${HOUSE_MODE[st?.house_mode] ?? st?.house_mode ?? 'unbekannt'}.`);
  const manual = rooms.filter((r) => overridden('muc', r));
  parts.push(manual.length
    ? `Manuell gestellt: ${manual.map((r) => `${say(r.name)} auf ${grad(r.override_temp)} bis ${bisWann(r.override_until)}`).join(', ')}.`
    : 'Kein Raum ist manuell gestellt.');
  const hints = (open ?? []).filter((x: any) => x.kind === 'hinweis');
  if (hints.length) parts.push(`KI-Hinweis: ${hints.map((x: any) => x.title).join('; ')}.`);
  return {
    text: prefix('muc') + parts.join(' ') + mucWarnings(s),
    data: {
      haus: 'München', modus: st?.house_mode ?? null, collector_minuten: age, automatik: s.automation_enabled, testmodus: s.dry_run,
      manuell: manual.map((r) => ({ raum: r.name, temperatur: r.override_temp, bis: r.override_until })),
      ki_hinweise: hints.map((x: any) => x.title), ki_offen: (open ?? []).length,
    },
  };
}

async function statusVen(): Promise<Result> {
  const [mode, rooms, pres] = await Promise.all([sysSetting('heating_day_mode'), loadRooms('ven'), presenceVen()]);
  const parts: string[] = [];
  if (mode?.computed_at && Date.now() - new Date(mode.computed_at).getTime() > 30 * 60000) {
    parts.push('Achtung, die Automatik hat seit über einer halben Stunde nichts berechnet.');
  }
  parts.push(pres.text);
  if (mode?.mode) parts.push(`Tagesmodus: ${VEN_DAY_MODE[mode.mode] ?? mode.mode}.`);
  const heating = rooms.filter((r) => r.is_heating);
  parts.push(heating.length ? `Es heizen gerade ${heating.length === 1 ? 'ein Raum' : `${heating.length} Räume`}: ${heating.map((r) => say(r.name)).join(', ')}.` : 'Gerade heizt kein Raum.');
  const manual = rooms.filter((r) => overridden('ven', r));
  if (manual.length) parts.push(`Manuell gestellt: ${manual.map((r) => `${say(r.name)} auf ${grad(r.target_temp)} bis ${bisWann(r.manual_override_until)}`).join(', ')}.`);
  return {
    text: prefix('ven') + parts.join(' '),
    data: {
      haus: 'Venediger', tagesmodus: mode?.mode ?? null, anwesenheit: pres.data,
      heizen: heating.map((r) => r.name), manuell: manual.map((r) => ({ raum: r.name, temperatur: r.target_temp, bis: r.manual_override_until })),
    },
  };
}

export async function status(haus: unknown): Promise<Result> {
  const out = await Promise.all(housesFor(haus).map((h) => (h === 'muc' ? statusMuc() : statusVen())));
  return { text: out.map((o) => o.text).join(' '), data: out.map((o) => o.data) };
}

// ----------------------------------------------------------------- Tool: raum
async function raumMuc(room: Room): Promise<Result> {
  const [{ data: r }, outlook] = await Promise.all([
    db.from('muc_room_readings').select('*').eq('room_id', room.id).order('ts', { ascending: false }).limit(1).maybeSingle(),
    db.rpc('muc_room_outlook').then((x: any) => (x.data ?? []).find((o: any) => o.room_id === room.id) ?? null, () => null),
  ]);
  if (!r) return { text: `${prefix('muc')}Für ${say(room.name)} habe ich noch keine Messwerte.`, data: { haus: 'München', raum: room.name } };
  let t = `${prefix('muc')}Im ${say(room.name)} sind es ${grad(r.temp)}, Soll ${grad(r.target ?? r.setpoint)}`;
  t += r.mode ? `, ${ROOM_MODE[r.mode] ?? r.mode}` : '';
  t += r.valve ? ', das Ventil ist offen.' : ', das Ventil ist zu.';
  const ov = overridden('muc', room);
  if (ov) t += ` Manuell bis ${bisWann(ov)}.`;
  if (outlook?.predicted_morning != null) t += ` Ohne Heizen wären es morgen früh etwa ${grad(Math.round(Number(outlook.predicted_morning) * 10) / 10)}.`;
  return {
    text: t,
    data: {
      haus: 'München', raum: room.name, ist: r.temp, soll: r.target ?? r.setpoint, modus: r.mode, ventil_offen: !!r.valve, gemessen: r.ts,
      manuell_bis: ov, min: Number(room.min_temp ?? HARD_MIN), max: Number(room.max_temp ?? HARD_MAX),
      prognose_morgen_frueh: outlook?.predicted_morning ?? null,
    },
  };
}
function raumVen(r: Room): Result {
  if (r.current_temp == null) return { text: `${prefix('ven')}Für ${say(r.name)} habe ich keine Temperatur.`, data: { haus: 'Venediger', raum: r.name } };
  let t = `${prefix('ven')}Im ${say(r.name)} sind es ${grad(r.current_temp)}, Soll ${grad(r.target_temp)}`;
  t += r.is_heating ? ', es wird gerade geheizt.' : ', es wird gerade nicht geheizt.';
  const ov = overridden('ven', r);
  if (ov) t += ` Manuell bis ${bisWann(ov)}.`;
  const stale = r.last_thermostat_sync && Date.now() - new Date(r.last_thermostat_sync).getTime() > 30 * 60000;
  if (stale) t += ' Achtung, das Thermostat hat sich länger nicht gemeldet.';
  return {
    text: t,
    data: {
      haus: 'Venediger', raum: r.name, ist: r.current_temp, soll: r.target_temp, heizt: !!r.is_heating, manuell_bis: ov,
      komfort: r.comfort_temp, eco: r.eco_temp, thermostat_gemeldet: r.last_thermostat_sync, thermostat_veraltet: !!stale,
    },
  };
}
export async function raum(raumName: unknown, haus: unknown): Promise<Result> {
  const res = await resolveRoom(raumName, haus, false);
  if (!res.ok) return res.result;
  const out = await Promise.all(res.hits.map((x) => (x.house === 'muc' ? raumMuc(x.room) : Promise.resolve(raumVen(x.room)))));
  return { text: out.map((o) => o.text).join(' '), data: out.length === 1 ? out[0].data : out.map((o) => o.data) };
}

// ----------------------------------------------------------------- Tool: energie
async function energieMuc(): Promise<Result> {
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
  let self: number | null = null;
  if (kp?.pv_kwh != null) {
    const pv = Number(kp.pv_kwh), feed = Number(kp.grid_out_kwh ?? 0);
    self = pv > 0.1 ? Math.round(100 * (1 - feed / pv)) : null;
    parts.push(self != null ? `Heute ${kwh(pv)} Sonnenstrom, davon ${self} Prozent selbst genutzt.` : 'Heute gab es noch keinen Sonnenstrom.');
    if (kp.autarky_pct != null) parts.push(`Die Autarkie liegt bei ${Math.round(Number(kp.autarky_pct))} Prozent.`);
    if (Number(kp.heat_grid_kwh) >= 1) parts.push(`Die Wärmepumpe hat ${kwh(Number(kp.heat_grid_kwh))} aus dem Netz gezogen.`);
  }
  return {
    text: prefix('muc') + (parts.join(' ') || 'Keine Energiewerte vorhanden.'),
    data: {
      haus: 'München', jetzt: e ? { pv_w: e.pv_w, akku_prozent: e.soc, netz_w: e.grid_w, gemessen: e.ts } : null,
      heute: kp ? { pv_kwh: kp.pv_kwh, eingespeist_kwh: kp.grid_out_kwh, eigenverbrauch_prozent: self, autarkie_prozent: kp.autarky_pct, heizstrom_netz_kwh: kp.heat_grid_kwh } : null,
    },
  };
}
async function energieVen(): Promise<Result> {
  const since = localToIso(today(), '00:00');
  const { data, error } = await db.from('energy_readings')
    .select('timestamp, pv_power, power_io, consumption, battery_soc')
    .gte('timestamp', since).order('timestamp', { ascending: true }).range(0, 4999);
  if (error) throw error;
  const rows = data ?? [];
  const e = rows.at(-1);
  if (!e) return { text: `${prefix('ven')}Für heute habe ich noch keine Messwerte.`, data: { haus: 'Venediger' } };
  const parts: string[] = [];
  const age = (Date.now() - new Date(e.timestamp).getTime()) / 60000;
  if (age > 20) parts.push(`Achtung, die letzten Messwerte sind ${Math.round(age)} Minuten alt.`);
  parts.push(`Die Sonne liefert gerade ${kw(e.pv_power)}, der Akku steht bei ${e.battery_soc != null ? Math.round(e.battery_soc) : 'unbekannt'} Prozent.`);
  if (e.power_io > 50) parts.push(`Aus dem Netz kommen ${kw(e.power_io)}.`);
  else if (e.power_io < -50) parts.push(`Eingespeist werden ${kw(e.power_io)}.`);
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
  const self = pv > 0.1 ? Math.round(100 * (1 - feed / pv)) : null;
  const aut = use > 0.1 ? Math.max(0, Math.round(100 * (1 - gridIn / use))) : null;
  parts.push(self != null ? `Heute ${kwh(pv)} Sonnenstrom, davon ${self} Prozent selbst genutzt.` : 'Heute gab es noch keinen Sonnenstrom.');
  if (aut != null) parts.push(`Die Autarkie liegt bei ${aut} Prozent.`);
  return {
    text: prefix('ven') + parts.join(' '),
    data: {
      haus: 'Venediger', jetzt: { pv_w: e.pv_power, akku_prozent: e.battery_soc, netz_w: e.power_io, gemessen: e.timestamp },
      heute: { pv_kwh: Math.round(pv * 10) / 10, eingespeist_kwh: Math.round(feed * 10) / 10, eigenverbrauch_prozent: self, autarkie_prozent: aut },
    },
  };
}
export async function energie(haus: unknown): Promise<Result> {
  const out = await Promise.all(housesFor(haus).map((h) => (h === 'muc' ? energieMuc() : energieVen())));
  return { text: out.map((o) => o.text).join(' '), data: out.map((o) => o.data) };
}

// ----------------------------------------------------------------- Tool: hinweise / tagesrueckblick (München-KI)
export async function hinweise(): Promise<Result> {
  const { data, error } = await db.from('muc_ki_suggestions').select('kind, title, why, room_id, created_at')
    .eq('status', 'offen').order('created_at', { ascending: false }).limit(20);
  if (error) throw error;
  const rows = data ?? [];
  const h = rows.filter((x: any) => x.kind === 'hinweis');
  const v = rows.filter((x: any) => x.kind !== 'hinweis');
  const parts: string[] = [];
  parts.push(h.length ? `${h.length === 1 ? 'Ein Hinweis' : `${h.length} Hinweise`}: ${h.map((x: any) => x.title).join('; ')}.` : 'Keine offenen Hinweise.');
  if (v.length) parts.push(`${v.length === 1 ? 'Ein Vorschlag wartet' : `${v.length} Vorschläge warten`} auf deine Entscheidung in der App: ${v.map((x: any) => x.title).join('; ')}.`);
  return { text: prefix('muc') + parts.join(' '), data: { haus: 'München', hinweise: h, vorschlaege: v } };
}
export async function tagesrueckblick(datum: unknown): Promise<Result> {
  const d = /^\d{4}-\d{2}-\d{2}$/.test(String(datum ?? '')) ? String(datum) : null;
  const q = db.from('muc_ki_runs').select('day, summary');
  const { data, error } = d ? await q.eq('day', d).maybeSingle() : await q.order('day', { ascending: false }).limit(1).maybeSingle();
  if (error) throw error;
  if (!data?.summary) return { text: `${prefix('muc')}Für ${d ?? 'heute'} gibt es noch keinen Rückblick.`, data: null };
  return { text: `${prefix('muc')}${data.summary}`, data: { haus: 'München', analyse_vom: data.day, rueckblick: data.summary } };
}

// ----------------------------------------------------------------- Venediger: Anwesenheit (Kalender = Abwesenheit)
type Period = { id?: string; start_at: string; end_at: string };
/** gleiche Regel wie usePresence.computePresence (Venediger) */
export function computePresence(periods: Period[], enabled: boolean, leadH: number, nowMs = Date.now()) {
  const open = periods.filter((p) => new Date(p.end_at).getTime() > nowMs).sort((a, b) => a.start_at.localeCompare(b.start_at));
  const current = open.filter((p) => new Date(p.start_at).getTime() <= nowMs);
  const next = open.find((p) => new Date(p.start_at).getTime() > nowMs) ?? null;
  const awayNow = current.filter((p) => new Date(p.end_at).getTime() - leadH * 3600_000 > nowMs);
  if (!enabled) return { enabled, away: false, inLead: false, until: null as string | null, next, current };
  if (awayNow.length) return { enabled, away: true, inLead: false, until: awayNow.map((p) => p.end_at).sort().at(-1)!, next, current };
  const until = current.length ? current.map((p) => p.end_at).sort().at(-1)! : null;
  return { enabled, away: false, inLead: current.length > 0, until, next, current };
}
async function presenceSettings() {
  const { data } = await db.from('heating_settings')
    .select('presence_control_enabled, presence_lead_hours, presence_departure_time, presence_arrival_time').limit(1).maybeSingle();
  return {
    enabled: data?.presence_control_enabled !== false,
    lead: Math.max(0, Math.min(72, Number(data?.presence_lead_hours ?? 6) || 0)),
    departure: String(data?.presence_departure_time ?? '11:00').slice(0, 5),
    arrival: String(data?.presence_arrival_time ?? '14:00').slice(0, 5),
  };
}
async function loadPeriods(): Promise<Period[]> {
  const { data, error } = await db.from('presence_periods').select('id, start_at, end_at').gt('end_at', new Date().toISOString()).order('start_at');
  if (error) throw error;
  return data ?? [];
}
export async function presenceVen(): Promise<Result> {
  const [s, periods] = await Promise.all([presenceSettings(), loadPeriods().catch(() => [] as Period[])]);
  const st = computePresence(periods, s.enabled, s.lead);
  let t: string;
  if (!st.enabled) t = 'Die Anwesenheitssteuerung ist ausgeschaltet, das Haus gilt als bewohnt.';
  else if (st.away) t = `Das Haus gilt als leer bis ${tag(st.until!)}, ${uhr(st.until!)} Uhr. Es wird nur das Nötigste und mit Sonnenstrom geheizt.`;
  else if (st.inLead) t = `Das Haus wird gerade für eure Rückkehr am ${tag(st.until!)}, ${uhr(st.until!)} Uhr, vorgeheizt.`;
  else t = 'Das Haus gilt als bewohnt.';
  if (st.next) t += ` Nächste geplante Abwesenheit ab ${tag(st.next.start_at)}, ${uhr(st.next.start_at)} Uhr, bis ${tag(st.next.end_at)}.`;
  return {
    text: t,
    data: { aktiv: st.enabled, abwesend: st.away, vorheizen: st.inLead, abwesend_bis: st.until, naechste_abwesenheit: st.next ? { von: st.next.start_at, bis: st.next.end_at } : null },
  };
}
export async function anwesenheit(): Promise<Result> {
  const r = await presenceVen();
  return { text: prefix('ven') + r.text, data: r.data };
}

/** Abwesenheit eintragen (wie Schnellschalter „Ich bin weg bis …“). Ohne bis: in 7 Tagen zur Standard-Rückkehr. */
export async function abwesenheitEintragen(von: unknown, bis: unknown): Promise<Result> {
  const s = await presenceSettings();
  if (!s.enabled) return { text: `${prefix('ven')}Die Anwesenheitssteuerung ist in der App ausgeschaltet. Bitte dort zuerst einschalten.`, fehler: true };
  const nowMs = Date.now();
  const startIso = parseWhen(von, s.departure) ?? new Date(nowMs).toISOString();
  let endIso = parseWhen(bis, s.arrival);
  if (!endIso) {
    const d = new Date(today() + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + 7);
    endIso = localToIso(d.toISOString().slice(0, 10), s.arrival);
  }
  const startMs = Math.max(new Date(startIso).getTime(), nowMs - 60_000);
  if (new Date(endIso).getTime() <= Math.max(startMs, nowMs) + 15 * 60000) {
    return { text: `${prefix('ven')}Die Rückkehr muss nach dem Beginn und in der Zukunft liegen. Wann kommt ihr zurück?`, frage: true };
  }
  if (new Date(endIso).getTime() - startMs > 90 * 86400_000) {
    return { text: `${prefix('ven')}Mehr als 90 Tage am Stück trage ich nicht ein. Längere Zeiträume bitte im Kalender der App.`, frage: true };
  }
  const start = new Date(startMs).toISOString();
  const { error } = await db.from('presence_periods').insert({ start_at: start, end_at: endIso, note: 'Alexa', source: 'quick' });
  if (error) throw error;
  const ab = startMs <= nowMs + 60_000 ? 'ab jetzt' : `ab ${tag(start)}, ${uhr(start)} Uhr`;
  return {
    text: `${prefix('ven')}Okay, abwesend ${ab} bis ${tag(endIso)}, ${uhr(endIso)} Uhr. ${s.lead} Stunden vor der Rückkehr wird vorgeheizt.`,
    data: { haus: 'Venediger', abwesend_von: start, abwesend_bis: endIso, vorlauf_stunden: s.lead },
  };
}

/** „Ich bin zurück“ – laufende Abwesenheiten enden jetzt (wie backNow). Künftige Einträge bleiben. */
export async function zurueck(): Promise<Result> {
  const nowIso = new Date().toISOString();
  const { data, error } = await db.from('presence_periods').select('id').lt('start_at', nowIso).gt('end_at', nowIso);
  if (error) throw error;
  if (!data?.length) return { text: `${prefix('ven')}Es läuft gerade keine Abwesenheit, das Haus gilt schon als bewohnt.`, data: { geaendert: 0 } };
  const { error: e2 } = await db.from('presence_periods').update({ end_at: nowIso, updated_at: nowIso }).in('id', data.map((p: any) => p.id));
  if (e2) throw e2;
  return { text: `${prefix('ven')}Willkommen zurück. Das Haus gilt ab jetzt als bewohnt und wird normal geheizt.`, data: { geaendert: data.length } };
}

// ----------------------------------------------------------------- Schreiben: Raum stellen / automatisch
async function venSetTemp(room: Room, temp: number, until: string) {
  const mode = (await sysSetting('tuya_control_mode'))?.mode ?? 'cloud';
  if (mode === 'local') {
    const { error } = await db.from('thermostat_commands').insert({ room_id: room.id, command: 'set_temp', value: temp, status: 'pending' });
    if (error) throw error;
  } else {
    if (!room.tuya_device_id) throw new Error(`Raum ${room.name} hat kein Thermostat`);
    const res = await tuyaFetch(`${SUPABASE_URL}/functions/v1/tuya-control/set-temp`, {
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

export async function raumStellen(a: { raum?: unknown; haus?: unknown; temperatur?: unknown; stufe?: unknown; dauer_minuten?: unknown; bis?: unknown }): Promise<Result> {
  const res = await resolveRoom(a.raum, a.haus, true);
  if (!res.ok) return res.result;
  const { house, room: r } = res.hits[0];
  const lo = house === 'muc' ? Math.max(HARD_MIN, Number(r.min_temp ?? HARD_MIN)) : HARD_MIN;
  const hi = house === 'muc' ? Math.min(HARD_MAX, Number(r.max_temp ?? HARD_MAX)) : HARD_MAX;
  const asked = a.temperatur != null && a.temperatur !== '' && !Number.isNaN(Number(a.temperatur)) ? Number(a.temperatur) : null;
  const stufe = String(a.stufe ?? '').toLowerCase();
  const fallback = house === 'muc'
    ? (stufe === 'normal' ? r.temp_normal : (r.temp_pv ?? r.temp_normal))
    : (stufe === 'eco' ? r.eco_temp : r.comfort_temp);
  const wanted = asked ?? Number(fallback ?? 22);
  const clamped = Math.min(hi, Math.max(lo, wanted));
  const target = Math.round(clamped * 2) / 2;

  let untilMs: number;
  const bisIso = parseWhen(a.bis, '22:00');
  if (bisIso) untilMs = new Date(bisIso).getTime();
  else {
    const m = Number(a.dauer_minuten);
    untilMs = Date.now() + (Number.isFinite(m) && m > 0 ? m : DEFAULT_MIN) * 60000;
  }
  const capped = untilMs > Date.now() + MAX_MIN * 60000;
  untilMs = Math.min(untilMs, Date.now() + MAX_MIN * 60000);
  if (untilMs <= Date.now() + 5 * 60000) return { text: `${prefix(house)}Die Endzeit liegt in der Vergangenheit. Bis wann soll ${say(r.name)} so bleiben?`, frage: true };
  const until = new Date(untilMs).toISOString();

  let warn = '';
  if (house === 'muc') {
    const s = await mucSettings();
    const { error } = await db.from('muc_rooms').update({ override_temp: target, override_until: until }).eq('id', r.id);
    if (error) throw error;
    await mucLog(r.id, target, `Alexa+: ${r.name} auf ${num(target)} °C bis ${uhr(until)}`);
    warn = mucWarnings(s);
  } else {
    await venSetTemp(r, target, until);
  }
  let t = `${prefix(house)}Okay, ${say(r.name)} steht auf ${grad(target)} bis ${bisWann(until)}.`;
  if (asked != null && clamped !== asked) {
    t += asked > clamped ? ` Mehr als ${grad(hi)} ist für diesen Raum nicht erlaubt.` : ` Weniger als ${grad(lo)} ist für diesen Raum nicht erlaubt.`;
  }
  if (capped) t += ' Länger als zwölf Stunden geht nicht.';
  if (house === 'muc' && !warn) t += ' Loxone übernimmt es in etwa einer Minute.';
  return { text: t + warn, data: { haus: HOUSE_NAME[house], raum: r.name, temperatur: target, bis: until, begrenzt: asked != null && clamped !== asked } };
}

async function clearOverride(h: House, ids: string[]) {
  const { error } = h === 'muc'
    ? await db.from('muc_rooms').update({ override_temp: null, override_until: null }).in('id', ids)
    : await db.from('rooms').update({ manual_override_until: null }).in('id', ids);
  if (error) throw error;
}

export async function raumAutomatisch(raumName: unknown, haus: unknown): Promise<Result> {
  const res = await resolveRoom(raumName, haus, true);
  if (!res.ok) return res.result;
  const { house, room } = res.hits[0];
  if (!overridden(house, room)) return { text: `${prefix(house)}${say(room.name)} läuft bereits automatisch.`, data: { haus: HOUSE_NAME[house], raum: room.name, geaendert: false } };
  await clearOverride(house, [room.id]);
  if (house === 'muc') await mucLog(room.id, null, `Alexa+: Übersteuerung ${room.name} beendet`);
  return { text: `${prefix(house)}Okay, ${say(room.name)} läuft wieder automatisch.`, data: { haus: HOUSE_NAME[house], raum: room.name, geaendert: true } };
}

export async function alleAutomatisch(haus: unknown, bestaetigt: unknown): Promise<Result> {
  const h = houseOf(haus);
  if (h == null) return { text: 'In welchem Haus sollen alle Räume wieder automatisch laufen: München, Venediger oder beide?', frage: true };
  if (h === 'beide' && bestaetigt !== true) {
    return { text: 'Soll ich wirklich in beiden Häusern alle manuellen Einstellungen beenden?', frage: true, data: { bestaetigung_noetig: true } };
  }
  const out: string[] = [];
  const changed: Record<string, string[]> = {};
  for (const x of h === 'beide' ? HOUSES : [h]) {
    const manual = (await loadRooms(x)).filter((r) => overridden(x, r));
    changed[HOUSE_NAME[x]] = manual.map((r) => r.name);
    if (!manual.length) { out.push(`${prefix(x)}Es ist kein Raum manuell gestellt.`); continue; }
    await clearOverride(x, manual.map((r) => r.id));
    if (x === 'muc') await mucLog(null, null, `Alexa+: alle Übersteuerungen beendet (${manual.map((r) => r.name).join(', ')})`);
    out.push(`${prefix(x)}Okay, ${manual.length === 1 ? 'ein Raum läuft' : `${manual.length} Räume laufen`} wieder automatisch.`);
  }
  return { text: out.join(' '), data: changed };
}

export async function automatikMuenchen(an: unknown, bestaetigt: unknown): Promise<Result> {
  if (typeof an !== 'boolean') {
    const s = await mucSettings();
    return { text: `${prefix('muc')}Die Automatik ist ${s.automation_enabled ? 'an' : 'aus'}.${s.dry_run ? ' Der Testmodus ist an.' : ''}`, data: { automatik: s.automation_enabled, testmodus: s.dry_run } };
  }
  if (an === false && bestaetigt !== true) {
    return {
      text: `${prefix('muc')}Wenn die Automatik aus ist, regelt Loxone nur noch mit den eigenen Werten, PV-Überschuss wird nicht mehr genutzt. Soll ich sie wirklich ausschalten?`,
      frage: true, data: { bestaetigung_noetig: true },
    };
  }
  const { error } = await db.from('muc_settings').update({ automation_enabled: an }).eq('id', 1);
  if (error) throw error;
  await mucLog(null, null, `Alexa+: Automatik ${an ? 'eingeschaltet' : 'ausgeschaltet'}`);
  return {
    text: an ? `${prefix('muc')}Okay, die Automatik ist wieder an.` : `${prefix('muc')}Okay, die Automatik ist aus. Loxone regelt jetzt mit den eigenen Werten.`,
    data: { automatik: an },
  };
}
