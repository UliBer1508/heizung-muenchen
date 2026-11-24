// Meine Heizung – MCP-Server für Alexa+ (München und Venediger) · Routing und MCP-Protokoll
//
// Konzept: Projekt-Doc konzept-alexa-plus-mcp.md, Anleitung: doc/ALEXA-PLUS.md
// Alexa+ ist der MCP-Client (Streamable HTTP, JSON-RPC 2.0). Dieser Server liefert Tools; Alexa+ versteht die Sprache,
// wählt die Tools und formuliert die Antwort. Zahlen und Schaltwege kommen nur von hier (heizung.ts).
//
// Wege (die Function liegt unter …/functions/v1/mcp-heizung, öffentlich über MCP_PUBLIC_BASE, z. B. die Vercel-App):
//   POST /mcp                                     MCP-Endpunkt (Bearer-Token Pflicht; 401 ohne WWW-Authenticate)
//   GET  /.well-known/oauth-protected-resource    RFC 9728
//   GET  /.well-known/oauth-authorization-server  RFC 8414
//   GET  /oauth/authorize   POST /oauth/token     OAuth 2.1 (oauth.ts)
//   GET  /oauth/request     POST /oauth/approve   Bestätigungsseite in der Heizungs-App (?alexa=…)
//
// Secrets (Supabase → Edge Functions → Secrets):
//   MCP_CLIENT_ID, MCP_CLIENT_SECRET   frei gewählt, dieselben Werte im Alexa+-Add-on
//   MCP_ALLOWED_EMAILS                 Konten, die verknüpfen dürfen (Ulis Login der Heizungs-App)
//   MCP_APP_URL                        Heizungs-App München, z. B. https://<deine-app>.vercel.app
//   MCP_PUBLIC_BASE                    öffentliche Basis-Adresse (Standard: die Function-URL)
//   MCP_REDIRECT_HOSTS                 optional: weitere erlaubte Rücksprung-Hosts
//
// Bereitstellen OHNE Supabase-JWT-Prüfung (Alexa+ schickt eigene Tokens):
//   supabase functions deploy mcp-heizung --no-verify-jwt

import * as O from './oauth.ts';
import { TOOL_BY_NAME, toolList } from './tools.ts';

const SUPABASE_URL = (Deno.env.get('SUPABASE_URL') ?? '').replace(/\/$/, '');
const FN_BASE = `${SUPABASE_URL}/functions/v1/mcp-heizung`;
const BASE = () => (Deno.env.get('MCP_PUBLIC_BASE') ?? '').trim().replace(/\/$/, '') || FN_BASE;
const RESOURCES = () => [...new Set([`${BASE()}/mcp`, `${FN_BASE}/mcp`])];

const PROTOCOLS = ['2025-11-25', '2025-06-18', '2025-03-26'];
const SERVER_INFO = { name: 'meine-heizung', title: 'Meine Heizung', version: '1.0.0' };
const INSTRUCTIONS = [
  'Heizungen von Uli in zwei Häusern: München (Wärmepumpe, Fußbodenheizung, Loxone) und Venediger in Neukirchen am Großvenediger, Österreich (Thermostate).',
  'Antworte auf Deutsch und übernimm Zahlen, Uhrzeiten und den Hausnamen genau aus dem Text der Tools. Rechne nichts selbst.',
  'Ist bekannt, wo das Echo steht, setze haus entsprechend. Sonst weglassen; der Server erkennt eindeutige Räume (z. B. „Bad Uli“ nur in Venediger) und fragt sonst nach.',
  'Hat ein Ergebnis rueckfrage=true, stelle dem Nutzer genau diese Frage und rufe das Tool danach mit der Antwort erneut auf.',
  'Schalte nichts ohne Tool. Einstellungen, Testmodus und KI-Vorschläge werden nur in der App geändert.',
].join(' ');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type, apikey, x-client-info',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};
const json = (body: unknown, status = 200, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...extra } });
const withCors = async (p: Promise<Response>) => {
  const r = await p;
  const h = new Headers(r.headers);
  for (const [k, v] of Object.entries(CORS)) h.set(k, v);
  return new Response(r.body, { status: r.status, headers: h });
};

