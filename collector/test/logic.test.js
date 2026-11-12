import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_SETTINGS as S, inWindow, parseHm, surplusW, phaseAt, desiredPvLevel, holdPvLevel, houseModeOf,
  roomTarget, needsWrite, averageEnergy, localMinutes, PV_FULL, shouldCaptureDayContext, allocateRooms, trackHeatRuns,
  dayModeOf, expectedSurplusKwh, holdBelow,
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
const T = (room, phase, dayMode = 'grid', now = at('12:00')) => roomTarget({ room, phase, dayMode, now });

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

test('Überschuss (Modell a): Raumzahl nach Überschuss, hoch, runter, voll', () => {
  const lvl = (e, cur, phase = 'TAG', n = 10) => desiredPvLevel({ energy: { batteryW: 0, soc: 80, ...e }, phase, settings: S, currentLevel: cur, nRooms: n }).level;
  assert.equal(lvl({ gridW: -1000 }, 0), 0);          // zu wenig zum Einschalten
  assert.equal(lvl({ gridW: -1600 }, 0), 1);          // knapp → ein Raum
  assert.equal(lvl({ gridW: -3600 }, 0), 3);          // 1,5 kW + 2 × 1 kW → drei Räume
  assert.equal(lvl({ gridW: -500 }, 2), 2);           // läuft, Rest reicht nicht für mehr
  assert.equal(lvl({ gridW: -2200 }, 2), 4);          // noch 2,2 kW übrig → zwei Räume mehr
  assert.equal(lvl({ gridW: -9000 }, 8), 10);         // höchstens alle Räume
  assert.equal(lvl({ gridW: 100 }, 3), 2);            // Bezug → ein Raum weniger
  assert.equal(lvl({ gridW: 100 }, 1), 0);            // letzter Raum → Überschuss-Heizen endet
  assert.equal(lvl({ gridW: -3500, soc: 96 }, 1), PV_FULL);
  assert.equal(lvl({ gridW: -500, soc: 90 }, PV_FULL), 10);
  assert.equal(lvl({ gridW: -5000 }, 2, 'NACHT'), 0); // nachts nie
  assert.equal(desiredPvLevel({ energy: null, phase: 'TAG', settings: S, currentLevel: 2, nRooms: 5 }).level, 0);
});

test('Haltezeit für Wechsel, Nacht sofort', () => {
  const cur = { level: 1, since: at('12:00') };
  const early = holdPvLevel({ desired: { level: 2, reason: 'x' }, current: cur, now: at('12:10'), settings: S });
  assert.equal(early.level, 1);
  assert.equal(early.pending, 2);
  assert.equal(holdPvLevel({ desired: { level: 2, reason: 'x' }, current: cur, now: at('12:31'), settings: S }).level, 2);
  assert.equal(holdPvLevel({ desired: { level: 0, reason: 'x', immediate: true }, current: cur, now: at('12:05'), settings: S }).level, 0);
});

test('Hausmodus', () => {
  assert.equal(houseModeOf('MORGEN', 0, 'grid'), 'MORGEN');
  assert.equal(houseModeOf('TAG', 3, 'grid'), 'PV');
  assert.equal(houseModeOf('TAG', PV_FULL, 'grid'), 'BATTERIE_VOLL');
  assert.equal(houseModeOf('TAG', 0, 'wait'), 'WARTETAG');
  assert.equal(houseModeOf('NACHT', 0, 'night'), 'NACHT');
});

// FEMS-Prognose: Leistung jetzt und in 1/3/6/12 h
const fc = (pv1, pv3, pv6, pv12 = 0, at_ = at('09:00')) => ({ at: at_.toISOString(), pv_1h: pv1, pv_3h: pv3, pv_6h: pv6, pv_12h: pv12 });

test('Erwarteter Überschuss: PV minus Grundlast minus Akku bis voll', () => {
  // 08.11.2026 09:06 – mittags kam der Überschuss
  assert.equal(expectedSurplusKwh({ forecast: fc(1107, 1372, 2672), energy: { pvW: 1500, soc: 3 }, settings: S, now: at('09:10') }), 5);
  // 09.11.2026 08:13 – trüb, Akku leer
  assert.ok(expectedSurplusKwh({ forecast: fc(969, 1899, 517, 0, at('08:13')), energy: { pvW: 135, soc: 0 }, settings: S, now: at('08:20') }) < 0);
  // alte Prognose zählt nicht
  assert.equal(expectedSurplusKwh({ forecast: fc(3000, 3000, 3000), energy: { pvW: 0, soc: 0 }, settings: S, now: at('11:00') }), null);
});

