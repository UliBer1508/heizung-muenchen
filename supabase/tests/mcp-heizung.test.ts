// Tests für den Alexa+-MCP-Server (supabase/functions/mcp-heizung) – ohne echte Datenbank.
// Start:  deno test -A supabase/tests/mcp-heizung.test.ts
import nodeAssert from 'node:assert/strict';
const assert: (v: unknown, msg?: string) => asserts v = (v, msg) => nodeAssert.ok(v, msg);
const assertEquals = (a: unknown, b: unknown) => nodeAssert.deepStrictEqual(a, b);
const assertMatch = (s: string, re: RegExp) => nodeAssert.match(s, re);
const assertStringIncludes = (s: string, part: string) => nodeAssert.ok(s.includes(part), `„${part}“ fehlt in: ${s}`);
import { fakeDb } from './fake-db.ts';

Deno.env.set('SUPABASE_URL', 'https://ref.supabase.co');
Deno.env.set('SUPABASE_SERVICE_ROLE_KEY', 'test-key');
Deno.env.set('MCP_CLIENT_ID', 'alexa-client');
Deno.env.set('MCP_CLIENT_SECRET', 'geheim-123');
Deno.env.set('MCP_ALLOWED_EMAILS', 'uli@example.com');
Deno.env.set('MCP_APP_URL', 'https://heizung.example.app');
Deno.env.set('MCP_PUBLIC_BASE', 'https://heizung.example.app');

const H = await import('../functions/mcp-heizung/heizung.ts');
const { route } = await import('../functions/mcp-heizung/server.ts');

const BASE = 'https://heizung.example.app';
const inH = (h: number) => new Date(Date.now() + h * 3600_000).toISOString();
const agoMin = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

function world() {
  const tables: Record<string, any[]> = {
    muc_rooms: [
      { id: 'kg_bad', name: 'KG Bad', sort: 1, min_temp: 5, max_temp: 24, temp_normal: 21, temp_pv: 23 },
      { id: 'dg_bad', name: 'DG Bad', sort: 2, min_temp: 5, max_temp: 26, temp_normal: 21, temp_pv: 23 },
      { id: 'eg_wohn', name: 'EG Wohnzimmer', sort: 3, min_temp: 5, max_temp: 26, temp_normal: 22, temp_pv: 23 },
      { id: 'og_luis_bad', name: 'OG Luis Bad', sort: 4, min_temp: 5, max_temp: 26, temp_normal: 22, temp_pv: 23 },
    ],
    rooms: [
      { id: 'v1', name: 'Bad Uli', priority: 1, comfort_temp: 23, eco_temp: 22, current_temp: 21.5, target_temp: 22, is_heating: true, tuya_device_id: 'dev1', last_thermostat_sync: agoMin(2) },
      { id: 'v2', name: 'Wohnzimmer', priority: 2, comfort_temp: 23, eco_temp: 21, current_temp: 20.1, target_temp: 21, is_heating: false, tuya_device_id: 'dev2', last_thermostat_sync: agoMin(3) },
      { id: 'v3', name: 'Kinder Bad', priority: 3, comfort_temp: 23, eco_temp: 21, current_temp: 22, target_temp: 21, is_heating: false, tuya_device_id: 'dev3', last_thermostat_sync: agoMin(3) },
    ],
    muc_settings: [{ id: 1, automation_enabled: true, dry_run: false }],
    muc_collector_status: [{ id: 1, last_seen: agoMin(1), house_mode: 'TAG' }],
    muc_room_readings: [
      { room_id: 'kg_bad', ts: agoMin(2), temp: 20.4, target: 21, mode: 'NORMAL', valve: 1 },
      { room_id: 'eg_wohn', ts: agoMin(2), temp: 21.9, target: 22, mode: 'NORMAL', valve: 0 },
    ],
    muc_energy_readings: [{ ts: agoMin(1), pv_w: 4100, soc: 92, grid_w: -2500 }],
    muc_decisions: [],
    muc_ki_suggestions: [{ kind: 'hinweis', title: 'Wärmepumpe liefert keine Wärme', status: 'offen', created_at: agoMin(30) }],
    muc_ki_runs: [{ day: '2026-11-24', summary: 'Mo 23.11.: außen Ø 0,4 °C, Sonne 13,5 kWh.' }],
    system_settings: [{ key: 'tuya_control_mode', value: { mode: 'local' } }, { key: 'heating_day_mode', value: { mode: 'wait', computed_at: agoMin(5) } }],
    heating_settings: [{ presence_control_enabled: true, presence_lead_hours: 6, presence_departure_time: '11:00:00', presence_arrival_time: '14:00:00' }],
    presence_periods: [],
    thermostat_commands: [],
    energy_readings: [],
    muc_mcp_oauth: [],
  };
  const db = fakeDb(tables, {
    muc_day_kpis: () => [{ pv_kwh: 13.5, grid_out_kwh: 0.7, autarky_pct: 46, heat_grid_kwh: 12 }],
    muc_room_outlook: () => [{ room_id: 'kg_bad', predicted_morning: 19.83 }],
  }, { 'jwt-uli': { id: '11111111-1111-1111-1111-111111111111', email: 'uli@example.com' }, 'jwt-fremd': { id: '2', email: 'x@y.z' } });
  H._setDb(db);
  return { db, tables };
}

