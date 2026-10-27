import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_SETTINGS as S, inWindow, parseHm, surplusW, phaseAt, desiredPvLevel, holdPvLevel, houseModeOf,
  roomTarget, needsWrite, averageEnergy, localMinutes, PV_FULL,
} from '../src/logic.js';

// Zeitpunkt in Berliner Ortszeit (Ende Oktober 2026 = UTC+1)
const at = (hm) => new Date(`2026-10-28T${hm}:00+01:00`);

const base = {
  id: 'x', temp_night: 19, temp_normal: 21, temp_pv: 23, temp_full: 24,
  min_temp: 5, max_temp: 26, override_temp: null, override_until: null,
};
const kueche = { ...base, heat_morning: true, heat_day: true, heat_evening: true, pv_prio: 1 };
const schlaf = { ...base, temp_night: 17, temp_normal: 18.5, temp_pv: 20, temp_full: 21, heat_morning: false, heat_day: false, heat_evening: false, pv_prio: 3 };
const nie = { ...base, heat_morning: false, heat_day: false, heat_evening: false, pv_prio: 0 };
const T = (room, phase, level = 0, soc = 80, now = at('12:00')) => roomTarget({ room, phase, level, soc, now, settings: S });

test('Zeitfenster über Mitternacht', () => {
  assert.equal(inWindow(parseHm('23:00'), '22:00', '06:00'), true);
  assert.equal(inWindow(parseHm('05:59'), '22:00', '06:00'), true);
  assert.equal(inWindow(parseHm('06:00'), '22:00', '06:00'), false);
  assert.equal(localMinutes(at('14:30')), 14 * 60 + 30);
});

test('Tagesphasen mit Standardzeiten', () => {
  assert.equal(phaseAt(at('03:00'), S), 'NACHT');
  assert.equal(phaseAt(at('06:00'), S), 'MORGEN');
  assert.equal(phaseAt(at('08:59'), S), 'MORGEN');
  assert.equal(phaseAt(at('09:00'), S), 'TAG');
  assert.equal(phaseAt(at('17:00'), S), 'ABEND');
  assert.equal(phaseAt(at('22:00'), S), 'NACHT');
});

test('Überschuss: Einspeisung zählt immer, Laden nur ab pv_min_soc', () => {
  assert.equal(surplusW({ gridW: -2000, batteryW: -3000, soc: 50 }, S), 2000);
  assert.equal(surplusW({ gridW: -2000, batteryW: -3000, soc: 70 }, S), 5000);
  assert.equal(surplusW({ gridW: 3600, batteryW: 800, soc: 76 }, S), 0);
});

test('PV-Stufen: ein, hoch, runter, voll', () => {
  const lvl = (e, cur, phase = 'TAG') => desiredPvLevel({ energy: { batteryW: 0, soc: 80, ...e }, phase, settings: S, currentLevel: cur }).level;
  assert.equal(lvl({ gridW: -1000 }, 0), 0);          // zu wenig zum Einschalten
  assert.equal(lvl({ gridW: -1600 }, 0), 1);          // Stufe 1
  assert.equal(lvl({ gridW: -500 }, 1), 1);           // läuft, Rest reicht nicht für Stufe 2
  assert.equal(lvl({ gridW: -1200 }, 1), 2);          // noch 1200 W übrig → Stufe 2
  assert.equal(lvl({ gridW: -1200 }, 3), 3);          // Stufe 3 ist das Maximum
  assert.equal(lvl({ gridW: 100 }, 2), 1);            // Bezug → eine Stufe zurück
  assert.equal(lvl({ gridW: -3500, soc: 96 }, 1), PV_FULL);
  assert.equal(lvl({ gridW: -500, soc: 90 }, PV_FULL), 3);
  assert.equal(lvl({ gridW: -5000 }, 2, 'NACHT'), 0); // nachts nie
  assert.equal(desiredPvLevel({ energy: null, phase: 'TAG', settings: S, currentLevel: 2 }).level, 0);
});

test('Haltezeit für Stufenwechsel, Nacht sofort', () => {
  const cur = { level: 1, since: at('12:00') };
  const early = holdPvLevel({ desired: { level: 2, reason: 'x' }, current: cur, now: at('12:10'), settings: S });
  assert.equal(early.level, 1);
  assert.equal(early.pending, 2);
  assert.equal(holdPvLevel({ desired: { level: 2, reason: 'x' }, current: cur, now: at('12:31'), settings: S }).level, 2);
  assert.equal(holdPvLevel({ desired: { level: 0, reason: 'x', immediate: true }, current: cur, now: at('12:05'), settings: S }).level, 0);
});

test('Hausmodus aus Phase und Stufe', () => {
  assert.equal(houseModeOf('MORGEN', 0), 'MORGEN');
  assert.equal(houseModeOf('TAG', 2), 'PV_2');
  assert.equal(houseModeOf('TAG', 4), 'BATTERIE_VOLL');
});

test('Morgens heizt nur, wer "morgens heizen" hat', () => {
  assert.equal(T(kueche, 'MORGEN').target, 21);
  assert.equal(T(kueche, 'MORGEN').mode, 'NORMAL');
  assert.equal(T(schlaf, 'MORGEN').target, 17);
  assert.equal(T(schlaf, 'MORGEN').mode, 'ABSENK');
});

test('Nachts alle Räume auf Absenkwert', () => {
  assert.equal(T(kueche, 'NACHT', 0, 80, at('23:00')).target, 19);
  assert.equal(T(schlaf, 'NACHT', 0, 80, at('23:00')).target, 17);
});

test('PV-Stufen nach Raum-Priorität', () => {
  assert.equal(T(kueche, 'TAG', 1).target, 23);  // Prio 1 ab Stufe 1
  assert.equal(T(schlaf, 'TAG', 1).target, 17);  // Prio 3 wartet
  assert.match(T(schlaf, 'TAG', 1).reason, /wartet auf PV-Stufe 3/);
  assert.equal(T(schlaf, 'TAG', 3).target, 20);
  assert.equal(T(schlaf, 'TAG', PV_FULL).target, 21);
  assert.equal(T(nie, 'TAG', PV_FULL).target, 19); // Prio 0 = nie mit PV
});

test('Abends nur heizen, wenn der Akku reicht', () => {
  assert.equal(T(kueche, 'ABEND', 0, 70, at('18:00')).target, 21);
  assert.equal(T(kueche, 'ABEND', 0, 40, at('18:00')).target, 19);
  assert.equal(T(schlaf, 'ABEND', 0, 90, at('18:00')).target, 17);
});

test('Ohne Profilspalten: Verhalten wie bisher (immer Normal, Prio 1)', () => {
  assert.equal(T(base, 'MORGEN').target, 21);
  assert.equal(T(base, 'TAG', 1).target, 23);
});

test('Override hat Vorrang, abgelaufen nicht mehr', () => {
  const ov = { ...schlaf, override_temp: 25, override_until: at('14:00').toISOString() };
  const r = T(ov, 'TAG', 0, 80, at('13:00'));
  assert.equal(r.mode, 'OVERRIDE');
  assert.equal(r.target, 25);
  assert.equal(T(ov, 'TAG', 0, 80, at('15:00')).target, 17);
});

test('Sicherheitsgrenzen 5–26 °C', () => {
  const crazy = { ...kueche, temp_pv: 40, temp_night: 0 };
  assert.equal(T(crazy, 'TAG', 1).target, 26);
  assert.equal(T(crazy, 'NACHT', 0, 80, at('23:00')).target, 5);
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
  assert.equal(a.soc, 61);
  assert.equal(averageEnergy([], now, 5), null);
});
