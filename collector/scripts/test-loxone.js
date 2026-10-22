// Prüft die Loxone-Anbindung für einen Raum.
// Aufruf:
//   npm run test:loxone                        -> nur lesen
//   npm run test:loxone -- --set 22            -> Sollwert 22 °C schreiben
// Namen können per Umgebungsvariablen überschrieben werden (siehe .env.example).
import { LoxoneClient } from '../src/loxone.js';

const env = process.env;
const client = new LoxoneClient({
  host: env.LOXONE_HOST || '192.168.188.128',
  user: env.LOXONE_USER,
  password: env.LOXONE_PASSWORD,
});

const names = {
  Raumtemperatur: env.TEST_TEMP_NAME || 'Temp KG Bad',
  'App-Sollwert': env.TEST_SETPOINT_NAME || 'API_Boost_Bad',
  Ventil: env.TEST_VALVE_NAME || 'Bad KG',
};

const setIdx = process.argv.indexOf('--set');
if (setIdx > 0) {
  const v = Number(process.argv[setIdx + 1]);
  try {
    const r = await client.setNumber(names['App-Sollwert'], v);
    console.log(`Geschrieben: ${names['App-Sollwert']} = ${r}`);
  } catch (e) {
    console.log(`Schreiben fehlgeschlagen: ${e.message}`);
  }
}

for (const [label, name] of Object.entries(names)) {
  try {
    const v = await client.readNumber(name);
    console.log(`${label.padEnd(16)} "${name}": ${v}`);
  } catch (e) {
    console.log(`${label.padEnd(16)} "${name}": FEHLER – ${e.message}`);
  }
}
