import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_SETTINGS as S, inWindow, parseHm, surplusW, phaseAt, desiredPvLevel, holdPvLevel, houseModeOf,
  roomTarget, needsWrite, averageEnergy, localMinutes, PV_FULL, shouldCaptureDayContext, applyHeatSequence,
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

test('Tagesprotokoll: einmal am Tag, nicht nachts', () => {
  assert.equal(shouldCaptureDayContext({ phase: 'NACHT', today: '2026-10-28', lastCapturedDay: null }), false);
  assert.equal(shouldCaptureDayContext({ phase: 'MORGEN', today: '2026-10-28', lastCapturedDay: '2026-10-27' }), true);
  assert.equal(shouldCaptureDayContext({ phase: 'TAG', today: '2026-10-28', lastCapturedDay: '2026-10-28' }), false);
  assert.equal(shouldCaptureDayContext({ phase: 'ABEND', today: '2026-10-28', lastCapturedDay: null }), true); // Start am Abend
});

// ---------------------------------------------------------------------------
// Heiz-Reihenfolge (0.7)
const SQ = { ...S, sequence_enabled: true };
const r = (id, rank, extra = {}) => ({ ...kueche, id, name: id, heat_rank: rank, ...extra });
const item = (room, temp, phase = 'TAG', level = 0) => ({ room, temp, t: T(room, phase, level) });
const byId = (res) => Object.fromEntries(res.items.map((it) => [it.room.id, it.t]));

test('Reihenfolge: Rang 1 zuerst, Rang 2 wartet mit Absenkwert', () => {
  const res = applyHeatSequence({ items: [item(r('A', 1), 20), item(r('B', 2), 20)], settings: SQ, now: at('12:00') });
  const t = byId(res);
  assert.equal(t.A.target, 21);
  assert.equal(t.B.mode, 'WARTET');
  assert.equal(t.B.target, 19);
  assert.equal(res.activeRank, 1);
  assert.match(res.reason, /Rang 1 ist dran – A 20,0 von 21,0/);
});

test('Reihenfolge: Rang 1 erreicht → Rang 2 dran, Rang 1 hält seinen Wert', () => {
  const res = applyHeatSequence({ items: [item(r('A', 1), 20.8), item(r('B', 2), 20), item(r('C', 3), 20)], settings: SQ, now: at('12:00') });
  const t = byId(res);
  assert.equal(t.A.target, 21);
  assert.equal(t.B.target, 21);
  assert.equal(t.C.mode, 'WARTET');
  assert.ok(res.reached.has('A'));
});

test('Reihenfolge: gleicher Rang heizt gemeinsam', () => {
  const t = byId(applyHeatSequence({ items: [item(r('A', 1), 20), item(r('B', 1), 20), item(r('C', 2), 20)], settings: SQ, now: at('12:00') }));
  assert.equal(t.A.target, 21);
  assert.equal(t.B.target, 21);
  assert.equal(t.C.mode, 'WARTET');
});

test('Reihenfolge: Hysterese – erreichter Raum fällt erst unter Soll − 0,8 zurück', () => {
  const reached = new Set(['A']);
  const still = byId(applyHeatSequence({ items: [item(r('A', 1), 20.4), item(r('B', 2), 20)], settings: SQ, reached, now: at('12:00') }));
  assert.equal(still.B.target, 21); // A bei 20,4 gilt weiter als fertig
  const back = byId(applyHeatSequence({ items: [item(r('A', 1), 20.1), item(r('B', 2), 20)], settings: SQ, reached, now: at('12:00') }));
  assert.equal(back.B.mode, 'WARTET'); // A unter 20,2 → wieder dran
});

test('Reihenfolge: Absenk-, manuelle und Räume ohne Messwert blockieren nicht', () => {
  const man = r('M', 1, { override_temp: 24, override_until: '2026-10-28T13:00:00+01:00' });
  const t = byId(applyHeatSequence({
    items: [item(man, 18), item(r('S', 1, { heat_day: false, pv_prio: 3 }), 15), item(r('X', 2), null), item(r('B', 3), 20)],
    settings: SQ, now: at('12:00'),
  }));
  assert.equal(t.M.mode, 'OVERRIDE');
  assert.equal(t.S.mode, 'ABSENK');
  assert.equal(t.B.target, 21); // M (manuell), S (Absenk) und X (kein Messwert) halten B nicht auf
});

test('Reihenfolge: nach seq_max_minutes wird zusätzlich der nächste Rang frei', () => {
  const items = [item(r('A', 1), 19.5), item(r('B', 2), 19.5), item(r('C', 3), 19.5)];
  const first = applyHeatSequence({ items, settings: SQ, now: at('10:00') });
  assert.equal(byId(first).B.mode, 'WARTET');
  const later = applyHeatSequence({ items, settings: SQ, turn: first.turn, now: at('13:05') });
  assert.equal(byId(later).B.target, 21);
  assert.equal(byId(later).C.mode, 'WARTET');
  assert.match(later.reason, /auch bis Rang 2 freigegeben/);
});

test('Reihenfolge aus: alles wie bisher', () => {
  const t = byId(applyHeatSequence({ items: [item(r('A', 1), 15), item(r('B', 2), 15)], settings: S, now: at('12:00') }));
  assert.equal(t.B.target, 21);
});

test('Reihenfolge mit PV: PV-Wert zählt als Soll', () => {
  const t = byId(applyHeatSequence({ items: [item(r('A', 1), 21, 'TAG', 1), item(r('B', 2), 21, 'TAG', 1)], settings: SQ, now: at('12:00') }));
  assert.equal(t.A.target, 23);
  assert.equal(t.B.mode, 'WARTET');
});
