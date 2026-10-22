// Schlanker Supabase-Zugriff über die REST-Schnittstelle (PostgREST), ohne Zusatzpakete.
// Der Collector nutzt den service_role-Key – er bleibt nur auf dem Mini-PC in der .env.

export class Db {
  constructor({ url, key }) {
    this.enabled = Boolean(url && key);
    this.base = url ? `${url.replace(/\/$/, '')}/rest/v1` : '';
    this.headers = {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    };
  }

  async req(method, path, body, extraHeaders = {}) {
    if (!this.enabled) throw new Error('Supabase nicht konfiguriert');
    const res = await fetch(`${this.base}/${path}`, {
      method,
      headers: { ...this.headers, ...extraHeaders },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      const t = await res.text();
      throw new Error(`Supabase ${method} ${path.split('?')[0]}: ${res.status} ${t.slice(0, 200)}`);
    }
    const t = await res.text();
    return t ? JSON.parse(t) : null;
  }

  select(table, query = '') {
    return this.req('GET', `${table}?${query}`);
  }

  insert(table, rows) {
    return this.req('POST', table, rows, { Prefer: 'return=minimal' });
  }

  update(table, filter, patch) {
    return this.req('PATCH', `${table}?${filter}`, patch, { Prefer: 'return=minimal' });
  }

  delete(table, filter) {
    return this.req('DELETE', `${table}?${filter}`, undefined, { Prefer: 'return=minimal' });
  }
}
