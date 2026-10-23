// Wetter und Prognosen aus dem FEMS über die App "REST/JSON lesend".
// http://x:<passwort>@<FEMS>/rest/channel/<Komponente>/<Kanal> – Benutzername beliebig, Standardpasswort "user".

const HOURS_AHEAD = [1, 3, 6, 12, 24, 36];
const HOURS_WEATHER = [4, 8, 12, 16, 20, 24];

export async function readFemsChannels({ host, port = 80, password = 'user', pattern, timeoutMs = 8000 }) {
  const url = `http://${host}:${port}/rest/channel/${pattern}`;
  const res = await fetch(url, {
    headers: { Authorization: 'Basic ' + Buffer.from(`x:${password}`).toString('base64') },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (res.status === 401) throw new Error('FEMS REST: Passwort falsch (FEMS_REST_PASSWORD)');
  if (!res.ok) throw new Error(`FEMS REST ${pattern}: ${res.status}`);
  const j = await res.json();
  const list = Array.isArray(j) ? j : [j];
  const map = {};
  for (const c of list) if (c && c.address) map[c.address] = c.value;
  return map;
}

const num = (v) => (v === null || v === undefined || v === '' || Number.isNaN(Number(v)) ? null : Number(v));
const int = (v) => (num(v) == null ? null : Math.round(num(v)));

/** Wandelt die FEMS-Kanäle in eine Zeile für muc_forecast um. */
export function forecastFromChannels(ch) {
  const row = {};
  const w = (name) => ch[`weather0/${name}`];
  row.outdoor_c = num(w('CurrentTemperature'));
  row.today_min_c = num(w('TodaysMinTemperature'));
  row.today_max_c = num(w('TodaysMaxTemperature'));
  row.sunshine_today_s = int(w('TodaysSunshineDuration'));
  row.weather_code = int(w('CurrentWeatherCode'));
  for (const h of HOURS_WEATHER) {
    row[`temp_${h}h`] = num(w(`TemperatureIn${h}h`));
    row[`code_${h}h`] = int(w(`WeatherCodeIn${h}h`));
  }

  // Prognose-Komponenten erkennen: Erzeugung (PV) bzw. Verbrauch
  const comps = {};
  for (const [addr, value] of Object.entries(ch)) {
    const [comp, chan] = addr.split('/');
    if (!/^predictor\d+$/.test(comp)) continue;
    comps[comp] ??= { alias: '', values: {} };
    if (chan === '_PropertyAlias') comps[comp].alias = String(value ?? '');
    const m = chan.match(/^Predictor(\w*?)Prediction(\d+)h(Ahead|Realized)$/);
    if (m) {
      comps[comp].model = m[1];
      comps[comp].values[`${m[3]}${m[2]}`] = int(value);
    }
  }
  const kindOf = (c) =>
    /production|erzeugung|pv/i.test(`${c.model} ${c.alias}`) ? 'pv'
      : /consum|verbrauch|profile/i.test(`${c.model} ${c.alias}`) ? 'load' : null;
  for (const c of Object.values(comps)) {
    const kind = kindOf(c);
    if (!kind) continue;
    for (const h of HOURS_AHEAD) {
      if (row[`${kind}_${h}h`] == null) row[`${kind}_${h}h`] = c.values[`Ahead${h}`] ?? null;
      if (kind === 'pv' && row[`pv_real_${h}h`] == null) row[`pv_real_${h}h`] = c.values[`Realized${h}`] ?? null;
    }
  }
  return row;
}

export async function readFemsForecast(opts) {
  const [weather, pred] = await Promise.all([
    readFemsChannels({ ...opts, pattern: 'weather0/.*' }),
    readFemsChannels({ ...opts, pattern: 'predictor.*/.*' }),
  ]);
  const ch = { ...weather, ...pred };
  if (!Object.keys(weather).length) throw new Error('FEMS: keine Wetterdaten (App "Wetter" installiert?)');
  return { row: forecastFromChannels(ch), raw: ch };
}
