// Zusatzdaten für die Analyse – beide Quellen sind optional.
// Fällt eine aus, läuft die Heizungssteuerung unverändert weiter.

/**
 * Außentemperatur von Open-Meteo (kostenlos, kein Schlüssel).
 * Liefert °C oder wirft einen Fehler.
 */
export async function readOutdoorTemp({ lat, lon, timeoutMs = 8000 }) {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m&timezone=Europe%2FBerlin`;
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`Open-Meteo ${res.status}`);
  const j = await res.json();
  const t = j?.current?.temperature_2m;
  if (typeof t !== 'number') throw new Error('Open-Meteo: keine Temperatur in der Antwort');
  return t;
}

/**
 * Ladeleistung aller Ladepunkte aus evcc (läuft auf demselben Mini-PC).
 * Neuere evcc-Versionen liefern das JSON direkt, ältere unter "result".
 * Liefert Watt (Summe) oder wirft einen Fehler.
 */
export async function readEvccChargePower({ url, timeoutMs = 4000 }) {
  const res = await fetch(`${url.replace(/\/$/, '')}/api/state`, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`evcc ${res.status}`);
  const j = await res.json();
  return evccChargePowerFromState(j);
}

export function evccChargePowerFromState(j) {
  const state = j && j.result ? j.result : j;
  const lps = state?.loadpoints;
  if (!Array.isArray(lps)) throw new Error('evcc: keine Ladepunkte in der Antwort');
  return Math.round(lps.reduce((sum, lp) => sum + (Number(lp.chargePower) || 0), 0));
}
