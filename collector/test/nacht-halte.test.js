// Tests für Collector 0.13: ohne Sonne früh zu (Nachts nur Untergrenze) und Haltezeit (Stufe A)
import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SETTINGS as S, roomTarget, allocateRooms, haltezeitOf, FRUEH_SCHUTZ_MIN } from '../src/logic.js';

const at = (hm) => new Date(`2026-11-24T${hm}:00+01:00`);
const room = (id, prio = 2, extra = {}) => ({
  id, name: id, priority: prio, temp_night: 20, temp_normal: 21, temp_pv: 22, temp_full: 23,
  min_temp: 5, max_temp: 26, heat_morning: true, heat_day: true, pv_prio: 1, ...extra,
});
const item = (r, temp, { phase = 'NACHT', dayMode = 'night', valve = 0, setpoint = null, now = at('23:00') } = {}) => ({
  room: r, temp, state: { valve, setpoint }, t: roomTarget({ room: r, phase, dayMode, now }),
});
const byId = (res) => Object.fromEntries(res.items.map((it) => [it.room.id, it.t]));

test('Nacht: Ventil offen, Ist + Überlauf erreicht Untergrenze + 0,1 → früh zu', () => {
  const res = allocateRooms({ items: [item(room('a'), 20.0, { valve: 1, setpoint: 20 })], settings: S, dayMode: 'night', now: at('23:00'), ueberlauf: { a: 0.15 } });
  const t = byId(res).a;
  assert.equal(t.mode, 'FRUEH_AUS');
  assert.equal(t.target, 19.5);                  // Ist 20 − 0,5 → Ventil zu
  assert.match(t.reason, /gemessener Überlauf 0,2/);
  assert.ok(res.frueh.a.bis);
  assert.deepEqual(res.fruehAus, ['a']);
});

test('Früh zu nie unter der Untergrenze: Ist 19,9 bei Untergrenze 20 → heizt weiter', () => {
  const res = allocateRooms({ items: [item(room('a'), 19.9, { valve: 1, setpoint: 20 })], settings: S, dayMode: 'night', now: at('23:00'), ueberlauf: { a: 0.5 } });
  assert.notEqual(byId(res).a.mode, 'FRUEH_AUS');
  assert.equal(byId(res).a.target, 20);
});

test('Ohne gemessenen Überlauf, tagsüber mit Sonne oder abgeschaltet: wie bisher', () => {
  const it = () => [item(room('a'), 20.2, { valve: 1 })];
  assert.equal(byId(allocateRooms({ items: it(), settings: S, dayMode: 'night', now: at('23:00') })).a.mode, 'ABSENK');
  assert.equal(byId(allocateRooms({ items: it(), settings: S, dayMode: 'night', level: 1, now: at('23:00'), ueberlauf: { a: 0.2 } })).a.mode !== 'FRUEH_AUS', true);
  assert.equal(byId(allocateRooms({ items: it(), settings: { ...S, nacht_frueh_aus: false }, dayMode: 'night', now: at('23:00'), ueberlauf: { a: 0.2 } })).a.mode, 'ABSENK');
});

test('Schutzzeit: kein neuer Anstoß, solange über der Untergrenze; darunter heizt er sofort', () => {
  const frueh = { a: { at: at('23:00').toISOString(), bis: new Date(at('23:00').getTime() + FRUEH_SCHUTZ_MIN * 60000).toISOString(), target: 19.5, temp: 20 } };
  const keep = allocateRooms({ items: [item(room('a'), 20.0, { setpoint: 19.5 })], settings: S, dayMode: 'night', now: at('23:10'), frueh, ueberlauf: { a: 0.15 } });
  assert.equal(byId(keep).a.mode, 'FRUEH_AUS');
  assert.equal(byId(keep).a.target, 19.5);
  assert.equal(keep.active.length, 0);
  const cold = allocateRooms({ items: [item(room('a'), 19.6, { setpoint: 19.5 })], settings: S, dayMode: 'night', now: at('23:10'), frueh, ueberlauf: { a: 0.15 } });
  assert.deepEqual(cold.active, ['a']);          // 19,6 < 20 − 0,3 → unter Untergrenze, heizt
  assert.equal(byId(cold).a.target, 20);
});

