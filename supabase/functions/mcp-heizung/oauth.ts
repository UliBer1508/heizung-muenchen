// OAuth 2.1 für das Alexa+-Add-on – klein, nur für Ulis Konto.
//
// Alexa+ (MCP Toolkit, Stand 11/2026) verlangt zwei Stufen:
//   Stufe 1  client_credentials       Alexa+ selbst: initialize, tools/list, Health-Check (Scope mcp:service, kein Refresh)
//   Stufe 2  authorization_code+PKCE  Kontoverknüpfung in der Alexa-App, für tools/call (Scopes mcp:tools mcp:resources)
// Keine Dynamic Client Registration: Client-ID und -Secret stehen als Secrets und werden im Add-on hinterlegt.
// Supabase Auth selbst kann kein client_credentials, deshalb dieser eigene Teil.
//
// Anmeldung: /oauth/authorize leitet auf die Heizungs-App München weiter (?alexa=<id>). Dort ist Uli ohnehin
// angemeldet und bestätigt mit einem Knopf. Die App ruft /oauth/approve mit ihrem Supabase-Token auf.
// Hier wird nie ein Passwort verarbeitet.
//
// Gespeichert wird nur der SHA-256-Hash jedes Codes/Tokens (Tabelle muc_mcp_oauth, nur service_role).

import { getDb } from './heizung.ts';

const env = (k: string, d = '') => (Deno.env.get(k) ?? d).trim();
export const CLIENT_ID = () => env('MCP_CLIENT_ID');
const CLIENT_SECRET = () => env('MCP_CLIENT_SECRET');
const ALLOWED_EMAILS = () => env('MCP_ALLOWED_EMAILS').toLowerCase().split(',').map((s) => s.trim()).filter(Boolean);
const APP_URL = () => env('MCP_APP_URL').replace(/\/$/, '');
// Erlaubte Rücksprung-Hosts (Amazon). Weitere per Secret MCP_REDIRECT_HOSTS (Komma).
const REDIRECT_HOSTS = () => [
  'amazon.com', 'amazon.de', 'amazon.co.uk', 'amazon.at', 'amazonalexa.com', 'amazon.dev', 'alexa.amazon.com',
  ...env('MCP_REDIRECT_HOSTS').split(',').map((s) => s.trim()).filter(Boolean),
];

export const ACCESS_TTL = 3600;          // 1 h
const REFRESH_TTL = 90 * 24 * 3600;      // 90 Tage
const CODE_TTL = 300;                    // 5 min
const REQUEST_TTL = 900;                 // 15 min für die Bestätigung in der App
const USER_SCOPES = ['mcp:tools', 'mcp:resources'];

// ----------------------------------------------------------------- Hilfen
const enc = new TextEncoder();
const b64url = (b: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export const randomToken = (bytes = 32) => b64url(crypto.getRandomValues(new Uint8Array(bytes)));
export async function sha256(s: string) { return b64url(await crypto.subtle.digest('SHA-256', enc.encode(s))); }
function safeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let x = 0;
  for (let i = 0; i < a.length; i++) x |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return x === 0;
}
const json = (body: unknown, status = 200, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...extra } });
const oauthError = (error: string, status = 400, description?: string) =>
  json({ error, ...(description ? { error_description: description } : {}) }, status);

export function redirectAllowed(uri: string): boolean {
  try {
    const u = new URL(uri);
    if (u.protocol !== 'https:') return false;
    return REDIRECT_HOSTS().some((h) => u.hostname === h || u.hostname.endsWith('.' + h));
  } catch { return false; }
}

// ----------------------------------------------------------------- Speicher
type Kind = 'request' | 'code' | 'access' | 'refresh';
async function put(kind: Kind, secret: string, ttl: number, data: Record<string, unknown>, user_id: string | null = null) {
  const { error } = await getDb().from('muc_mcp_oauth').insert({
    id: await sha256(secret), kind, user_id, data, expires_at: new Date(Date.now() + ttl * 1000).toISOString(),
  });
  if (error) throw error;
}
async function get(kind: Kind, secret: string) {
  if (!secret) return null;
  const { data } = await getDb().from('muc_mcp_oauth').select('*').eq('id', await sha256(secret)).eq('kind', kind).maybeSingle();
  if (!data || new Date(data.expires_at).getTime() <= Date.now()) return null;
  return data as { id: string; kind: Kind; user_id: string | null; data: any; expires_at: string };
}
async function del(id: string) { await getDb().from('muc_mcp_oauth').delete().eq('id', id); }
async function cleanup() { await getDb().from('muc_mcp_oauth').delete().lt('expires_at', new Date().toISOString()); }

