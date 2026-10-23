import { useState } from 'react';
import { supabase } from './supabase.js';
import { fmtW, fmtT, fmtTime, minutesAgo, modeMeta } from './lib.js';

function StatusBar({ status, settings }) {
  const age = minutesAgo(status?.last_seen);
  const online = age != null && age <= 3;
  return (
    <div className="statusbar">
      <span className={`dot ${online ? 'ok' : 'bad'}`} />
      <span>{online ? 'Collector läuft' : age == null ? 'Collector noch nie gemeldet' : `Collector offline seit ${age} min`}</span>
      <span className="sep">·</span>
      <span className={status?.fenecon_ok ? '' : 'warn-text'}>FENECON {status?.fenecon_ok ? 'ok' : 'Fehler'}</span>
      <span className="sep">·</span>
      <span className={status?.loxone_ok ? '' : 'warn-text'}>Loxone {status?.loxone_ok ? 'ok' : 'Fehler'}</span>
      {settings.dry_run && <span className="pill rose">Testmodus – es wird nichts geschaltet</span>}
      {!settings.automation_enabled && <span className="pill neutral">Automatik aus</span>}
    </div>
  );
}

function ModeHero({ status }) {
  const m = modeMeta(status?.house_mode);
  const pending = status?.pending_mode ? modeMeta(status.pending_mode) : null;
  return (
    <section className={`card hero tone-${m.tone}`}>
      <div className="eyebrow">Betriebsmodus</div>
      <div className="hero-mode">{m.label}</div>
      <div className="hero-reason">{status?.mode_reason || m.hint}</div>
      <div className="muted small">
        seit {fmtTime(status?.mode_since)}
        {pending && <> · Wechsel zu <strong>{pending.label}</strong> wartet auf Haltezeit</>}
      </div>
    </section>
  );
}

function Energy({ e }) {
  const grid = e?.grid_w;
  const bat = e?.battery_w;
  const tiles = [
    { k: 'PV', v: fmtW(e?.pv_w), s: 'Erzeugung' },
    { k: 'Netz', v: fmtW(grid == null ? null : Math.abs(grid)), s: grid == null ? '' : grid > 50 ? 'Bezug' : grid < -50 ? 'Einspeisung' : 'ausgeglichen', warn: grid > 50 },
    { k: 'Batterie', v: e?.soc != null ? `${e.soc} %` : '–', s: bat == null ? '' : bat < -50 ? `lädt ${fmtW(-bat)}` : bat > 50 ? `entlädt ${fmtW(bat)}` : 'ruht' },
    { k: 'Haus', v: fmtW(e?.consumption_w), s: 'Verbrauch' },
    { k: 'Überschuss', v: fmtW(e?.surplus_w), s: 'nutzbar für Heizung', accent: true },
  ];
  return (
    <section className="energy">
      {tiles.map((t) => (
        <div key={t.k} className={`card tile ${t.accent ? 'accent' : ''}`}>
          <div className="eyebrow">{t.k}</div>
          <div className={`tile-value ${t.warn ? 'warn-text' : ''}`}>{t.v}</div>
          <div className="muted small">{t.s}</div>
        </div>
      ))}
      <div className="muted small energy-foot">Stand {fmtTime(e?.ts)}</div>
    </section>
  );
}

function RoomCard({ room, reading, reload }) {
  const [temp, setTemp] = useState(Number(room.override_temp ?? reading?.target ?? room.temp_normal));
  const [hours, setHours] = useState(2);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [open, setOpen] = useState(false);
  const overrideOn = room.override_until && new Date(room.override_until) > new Date();
  const m = modeMeta(reading?.mode);

  const save = async (patch) => {
    setBusy(true);
    setErr(null);
    const { error } = await supabase.from('muc_rooms').update(patch).eq('id', room.id);
    if (error) setErr(error.message);
    await reload();
    setBusy(false);
  };
  const start = () =>
    save({ override_temp: temp, override_until: new Date(Date.now() + hours * 3600000).toISOString() });
  const stop = () => save({ override_temp: null, override_until: null });

  const valveOpen = reading?.valve === 1;
  return (
    <section className="card room">
      <div className="room-head">
        <div>
          <div className="room-name">{room.name}</div>
          <div className="muted small">Messung {fmtTime(reading?.ts)}</div>
        </div>
        <span className={`pill ${m.tone}`}>{m.label}</span>
      </div>
      <div className="room-figures">
        <div>
          <div className="eyebrow">Ist</div>
          <div className="big">{fmtT(reading?.temp)}</div>
        </div>
        <div>
          <div className="eyebrow">Soll</div>
          <div className="big">{fmtT(reading?.setpoint)}</div>
          {reading?.target != null && Number(reading.target) !== Number(reading.setpoint) && (
            <div className="muted small">Ziel {fmtT(reading.target)}</div>
          )}
        </div>
        <div>
          <div className="eyebrow">Ventil</div>
          <div className={`valve ${valveOpen ? 'open' : ''}`}>{reading?.valve == null ? '–' : valveOpen ? 'offen' : 'zu'}</div>
        </div>
      </div>

      <div className="override">
        {overrideOn ? (
          <div className="override-active">
            <span>Manuell <strong>{fmtT(room.override_temp)}</strong> bis {fmtTime(room.override_until)}</span>
            <button className="btn" onClick={stop} disabled={busy}>Beenden</button>
          </div>
        ) : !open ? (
          <button className="btn ghost override-toggle" onClick={() => { setTemp(Number(reading?.target ?? room.temp_normal)); setOpen(true); }}>
            Manuell übersteuern …
          </button>
        ) : (
          <>
            <div className="override-row">
              <div className="stepper">
                <button className="btn" onClick={() => setTemp((t) => Math.max(5, +(t - 0.5).toFixed(1)))} aria-label="kälter">−</button>
                <span className="stepper-val">{fmtT(temp)}</span>
                <button className="btn" onClick={() => setTemp((t) => Math.min(26, +(t + 0.5).toFixed(1)))} aria-label="wärmer">+</button>
              </div>
              <select value={hours} onChange={(e) => setHours(Number(e.target.value))} aria-label="Dauer">
                {[1, 2, 4, 8, 24].map((h) => <option key={h} value={h}>für {h} h</option>)}
              </select>
            </div>
            <div className="override-actions">
              <button className="btn ghost" onClick={() => setOpen(false)} disabled={busy}>Abbrechen</button>
              <button className="btn primary" onClick={async () => { await start(); setOpen(false); }} disabled={busy}>Setzen</button>
            </div>
            <div className="muted small">Wird innerhalb einer Minute in Loxone übernommen.</div>
          </>
        )}
        {err && <div className="alert">{err}</div>}
      </div>
      <div className="room-temps muted small">
        Nacht {fmtT(room.temp_night)} · Normal {fmtT(room.temp_normal)} · PV {fmtT(room.temp_pv)} · Voll {fmtT(room.temp_full)}
      </div>
    </section>
  );
}

export default function Overview({ data, reload }) {
  return (
    <div className="stack">
      <StatusBar status={data.status} settings={data.settings} />
      {data.status?.last_error && <div className="alert">Letzter Fehler: {data.status.last_error}</div>}
      <div className="grid-2">
        <ModeHero status={data.status} />
        <Energy e={data.energy} />
      </div>
      <div className="rooms">
        {data.rooms.filter((r) => r.enabled).map((r) => (
          <RoomCard key={r.id} room={r} reading={data.latestByRoom[r.id]} reload={reload} />
        ))}
      </div>
    </div>
  );
}
