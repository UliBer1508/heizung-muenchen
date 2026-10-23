import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { forecastFromChannels, readFemsForecast } from '../src/fems-rest.js';

const sample = {
  'weather0/CurrentTemperature': 6, 'weather0/TodaysMinTemperature': 3, 'weather0/TodaysMaxTemperature': 12,
  'weather0/TodaysSunshineDuration': 6032, 'weather0/CurrentWeatherCode': 3,
  'weather0/TemperatureIn4h': 12, 'weather0/WeatherCodeIn12h': 61, 'weather0/TemperatureIn24h': 7,
  'predictor1/_PropertyAlias': 'Erzeugungsprognose',
  'predictor1/PredictorProductionLinearModelPrediction1hAhead': 3630,
  'predictor1/PredictorProductionLinearModelPrediction24hAhead': 5815,
  'predictor1/PredictorProductionLinearModelPrediction1hRealized': 3075,
  'predictor1/PredictorProductionLinearModelPrediction36hRealized': null,
  'predictor2/_PropertyAlias': 'Verbrauchsprognose',
  'predictor2/PredictorProfileClusteringModelPrediction1hAhead': 5096,
  'predictor0/_PropertyAlias': 'Standardprognose',
};

test('FEMS-Kanäle → Prognosezeile', () => {
  const r = forecastFromChannels(sample);
  assert.equal(r.outdoor_c, 6);
  assert.equal(r.today_max_c, 12);
  assert.equal(r.sunshine_today_s, 6032);
  assert.equal(r.temp_4h, 12);
  assert.equal(r.code_12h, 61);
  assert.equal(r.pv_1h, 3630);
  assert.equal(r.pv_24h, 5815);
  assert.equal(r.pv_real_1h, 3075);
  assert.equal(r.pv_real_36h, null);
  assert.equal(r.load_1h, 5096);
  assert.equal(r.pv_3h, null);
});

test('REST-Abruf mit Passwort und Platzhalter', async () => {
  let auth;
  const server = http.createServer((req, res) => {
    auth = req.headers.authorization;
    const comp = decodeURIComponent(req.url).split('/')[3];
    const list = Object.entries(sample)
      .filter(([a]) => (comp === 'weather0' ? a.startsWith('weather0/') : a.startsWith('predictor')))
      .map(([address, value]) => ({ address, value }));
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(list));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const { row } = await readFemsForecast({ host: '127.0.0.1', port: server.address().port, password: 'user' });
    assert.equal(auth, 'Basic ' + Buffer.from('x:user').toString('base64'));
    assert.equal(row.outdoor_c, 6);
    assert.equal(row.pv_24h, 5815);
  } finally {
    server.close();
  }
});
