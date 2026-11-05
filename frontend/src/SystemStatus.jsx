// Systemstatus – Symbol in der Kopfleiste + Fenster (05.11.2026)
// Gleiche Daten wie in der App Heizung Venediger (Supabase-Projekt ist dasselbe):
// Doku im Venediger-Repo: smartfox-insight-ai-selfhosted/doc/SYSTEMSTATUS-2026-11-05.md
//   - system_problems()      eine Problemliste (dieselbe, die die Mail auslöst)
//   - system_hosts/services  Dienste je PC, gemeldet vom Dienste-Wächter alle 30 s
//   - system_cloud_status()  Fronius-Daten, Thermostate Venediger, Cron, Function-Aufrufe
//   - service_commands       Start/Stop/Neustart – nur Admins (system_status_admins), Fernzugriff nur Start
import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { supabase } from './supabase.js';

const HOST_STALE_MS = 10 * 60 * 1000;

const fmtTime = (iso) =>
  iso ? new Date(iso).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '–';

function ago(iso) {
  if (!iso) return 'nie';
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return `vor ${s} s`;
  const m = Math.round(s / 60);
  if (m < 60) return `vor ${m} min`;
  const h = Math.round(m / 60);
  return h < 48 ? `vor ${h} h` : `seit ${fmtTime(iso)}`;
}

function useSystemStatus(open) {
  const [st, setSt] = useState({ ready: false, problems: [], hosts: [], services: [], commands: [], cloud: null, isAdmin: false, loadedAt: null });

  const load = useCallback(async () => {
    const prob = await supabase.rpc('system_problems');
    if (prob.error) { setSt((s) => ({ ...s, ready: false })); return; }
    if (!open) { setSt((s) => ({ ...s, ready: true, problems: prob.data || [], loadedAt: new Date() })); return; }
    const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const [h, sv, c, cl, adm] = await Promise.all([
      supabase.from('system_hosts').select('*').order('host'),
      supabase.from('system_services').select('*').order('label'),
      supabase.from('service_commands').select('*').gte('created_at', since).order('created_at', { ascending: false }).limit(50),
      supabase.rpc('system_cloud_status'),
      supabase.rpc('is_system_admin'),
    ]);
    setSt({
      ready: true, problems: prob.data || [], hosts: h.data || [], services: sv.data || [], commands: c.data || [],
      cloud: cl.data || null, isAdmin: adm.data === true, loadedAt: new Date(),
    });
  }, [open]);

  const pending = st.commands.filter((c) => c.status === 'pending' || c.status === 'running').length;
  useEffect(() => {
    load();
    const ms = open && pending > 0 ? 3000 : 30000;
    const t = setInterval(() => { if (document.visibilityState === 'visible') load(); }, ms);
    return () => clearInterval(t);
  }, [load, open, pending]);

  const send = async (host, name, action) => {
    const { data: { user } } = await supabase.auth.getUser();
    const { error } = await supabase.from('service_commands').insert({ host, service_name: name, action, requested_by: user?.id });
    await load();
    if (!error) return null;
    return /row-level security/.test(error.message)
      ? 'Nicht erlaubt (Fernzugriff nur starten, oder ein Befehl läuft schon).'
      : error.message;
  };
  return { ...st, reload: load, send };
}

const ServerIcon = () => (
  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <rect x="3" y="4" width="18" height="7" rx="2" /><rect x="3" y="13" width="18" height="7" rx="2" /><path d="M7 7.5h.01M7 16.5h.01" />
  </svg>
);

export default function SystemStatusButton() {
  const [open, setOpen] = useState(false);
  const st = useSystemStatus(open);
  if (!st.ready) return null;
  const n = st.problems.length;
  const label = n === 0 ? 'Alles läuft' : n === 1 ? '1 Problem' : `${n} Probleme`;
  return (
    <>
      <button className={n === 0 ? 'sys-btn' : 'sys-btn bad'} onClick={() => setOpen(true)} title={`Systemstatus: ${label}`} aria-label={`Systemstatus: ${label}`}>
        <ServerIcon />
        {n === 0 ? <span className="dot ok" /> : <span>{n}</span>}
      </button>
      {/* Portal an <body>: die Kopfleiste hat backdrop-filter – darin wäre position:fixed
          an die Kopfleiste gebunden und das Fenster läge hinter der Übersicht */}
      {open && createPortal(<SystemStatusDialog st={st} onClose={() => setOpen(false)} />, document.body)}
    </>
  );
}

