// Einstellungen → „Datensicherung“ (13.11.2026, übernommen aus Heizung Venediger,
// src/components/settings/BackupSettingsSection.tsx + src/lib/backupStatus.ts).
//
// Die Münchner Tabellen (muc_*) liegen im selben Supabase-Projekt wie Venediger.
// Die nächtliche Sicherung (Backup-Supabase.ps1, Profil „Heizung“) sichert die
// GANZE Datenbank – München ist also immer mit drin. Diese Karte zeigt nur an,
// was die Sicherungs-PCs in backup_runs gemeldet haben.
//
// Unterschied zu Venediger:
//  - nur lesen: Sicherung aktiv / Aufbewahrung / Warnschwelle gelten für beide Apps
//    und werden in der Venediger-App eingestellt (system_settings.backup_settings);
//    die München-App schreibt weiterhin nur in muc_*-Tabellen.
//  - Stand je Rechner: PC München sichert jede Nacht. PC Österreich ist ERSATZ
//    (Skript v5, config.json "StandbyHours"): Er sichert nur, wenn kein anderer
//    Rechner in den letzten StandbyHours erfolgreich war, und meldet sich sonst nur
//    mit einem Lebenszeichen in system_settings.backup_standby.
//    Rot: keine gelungene Sicherung innerhalb der Warnschwelle.
//    Gelb: Ersatz ist eingesprungen (Hauptrechner prüfen) oder Ersatz meldet sich nicht.
//
// Doku: doc/DATENSICHERUNG.md
import { useEffect, useState } from 'react';
import { supabase } from './supabase.js';
import { Klappkarte } from './Klapp.jsx';

const DEFAULTS = { enabled: true, retention_days: 30, warn_after_hours: 30 };

// Gleicher Wortlaut wie in LETZTE-SICHERUNG.txt auf dem PC und in Venediger.
const STATUS_LABEL = {
  erfolgreich: 'Erfolgreich',
  warnungen: 'Mit Warnungen',
  fehlgeschlagen: 'Fehlgeschlagen',
  pausiert: 'Pausiert',
};
const STATUS_ICON = { erfolgreich: '🟢', warnungen: '🟡', fehlgeschlagen: '🔴', pausiert: '⚪' };

const gelungen = (r) => r.status === 'erfolgreich' || r.status === 'warnungen';

// Rechnername → verständlicher Name
export function rechnerName(host) {
  if (!host) return 'unbekannter Rechner';
  const h = host.toUpperCase();
  if (h.includes('WEIDMANN')) return 'PC München';
  if (h.includes('VENEDIG')) return 'PC Österreich'; // Windows kürzt auf 15 Zeichen: MINIPC-VENEDIGE
  return host;
}

export function formatBytes(bytes) {
  if (bytes == null || !Number.isFinite(Number(bytes))) return '–';
  const b = Number(bytes);
  if (b < 1024) return `${b} Bytes`;
  const units = ['KB', 'MB', 'GB'];
  let v = b / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  const d = v >= 100 ? 0 : 1;
  return `${v.toLocaleString('de-DE', { minimumFractionDigits: d, maximumFractionDigits: d })} ${units[i]}`;
}

const wann = (ts) =>
  new Date(ts).toLocaleString('de-DE', {
    weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Berlin',
  });

const vor = (ts) => {
  const h = (Date.now() - new Date(ts)) / 36e5;
  if (h < 1) return `vor ${Math.max(1, Math.round(h * 60))} min`;
  if (h < 48) return `vor ${Math.round(h)} h`;
  return `vor ${Math.round(h / 24)} Tagen`;
};

// Stand je Rechner: letzter Lauf, letzte gelungene Sicherung, überfällig?
export function standJeRechner(runs, warnStunden, jetzt = Date.now()) {
  const map = new Map();
  for (const r of runs) {                      // runs: neueste zuerst
    const key = r.host || '?';
    if (!map.has(key)) map.set(key, { host: r.host, letzter: r, gelungen: null });
    const e = map.get(key);
    if (!e.gelungen && gelungen(r)) e.gelungen = r;
  }
  return [...map.values()].map((e) => ({
    ...e,
    ueberfaellig: !e.gelungen || (jetzt - new Date(e.gelungen.finished_at)) / 36e5 > warnStunden,
  }));
}

