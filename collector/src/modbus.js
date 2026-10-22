// Minimaler Modbus-TCP-Client (nur Lesen), ohne externe Abhängigkeiten.
import net from 'node:net';

let transactionId = 0;

/**
 * Liest `count` Register ab `address` (0-basierte PDU-Adresse, wie in der
 * FEMS-Modbus-Tabelle angegeben).
 * functionCode 3 = Holding Register, 4 = Input Register.
 * Gibt einen Buffer mit count*2 Bytes zurück.
 */
export function readRegisters({ host, port = 502, unitId = 1, address, count, functionCode = 3, timeoutMs = 3000 }) {
  return new Promise((resolve, reject) => {
    const tid = (transactionId = (transactionId + 1) & 0xffff);
    const req = Buffer.alloc(12);
    req.writeUInt16BE(tid, 0); // Transaction ID
    req.writeUInt16BE(0, 2); // Protocol ID
    req.writeUInt16BE(6, 4); // Länge
    req.writeUInt8(unitId, 6);
    req.writeUInt8(functionCode, 7);
    req.writeUInt16BE(address, 8);
    req.writeUInt16BE(count, 10);

    const socket = net.createConnection({ host, port });
    let data = Buffer.alloc(0);
    const done = (err, val) => {
      clearTimeout(timer);
      socket.destroy();
      err ? reject(err) : resolve(val);
    };
    const timer = setTimeout(() => done(new Error(`Modbus-Timeout ${host}:${port} (Register ${address})`)), timeoutMs);

    socket.on('connect', () => socket.write(req));
    socket.on('error', (e) => done(e));
    socket.on('data', (chunk) => {
      data = Buffer.concat([data, chunk]);
      if (data.length < 9) return;
      const len = data.readUInt16BE(4);
      if (data.length < 6 + len) return;
      const fc = data.readUInt8(7);
      if (fc & 0x80) return done(new Error(`Modbus-Fehler ${data.readUInt8(8)} bei Register ${address}`));
      const byteCount = data.readUInt8(8);
      done(null, data.subarray(9, 9 + byteCount));
    });
  });
}

export async function readFloat32(opts) {
  const buf = await readRegisters({ ...opts, count: 2 });
  return buf.readFloatBE(0); // OpenEMS/FEMS: Big Endian, High-Word zuerst
}

export async function readUint16(opts) {
  const buf = await readRegisters({ ...opts, count: 1 });
  return buf.readUInt16BE(0);
}
