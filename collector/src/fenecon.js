// FENECON FEMS über die App "Modbus/TCP lesend".
// Register laut FEMS-Modbus-Tabelle (Komponente _sum):
//   302 EssSoc                 uint16  %
//   315 GridActivePower        float32 W  (+ Bezug, − Einspeisung)
//   327 ProductionActivePower  float32 W
//   343 ConsumptionActivePower float32 W
//   415 EssDischargePower      float32 W  (+ Entladen, − Laden)
import { readFloat32, readUint16 } from './modbus.js';

export const DEFAULT_REGISTERS = Object.freeze({
  soc: 302,
  grid: 315,
  pv: 327,
  consumption: 343,
  battery: 415,
});

// 0.11.1 (12.11.2026): Das FEMS liefert bei einem kurzen Aussetzer für „unbekannt“ 0xFFFF = 65535 (so am 05.11.2026
// 12:38–12:40). Ein Ladestand außerhalb 0–100 % gilt als nicht gelesen (null) – die Logik behandelt null schon sicher.
export const validSoc = (v) => (Number.isInteger(v) && v >= 0 && v <= 100 ? v : null);

export async function readFenecon(cfg) {
  const base = { host: cfg.host, port: cfg.port, unitId: cfg.unitId, functionCode: cfg.functionCode };
  const r = { ...DEFAULT_REGISTERS, ...(cfg.registers || {}) };
  // nacheinander lesen – FEMS mag keine parallelen Verbindungen
  const soc = await readUint16({ ...base, address: r.soc });
  const gridW = await readFloat32({ ...base, address: r.grid });
  const pvW = await readFloat32({ ...base, address: r.pv });
  const consumptionW = await readFloat32({ ...base, address: r.consumption });
  const batteryW = await readFloat32({ ...base, address: r.battery });
  const clean = (v) => (Number.isFinite(v) ? Math.round(v) : null);
  return {
    ts: Date.now(),
    soc: validSoc(soc),
    gridW: clean(gridW),
    pvW: clean(pvW),
    consumptionW: clean(consumptionW),
    batteryW: clean(batteryW),
  };
}