// Gesamturteil mit Ersatz-Rechner. standby = system_settings.backup_standby (oder null).
export function bewerten(runs, standby, warnStunden, jetzt = Date.now()) {
  const alt = (ts) => !ts || (jetzt - new Date(ts)) / 36e5 > warnStunden;
  const rechner = standJeRechner(runs, warnStunden, jetzt);
  const ersatzHost = standby?.host || null;
  let ersatz = null;
  if (ersatzHost) {
    ersatz = rechner.find((r) => r.host === ersatzHost) || { host: ersatzHost, letzter: null, gelungen: null };
    if (!rechner.includes(ersatz)) rechner.push(ersatz);
    ersatz.ersatz = true;
    ersatz.beat = standby;
    const zeiten = [standby.checked_at, ersatz.letzter?.finished_at].filter(Boolean).map((t) => new Date(t).getTime());
    ersatz.zuletztGemeldet = zeiten.length ? new Date(Math.max(...zeiten)).toISOString() : null;
  }
  const haupt = rechner.filter((r) => !r.ersatz);
  const neueste = runs.find(gelungen) || null;
  const rot = alt(neueste?.finished_at);
  const gelb = [];
  if (!rot) {
    for (const h of haupt) {
      if (h.ueberfaellig) gelb.push(`${rechnerName(h.host)} hat seit mehr als ${warnStunden} h nicht gesichert${ersatz ? ` – ${rechnerName(ersatz.host)} ist eingesprungen` : ''}. Die Daten sind gesichert, ${rechnerName(h.host)} bitte prüfen.`);
    }
  }
  if (ersatz && alt(ersatz.zuletztGemeldet)) {
    gelb.push(`${rechnerName(ersatz.host)} (Ersatz) meldet sich seit mehr als ${warnStunden} h nicht – fällt der Hauptrechner aus, sichert niemand. Bitte prüfen.`);
  }
  return { rechner, ersatz, neueste, rot, gelb };
}

