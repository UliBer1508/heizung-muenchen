// Prüft den Alexa+-MCP-Server „Meine Heizung“ von außen – so, wie Alexa+ ihn aufruft (doc/ALEXA-PLUS.md, Schritt 3).
// Läuft mit Node ≥ 18 auf jedem PC, z. B. dem Mini-PC:
//   node alexa-plus/pruefen.mjs https://<heizungs-app>.vercel.app <MCP_CLIENT_ID> <MCP_CLIENT_SECRET>
// Prüft: Metadaten, Anmeldung Stufe 1 (client_credentials), initialize, tools/list, Antwortzeiten (< 500 ms verlangt).
// Schaltet nichts.

const [base, id, secret] = process.argv.slice(2);
if (!base || !id || !secret) {
  console.log('Aufruf: node alexa-plus/pruefen.mjs <Basis-Adresse> <MCP_CLIENT_ID> <MCP_CLIENT_SECRET>');
  process.exit(1);
}
const B = base.replace(/\/$/, '');
let fehler = 0;
const ok = (t) => console.log('  ✓', t);
const nein = (t) => { fehler++; console.log('  ✗', t); };
async function timed(label, p) {
  const t0 = Date.now();
  const r = await p;
  const ms = Date.now() - t0;
  console.log(`  ${ms < 500 ? '·' : '!'} ${label}: ${ms} ms${ms >= 500 ? '  (über 500 ms – beim zweiten Lauf meist schneller)' : ''}`);
  return r;
}

console.log(`\nMeine Heizung – Prüfung von ${B}\n`);

console.log('1. Metadaten');
const as = await (await fetch(`${B}/.well-known/oauth-authorization-server`)).json().catch(() => null);
as?.token_endpoint ? ok(`Anmeldeserver: ${as.issuer}`) : nein('/.well-known/oauth-authorization-server fehlt (vercel.json?)');
const pr = await (await fetch(`${B}/.well-known/oauth-protected-resource`)).json().catch(() => null);
pr?.resource ? ok(`MCP-Adresse: ${pr.resource}`) : nein('/.well-known/oauth-protected-resource fehlt');

console.log('\n2. Ohne Anmeldung');
const anon = await fetch(`${B}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
anon.status === 401 && !anon.headers.get('www-authenticate') ? ok('401 ohne WWW-Authenticate') : nein(`erwartet 401, bekommen ${anon.status}`);

console.log('\n3. Anmeldung Stufe 1 (Alexa+ selbst)');
const tr = await timed('Token', fetch(as?.token_endpoint ?? `${B}/oauth/token`, {
  method: 'POST',
  headers: { Authorization: 'Basic ' + Buffer.from(`${id}:${secret}`).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ grant_type: 'client_credentials', scope: 'mcp:service', resource: pr?.resource ?? `${B}/mcp` }),
}));
const tok = await tr.json().catch(() => ({}));
tok.access_token ? ok(`Token erhalten (gültig ${tok.expires_in} s)`) : nein(`kein Token: ${JSON.stringify(tok)} – stimmen MCP_CLIENT_ID/SECRET?`);

if (tok.access_token) {
  const rpc = (method, params = {}) => fetch(`${B}/mcp`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${tok.access_token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  }).then((r) => r.json());
  console.log('\n4. MCP');
  const init = await timed('initialize', rpc('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'pruefen.mjs', version: '1' } }));
  init.result ? ok(`${init.result.serverInfo?.title} · Protokoll ${init.result.protocolVersion}`) : nein(JSON.stringify(init));
  const list = await timed('tools/list', rpc('tools/list'));
  list.result?.tools?.length ? ok(`${list.result.tools.length} Tools: ${list.result.tools.map((t) => t.name).join(', ')}`) : nein(JSON.stringify(list));
  const call = await rpc('tools/call', { name: 'status', arguments: {} });
  call.error?.code === -32001 ? ok('Tools nur nach Kontoverknüpfung (richtig)') : nein(`tools/call ohne Verknüpfung: ${JSON.stringify(call)}`);
}

console.log(fehler ? `\n${fehler} Fehler.\n` : '\nAlles in Ordnung. Weiter mit Schritt 4 (Add-on anlegen).\n');
process.exit(fehler ? 1 : 0);