test('Tagesmodus: Nacht, Abend wie Nacht, Wartetag, ohne PV', () => {
  const sunny = fc(3000, 4000, 3000, 0, at('09:00'));
  const dull = fc(300, 400, 200, 0, at('09:00'));
  const D = (phase, forecast, soc = 80, now = at('09:10')) => dayModeOf({ phase, energy: { pvW: 1000, soc }, forecast, settings: S, now }).mode;
  assert.equal(D('NACHT', sunny), 'night');
  assert.equal(D('ABEND', sunny), 'evening');
  assert.equal(D('TAG', sunny), 'wait');
  assert.equal(D('TAG', dull), 'grid');
  assert.equal(D('TAG', null), 'grid');                       // keine Prognose → nicht warten
  assert.equal(dayModeOf({ phase: 'TAG', energy: { pvW: 1000, soc: 80 }, forecast: sunny, settings: { ...S, wait_min_kwh: 0 }, now: at('09:10') }).mode, 'grid');
});

test('Wunschwert: Nacht, Abend, Wartetag = Untergrenze; ohne PV nach Profil', () => {
  assert.equal(T(kueche, 'NACHT', 'night', at('23:00')).target, 19);
  assert.equal(T(kueche, 'ABEND', 'evening', at('18:00')).target, 19);   // Abend wie Nacht, auch mit „abends heizen“
  assert.equal(T(kueche, 'TAG', 'wait').target, 19);
  assert.equal(T(kueche, 'MORGEN', 'grid').target, 21);
  assert.equal(T(kueche, 'MORGEN', 'grid').mode, 'NORMAL');
  assert.equal(T(schlaf, 'MORGEN', 'grid').target, 17);
  assert.equal(T(schlaf, 'MORGEN', 'grid').mode, 'ABSENK');
  assert.equal(T(base, 'TAG', 'grid').target, 21);                      // ohne Profilspalten: Normal
});

test('Override hat Vorrang, abgelaufen nicht mehr', () => {
  const ov = { ...schlaf, override_temp: 25, override_until: at('14:00').toISOString() };
  const r = T(ov, 'TAG', 'grid', at('13:00'));
  assert.equal(r.mode, 'OVERRIDE');
  assert.equal(r.target, 25);
  assert.equal(T(ov, 'TAG', 'grid', at('15:00')).target, 17);
});

test('Sicherheitsgrenzen 5–26 °C', () => {
  const crazy = { ...kueche, temp_normal: 40, temp_night: 0 };
  assert.equal(T(crazy, 'TAG', 'grid').target, 26);
  assert.equal(T(crazy, 'NACHT', 'night', at('23:00')).target, 5);
});

test('Wartewert: Ist − 0,5 °C abgerundet auf 0,5, nie über dem Wunsch', () => {
  assert.equal(holdBelow(18.4, 22), 17.5);
  assert.equal(holdBelow(19.0, 22), 18.5);
  assert.equal(holdBelow(19.0, 18), 18);
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
  // Lesefehler (65535 / null) zählt nicht: letzter gültiger Wert, sonst null
  assert.equal(averageEnergy([...buf, { ts: now, pvW: null, gridW: null, batteryW: null, consumptionW: null, soc: null }], now, 5).soc, 61);
  assert.equal(averageEnergy([{ ts: now, pvW: 1, gridW: 1, batteryW: 0, consumptionW: 1, soc: 65535 }], now, 5).soc, null);
});

test('Tagesprotokoll: einmal am Tag, nicht nachts', () => {
  assert.equal(shouldCaptureDayContext({ phase: 'NACHT', today: '2026-10-28', lastCapturedDay: null }), false);
  assert.equal(shouldCaptureDayContext({ phase: 'MORGEN', today: '2026-10-28', lastCapturedDay: '2026-10-27' }), true);
  assert.equal(shouldCaptureDayContext({ phase: 'TAG', today: '2026-10-28', lastCapturedDay: '2026-10-28' }), false);
  assert.equal(shouldCaptureDayContext({ phase: 'ABEND', today: '2026-10-28', lastCapturedDay: null }), true); // Start am Abend
});

// ---------------------------------------------------------------------------
// Verteilung auf die Kreise (0.11)
const r = (id, prio, extra = {}) => ({ ...kueche, id, name: id, priority: prio, ...extra });
const item = (room, temp, phase = 'TAG', dayMode = 'grid', valve = 0) => ({ room, temp, state: { valve }, t: T(room, phase, dayMode) });
const byId = (res) => Object.fromEntries(res.items.map((it) => [it.room.id, it.t]));
const A = (items, extra = {}) => allocateRooms({ items, settings: S, now: at('12:00'), ...extra });

