// Kleine In-Memory-Nachbildung des Supabase-Clients für die Tests von mcp-heizung (nur die benutzten Methoden).
type Row = Record<string, any>;

export function fakeDb(tables: Record<string, Row[]>, rpcs: Record<string, (args: any) => any> = {}, users: Record<string, Row> = {}) {
  const t = (name: string) => (tables[name] ??= []);
  function builder(name: string) {
    let op: 'select' | 'insert' | 'update' | 'delete' = 'select';
    let payload: any = null;
    const filters: ((r: Row) => boolean)[] = [];
    let orderBy: { col: string; asc: boolean } | null = null;
    let lim: number | null = null;
    let one: 'single' | 'maybe' | null = null;
    const run = () => {
      let rows = t(name).filter((r) => filters.every((f) => f(r)));
      if (op === 'insert') {
        const list = Array.isArray(payload) ? payload : [payload];
        for (const p of list) {
          if (name === 'muc_mcp_oauth' && t(name).some((r) => r.id === p.id)) return { data: null, error: { message: 'duplicate' } };
          t(name).push({ id: p.id ?? crypto.randomUUID(), ts: new Date().toISOString(), ...p });
        }
        return { data: null, error: null };
      }
      if (op === 'update') { rows.forEach((r) => Object.assign(r, payload)); return { data: null, error: null }; }
      if (op === 'delete') { tables[name] = t(name).filter((r) => !rows.includes(r)); return { data: null, error: null }; }
      if (orderBy) {
        const { col, asc } = orderBy;
        rows = [...rows].sort((a, b) => (a[col] > b[col] ? 1 : a[col] < b[col] ? -1 : 0) * (asc ? 1 : -1));
      }
      if (lim != null) rows = rows.slice(0, lim);
      if (one === 'single') return rows.length ? { data: rows[0], error: null } : { data: null, error: { message: 'no rows' } };
      if (one === 'maybe') return { data: rows[0] ?? null, error: null };
      return { data: rows, error: null };
    };
    const b: any = {
      select: () => b,
      insert: (p: any) => { op = 'insert'; payload = p; return b; },
      update: (p: any) => { op = 'update'; payload = p; return b; },
      delete: () => { op = 'delete'; return b; },
      eq: (c: string, v: any) => { filters.push((r) => r[c] === v); return b; },
      in: (c: string, v: any[]) => { filters.push((r) => v.includes(r[c])); return b; },
      gt: (c: string, v: any) => { filters.push((r) => r[c] > v); return b; },
      gte: (c: string, v: any) => { filters.push((r) => r[c] >= v); return b; },
      lt: (c: string, v: any) => { filters.push((r) => r[c] < v); return b; },
      order: (col: string, o?: { ascending?: boolean }) => { orderBy = { col, asc: o?.ascending !== false }; return b; },
      limit: (n: number) => { lim = n; return b; },
      range: (_a: number, z: number) => { lim = z + 1; return b; },
      single: () => { one = 'single'; return b; },
      maybeSingle: () => { one = 'maybe'; return b; },
      then: (res: any, rej: any) => Promise.resolve(run()).then(res, rej),
    };
    return b;
  }
  return {
    tables,
    from: builder,
    rpc: (fn: string, args: any) => Promise.resolve({ data: rpcs[fn] ? rpcs[fn](args) : null, error: null }),
    auth: {
      getUser: (jwt: string) => Promise.resolve(users[jwt] ? { data: { user: users[jwt] }, error: null } : { data: { user: null }, error: { message: 'bad jwt' } }),
    },
  };
}