// ----------------------------------------------------------------- Metadaten
export function authServerMetadata(base: string) {
  return {
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/oauth/token`,
    response_types_supported: ['code'],
    grant_types_supported: ['client_credentials', 'authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
    scopes_supported: ['mcp:service', ...USER_SCOPES],
  };
}
export function protectedResourceMetadata(base: string) {
  return {
    resource: `${base}/mcp`,
    authorization_servers: [base],
    scopes_supported: ['mcp:service', ...USER_SCOPES],
    bearer_methods_supported: ['header'],
    resource_name: 'Meine Heizung (München und Venediger)',
  };
}

// ----------------------------------------------------------------- /oauth/authorize
export async function authorize(url: URL, base: string, resources: string[]): Promise<Response> {
  const p = url.searchParams;
  const redirectUri = p.get('redirect_uri') ?? '';
  const state = p.get('state');
  if (!CLIENT_ID() || p.get('client_id') !== CLIENT_ID()) return oauthError('invalid_client', 401, 'unbekannte client_id');
  if (!redirectAllowed(redirectUri)) return oauthError('invalid_request', 400, 'redirect_uri nicht erlaubt');
  // ab hier Fehler per Rücksprung an Amazon
  const back = (error: string, desc: string) => {
    const u = new URL(redirectUri);
    u.searchParams.set('error', error); u.searchParams.set('error_description', desc);
    if (state) u.searchParams.set('state', state);
    return Response.redirect(u.toString(), 302);
  };
  if (p.get('response_type') !== 'code') return back('unsupported_response_type', 'nur code');
  if (p.get('code_challenge_method') !== 'S256' || !p.get('code_challenge')) return back('invalid_request', 'PKCE S256 erforderlich');
  const resource = p.get('resource');
  if (resource && !resources.includes(resource.replace(/\/$/, ''))) return back('invalid_target', 'unbekannte resource');
  const scope = (p.get('scope') ?? USER_SCOPES.join(' ')).split(/\s+/).filter((s) => USER_SCOPES.includes(s));
  if (!APP_URL()) return back('server_error', 'MCP_APP_URL fehlt');
  const id = randomToken(18);
  await put('request', id, REQUEST_TTL, {
    redirect_uri: redirectUri, state, code_challenge: p.get('code_challenge'), scope: (scope.length ? scope : USER_SCOPES).join(' '),
    resource: resource ?? `${base}/mcp`, client_id: CLIENT_ID(),
  });
  return Response.redirect(`${APP_URL()}/?alexa=${encodeURIComponent(id)}`, 302);
}

// ----------------------------------------------------------------- App-Seite „Alexa verknüpfen“
async function appUser(req: Request): Promise<{ id: string; email: string } | null> {
  const jwt = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
  if (!jwt) return null;
  const { data, error } = await getDb().auth.getUser(jwt);
  if (error || !data?.user) return null;
  return { id: data.user.id, email: (data.user.email ?? '').toLowerCase() };
}

/** GET /oauth/request?id=… – ist die Anfrage noch gültig? (für die Anzeige in der App) */
export async function requestInfo(req: Request, url: URL): Promise<Response> {
  const user = await appUser(req);
  if (!user) return json({ error: 'nicht angemeldet' }, 401);
  const r = await get('request', url.searchParams.get('id') ?? '');
  const erlaubt = ALLOWED_EMAILS().includes(user.email);
  return json({ gueltig: !!r, erlaubt, email: user.email, ziel: r ? new URL(r.data.redirect_uri).hostname : null });
}

/** POST /oauth/approve {id, erlauben} – Uli bestätigt in der App. Antwort: {redirect} */
export async function approve(req: Request): Promise<Response> {
  const user = await appUser(req);
  if (!user) return json({ error: 'nicht angemeldet' }, 401);
  let body: any = {};
  try { body = await req.json(); } catch { /* leer */ }
  const r = await get('request', String(body.id ?? ''));
  if (!r) return json({ error: 'Die Anfrage ist abgelaufen. Bitte die Verknüpfung in der Alexa-App neu starten.' }, 410);
  await del(r.id);
  const u = new URL(r.data.redirect_uri);
  if (r.data.state) u.searchParams.set('state', r.data.state);
  if (body.erlauben !== true) {
    u.searchParams.set('error', 'access_denied');
    return json({ redirect: u.toString() });
  }
  if (!ALLOWED_EMAILS().includes(user.email)) {
    console.warn('Alexa-Verknüpfung abgelehnt für', user.email);
    return json({ error: `Das Konto ${user.email} ist für Alexa nicht freigegeben (Secret MCP_ALLOWED_EMAILS).` }, 403);
  }
  const code = randomToken();
  await put('code', code, CODE_TTL, { ...r.data }, user.id);
  u.searchParams.set('code', code);
  console.log('Alexa-Verknüpfung bestätigt für', user.email);
  return json({ redirect: u.toString() });
}

// ----------------------------------------------------------------- /oauth/token
async function issue(user_id: string | null, scope: string, client_id: string, withRefresh: boolean) {
  const access = randomToken();
  await put('access', access, ACCESS_TTL, { scope, client_id, service: user_id == null }, user_id);
  const out: Record<string, unknown> = { access_token: access, token_type: 'Bearer', expires_in: ACCESS_TTL, scope };
  if (withRefresh) {
    const refresh = randomToken();
    await put('refresh', refresh, REFRESH_TTL, { scope, client_id }, user_id);
    out.refresh_token = refresh;
  }
  return out;
}

export async function token(req: Request, resources: string[]): Promise<Response> {
  if (req.method !== 'POST') return oauthError('invalid_request', 405, 'nur POST');
  if (new URL(req.url).search.includes('client_secret')) return oauthError('invalid_request', 400, 'keine Zugangsdaten in der URL');
  const ct = req.headers.get('Content-Type') ?? '';
  let p: URLSearchParams;
  if (ct.includes('application/json')) {
    const j = await req.json().catch(() => ({}));
    p = new URLSearchParams(Object.entries(j).map(([k, v]) => [k, String(v)]));
  } else p = new URLSearchParams(await req.text());

  // Client-Authentifizierung: Basic oder im Body
  let cid = p.get('client_id') ?? '', csec = p.get('client_secret') ?? '';
  const auth = req.headers.get('Authorization') ?? '';
  if (/^Basic\s+/i.test(auth)) {
    try {
      const [a, ...b] = atob(auth.replace(/^Basic\s+/i, '')).split(':');
      cid = decodeURIComponent(a); csec = decodeURIComponent(b.join(':'));
    } catch { return oauthError('invalid_client', 401); }
  }
  if (!CLIENT_ID() || !CLIENT_SECRET() || !safeEqual(cid, CLIENT_ID()) || !safeEqual(csec, CLIENT_SECRET())) {
    console.warn('token: falscher Client', cid);
    return oauthError('invalid_client', 401);
  }
  const resource = p.get('resource');
  if (resource && !resources.includes(resource.replace(/\/$/, ''))) return oauthError('invalid_target', 400, 'unbekannte resource');

  cleanup().catch(() => {});
  const grant = p.get('grant_type');
  if (grant === 'client_credentials') {
    const scope = p.get('scope') ?? 'mcp:service';
    if (scope.split(/\s+/).some((s) => s !== 'mcp:service')) return oauthError('invalid_scope', 400, 'nur mcp:service');
    return json(await issue(null, 'mcp:service', cid, false));
  }
  if (grant === 'authorization_code') {
    const c = await get('code', p.get('code') ?? '');
    if (!c) return oauthError('invalid_grant', 400, 'Code ungültig oder abgelaufen');
    await del(c.id); // nur einmal verwendbar
    if (c.data.client_id !== cid) return oauthError('invalid_grant', 400, 'falscher Client');
    if ((p.get('redirect_uri') ?? c.data.redirect_uri) !== c.data.redirect_uri) return oauthError('invalid_grant', 400, 'redirect_uri passt nicht');
    const verifier = p.get('code_verifier') ?? '';
    if (!verifier || (await sha256(verifier)) !== c.data.code_challenge) return oauthError('invalid_grant', 400, 'PKCE passt nicht');
    return json(await issue(c.user_id, c.data.scope, cid, true));
  }
  if (grant === 'refresh_token') {
    const r = await get('refresh', p.get('refresh_token') ?? '');
    if (!r || r.data.client_id !== cid) return oauthError('invalid_grant', 400, 'Refresh-Token ungültig');
    await del(r.id); // Rotation
    return json(await issue(r.user_id, r.data.scope, cid, true));
  }
  return oauthError('unsupported_grant_type');
}

// ----------------------------------------------------------------- Bearer prüfen (für /mcp)
const cache = new Map<string, { until: number; who: Who }>();
export type Who = { service: boolean; user_id: string | null; scope: string };
export async function bearer(req: Request): Promise<Who | null> {
  const t = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
  if (!t || t === req.headers.get('Authorization')) return null;
  const c = cache.get(t);
  if (c && c.until > Date.now()) return c.who;
  const row = await get('access', t);
  if (!row) return null;
  const who: Who = { service: !!row.data.service, user_id: row.user_id, scope: row.data.scope ?? '' };
  cache.set(t, { until: Math.min(Date.now() + 5 * 60000, new Date(row.expires_at).getTime()), who });
  if (cache.size > 200) cache.clear();
  return who;
}
