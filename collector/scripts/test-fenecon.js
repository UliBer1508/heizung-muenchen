// Prüft die FENECON-Anbindung: liest alle Werte und zeigt sie an.
// Aufruf: npm run test:fenecon
// Vergleiche die Werte mit der FENECON-App (gleicher Moment!).
import { readFenecon } from '../src/fenecon.js';

const env = process.env;
const base = {
  host: env.FENECON_HOST || '192.168.188.59',
  port: Number(env.FENECON_PORT || 502),
  unitId: Number(env.FENECON_UNIT_ID || 1),
};

for (const functionCode of [3, 4]) {
  try {
    const r = await readFenecon({ ...base, functionCode });
    console.log(`\nFunktionscode ${functionCode} (${functionCode === 3 ? 'Holding' : 'Input'} Register): OK`);
    console.log(`  Ladezustand (SoC):   ${r.soc} %`);
    console.log(`  PV-Erzeugung:        ${r.pvW} W`);
    console.log(`  Netz:                ${r.gridW} W   (${r.gridW >= 0 ? 'Bezug' : 'Einspeisung'})`);
    console.log(`  Batterie:            ${r.batteryW} W   (${r.batteryW >= 0 ? 'entlädt' : 'lädt'})`);
    console.log(`  Hausverbrauch:       ${r.consumptionW} W`);
    const check = r.pvW + r.gridW + r.batteryW - r.consumptionW;
    console.log(`  Plausibilität PV+Netz+Batterie−Verbrauch = ${check} W (sollte nahe 0 sein)`);
  } catch (e) {
    console.log(`\nFunktionscode ${functionCode}: Fehler – ${e.message}`);
  }
}
