// Uhrzeit der Sicherung je PC ändern (24.11.2026) – übernommen aus Heizung Venediger
// (src/components/settings/BackupUhrzeit.tsx, SQL 55, Dienste-Wächter v1.1).
// Uli: „Ich ändere die Zeit und drücke den Button, der die Änderung ausführt.“
// Weg: Befehl service_commands (action 'backup_time', param 'HH:MM') → Dienste-Wächter des PCs holt ihn ab (≤ 30 s),
// stellt die geplante Aufgabe „Supabase-Sicherung Heizung“ um und meldet den nächsten Lauf zurück.
// Schreibt außerhalb der muc_-Tabellen nur diesen einen Befehl (wie Start/Stop im Systemstatus). Doku: doc/DATENSICHERUNG.md
import { useCallback, useEffect, useState } from 'react';
import { supabase } from './supabase.js';

const TIME_RE = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;
const zweistellig = (t) => {
  const m = String(t ?? '').match(/^(\d{1,2}):(\d{2})/);
  return m ? `${m[1].padStart(2, '0')}:${m[2]}` : '';
};
const wann = (iso) => new Date(iso).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Berlin' });
const versionOk = (v) => {
  const [a, b] = String(v ?? '0').split('.').map(Number);
  return a > 1 || (a === 1 && (b || 0) >= 1);
};

/** backupHost = Rechnername aus backup_runs (z. B. MINIPC-WEIDMANN, von Windows auf 15 Zeichen gekürzt) */
export default function BackupUhrzeit({ backupHost, aktuell }) {
  const [host, setHost] = useState(null);
  const [admin, setAdmin] = useState(false);
  const [cmd, setCmd] = useState(null);
  const [zeit, setZeit] = useState(zweistellig(aktuell));
  const [fehler, setFehler] = useState(null);
  const [busy, setBusy] = useState(false);

  const laden = useCallback(async () => {
    if (!backupHost) return;
    const [h, a] = await Promise.all([
      supabase.from('system_hosts').select('host,label,last_seen,agent_version,info'),
      supabase.rpc('is_system_admin'),
    ]);
    const key = backupHost.toUpperCase();
    const found = (h.data || []).find((x) => x.host !== 'cloud' && String(x.info?.computer ?? '').toUpperCase().startsWith(key)) || null;
    setHost(found);
    setAdmin(a.data === true);
    if (found) {
      const { data } = await supabase.from('service_commands').select('id,status,result,param,created_at,executed_at')
        .eq('host', found.host).eq('action', 'backup_time').order('created_at', { ascending: false }).limit(1);
      setCmd(data?.[0] || null);
    }
  }, [backupHost]);

  useEffect(() => { laden(); }, [laden]);
  const offen = cmd && (cmd.status === 'pending' || cmd.status === 'running');
  useEffect(() => {
    if (!offen) return undefined;
    const t = setInterval(laden, 3000);
    return () => clearInterval(t);
  }, [offen, laden]);
  useEffect(() => { setZeit(zweistellig(aktuell)); }, [aktuell]);

  if (!backupHost) return null;
  const online = host?.last_seen && Date.now() - new Date(host.last_seen).getTime() < 10 * 60000;
  const grund = !host ? 'Dienste-Wächter dieses PCs nicht gefunden'
    : !versionOk(host.agent_version) ? `Dienste-Wächter ${host.agent_version ?? '?'} – für die Uhrzeit wird v1.1 gebraucht`
      : !online ? 'PC meldet sich gerade nicht'
        : !admin ? 'nur mit Admin-Anmeldung' : null;
  const gueltig = TIME_RE.test(zeit);

  const ausfuehren = async () => {
    if (!host || !gueltig) return;
    setBusy(true); setFehler(null);
    const { data: { user } } = await supabase.auth.getUser();
    const { error } = await supabase.from('service_commands').insert({
      host: host.host, service_name: 'backup', action: 'backup_time', param: zeit, requested_by: user?.id,
    });
    if (error) setFehler(/row-level security/.test(error.message) ? 'Nicht erlaubt – läuft schon eine Änderung?' : error.message);
    await laden();
    setBusy(false);
  };

  return (
    <div className="voll sich-uhrzeit">
      <div className="sich-uhrzeit-zeile">
        <input type="time" value={zeit} onChange={(e) => setZeit(e.target.value)} aria-label="Neue Uhrzeit" disabled={!!grund} />
        <button className="btn primary small" onClick={ausfuehren}
          disabled={!!grund || !gueltig || busy || !!offen || zeit === zweistellig(aktuell)}>
          {offen ? 'wird geändert …' : 'Uhrzeit ändern'}
        </button>
      </div>
      {grund && <div className="muted small">{grund}</div>}
      {fehler && <div className="small" style={{ color: 'var(--rose)' }}>{fehler}</div>}
      {cmd && !offen && (
        <div className={`small ${cmd.status === 'done' ? 'good-text' : ''}`} style={cmd.status === 'done' ? undefined : { color: 'var(--sun)' }}>
          {cmd.status === 'done' ? '✓' : '✗'} {wann(cmd.executed_at || cmd.created_at)}: {cmd.result || cmd.status}
        </div>
      )}
    </div>
  );
}
