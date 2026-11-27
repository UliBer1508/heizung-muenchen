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

test('Wer heizt, heizt fertig: Kreis bleibt beim Raum, auch wenn ein Raum mit kleinerer Prio-Nummer kommt (0.16)', () => {
  const items = [item(room('p1', 1), 19.5), item(room('p2', 2), 19.5)];
  const settings = { ...S, max_grid_circuits: 1 };
  const neu = allocateRooms({ items, settings, dayMode: 'night', now: at('23:05') });
  assert.deepEqual(neu.active, ['p1']);          // niemand heizt → Prio 1 zuerst
  const laeuft = allocateRooms({ items, settings, dayMode: 'night', now: at('23:05'), active: new Set(['p2']) });
  assert.deepEqual(laeuft.active, ['p2']);       // p2 heizt schon → behält den Kreis bis zum Ziel
  assert.match(byId(laeuft).p1.reason, /es heizen bis zum Ziel: p2/);
  const spaeter = allocateRooms({ items, settings, dayMode: 'night', now: at('03:00'), active: new Set(['p2']) });
  assert.deepEqual(spaeter.active, ['p2']);      // auch nach Stunden – kein Zeitlimit
  const fertig = allocateRooms({ items: [items[0], item(room('p2', 2), 20.0)], settings, dayMode: 'night', now: at('03:00'), active: new Set(['p2']) });
  assert.deepEqual(fertig.active, ['p1']);       // p2 am Ziel → Kreis an p1
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

// ---------------------------------------------------------------------------
// 0.16 (27.11.2026): nach Priorität heizen, fertig heizen, offene Ventile zählen
const tag = (r, temp, opts = {}) => item(r, temp, { phase: 'TAG', dayMode: 'grid', now: at('12:00'), ...opts });
const day = (r) => ({ ...room(r.id, r.prio, { temp_night: 21, temp_normal: 22, ...r.extra }) });

test('0.16: Ventil eines wartenden Raums, das Loxone noch nicht zugemacht hat, belegt einen Kreis', () => {
  const items = [tag(day({ id: 'a', prio: 1 }), 20.0), tag(day({ id: 'b', prio: 1 }), 20.0),
    tag(day({ id: 'w', prio: 2 }), 20.5, { valve: 1, setpoint: 20.0 })];
  const res = allocateRooms({ items, settings: { ...S, max_grid_circuits: 2 }, dayMode: 'grid', now: at('12:00') });
  assert.deepEqual(res.active, ['a']);           // w hat noch offenes Ventil → nur 1 Kreis frei
  assert.equal(byId(res).b.mode, 'WARTET');
  assert.match(byId(res).b.reason, /Ventil noch offen: w/);
});

test('0.16: nach dem Ziel bleibt das Ventil zu, bis Ist unter Ziel − 0,8 °C fällt', () => {
  const settings = { ...S, max_grid_circuits: 1 };
  const a = (t) => [tag(day({ id: 'a', prio: 1, extra: { temp_night: 19 } }), t)];
  const fertig = allocateRooms({ items: a(21.8), settings: { ...settings, seq_off_delta: 0.8 }, dayMode: 'grid', now: at('12:00'), active: new Set(['a']) });
  assert.equal(fertig.active.length, 0);         // 21,8 ≥ 22 − 0,3 → zu
  const reached = fertig.reached;
  for (const t of [21.6, 21.3, 21.2]) {
    assert.equal(allocateRooms({ items: a(t), settings: { ...settings, seq_off_delta: 0.8 }, dayMode: 'grid', now: at('12:30'), reached }).active.length, 0, `bei ${t}`);
  }
  assert.deepEqual(allocateRooms({ items: a(21.1), settings: { ...settings, seq_off_delta: 0.8 }, dayMode: 'grid', now: at('13:00'), reached }).active, ['a']);
});

test('0.16: Raum unter Min geht vor einem Raum, der schon über Min Richtung Normal heizt', () => {
  const items = [tag(day({ id: 'warm', prio: 1 }), 21.4), tag(day({ id: 'kalt', prio: 2 }), 20.2)];
  const res = allocateRooms({ items, settings: { ...S, max_grid_circuits: 1 }, dayMode: 'grid', now: at('12:00'), active: new Set(['warm']) });
  assert.deepEqual(res.active, ['kalt']);
  assert.equal(byId(res).warm.mode, 'WARTET');
});

test('0.16: Lage 27.11.2026 12:16 – höchstens 6 Ventile, Prio 1 zuerst, kein Wechsel im nächsten Lauf', () => {
  // [id, prio, Ist, Min, Normal, Ventil]
  const lage = [
    ['OG Eltern Bad', 1, 20.0, 21, 22, 1], ['OG Eltern Schlafzimmer', 1, 20.0, 21, 22, 0], ['OG Luis Bad', 1, 21.0, 21, 22, 0],
    ['OG Luis Schlafzimmer', 1, 20.5, 21, 22, 1], ['DG Bad', 2, 20.5, 21, 22, 1], ['DG Schlafzimmer', 2, 20.2, 21, 22, 0],
    ['DG Wohnen', 2, 20.4, 21, 22, 0], ['EG Büro', 2, 18.8, 21, 22, 0], ['EG Eingang', 2, 20.5, 21, 22, 1],
    ['EG Küche', 2, 19.2, 21, 22, 1], ['EG WC', 2, 21.6, 20, 21, 0], ['EG Wohnzimmer', 2, 19.7, 21, 22, 0],
    ['KG Hobbyraum', 2, 20.6, 21, 22, 1], ['OG Ankleide', 2, 19.2, 20, 21, 1], ['OG Büro', 2, 20.1, 21, 22, 1],
  ];
  const mk = () => lage.map(([id, prio, t, min, normal, valve], i) =>
    tag(room(id, prio, { temp_night: min, temp_normal: normal, sort: i }), t, { valve }));
  const settings = { ...S, max_grid_circuits: 6 };
  const active = new Set(['KG Hobbyraum', 'OG Eltern Bad', 'OG Luis Schlafzimmer', 'OG Eltern Schlafzimmer', 'OG Ankleide', 'EG Eingang']);
  const res = allocateRooms({ items: mk(), settings, dayMode: 'grid', now: at('12:16'), active, haltMin: 12 });
  // offen und nicht zugeteilt: DG Bad, EG Küche, OG Büro → belegen 3 Kreise; die 6 Zugeteilten behalten ihren Kreis,
  // der Rest wartet. Im nächsten Lauf (Ventile zu) ändert sich die Zuteilung nicht.
  assert.deepEqual(new Set(res.active), active);
  const res2 = allocateRooms({ items: mk(), settings, dayMode: 'grid', now: at('12:21'), active: new Set(res.active), reached: res.reached, waitSince: res.waitSince });
  assert.deepEqual(new Set(res2.active), active);
});

test('0.17: Spanne – nach dem Ziel erst wieder auf bei Ziel − 1,5 °C, nie unter Min', () => {
  const settings = { ...S, max_grid_circuits: 1, seq_off_delta: 1.5 };
  const run = (t, min, reached) => allocateRooms({ items: [tag(day({ id: 'a', prio: 1, extra: { temp_night: min } }), t)], settings, dayMode: 'grid', now: at('12:00'), reached });
  // Normal 22, Min 19 → wieder auf unter 20,5
  let reached = run(21.8, 19, new Set()).reached;
  assert.equal(run(20.6, 19, reached).active.length, 0);
  assert.deepEqual(run(20.4, 19, reached).active, ['a']);
  // Normal 22, Min 21 → 20,5 läge unter Min → wieder auf unter 21,0
  reached = run(21.8, 21, new Set()).reached;
  assert.equal(run(21.0, 21, reached).active.length, 0);
  assert.deepEqual(run(20.9, 21, reached).active, ['a']);
});
