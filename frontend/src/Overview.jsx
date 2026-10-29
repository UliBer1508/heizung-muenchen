import { useState } from 'react';
import { supabase } from './supabase.js';
import { fmtW, fmtT, fmtTime, minutesAgo, modeMeta, weatherText, clockIn, profileText } from './lib.js';
import EnergyFlow from './EnergyFlow.jsx';

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

// Eigenverbrauchsquote und Autarkie aus den aktuellen Leistungswerten.
// Eigenverbrauch = PV, die nicht ins Netz geht (Haus, Wärmepumpe, Auto, Batterie laden).
// Autarkie      = Anteil des Hausverbrauchs, der nicht aus dem Netz kommt.
function selfUse(e) {
  if (e?.pv_w == null || e?.grid_w == null) return { quote: null, self: null, autarky: null, gridIn: null };
  const pv = Math.max(0, e.pv_w);
  const feed = Math.max(0, -e.grid_w);
  const gridIn = Math.max(0, e.grid_w);
  const use = e.consumption_w ?? Math.max(0, pv + e.grid_w + (e.battery_w ?? 0));
  const self = Math.max(0, pv - feed);
  const quote = pv >= 50 ? Math.min(100, Math.round((100 * self) / pv)) : null;
  const autarky = use >= 50 ? Math.max(0, Math.min(100, Math.round(100 * (1 - gridIn / use)))) : null;
  return { quote, self, autarky, gridIn };
}

function Energy({ e }) {
  const grid = e?.grid_w;
  const bat = e?.battery_w;
  const su = selfUse(e);
  const tiles = [
    { k: 'PV', v: fmtW(e?.pv_w), s: 'Erzeugung' },
    { k: 'Netz', v: fmtW(grid == null ? null : Math.abs(grid)), s: grid == null ? '' : grid > 50 ? 'Bezug' : grid < -50 ? 'Einspeisung' : 'ausgeglichen', warn: grid > 50 },
    { k: 'Batterie', v: e?.soc != null ? `${e.soc} %` : '–', s: bat == null ? '' : bat < -50 ? `lädt ${fmtW(-bat)}` : bat > 50 ? `entlädt ${fmtW(bat)}` : 'ruht' },
    { k: 'Haus', v: fmtW(e?.consumption_w), s: 'Verbrauch' },
    { k: 'Überschuss', v: fmtW(e?.surplus_w), s: 'nutzbar für Heizung', accent: true },
    {
      k: 'Eigenverbrauch',
      v: su.quote != null ? `${su.quote} %` : '–',
      s: su.quote != null ? `${fmtW(su.self)} der PV selbst genutzt` : 'keine PV-Erzeugung',
    },
    {
      k: 'Autarkie',
      v: su.autarky != null ? `${su.autarky} %` : '–',
      s: su.autarky == null ? '' : su.gridIn > 50 ? `${fmtW(su.gridIn)} aus dem Netz` : 'ohne Netzbezug',
    },
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

function forecastHint(f) {
  // Mittag morgen (24-h-Wert liegt dann um die Mittagszeit) als einfache Einordnung
  const h = Number(new Date(new Date(f.ts).getTime() + 24 * 3600000).toLocaleString('en-GB', { hour: 'numeric', hour12: false, timeZone: 'Europe/Berlin' }));
  if (f.pv_24h == null || h < 10 || h > 15) return null;
  const kw = (f.pv_24h / 1000).toLocaleString('de-DE', { maximumFractionDigits: 1 });
  if (f.pv_24h >= 4000) return `Morgen gegen ${h} Uhr erwartet FENECON ${kw} kW PV – ein sonniger Tag.`;
  if (f.pv_24h >= 1500) return `Morgen gegen ${h} Uhr erwartet FENECON ${kw} kW PV – wechselhaft.`;
  return `Morgen gegen ${h} Uhr erwartet FENECON nur ${kw} kW PV – wenig Sonne.`;
}

function Forecast({ f }) {
  if (!f) return null;
  const age = minutesAgo(f.ts);
  const now = weatherText(f.weather_code);
  const sun = f.sunshine_today_s != null ? (f.sunshine_today_s / 3600).toLocaleString('de-DE', { maximumFractionDigits: 1 }) : null;
  const pv = [1, 3, 6, 12, 24, 36].map((h) => ({ h, v: f[`pv_${h}h`] })).filter((x) => x.v != null);
  const wx = [4, 8, 12, 16, 20, 24].map((h) => ({ h, t: f[`temp_${h}h`], c: f[`code_${h}h`] })).filter((x) => x.t != null || x.c != null);
  const hint = forecastHint(f);
  return (
    <section className="card forecast">
      <div className="forecast-head">
        <div>
          <div className="eyebrow">Wetter & PV-Prognose · FENECON</div>
          <div className="forecast-now">
            <span className="forecast-icon" aria-hidden="true">{now.icon}</span>
            <span className="big">{fmtT(f.outdoor_c, 0)}</span>
            <span>{now.text}</span>
          </div>
          <div className="muted small">
            Heute {f.today_min_c ?? '–'} bis {f.today_max_c ?? '–'} °C{sun != null && <> · Sonne {sun} h</>}
          </div>
        </div>
        <div className={`muted small ${age != null && age > 40 ? 'warn-text' : ''}`}>Stand {fmtTime(f.ts)}</div>
      </div>
      {hint && <div className="forecast-hint">{hint}</div>}
      {pv.length > 0 && (
        <div>
          <div className="eyebrow">Erwartete PV-Leistung</div>
          <div className="forecast-row">
            {pv.map((x) => (
              <div key={x.h} className="fc-cell">
                <div className="muted small">{clockIn(f.ts, x.h)}</div>
                <div className="fc-value">{fmtW(x.v)}</div>
              </div>
            ))}
          </div>
        </div>
      )}
      {wx.length > 0 && (
        <div>
          <div className="eyebrow">Wetter</div>
          <div className="forecast-row">
            {wx.map((x) => {
              const w = weatherText(x.c);
              return (
                <div key={x.h} className="fc-cell" title={w.text}>
                  <div className="muted small">{clockIn(f.ts, x.h)}</div>
                  <div className="fc-value">{w.icon} {x.t != null ? `${x.t}°` : ''}</div>
                </div>
              );
            })}
          </div>
        </div>
      )}
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
          {profileText(room) && <div className="muted small">{profileText(room)}</div>}
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
        Absenk {fmtT(room.temp_night)} · Normal {fmtT(room.temp_normal)} · PV {fmtT(room.temp_pv)} · Voll {fmtT(room.temp_full)}
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
      <EnergyFlow energy={data.energy} />
      <Forecast f={data.forecast} />
      <div className="rooms">
        {data.rooms.filter((r) => r.enabled).map((r) => (
          <RoomCard key={r.id} room={r} reading={data.latestByRoom[r.id]} reload={reload} />
        ))}
      </div>
    </div>
  );
}