// ------------------------------------------------------------------ Raumerkennung
Deno.test('„Uli Bad“ findet Bad Uli in Venediger – Wortstellung egal', async () => {
  world();
  for (const s of ['Uli Bad', 'Bad Uli', 'Ulis Bad', 'Bad von Uli']) {
    const r = await H.resolveRoom(s, undefined, true);
    assert(r.ok, s);
    if (r.ok) { assertEquals(r.hits[0].house, 'ven'); assertEquals(r.hits[0].room.name, 'Bad Uli'); }
  }
});

Deno.test('„Luis Bad“ ist München, „Kinderbad“ Venediger', async () => {
  world();
  const a = await H.resolveRoom('Luis Bad', undefined, true);
  assert(a.ok && a.hits[0].room.id === 'og_luis_bad');
  const b = await H.resolveRoom('Kinderbad', undefined, true);
  assert(b.ok && b.hits[0].room.id === 'v3');
});

Deno.test('Wohnzimmer ohne Haus: Lesen beide Häuser, Schreiben Rückfrage', async () => {
  world();
  const r = await H.raum('Wohnzimmer', undefined);
  assertStringIncludes(r.text, 'München: Im EG Wohnzimmer');
  assertStringIncludes(r.text, 'Venediger: Im Wohnzimmer');
  const w = await H.raumStellen({ raum: 'Wohnzimmer', temperatur: 23 });
  assert(w.frage);
  assertStringIncludes(w.text, 'In welchem Haus');
});

Deno.test('„Bad“ in München ist mehrdeutig → Rückfrage nach dem Geschoss', async () => {
  world();
  const r = await H.raumStellen({ raum: 'Bad', haus: 'muenchen', temperatur: 22 });
  assert(r.frage);
  assertMatch(r.text, /^München: Meinst du KG Bad, DG Bad oder|^München: Meinst du KG Bad oder DG Bad/);
});

// ------------------------------------------------------------------ Schreiben
Deno.test('Uli Bad auf 22 Grad: Venediger, lokaler Tuya-Befehl, 2 h, Hausname vorn', async () => {
  const { tables } = world();
  const r = await H.raumStellen({ raum: 'Uli Bad', temperatur: 22 });
  assertMatch(r.text, /^Venediger: Okay, Bad Uli steht auf 22 Grad bis/);
  assertEquals(tables.thermostat_commands.length, 1);
  assertEquals(tables.thermostat_commands[0].value, 22);
  const v1 = tables.rooms.find((x) => x.id === 'v1');
  const h = (new Date(v1.manual_override_until).getTime() - Date.now()) / 3600_000;
  assert(h > 1.95 && h <= 2.01, `Dauer ${h}`);
});

Deno.test('München: Grenze je Raum, Protokoll alexa_plus, Testmodus-Hinweis', async () => {
  const { tables } = world();
  tables.muc_settings[0].dry_run = true;
  const r = await H.raumStellen({ raum: 'Bad im Keller', temperatur: 30, dauer_minuten: 900 });
  assertStringIncludes(r.text, 'München: Okay, KG Bad steht auf 24 Grad');
  assertStringIncludes(r.text, 'Mehr als 24 Grad');
  assertStringIncludes(r.text, 'zwölf Stunden');
  assertStringIncludes(r.text, 'Testmodus');
  const kg = tables.muc_rooms.find((x) => x.id === 'kg_bad');
  assertEquals(kg.override_temp, 24);
  assertEquals(tables.muc_decisions[0].kind, 'alexa_plus');
});

