import { useCallback, useEffect, useState } from 'react';
import { supabase, configured } from './supabase.js';
import Overview from './Overview.jsx';
import History from './History.jsx';
import Settings from './Settings.jsx';
import Log from './Log.jsx';

const TABS = [
  { id: 'overview', label: 'Übersicht' },
  { id: 'history', label: 'Verlauf' },
  { id: 'log', label: 'Protokoll' },
  { id: 'settings', label: 'Einstellungen' },
];

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
          <span className="brand-mark" aria-hidden>◐</span>
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
      supabase.from('settings').select('*').eq('id', 1).single(),
      supabase.from('rooms').select('*').order('sort'),
      supabase.from('collector_status').select('*').eq('id', 1).single(),
      supabase.from('energy_readings').select('*').order('ts', { ascending: false }).limit(1),
      supabase.from('room_readings').select('*').order('ts', { ascending: false }).limit(50),
      supabase.from('decisions').select('*').order('ts', { ascending: false }).limit(100),
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
    return () => clearInterval(t);
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
          <span className="brand-mark" aria-hidden>◐</span>
          <div className="brand-title">Heizung München</div>
        </div>
        <nav className="tabs" role="tablist">
          {TABS.map((t) => (
            <button key={t.id} role="tab" aria-selected={tab === t.id} className={tab === t.id ? 'tab active' : 'tab'} onClick={() => setTab(t.id)}>
              {t.label}
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