export function SystemStatusDialog({ st, onClose }) {
  const [error, setError] = useState(null);
  const [busyPv, setBusyPv] = useState(false);
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const pcs = st.hosts.filter((h) => h.host !== 'cloud');
  const web = st.services.filter((s) => s.host === 'cloud');
  const act = async (svc, action) => {
    if (action === 'stop' && !window.confirm(`${svc.label} wirklich stoppen?`)) return;
    setError(await st.send(svc.host, svc.name, action));
  };
  const runPv = async () => {
    setBusyPv(true);
    const { error: e } = await supabase.functions.invoke('pv-automation', { body: { action: 'check' } });
    setError(e ? e.message : null);
    setBusyPv(false);
    st.reload();
  };

  return (
    <div className="sys-overlay" onClick={onClose}>
      <div className="sys-dialog card" role="dialog" aria-modal="true" aria-label="Systemstatus" onClick={(e) => e.stopPropagation()}>
        <div className="sys-head">
          <div>
            <div className="section-title">Systemstatus</div>
            <div className="muted small">Laufen alle Prozesse – auf den PCs und in der Cloud?</div>
          </div>
          <button className="btn ghost small" onClick={onClose} aria-label="Schließen">✕</button>
        </div>

        {st.problems.length === 0
          ? <div className="sys-ok">Alles läuft.</div>
          : <div className="alert">{st.problems.map((p) => <div key={p.key}><b>{p.area}:</b> {p.text}</div>)}</div>}
        {error && <div className="alert">{error}</div>}

        {pcs.length === 0 && <div className="muted small">Noch kein PC verbunden.</div>}

        {pcs.map((h) => {
          const stale = !h.last_seen || Date.now() - new Date(h.last_seen).getTime() > HOST_STALE_MS;
          return (
            <section key={h.host} className="sys-box">
              <div className="sys-box-head">
                <span>{h.label}</span>
                <span className={stale ? 'small warn-text' : 'small muted'}>
                  {stale ? `meldet sich nicht ${h.last_seen ? 'seit ' + fmtTime(h.last_seen) : ''}` : `meldet sich · ${ago(h.last_seen)}`}
                </span>
              </div>
              {st.services.filter((s) => s.host === h.host).map((s) => (
                <ServiceRow key={s.name} svc={s} stale={stale} isAdmin={st.isAdmin}
                  cmd={st.commands.find((c) => c.host === s.host && c.service_name === s.name)} onAction={(a) => act(s, a)} />
              ))}
            </section>
          );
        })}

        <section className="sys-box">
          <div className="sys-box-head"><span>Cloud</span></div>
          <CloudRows cloud={st.cloud} isAdmin={st.isAdmin} busyPv={busyPv} onRunPv={runPv} />
          {web.map((s) => (
            <Row key={s.name} tone={s.status === 'running' ? 'ok' : 'bad'} title={s.label} url={s.url}
              sub={`${s.status === 'running' ? 'erreichbar' : 'nicht erreichbar'}${s.detail ? ' · ' + s.detail : ''} · geprüft ${ago(s.updated_at)}`} />
          ))}
        </section>

        <div className="sys-foot muted small">
          <span>
            {st.isAdmin
              ? 'Start und Stop führt der Dienste-Wächter innerhalb von 30 s aus. Fernzugriff (Tailscale, Cloudflare) nur starten, nie stoppen.'
              : 'Ansehen. Steuern dürfen nur Admins.'}
            {st.loadedAt && ` Stand ${st.loadedAt.toLocaleTimeString('de-DE')}.`}
          </span>
          <button className="btn small" onClick={st.reload}>Aktualisieren</button>
        </div>
      </div>
    </div>
  );
}

function Row({ tone, title, sub, url, actions }) {
  return (
    <div className="sys-row">
      <span className={`dot ${tone}`} />
      <div className="sys-row-main">
        <div>{title}{url && <> <a className="muted" href={url} target="_blank" rel="noreferrer" aria-label="Öffnen">↗</a></>}</div>
        {sub && <div className="small muted">{sub}</div>}
      </div>
      {actions && <div className="sys-actions">{actions}</div>}
    </div>
  );
}