Deno.test('raum_automatisch und alle_automatisch (beide nur mit Bestätigung)', async () => {
  const { tables } = world();
  await H.raumStellen({ raum: 'Bad Uli', temperatur: 23 });
  await H.raumStellen({ raum: 'Bad im Keller', temperatur: 22 });
  const q = await H.alleAutomatisch('beide', undefined);
  assert(q.frage);
  const r = await H.alleAutomatisch('beide', true);
  assertStringIncludes(r.text, 'München: Okay, ein Raum läuft wieder automatisch');
  assertStringIncludes(r.text, 'Venediger: Okay, ein Raum läuft wieder automatisch');
  assertEquals(tables.rooms.find((x) => x.id === 'v1').manual_override_until, null);
  const again = await H.raumAutomatisch('Bad Uli', undefined);
  assertStringIncludes(again.text, 'läuft bereits automatisch');
});

Deno.test('Automatik München aus nur nach Bestätigung', async () => {
  const { tables } = world();
  const q = await H.automatikMuenchen(false, undefined);
  assert(q.frage);
  assertEquals(tables.muc_settings[0].automation_enabled, true);
  await H.automatikMuenchen(false, true);
  assertEquals(tables.muc_settings[0].automation_enabled, false);
});

// ------------------------------------------------------------------ Venediger Abwesenheit (Kalender = Abwesenheit)
Deno.test('Abwesenheit eintragen und zurück – neue Regel seit 01.11.2026', async () => {
  const { tables } = world();
  const d = new Date(Date.now() + 5 * 86400_000).toLocaleDateString('sv-SE', { timeZone: 'Europe/Berlin' });
  const r = await H.abwesenheitEintragen(undefined, d);
  assertStringIncludes(r.text, 'Venediger: Okay, abwesend ab jetzt bis');
  assertStringIncludes(r.text, '14:00 Uhr');
  assertEquals(tables.presence_periods.length, 1);
  const st = await H.anwesenheit();
  assertStringIncludes(st.text, 'gilt als leer');
  const z = await H.zurueck();
  assertStringIncludes(z.text, 'Willkommen zurück');
  const st2 = await H.anwesenheit();
  assertStringIncludes(st2.text, 'gilt als bewohnt');
});

Deno.test('Abwesenheit später: von Freitag bis Dienstag', async () => {
  const { tables } = world();
  const von = new Date(Date.now() + 3 * 86400_000).toLocaleDateString('sv-SE', { timeZone: 'Europe/Berlin' });
  const bis = new Date(Date.now() + 7 * 86400_000).toLocaleDateString('sv-SE', { timeZone: 'Europe/Berlin' });
  const r = await H.abwesenheitEintragen(von, bis);
  assertStringIncludes(r.text, '11:00 Uhr bis');
  const p = tables.presence_periods[0];
  assert(new Date(p.start_at).getTime() > Date.now() + 2 * 86400_000);
  const st = await H.anwesenheit();
  assertStringIncludes(st.text, 'gilt als bewohnt');
  assertStringIncludes(st.text, 'Nächste geplante Abwesenheit');
});

Deno.test('computePresence wie Venediger: Vorlauf vor Rückkehr', () => {
  const now = Date.now();
  const p = [{ start_at: new Date(now - 86400_000).toISOString(), end_at: new Date(now + 3 * 3600_000).toISOString() }];
  const s = H.computePresence(p, true, 6, now);
  assertEquals(s.away, false);
  assertEquals(s.inLead, true);
  const s2 = H.computePresence(p, true, 2, now);
  assertEquals(s2.away, true);
});

// ------------------------------------------------------------------ Lesen
Deno.test('Status und Energie nennen immer das Haus', async () => {
  world();
  const s = await H.status(undefined);
  assertMatch(s.text, /^München: .*Tagbetrieb.*KI-Hinweis: Wärmepumpe liefert keine Wärme.* Venediger: /);
  const e = await H.energie('muenchen');
  assertMatch(e.text, /^München: Die Sonne liefert gerade 4,1 Kilowatt, der Akku steht bei 92 Prozent\. Eingespeist werden 2,5 Kilowatt\./);
  assertStringIncludes(e.text, '95 Prozent selbst genutzt');
  const k = await H.raum('Keller Bad', 'muenchen');
  assertStringIncludes(k.text, 'morgen früh etwa 19,8 Grad');
});

