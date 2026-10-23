import { useCallback, useEffect, useState } from 'react';
import { supabase, configured } from './supabase.js';
import Overview from './Overview.jsx';
import History from './History.jsx';
import Settings from './Settings.jsx';
import Log from './Log.jsx';

const ICONS = {
  overview: <path d="M3 11.5 12 4l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z" />,
  history: <path d="M4 19h16M6 16l4-5 3 3 5-7" />,
  log: <path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01" />,
  settings: <><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" /></>,
};

const TABS = [
  { id: 'overview', label: 'Übersicht' },
  { id: 'history', label: 'Verlauf' },
  { id: 'log', label: 'Protokoll' },
  { id: 'settings', label: 'Einstellungen' },
];

function TabIcon({ id }) {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {ICONS[id]}
    </svg>
  );
}

function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) setError('Anmeldung fehlgeschlagen. E-Mail oder Passwort prüfen.');
    setBusy(false);
  };
  return (
    <div className="login">
      <form className="card login-card" onSubmit={submit}>
        <div className="brand">
          <img className="brand-mark" src="/icon-192.png" alt="" />
          <div>
            <div className="brand-title">Heizung München</div>
            <div className="muted small">PV-gesteuerte Fußbodenheizung</div>
          </div>
        </div>
        <label>E-Mail<input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" required /></label>
        <label>Passwort<input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required /></label>
        {error && <div className="alert">{error}</div>}
        <button className="btn primary" disabled={busy}>{busy ? 'Anmelden …' : 'Anmelden'}</button>
      </form>
    </div>
  );
}

export function useLiveData(intervalMs = 30000) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const load = useCallback(async () => {
    const [settings, rooms, status, energy, roomReadings, decisions] = await Promise.all([
      supabase.from('muc_settings').select('*').eq('id', 1).single(),
      supabase.from('muc_rooms').select('*').order('sort'),
      supabase.from('muc_collector_status').select('*').eq('id', 1).single(),
      supabase.from('muc_energy_readings').select('*').order('ts', { ascending: false }).limit(1),
      supabase.from('muc_room_readings').select('*').order('ts', { ascending: false }).limit(50),
      supabase.from('muc_decisions').select('*').order('ts', { ascending: false }).limit(100),
    ]);
    const firstErr = [settings, rooms, status, energy, roomReadings, decisions].find((r) => r.error);
    if (firstErr) {
      setError(firstErr.error.message);
      return;
    }
    const latestByRoom = {};
    for (const r of roomReadings.data) if (!latestByRoom[r.room_id]) latestByRoom[r.room_id] = r;
    setError(null);
    setData({
      settings: settings.data,
      rooms: rooms.data,
      status: status.data,
      energy: energy.data[0] || null,
      latestByRoom,
      decisions: decisions.data,
      loadedAt: new Date(),
    });
  }, []);
  useEffect(() => {
    load();
    const t = setInterval(load, intervalMs);
    // App am Handy wieder geöffnet → sofort aktualisieren
    const onVisible = () => { if (document.visibilityState === 'visible') load(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', onVisible); };
  }, [load, intervalMs]);
  return { data, error, reload: load };
}

function Shell({ session }) {
  const [tab, setTab] = useState('overview');
  const live = useLiveData();
  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <img className="brand-mark" src="/icon-192.png" alt="" />
          <div className="brand-title">Heizung München</div>
        </div>
        <nav className="tabs" role="tablist">
          {TABS.map((t) => (
            <button key={t.id} role="tab" aria-selected={tab === t.id} className={tab === t.id ? 'tab active' : 'tab'}
              onClick={() => { setTab(t.id); window.scrollTo(0, 0); }}>
              <TabIcon id={t.id} />
              <span>{t.label}</span>
            </button>
          ))}
        </nav>
        <button className="btn ghost small" onClick={() => supabase.auth.signOut()} title={session.user.email}>Abmelden</button>
      </header>
      <main className="content">
        {live.error && <div className="alert">Daten konnten nicht geladen werden: {live.error}</div>}
        {!live.data && !live.error && <div className="muted">Lade …</div>}
        {live.data && tab === 'overview' && <Overview data={live.data} reload={live.reload} />}
        {live.data && tab === 'history' && <History rooms={live.data.rooms} />}
        {live.data && tab === 'log' && <Log data={live.data} />}
        {live.data && tab === 'settings' && <Settings data={live.data} reload={live.reload} />}
      </main>
    </div>
  );
}

export default function App() {
  const [session, setSession] = useState(undefined);
  useEffect(() => {
    if (!configured) return;
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => sub.subscription.unsubscribe();
  }, []);
  if (!configured) {
    return (
      <div className="login">
        <div className="card login-card">
          <div className="brand-title">Konfiguration fehlt</div>
          <p className="muted">VITE_SUPABASE_URL und VITE_SUPABASE_ANON_KEY sind nicht gesetzt (siehe frontend/.env.example).</p>
        </div>
      </div>
    );
  }
  if (session === undefined) return null;
  return session ? <Shell session={session} /> : <Login />;
}
