// Loxone Miniserver über den HTTP-Webservice (jdev/sps/io).
//   Lesen:     GET /jdev/sps/io/<Bezeichnung>/state  -> {"LL":{"value":"21.375°", "Code":"200"}}
//   Schreiben: GET /jdev/sps/io/<Bezeichnung>/<Wert>
// Die Bezeichnungen müssen in Loxone eindeutig sein.

export class LoxoneClient {
  constructor({ host, user, password, timeoutMs = 5000 }) {
    this.base = `http://${host}`;
    this.auth = 'Basic ' + Buffer.from(`${user}:${password}`).toString('base64');
    this.timeoutMs = timeoutMs;
  }

  async call(path) {
    const url = `${this.base}/${path.replace(/^\//, '')}`;
    const res = await fetch(url, {
      headers: { Authorization: this.auth },
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (res.status === 401) throw new Error('Loxone: Benutzer oder Passwort falsch (401)');
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error(`Loxone: unerwartete Antwort (${res.status}): ${text.slice(0, 120)}`);
    }
    const ll = json.LL || {};
    if (String(ll.Code ?? ll.code) !== '200') {
      throw new Error(`Loxone: Code ${ll.Code ?? ll.code} für ${path}`);
    }
    return ll.value;
  }

  static io(name, command) {
    return `jdev/sps/io/${encodeURIComponent(name)}/${command}`;
  }

  /** Zahlenwert lesen; Einheiten wie "°" oder "%" werden entfernt. */
  async readNumber(name) {
    const raw = await this.call(LoxoneClient.io(name, 'state'));
    const n = parseFloat(String(raw).replace(',', '.'));
    if (Number.isNaN(n)) throw new Error(`Loxone: "${name}" liefert keinen Zahlenwert (${raw})`);
    return n;
  }

  async setNumber(name, value) {
    const v = Number(value).toFixed(1);
    const raw = await this.call(LoxoneClient.io(name, v));
    return parseFloat(raw);
  }
}

/** Liest Raumtemperatur, aktuellen App-Sollwert und Ventilstatus eines Raumes. */
export async function readRoom(client, room) {
  const out = { roomId: room.id, temp: null, setpoint: null, valve: null, errors: [] };
  const tryRead = async (key, name) => {
    if (!name) return;
    try {
      out[key] = await client.readNumber(name);
    } catch (e) {
      out.errors.push(e.message);
    }
  };
  await tryRead('temp', room.loxone_temp_name);
  await tryRead('setpoint', room.loxone_setpoint_name);
  await tryRead('valve', room.loxone_valve_name);
  if (out.valve != null) out.valve = out.valve > 0 ? 1 : 0;
  return out;
}
