// End-to-End-Test mit nachgebautem FEMS (Modbus) und Loxone (HTTP) – ohne echte Hardware.
import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readFenecon } from '../src/fenecon.js';
import { LoxoneClient } from '../src/loxone.js';

const here = path.dirname(fileURLToPath(import.meta.url));

function fakeFems(values) {
  // values: { register: number }, Float32 außer 302 (uint16)
  const server = net.createServer((sock) => {
    sock.on('data', (req) => {
      const tid = req.readUInt16BE(0);
      const fc = req.readUInt8(7);
      const addr = req.readUInt16BE(8);
      const count = req.readUInt16BE(10);
      const payload = Buffer.alloc(count * 2);
      if (count === 1) payload.writeUInt16BE(values[addr] ?? 0, 0);
      else payload.writeFloatBE(values[addr] ?? 0, 0);
      const res = Buffer.alloc(9 + payload.length);
      res.writeUInt16BE(tid, 0);
      res.writeUInt16BE(0, 2);
      res.writeUInt16BE(3 + payload.length, 4);
      res.writeUInt8(1, 6);
      res.writeUInt8(fc, 7);
      res.writeUInt8(payload.length, 8);
      payload.copy(res, 9);
      sock.write(res);
    });
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server)));
}

function fakeLoxone(state) {
  const calls = [];
  const server = http.createServer((req, res) => {
    const auth = req.headers.authorization || '';
    if (auth !== 'Basic ' + Buffer.from('api:geheim').toString('base64')) {
      res.writeHead(401).end();
      return;
    }
    const m = req.url.match(/^\/jdev\/sps\/io\/([^/]+)\/(.+)$/);
    const name = decodeURIComponent(m[1]);
    const cmd = m[2];
    calls.push({ name, cmd });
    if (!(name in state)) {
      res.end(JSON.stringify({ LL: { control: req.url, value: '', Code: '500' } }));
      return;
    }
    if (cmd !== 'state') state[name] = Number(cmd);
    const v = name.startsWith('Temp') ? `${state[name]}°` : String(state[name]);
    res.end(JSON.stringify({ LL: { control: req.url, value: v, Code: '200' } }));
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ server, calls })));
}

test('FENECON lesen über Modbus', async () => {
  const fems = await fakeFems({ 302: 80, 315: -2500, 327: 6000, 343: 2000, 415: -1500 });
  const r = await readFenecon({ host: '127.0.0.1', port: fems.address().port, unitId: 1, functionCode: 3 });
  fems.close();
  assert.deepEqual(
    { soc: r.soc, gridW: r.gridW, pvW: r.pvW, consumptionW: r.consumptionW, batteryW: r.batteryW },
    { soc: 80, gridW: -2500, pvW: 6000, consumptionW: 2000, batteryW: -1500 },
  );
});

test('Loxone lesen, schreiben, falsches Passwort', async () => {
  const { server, calls } = await fakeLoxone({ 'Temp KG Bad': 21.375, API_Boost_Bad: 21 });
  const host = `127.0.0.1:${server.address().port}`;
  const lox = new LoxoneClient({ host, user: 'api', password: 'geheim' });
  assert.equal(await lox.readNumber('Temp KG Bad'), 21.375);
  assert.equal(await lox.setNumber('API_Boost_Bad', 23), 23);
  assert.equal(calls.at(-1).cmd, '23.0');
  await assert.rejects(new LoxoneClient({ host, user: 'api', password: 'falsch' }).readNumber('Temp KG Bad'), /401/);
  await assert.rejects(lox.readNumber('Gibt es nicht'), /Code 500/);
  server.close();
});

test('Ein Durchlauf: Überschuss → KG Bad bekommt PV-Sollwert', async () => {
  const fems = await fakeFems({ 302: 85, 315: -3000, 327: 7000, 343: 2500, 415: -1500 });
  const lox = await fakeLoxone({ 'Temp KG Bad': 21.4, API_Boost_Bad: 21, 'Bad KG': 0 });
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-'));
  // Mittagszeit erzwingen: Nachtfenster so legen, dass "jetzt" nie drin ist
  fs.writeFileSync(path.join(stateDir, 'cache.json'), JSON.stringify({
    settings: { dry_run: false, night_start: '00:00', night_end: '00:00', evening_start: '23:59' },
    rooms: [{
      id: 'kg_bad', name: 'KG Bad', loxone_temp_name: 'Temp KG Bad', loxone_setpoint_name: 'API_Boost_Bad',
      loxone_valve_name: 'Bad KG', temp_night: 19, temp_normal: 21, temp_pv: 23, temp_full: 24,
    }],
  }));
  const out = await new Promise((resolve) => {
    const p = spawn(process.execPath, [path.join(here, '..', 'src', 'index.js'), '--once'], {
      env: {
        ...process.env,
        STATE_DIR: stateDir,
        FENECON_HOST: '127.0.0.1', FENECON_PORT: String(fems.address().port),
        LOXONE_HOST: `127.0.0.1:${lox.server.address().port}`, LOXONE_USER: 'api', LOXONE_PASSWORD: 'geheim',
        SUPABASE_URL: '', SUPABASE_SERVICE_ROLE_KEY: '', FORCE_DRY_RUN: '0',
      },
    });
    let s = '';
    p.stdout.on('data', (d) => (s += d));
    p.stderr.on('data', (d) => (s += d));
    p.on('close', () => resolve(s));
  });
  fems.close();
  lox.server.close();
  assert.match(out, /Modus: – → PV_LADEN/);
  assert.match(out, /KG Bad: Soll 21 → 23 °C/);
  assert.ok(lox.calls.some((c) => c.name === 'API_Boost_Bad' && c.cmd === '23.0'), out);
  const cache = JSON.parse(fs.readFileSync(path.join(stateDir, 'cache.json'), 'utf8'));
  assert.equal(cache.house.mode, 'PV_LADEN');
});