test('Modell b: Netzgrenze – höchstens max_grid_circuits Räume, nach Priorität', () => {
  const rooms = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map((id, i) => item(r(id, i < 4 ? 1 : 2), 19));
  const res = A(rooms);
  const t = byId(res);
  assert.equal(res.active.length, 6);
  for (const id of ['a', 'b', 'c', 'd', 'e', 'f']) assert.equal(t[id].target, 21);
  assert.equal(t.g.mode, 'WARTET');
  assert.equal(t.g.target, 18.5);            // Ist 19 − 0,5 → Ventil zu
  assert.match(t.g.reason, /Netzgrenze 6 Kreise voll/);
});

test('Modell b: alle Räume einer Prio heizen gemeinsam, Prio 2 kommt dazu, solange die Grenze nicht voll ist', () => {
  const t = byId(A([item(r('a', 1), 19), item(r('b', 1), 19), item(r('c', 2), 19)]));
  assert.equal(t.a.target, 21);
  assert.equal(t.b.target, 21);
  assert.equal(t.c.target, 21);               // Grenze 6 nicht erreicht → heizt auch
});

test('Modell b: fertige Räume halten Normal und belegen keinen Kreis – außer ihr Ventil ist noch offen', () => {
  const rooms = [item(r('a', 1), 21, 'TAG', 'grid', 1), item(r('b', 1), 21), ...['c', 'd', 'e', 'f', 'g', 'h'].map((id) => item(r(id, 2), 19))];
  const res = A(rooms);
  const t = byId(res);
  assert.equal(t.a.target, 21);
  assert.equal(t.b.target, 21);
  assert.equal(res.gridUsed, 6);              // a im Nachlauf + 5 neue
  assert.equal(t.h.mode, 'WARTET');
});

test('Nacht: nur Räume unter der Untergrenze heizen, unter der Netzgrenze', () => {
  const rooms = [item(r('a', 1), 18, 'NACHT', 'night'), item(r('b', 2), 19.5, 'NACHT', 'night'), item(r('c', 2), 17, 'NACHT', 'night')];
  const t = byId(allocateRooms({ items: rooms, settings: { ...S, max_grid_circuits: 1 }, dayMode: 'night', now: at('23:00') }));
  assert.equal(t.a.target, 19);               // unter Untergrenze, Prio 1 → heizt bis 19
  assert.match(t.a.reason, /unter Untergrenze 19,0/);
  assert.equal(t.b.target, 19);               // warm genug → hält 19, heizt nicht
  assert.equal(t.c.mode, 'WARTET');           // Grenze 1 Kreis voll
  assert.equal(t.c.target, 16.5);
});

test('Nacht 08./09.11.: Untergrenze 21 bei 18–19 °C – nur noch 6 statt aller Kreise', () => {
  const rooms = Array.from({ length: 13 }, (_, i) => item(r(`r${i}`, i < 4 ? 1 : 2, { temp_night: 21 }), 18.5, 'NACHT', 'night'));
  const res = allocateRooms({ items: rooms, settings: S, dayMode: 'night', now: at('23:00') });
  assert.equal(res.active.length, 6);
});

test('Wartetag: Räume über der Untergrenze heizen nicht', () => {
  const res = A([item(r('a', 1), 19.5, 'TAG', 'wait'), item(r('b', 2), 20, 'TAG', 'wait')], { dayMode: 'wait' });
  assert.equal(res.active.length, 0);
  assert.equal(byId(res).a.target, 19);
});

test('Modell a: Überschuss reicht für 2 Räume → Prio 1 zuerst auf PV-Wert, Rest wartet auf mehr Überschuss', () => {
  const rooms = [item(r('a', 1), 21, 'TAG', 'wait'), item(r('b', 1), 21, 'TAG', 'wait'), item(r('c', 2), 21, 'TAG', 'wait'), item(r('d', 2), 21, 'TAG', 'wait')];
  const res = A(rooms, { dayMode: 'wait', level: 2 });
  const t = byId(res);
  assert.equal(t.a.target, 23);
  assert.equal(t.a.mode, 'PV');
  assert.equal(t.b.target, 23);
  assert.equal(t.c.target, 19);               // Wartetag-Grundwert, Ventil zu (warm genug)
  assert.match(t.c.reason, /wartet auf mehr Überschuss/);
  assert.equal(res.pvUsed, 2);
  assert.equal(res.gridUsed, 0);
});