// ----------------------------------------------------------------- JSON-RPC
type Rpc = { jsonrpc: '2.0'; id?: string | number | null; method: string; params?: any };
const ok = (id: Rpc['id'], result: unknown) => ({ jsonrpc: '2.0', id, result });
const err = (id: Rpc['id'], code: number, message: string) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });

async function handle(msg: Rpc, who: O.Who): Promise<object | null> {
  if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return err(msg?.id, -32600, 'Invalid Request');
  const isNote = msg.id === undefined || msg.method.startsWith('notifications/');
  switch (msg.method) {
    case 'initialize': {
      const asked = msg.params?.protocolVersion;
      return ok(msg.id, {
        protocolVersion: PROTOCOLS.includes(asked) ? asked : PROTOCOLS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: INSTRUCTIONS,
      });
    }
    case 'ping': return ok(msg.id, {});
    case 'tools/list': return ok(msg.id, { tools: toolList() });
    case 'tools/call': {
      if (who.service || !who.user_id) return err(msg.id, -32001, 'Für Tools ist die Kontoverknüpfung nötig');
      const name = msg.params?.name;
      const tool = TOOL_BY_NAME.get(name);
      if (!tool) return err(msg.id, -32602, `Unbekanntes Tool: ${name}`);
      const t0 = Date.now();
      try {
        const r = await tool.run(msg.params?.arguments ?? {});
        console.log(`tool ${name} ${Date.now() - t0} ms`, JSON.stringify(msg.params?.arguments ?? {}));
        return ok(msg.id, {
          content: [{ type: 'text', text: r.text }],
          structuredContent: { text: r.text, rueckfrage: !!r.frage, ergebnis: r.data ?? null },
          isError: !!r.fehler,
        });
      } catch (e) {
        console.error(`tool ${name} Fehler nach ${Date.now() - t0} ms:`, e);
        return ok(msg.id, {
          content: [{ type: 'text', text: 'Da ist etwas schiefgegangen. Ich komme gerade nicht an die Heizungsdaten.' }],
          isError: true,
        });
      }
    }
    default:
      if (isNote) return null; // notifications/initialized, notifications/cancelled …
      return err(msg.id, -32601, `Methode nicht unterstützt: ${msg.method}`);
  }
}

async function mcp(req: Request): Promise<Response> {
  if (req.method !== 'POST') return new Response('Method Not Allowed', { status: 405, headers: { Allow: 'POST' } });
  const who = await O.bearer(req);
  // 401 bewusst OHNE WWW-Authenticate (unterstützt Alexa+ nicht)
  if (!who) return json({ error: 'invalid_token' }, 401);
  let body: any;
  try { body = await req.json(); } catch { return json(err(null, -32700, 'Parse error'), 400); }
  const msgs: Rpc[] = Array.isArray(body) ? body : [body];
  const out = (await Promise.all(msgs.map((m) => handle(m, who)))).filter(Boolean);
  if (!out.length) return new Response(null, { status: 202 });
  return json(Array.isArray(body) ? out : out[0]);
}

// ----------------------------------------------------------------- Routing
export async function route(req: Request): Promise<Response> {
  const url = new URL(req.url);
  // Supabase liefert /mcp-heizung/…, über Vercel kommt dasselbe an; beides abschneiden
  const path = url.pathname.replace(/^\/functions\/v1/, '').replace(/^\/mcp-heizung/, '').replace(/\/$/, '') || '/';
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

  if (path === '/mcp') return mcp(req);
  if (path.startsWith('/.well-known/oauth-protected-resource')) return json(O.protectedResourceMetadata(BASE()));
  if (path.startsWith('/.well-known/oauth-authorization-server')) return json(O.authServerMetadata(BASE()));
  if (path === '/oauth/authorize') return O.authorize(url, BASE(), RESOURCES());
  if (path === '/oauth/token') return O.token(req, RESOURCES());
  if (path === '/oauth/request') return withCors(O.requestInfo(req, url));
  if (path === '/oauth/approve' && req.method === 'POST') return withCors(O.approve(req));
  if (path === '/' && req.method === 'GET') {
    return new Response(`Meine Heizung – MCP-Server für Alexa+ (München und Venediger)\nMCP: ${BASE()}/mcp\n`, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  }
  return new Response('Not Found', { status: 404 });
}