// ------------------------------------------------------------------ OAuth + MCP über HTTP
const form = (o: Record<string, string>) => new URLSearchParams(o).toString();
const basic = 'Basic ' + btoa('alexa-client:geheim-123');
async function b64sha(s: string) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return btoa(String.fromCharCode(...new Uint8Array(d))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
const post = (path: string, body: string, headers: Record<string, string>) =>
  route(new Request(`https://ref.supabase.co/mcp-heizung${path}`, { method: 'POST', body, headers }));
const rpc = (tok: string, method: string, params: unknown = {}, id: number | undefined = 1) =>
  post('/mcp', JSON.stringify({ jsonrpc: '2.0', ...(id !== undefined ? { id } : {}), method, params }), { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' });

Deno.test('Metadaten (RFC 8414 / 9728) über Supabase-Pfad und Vercel-Pfad', async () => {
  world();
  for (const p of ['https://ref.supabase.co/mcp-heizung/.well-known/oauth-authorization-server', 'https://heizung.example.app/.well-known/oauth-authorization-server/x']) {
    const m = await (await route(new Request(p))).json();
    assertEquals(m.issuer, BASE);
    assertEquals(m.token_endpoint, `${BASE}/oauth/token`);
    assert(m.grant_types_supported.includes('client_credentials'));
    assertEquals(m.code_challenge_methods_supported, ['S256']);
  }
  const pr = await (await route(new Request('https://heizung.example.app/.well-known/oauth-protected-resource/mcp'))).json();
  assertEquals(pr.resource, `${BASE}/mcp`);
});

Deno.test('MCP ohne Token: 401 ohne WWW-Authenticate', async () => {
  world();
  const r = await post('/mcp', '{}', { 'Content-Type': 'application/json' });
  assertEquals(r.status, 401);
  assertEquals(r.headers.get('WWW-Authenticate'), null);
});

Deno.test('Stufe 1: client_credentials → initialize + tools/list, aber kein tools/call', async () => {
  world();
  const bad = await post('/oauth/token', form({ grant_type: 'client_credentials' }), { Authorization: 'Basic ' + btoa('alexa-client:falsch'), 'Content-Type': 'application/x-www-form-urlencoded' });
  assertEquals(bad.status, 401);
  const t = await (await post('/oauth/token', form({ grant_type: 'client_credentials', scope: 'mcp:service', resource: `${BASE}/mcp` }), { Authorization: basic, 'Content-Type': 'application/x-www-form-urlencoded' })).json();
  assertEquals(t.token_type, 'Bearer');
  assertEquals(t.refresh_token, undefined);
  const init = await (await rpc(t.access_token, 'initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'Alexa+' } })).json();
  assertEquals(init.result.protocolVersion, '2025-11-25');
  assertEquals((await rpc(t.access_token, 'notifications/initialized', {}, undefined)).status, 202);
  const list = await (await rpc(t.access_token, 'tools/list')).json();
  assertEquals(list.result.tools.length, 13);
  assert(list.result.tools.every((x: any) => x.inputSchema?.type === 'object' && x.description));
  const call = await (await rpc(t.access_token, 'tools/call', { name: 'status', arguments: {} })).json();
  assertEquals(call.error.code, -32001);
});

Deno.test('Stufe 2: Kontoverknüpfung über die App, PKCE, Tool-Aufruf, Refresh-Rotation', async () => {
  const { tables } = world();
  const verifier = 'v'.repeat(64);
  const challenge = await b64sha(verifier);
  const redirect = 'https://layla.amazon.com/api/skill/link/M123';
  const q = new URLSearchParams({ response_type: 'code', client_id: 'alexa-client', redirect_uri: redirect, state: 'xyz', code_challenge: challenge, code_challenge_method: 'S256', scope: 'mcp:tools mcp:resources', resource: `${BASE}/mcp` });
  // fremde redirect_uri wird abgelehnt
  const evil = new URLSearchParams(q); evil.set('redirect_uri', 'https://boese.example.com/cb');
  assertEquals((await route(new Request(`${BASE}/oauth/authorize?${evil}`))).status, 400);

  const a = await route(new Request(`${BASE}/oauth/authorize?${q}`));
  assertEquals(a.status, 302);
  const loc = new URL(a.headers.get('Location')!);
  assertEquals(loc.origin, 'https://heizung.example.app');
  const id = loc.searchParams.get('alexa')!;

  // App: fremdes Konto darf nicht
  const info = await (await route(new Request(`${BASE}/oauth/request?id=${id}`, { headers: { Authorization: 'Bearer jwt-fremd' } }))).json();
  assertEquals(info.erlaubt, false);
  const deny = await post('/oauth/approve', JSON.stringify({ id, erlauben: true }), { Authorization: 'Bearer jwt-uli', 'Content-Type': 'application/json' });
  const { redirect: back } = await deny.json();
  const bu = new URL(back);
  assertEquals(bu.searchParams.get('state'), 'xyz');
  const code = bu.searchParams.get('code')!;
  assert(code);
  // Code nur als Hash gespeichert
  assert(!tables.muc_mcp_oauth.some((r) => r.id === code));

  const wrongPkce = await post('/oauth/token', form({ grant_type: 'authorization_code', code, redirect_uri: redirect, code_verifier: 'falsch' }), { Authorization: basic, 'Content-Type': 'application/x-www-form-urlencoded' });
  assertEquals(wrongPkce.status, 400); // Code ist danach verbraucht – Alexa startet neu

  // neuer Durchlauf mit richtigem Verifier
  const a2 = await route(new Request(`${BASE}/oauth/authorize?${q}`));
  const id2 = new URL(a2.headers.get('Location')!).searchParams.get('alexa')!;
  const code2 = new URL((await (await post('/oauth/approve', JSON.stringify({ id: id2, erlauben: true }), { Authorization: 'Bearer jwt-uli' })).json()).redirect).searchParams.get('code')!;
  const tok = await (await post('/oauth/token', form({ grant_type: 'authorization_code', code: code2, redirect_uri: redirect, code_verifier: verifier }), { Authorization: basic, 'Content-Type': 'application/x-www-form-urlencoded' })).json();
  assert(tok.access_token && tok.refresh_token);
  assertEquals(tok.scope, 'mcp:tools mcp:resources');

  const call = await (await rpc(tok.access_token, 'tools/call', { name: 'raum_stellen', arguments: { raum: 'Uli Bad', temperatur: 22 } })).json();
  assertMatch(call.result.content[0].text, /^Venediger: Okay, Bad Uli steht auf 22 Grad/);
  assertEquals(call.result.structuredContent.ergebnis.raum, 'Bad Uli');
  assertEquals(call.result.isError, false);

  const ref = await (await post('/oauth/token', form({ grant_type: 'refresh_token', refresh_token: tok.refresh_token }), { Authorization: basic, 'Content-Type': 'application/x-www-form-urlencoded' })).json();
  assert(ref.access_token && ref.refresh_token !== tok.refresh_token);
  const reuse = await post('/oauth/token', form({ grant_type: 'refresh_token', refresh_token: tok.refresh_token }), { Authorization: basic, 'Content-Type': 'application/x-www-form-urlencoded' });
  assertEquals(reuse.status, 400);
});

Deno.test('Tool-Fehler werden als isError zurückgegeben, nicht als Absturz', async () => {
  const { db } = world();
  const t = await (await post('/oauth/token', form({ grant_type: 'client_credentials' }), { Authorization: basic, 'Content-Type': 'application/x-www-form-urlencoded' })).json();
  // Nutzer-Token direkt anlegen
  const tok = 'nutzer-token';
  await db.from('muc_mcp_oauth').insert({ id: await b64sha(tok), kind: 'access', user_id: 'u', data: { scope: 'mcp:tools', service: false }, expires_at: inH(1) });
  (db as any).tables.muc_rooms = null; // Lesefehler erzwingen
  H._setDb({ ...db, from: (n: string) => (n === 'muc_rooms' ? { select: () => { throw new Error('kaputt'); } } : db.from(n)) });
  const r = await (await rpc(tok, 'tools/call', { name: 'status', arguments: { haus: 'muenchen' } })).json();
  assertEquals(r.result.isError, true);
  assert(t.access_token);
});

Deno.test('Abwesenheit länger als 90 Tage wird nicht eingetragen', async () => {
  const { tables } = world();
  const bis = new Date(Date.now() + 120 * 86400_000).toLocaleDateString('sv-SE', { timeZone: 'Europe/Berlin' });
  const r = await H.abwesenheitEintragen(undefined, bis);
  assert(r.frage);
  assertEquals(tables.presence_periods.length, 0);
});