test('Modell a: am Tag ohne PV-Prognose bekommen die übrigen Räume Normal unter der Netzgrenze', () => {
  const rooms = [item(r('a', 1), 20), item(r('b', 2), 20), item(r('c', 2), 20)];
  const t = byId(A(rooms, { level: 1 }));
  assert.equal(t.a.target, 23);               // PV
  assert.equal(t.b.target, 21);               // Normal aus Netzgrenze
  assert.equal(t.c.target, 21);
});

test('Modell a: Batterie voll → alle PV-Räume auf Voll, „nie mit PV“ nicht', () => {
  const rooms = [item(r('a', 1), 21), item(r('b', 3), 21), item(r('n', 2, { pv_prio: 0 }), 21)];
  const t = byId(A(rooms, { level: PV_FULL }));
  assert.equal(t.a.target, 24);
  assert.equal(t.b.target, 24);
  assert.equal(t.n.target, 21);
});

test('Modell a: Raum hat PV-Wert erreicht → hält ihn ohne Kreis, nächster Raum kommt dran', () => {
  const rooms = [item(r('a', 1), 22.9), item(r('b', 2), 21)];
  const res = A(rooms, { level: 1 });
  const t = byId(res);
  assert.equal(t.a.target, 23);
  assert.equal(t.b.target, 23);
  assert.deepEqual(res.active, ['b']);
});

test('Hysterese: erreichter Wunsch gilt erst unter Wunsch − 0,8 wieder als offen', () => {
  const reached = new Set(['a@21']);
  const still = A([item(r('a', 1), 20.4)], { reached, settings: { ...S, max_grid_circuits: 1 } });
  assert.equal(still.active.length, 0);
  const back = A([item(r('a', 1), 20.1)], { reached, settings: { ...S, max_grid_circuits: 1 } });
  assert.deepEqual(back.active, ['a']);
});

test('Wer lange wartet, kommt zuerst dran', () => {
  const rooms = [item(r('a', 1), 19), item(r('b', 2), 19)];
  const settings = { ...S, max_grid_circuits: 1 };
  assert.deepEqual(allocateRooms({ items: rooms, settings, now: at('12:00') }).active, ['a']);
  assert.deepEqual(allocateRooms({ items: rooms, settings, waitSince: { b: at('10:30').toISOString() }, now: at('12:00') }).active, ['b']);
});

test('Manuelle Räume zählen mit, Räume ohne Messwert blockieren nicht', () => {
  const man = r('m', 1, { override_temp: 24, override_until: '2026-10-28T13:00:00+01:00' });
  const t = byId(A([item(man, 18), item(r('x', 1), null), item(r('b', 2), 19)], { settings: { ...S, max_grid_circuits: 2 } }));
  assert.equal(t.m.mode, 'OVERRIDE');
  assert.equal(t.x.target, 21);
  assert.equal(t.b.target, 21);
});

test('Aufheiz-Messung: Lauf beginnt beim Heizen und endet, wenn der Raum fertig ist', () => {
  const A = r('A', 1);
  let st = trackHeatRuns({}, { now: at('10:00'), items: [item(A, 19.0)], active: new Set(['A']), reached: new Set(), heatW: 2000, outdoorC: 5 });
  assert.equal(st.finished.length, 0);
  st = trackHeatRuns(st.runs, { now: at('11:00'), items: [item(A, 19.6)], active: new Set(['A']), reached: new Set(), heatW: 2400, outdoorC: 6 });
  st = trackHeatRuns(st.runs, { now: at('12:30'), items: [item(A, 20.8)], active: new Set(), reached: new Set(['A']), heatW: 0 });
  assert.equal(st.finished.length, 1);
  const f = st.finished[0];
  assert.equal(f.minutes, 150);
  assert.equal(f.temp_start, 19);
  assert.equal(f.temp_end, 20.8);
  assert.equal(f.reached, true);
  assert.equal(f.heat_w, 2200);
  assert.equal(f.rooms_heating, 1);
  assert.deepEqual(st.runs, {});
});

test('Aufheiz-Messung: zu kurze Läufe (< 30 min) werden verworfen', () => {
  const A = r('A', 1);
  let st = trackHeatRuns({}, { now: at('10:00'), items: [item(A, 19)], active: new Set(['A']), reached: new Set() });
  st = trackHeatRuns(st.runs, { now: at('10:20'), items: [item(A, 19.1)], active: new Set(), reached: new Set() });
  assert.equal(st.finished.length, 0);
});