function ServiceRow({ svc, stale, isAdmin, cmd, onAction }) {
  const busy = cmd && (cmd.status === 'pending' || cmd.status === 'running');
  const recentFail = cmd && (cmd.status === 'failed' || cmd.status === 'expired') && Date.now() - new Date(cmd.created_at).getTime() < 15 * 60 * 1000;
  const tone = stale ? 'off' : svc.status === 'running' ? 'ok' : svc.intended_stop ? 'off' : svc.status === 'stopped' ? 'bad' : 'warn';
  const state = stale ? 'Zustand unbekannt (PC meldet sich nicht)'
    : svc.status === 'running' ? 'läuft'
    : svc.intended_stop ? `per App gestoppt · ${fmtTime(svc.status_since)}`
    : svc.status === 'stopped' ? `gestoppt seit ${fmtTime(svc.status_since)}` : 'Zustand unbekannt';
  const sub = busy
    ? `${cmd.action === 'start' ? 'wird gestartet' : cmd.action === 'stop' ? 'wird gestoppt' : 'wird neu gestartet'} …${cmd.status === 'pending' ? ' (wartet auf den PC)' : ''}`
    : recentFail ? <span className="warn-text">{state} · Befehl fehlgeschlagen: {cmd.result}</span> : state;

  let actions = null;
  if (svc.control === 'none') actions = <span className="muted" title="nur ansehen">🔒</span>;
  else if (isAdmin && !stale && !busy) {
    if (svc.status !== 'running') actions = <button className="btn small primary" onClick={() => onAction('start')}>Start</button>;
    else if (svc.control === 'full') actions = <>
      <button className="btn small" onClick={() => onAction('restart')}>Neustart</button>
      <button className="btn small" onClick={() => onAction('stop')}>Stop</button>
    </>;
    else actions = <span className="muted" title="Fernzugriff: nur starten">🔒</span>;
  }
  return <Row tone={tone} title={svc.label} sub={sub} url={svc.url} actions={actions} />;
}

function CloudRows({ cloud, isAdmin, busyPv, onRunPv }) {
  if (!cloud) return <Row tone="off" title="Lade …" />;
  const old = (iso, min) => !iso || Date.now() - new Date(iso).getTime() > min * 60000;
  const t = cloud.tuya || {};
  const partial = t.devices_ok != null && t.devices_configured != null && t.devices_ok < t.devices_configured;
  return (
    <>
      <Row tone={old(cloud.pv_automation_last, 15) ? 'bad' : 'ok'} title="Heizungsautomatik Venediger (pv-automation)"
        sub={`letzter Lauf ${ago(cloud.pv_automation_last)}`}
        actions={isAdmin && <button className="btn small" disabled={busyPv} onClick={onRunPv}>{busyPv ? '…' : 'Jetzt ausführen'}</button>} />
      <Row tone={old(cloud.last_energy, 15) ? 'bad' : 'ok'} title="Fronius-Daten Venediger" sub={`letzte Messung ${ago(cloud.last_energy)}`} />
      <Row tone={old(t.last_sync, 10) ? 'bad' : partial ? 'warn' : 'ok'} title="Thermostate Venediger"
        sub={`${t.devices_ok ?? '–'}/${t.devices_configured ?? '–'} erreichbar · letzte Meldung ${ago(t.last_sync)}${cloud.open_api_errors ? ` · ${cloud.open_api_errors} offene Gerätefehler` : ''}`} />
      {cloud.muc && (
        <Row tone={old(cloud.muc.last_seen, 10) ? 'bad' : cloud.muc.fenecon_ok === false || cloud.muc.loxone_ok === false ? 'warn' : 'ok'}
          title="Heizung München (Collector)"
          sub={`letzte Meldung ${ago(cloud.muc.last_seen)} · FENECON ${cloud.muc.fenecon_ok === false ? 'Fehler' : 'ok'} · Loxone ${cloud.muc.loxone_ok === false ? 'Fehler' : 'ok'}`} />
      )}
      <Row tone={cloud.cron.failed_24h > 0 ? 'warn' : 'ok'} title="Geplante Aufgaben (pg_cron)"
        sub={`${cloud.cron.jobs} Aufgaben · ${cloud.cron.runs_24h} Läufe in 24 h · ${cloud.cron.failed_24h ? `${cloud.cron.failed_24h} Fehler` : 'keine Fehler'}`} />
      <Row tone={cloud.net_2h.errors > 0 ? 'warn' : 'ok'} title="Function-Aufrufe (2 h)"
        sub={`${cloud.net_2h.ok} ok · ${cloud.net_2h.errors} Fehler${cloud.net_2h.timeouts ? ` · ${cloud.net_2h.timeouts} ohne Antwort (lange Läufe, meist harmlos)` : ''}`} />
    </>
  );
}