test('Haltezeit: Kreis bleibt beim Raum, auch wenn ein Raum mit kleinerer Prio-Nummer kommt', () => {
  const items = [item(room('p1', 1), 19.5), item(room('p2', 2), 19.5)];
  const settings = { ...S, max_grid_circuits: 1 };
  const ohne = allocateRooms({ items, settings, dayMode: 'night', now: at('23:05'), active: new Set(['p2']) });
  assert.deepEqual(ohne.active, ['p1']);         // ohne Haltezeit: Prio 1 verdrängt
  const mit = allocateRooms({ items, settings, dayMode: 'night', now: at('23:05'), active: new Set(['p2']), haltMin: 15, grantedSince: { p2: at('23:00').toISOString() } });
  assert.deepEqual(mit.active, ['p2']);
  assert.match(byId(mit).p1.reason, /Haltezeit: p2 bis 23:15/);
  const spaeter = allocateRooms({ items, settings, dayMode: 'night', now: at('23:16'), active: new Set(['p2']), haltMin: 15, grantedSince: { p2: at('23:00').toISOString() } });
  assert.deepEqual(spaeter.active, ['p1']);      // Haltezeit vorbei
  assert.equal(mit.grantedSince.p2, at('23:00').toISOString());
});

test('Haltezeit: Ventil eines fertigen Raums gilt noch halte_min als belegt (kein Kreis für 1 Minute)', () => {
  const items = [item(room('f', 1), 20.3, { valve: 0 }), item(room('w', 2), 19.5)];
  const settings = { ...S, max_grid_circuits: 1 };
  const valveSeen = { f: at('22:58').toISOString() };
  const mit = allocateRooms({ items, settings, dayMode: 'night', now: at('23:00'), haltMin: 15, valveSeen });
  assert.equal(mit.active.length, 0);
  assert.equal(byId(mit).w.mode, 'WARTET');
  const ohne = allocateRooms({ items, settings, dayMode: 'night', now: at('23:00'), valveSeen });
  assert.deepEqual(ohne.active, ['w']);
  assert.equal(mit.valveSeen.f, valveSeen.f);
});

test('Wartende: Loxone-Sollwert, der das Ventil schon zuhält, bleibt stehen (kein Nachführen)', () => {
  const items = [item(room('a', 1), 19.5), item(room('b', 2), 19.2, { setpoint: 18.5 })];
  const res = allocateRooms({ items, settings: { ...S, max_grid_circuits: 1 }, dayMode: 'night', now: at('23:00') });
  assert.equal(byId(res).b.mode, 'WARTET');
  assert.equal(byId(res).b.target, 18.5);        // nicht 18,5 → 18,5 neu gerechnet, sondern stehen gelassen
  const res2 = allocateRooms({ items: [items[0], item(room('b', 2), 19.6, { setpoint: 18.5 })], settings: { ...S, max_grid_circuits: 1 }, dayMode: 'night', now: at('23:00') });
  assert.equal(byId(res2).b.target, 18.5);       // Ist 19,6: holdBelow wäre 19,0 – 18,5 hält das Ventil auch zu
});

test('Haltezeit: Vorgabe vor gelerntem Wert, sonst 15 min', () => {
  assert.equal(haltezeitOf({}), 15);
  assert.equal(haltezeitOf({ halte_min_gelernt: 12 }), 12);
  assert.equal(haltezeitOf({ halte_min_gelernt: 2 }), 5);
  assert.equal(haltezeitOf({ halte_min_gelernt: 12, halte_min_vorgabe: 0 }), 0);
  assert.equal(haltezeitOf({ halte_min_gelernt: 12, halte_min_vorgabe: 20 }), 20);
});
