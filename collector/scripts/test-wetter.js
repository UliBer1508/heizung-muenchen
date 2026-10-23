// Zeigt Wetter und Prognose aus dem FEMS – wie sie der Collector speichert.
import { readFemsForecast } from '../src/fems-rest.js';

const opts = {
  host: process.env.FEMS_REST_HOST || process.env.FENECON_HOST || '192.168.188.59',
  port: Number(process.env.FEMS_REST_PORT || 80),
  password: process.env.FEMS_REST_PASSWORD || 'user',
};
try {
  const { row } = await readFemsForecast(opts);
  console.log(`FEMS ${opts.host}: Wetter und Prognose gelesen\n`);
  for (const [k, v] of Object.entries(row)) console.log(k.padEnd(18), v ?? '–');
} catch (e) {
  console.error('Fehler:', e.message);
  process.exit(1);
}