export default function Datensicherung() {
  const [runs, setRuns] = useState(null);
  const [cfg, setCfg] = useState(DEFAULTS);
  const [err, setErr] = useState(null);
  const [standby, setStandby] = useState(null);

  useEffect(() => {
    const seit = new Date(Date.now() - 14 * 864e5).toISOString();
    Promise.all([
      supabase.from('backup_runs').select('*').gte('finished_at', seit)
        .order('finished_at', { ascending: false }).limit(60),
      supabase.from('system_settings').select('value').eq('key', 'backup_settings').maybeSingle(),
      supabase.from('system_settings').select('value').eq('key', 'backup_standby').maybeSingle(),
    ]).then(([a, b, c]) => {
      setStandby(c.data?.value ?? null);
      setErr(a.error?.message ?? null);
      setRuns(a.data || []);
      if (b.data?.value) setCfg({ ...DEFAULTS, ...b.data.value });
    });
  }, []);

  if (runs === null) {
    return <Klappkarte id="einstellungen-sicherung" titel="Datensicherung" sum="lädt …" standardAuf={false}><div className="muted small">Lädt …</div></Klappkarte>;
  }

  const warn = Number(cfg.warn_after_hours) || DEFAULTS.warn_after_hours;
  const { rechner, neueste, rot, gelb } = bewerten(runs, standby, warn);
  const allesAlt = cfg.enabled && rot;

  const sum = err
    ? 'Protokoll nicht lesbar'
    : !cfg.enabled
      ? 'pausiert'
      : allesAlt
        ? '⚠ keine aktuelle Sicherung'
        : neueste
          ? `zuletzt ${vor(neueste.finished_at)} · ${rechnerName(neueste.host)}${gelb.length ? ' · ⚠' : ''}`
          : 'noch keine Sicherung';

  return (
    <Klappkarte id="einstellungen-sicherung" titel="Datensicherung" sub="nächtlich ins OneDrive" sum={sum} standardAuf={false}>
      <p className="muted small">
        Die Münchner Daten liegen im selben Supabase-Projekt wie Venediger. Jede Nacht wird die <strong>ganze Datenbank</strong> ins
        OneDrive gesichert – München ist damit immer mit drin. Der PC führt die Sicherung nur aus; Daten und Sicherungen liegen in der Cloud.
      </p>

      {err ? (
        <div className="alert">Das Sicherungsprotokoll konnte nicht geladen werden: {err}</div>
      ) : (
        <>
          {!cfg.enabled && (
            <div className="notice-warn small">Die Sicherung ist <strong>pausiert</strong> (eingestellt in der Venediger-App).</div>
          )}
          {allesAlt && (
            <div className="alert">
              <strong>{neueste ? `Letzte gelungene Sicherung ${vor(neueste.finished_at)}.` : 'In den letzten 14 Tagen gab es keine gelungene Sicherung.'}</strong>{' '}
              Bitte die Sicherungs-PCs prüfen: eingeschaltet? Aufgabenplanung „Supabase-Sicherung Heizung“ gelaufen?
            </div>
          )}
          {cfg.enabled && gelb.map((t, i) => <div key={i} className="notice-warn small">{t}</div>)}

          {rechner.length === 0 ? (
            <div className="muted small">In den letzten 14 Tagen wurde keine Sicherung gemeldet.</div>
          ) : (
            <table className="ptable">
              <thead><tr><th>Rechner</th><th>Letzter Lauf</th><th>Letzte gelungene</th><th>Größe</th></tr></thead>
              <tbody>
                {rechner.map((r) => (
                  <tr key={r.host || '?'}>
                    <td>{rechnerName(r.host)}<div className="muted small">{r.ersatz ? 'Ersatz – sichert nur, wenn nötig' : 'sichert jede Nacht'}</div><div className="muted small mono">{r.host}</div></td>
                    {r.ersatz && r.beat?.result === 'uebersprungen' && (!r.letzter || new Date(r.beat.checked_at) > new Date(r.letzter.finished_at)) ? (
                      <td>⏸ Übersprungen<div className="muted small">{wann(r.beat.checked_at)} · {rechnerName(r.beat.main_host)} hatte gesichert</div></td>
                    ) : r.letzter ? (
                      <td>{STATUS_ICON[r.letzter.status]} {STATUS_LABEL[r.letzter.status] || r.letzter.status}<div className="muted small">{wann(r.letzter.finished_at)}{r.ersatz ? ' · eingesprungen' : ''}</div></td>
                    ) : <td>–</td>}
                    <td>{r.gelungen ? <>{wann(r.gelungen.finished_at)}<div className="muted small">{vor(r.gelungen.finished_at)}</div></> : '–'}</td>
                    <td>{r.gelungen ? <>{formatBytes(r.gelungen.db_bytes)}<div className="muted small">{r.gelungen.table_count ?? '–'} Tabellen</div></> : '–'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {runs.length > 0 && (
            <>
              <div className="eyebrow">Verlauf (letzte 14 Tage)</div>
              <table className="ptable">
                <tbody>
                  {runs.slice(0, 14).map((r) => (
                    <tr key={r.id}>
                      <td>{STATUS_ICON[r.status]} {wann(r.finished_at)}</td>
                      <td>{rechnerName(r.host)}</td>
                      <td className="muted small">{gelungen(r) ? formatBytes(r.db_bytes) : STATUS_LABEL[r.status]}</td>
                      <td className="muted small mono">{r.backup_folder || ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {runs[0].messages?.length > 0 && (
                <ul className="muted small">{runs[0].messages.map((m, i) => <li key={i}>{m}</li>)}</ul>
              )}
            </>
          )}

          <div className="muted small">
            Einstellungen (gelten für München und Venediger, änderbar in der Venediger-App): Sicherung {cfg.enabled ? 'aktiv' : 'pausiert'} ·
            {' '}aufbewahren {cfg.retention_days} Tage · warnen nach {warn} h.
            {' '}Ablage: <span className="mono">OneDrive\Backups\Supabase-Heizung\</span>
          </div>
          {/* eigener Block mit Abstand: ein Inline-Link mit Polster lag über der Zeile darüber */}
          <div style={{ marginTop: 10 }}>
            <a className="btn" style={{ display: 'inline-block', textDecoration: 'none', color: 'inherit' }}
              href="https://onedrive.live.com/" target="_blank" rel="noopener noreferrer">Sicherungen im OneDrive öffnen</a>
          </div>
        </>
      )}
    </Klappkarte>
  );
}
