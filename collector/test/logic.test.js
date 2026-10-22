import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MODES, DEFAULT_SETTINGS as S, inWindow, parseHm, surplusW, desiredHouseMode, applyHold,
  roomTarget, needsWrite, averageEnergy, localMinutes,
} from '../src/logic.js';

// Hilfsfunktion: Zeitpunkt in Berliner Ortszeit (Oktober 2026 = UTC+2)
const at = (hm) => new Date(`2026-10-22T${hm}:00+02:00`);

const room = {
  id: 'kg_bad', temp_night: 19, temp_normal: 21, temp_pv: 23, temp_full: 24,
  min_temp: 5, max_temp: 26, override_temp: null, override_until: null,
};

test('Zeitfenster über Mitternacht', () => {
  assert.equal(inWindow(parseHm('23:00'), '20:00', '09:00'), true);
  assert.equal(inWindow(parseHm('05:00'), '20:00', '09:00'), true);
  assert.equal(inWindow(parseHm('09:00'), '20:00', '09:00'), false);
  assert.equal(inWindow(parseHm('12:00'), '20:00', '09:00'), false);
  assert.equal(localMinutes(at('14:30')), 14 * 60 + 30);
});

test('Überschuss: Einspeisung zählt immer, Laden nur ab pv_min_soc', () => {
  assert.equal(surplusW({ gridW: -2000, batteryW: -3000, soc: 50 }, S), 2000);
  assert.equal(surplusW({ gridW: -2000, batteryW: -3000, soc: 70 }, S), 5000);
  assert.equal(surplusW({ gridW: 3600, batteryW: 800, soc: 76 }, S), 0); // Bezug
});

test('Nachts immer NACHT, auch bei Sonne', () => {
  const r = desiredHouseMode({ energy: { gridW: -5000, batteryW: 0, soc: 100 }, now: at('21:00'), settings: S });
  assert.equal(r.mode, MODES.NACHT);
});

test('PV_LADEN mit Hysterese', () => {
  const e = { gridW: -800, batteryW: 0, soc: 80 };
  // 800 W reicht nicht zum Einschalten …
  assert.equal(desiredHouseMode({ energy: e, now: at('12:00'), settings: S }).mode, MODES.NORMAL);
  // … hält aber einen laufenden PV-Modus
  assert.equal(desiredHouseMode({ energy: e, now: at('12:00'), settings: S, currentMode: MODES.PV_LADEN }).mode, MODES.PV_LADEN);
  assert.equal(desiredHouseMode({ energy: { gridW: -1600, batteryW: 0, soc: 80 }, now: at('12:00'), settings: S }).mode, MODES.PV_LADEN);
});

test('BATTERIE_VOLL bei vollem Speicher und großem Export', () => {
  const r = desiredHouseMode({ energy: { gridW: -3500, batteryW: 0, soc: 97 }, now: at('13:00'), settings: S });
  assert.equal(r.mode, MODES.BATTERIE_VOLL);
});

test('ABEND_SCHUTZ ab 16 Uhr bei niedriger Batterie', () => {
  const e = { gridW: 200, batteryW: 1500, soc: 30 };
  assert.equal(desiredHouseMode({ energy: e, now: at('17:00'), settings: S }).mode, MODES.ABEND_SCHUTZ);
  assert.equal(desiredHouseMode({ energy: e, now: at('15:00'), settings: S }).mode, MODES.NORMAL);
});

test('Ohne FENECON-Daten: sicherer Normalbetrieb', () => {
  assert.equal(desiredHouseMode({ energy: null, now: at('12:00'), settings: S }).mode, MODES.NORMAL);
});

test('Haltezeit verzögert Wechsel, Nacht wechselt sofort', () => {
  const current = { mode: MODES.PV_LADEN, since: at('12:00') };
  const early = applyHold({ desired: { mode: MODES.NORMAL, reason: 'x' }, current, now: at('12:10'), settings: S });
  assert.equal(early.mode, MODES.PV_LADEN);
  assert.equal(early.pending, MODES.NORMAL);
  const late = applyHold({ desired: { mode: MODES.NORMAL, reason: 'x' }, current, now: at('12:31'), settings: S });
  assert.equal(late.mode, MODES.NORMAL);
  const night = applyHold({ desired: { mode: MODES.NACHT, reason: 'x' }, current: { mode: MODES.PV_LADEN, since: at('19:55') }, now: at('20:00'), settings: S });
  assert.equal(night.mode, MODES.NACHT);
});

test('Raum-Sollwert je Modus und Override', () => {
  assert.equal(roomTarget({ room, houseMode: MODES.PV_LADEN, now: at('12:00') }).target, 23);
  assert.equal(roomTarget({ room, houseMode: MODES.ABEND_SCHUTZ, now: at('17:00') }).target, 19);
  const ov = { ...room, override_temp: 25, override_until: at('14:00').toISOString() };
  const r = roomTarget({ room: ov, houseMode: MODES.NORMAL, now: at('13:00') });
  assert.equal(r.mode, MODES.OVERRIDE);
  assert.equal(r.target, 25);
  // abgelaufener Override
  assert.equal(roomTarget({ room: ov, houseMode: MODES.NORMAL, now: at('15:00') }).target, 21);
});

test('Sicherheitsgrenzen 5–26 °C', () => {
  const crazy = { ...room, temp_pv: 40, temp_night: 0 };
  assert.equal(roomTarget({ room: crazy, houseMode: MODES.PV_LADEN, now: at('12:00') }).target, 26);
  assert.equal(roomTarget({ room: crazy, houseMode: MODES.NACHT, now: at('22:00') }).target, 5);
});

test('Schreiben nur bei Abweichung', () => {
  const now = at('12:00');
  assert.equal(needsWrite({ target: 21, loxoneSetpoint: 21, lastWrittenAt: at('11:30'), now }), false);
  assert.equal(needsWrite({ target: 23, loxoneSetpoint: 21, lastWrittenAt: at('11:30'), now }), true);
  assert.equal(needsWrite({ target: 21, loxoneSetpoint: null, now }), true);
  assert.equal(needsWrite({ target: 21, loxoneSetpoint: 21, lastWrittenAt: at('09:00'), now }), true);
});

test('Mittelwert über die letzten Minuten', () => {
  const now = at('12:00').getTime();
  const buf = [
    { ts: now - 10 * 60000, pvW: 0, gridW: 0, batteryW: 0, consumptionW: 0, soc: 50 },
    { ts: now - 2 * 60000, pvW: 4000, gridW: -1000, batteryW: -1000, consumptionW: 2000, soc: 60 },
    { ts: now, pvW: 6000, gridW: -3000, batteryW: -1000, consumptionW: 2000, soc: 61 },
  ];
  const a = averageEnergy(buf, now, 5);
  assert.equal(a.pvW, 5000);
  assert.equal(a.gridW, -2000);
  assert.equal(a.soc, 61);
  assert.equal(averageEnergy([], now, 5), null);
});
