// Tests für Collector 0.14: „KI steuert“ – Plan umsetzen innerhalb der festen Regeln (src/plan.js)
import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SETTINGS as S, roomTarget, allocateRooms } from '../src/logic.js';
import { planStandAus, planAnwenden, grenzeAus, pvFreiAus, PLAN_MAX_ALTER_MIN } from '../src/plan.js';

const at = (hm) => new Date(`2026-11-24T${hm}:00+01:00`);
const room = (id, prio = 2, extra = {}) => ({
  id, name: id, priority: prio, temp_night: 20, temp_normal: 21, temp_pv: 22, temp_full: 23,
  min_temp: 5, max_temp: 26, heat_morning: true, heat_day: true, pv_prio: 1, ...extra,
});
const items = (list, { phase = 'TAG', dayMode = 'grid', now = at('11:00') } = {}) => allocateRooms({
  items: list.map(([r, temp, st = {}]) => ({ room: r, temp, state: { valve: 0, setpoint: null, ...st }, t: roomTarget({ room: r, phase, dayMode, now }) })),
  settings: S, dayMode, now,
}).items;
// Plan ab 11:00, 96 Slots; h = Heizen je Slot
const planRow = (raeume, { erstellt = at('10:58'), start = at('11:00') } = {}) => ({
  erstellt_at: erstellt.toISOString(),
  plan: { start: start.getTime() / 1000, raeume: raeume.map((r) => ({ p: 400, m2: true, pruefung_ok: true, unter: 20, ziel: Array(96).fill(21), ...r, h: r.h ?? '0'.repeat(96) })) },
});
const byId = (res) => Object.fromEntries(res.items.map((it) => [it.room.id, it.t]));

test('Modus schatten oder aus: Plan wird nicht gelesen, Regel-Steuerung bleibt', () => {
  assert.equal(planStandAus(planRow([{ id: 'a' }]), { modus: 'schatten', now: at('11:05') }).map, null);
  assert.equal(planStandAus(planRow([{ id: 'a' }]), { modus: 'aus', now: at('11:05') }).map, null);
});

test('Plan älter als 30 min → Regel-Steuerung', () => {
  const st = planStandAus(planRow([{ id: 'a' }], { erstellt: at('10:20') }), { modus: 'steuern', now: at('11:05') });
  assert.equal(st.map, null);
  assert.match(st.grund, new RegExp(`> ${PLAN_MAX_ALTER_MIN}`));
});

test('Raum mit altem Modell oder auffälliger Prüfung bleibt bei der Regel-Steuerung', () => {
  const st = planStandAus(planRow([{ id: 'a', m2: false }, { id: 'b', pruefung_ok: false }, { id: 'c' }]), { modus: 'steuern', now: at('11:05') });
  assert.deepEqual([...st.map.keys()], ['c']);
});

test('Plan heizt, Tag ohne genug Sonne (Netzgrenze Normal): Sollwert über Ist → Ventil auf', () => {
  const its = items([[room('a'), 20.4]]);
  const st = planStandAus(planRow([{ id: 'a', h: '1'.repeat(96) }]), { modus: 'steuern', now: at('11:05') });
  const res = planAnwenden({ items: its, stand: st, settings: S, grenze: 'normal', pvFreiW: 0, now: at('11:05') });
  const t = byId(res).a;
  assert.equal(t.mode, 'PLAN');
  assert.equal(t.target, 21);           // max(Ziel 21, ceil((20,4 + 0,5)·2)/2 = 21)
  assert.deepEqual(res.heizen, ['a']);
});

test('Plan heizt ohne Sonne, Wartetag/Nacht (Netzgrenze Untergrenze), Raum über Untergrenze → Regel: wartet, Ventil zu', () => {
  const its = items([[room('a'), 20.5]], { phase: 'NACHT', dayMode: 'night', now: at('23:00') });
  const st = planStandAus(planRow([{ id: 'a', h: '1'.repeat(96) }], { erstellt: at('22:58'), start: at('23:00') }), { modus: 'steuern', now: at('23:05') });
  const t = byId(planAnwenden({ items: its, stand: st, settings: S, grenze: 'min', pvFreiW: 0, now: at('23:05') })).a;
  assert.equal(t.mode, 'PLAN_ZU');
  assert.ok(t.target <= 20);
  assert.match(t.reason, /Regel: ohne PV-Überschuss nur bis Untergrenze/);
});

test('Gleiche Lage mit Sonnenstrom: Plan darf heizen', () => {
  const its = items([[room('a'), 20.5]]);
  const st = planStandAus(planRow([{ id: 'a', h: '1'.repeat(96) }]), { modus: 'steuern', now: at('11:05') });
  const t = byId(planAnwenden({ items: its, stand: st, settings: S, grenze: 'min', pvFreiW: 800, now: at('11:05') })).a;
  assert.equal(t.mode, 'PLAN');
  assert.match(t.reason, /mit Sonnenstrom/);
});

test('Plan heizt nicht, Raum unter Untergrenze → heizt trotzdem (Min hart)', () => {
  const its = items([[room('a'), 19.6]]);
  const st = planStandAus(planRow([{ id: 'a' }]), { modus: 'steuern', now: at('11:05') });
  const t = byId(planAnwenden({ items: its, stand: st, settings: S, grenze: 'min', pvFreiW: 0, now: at('11:05') })).a;
  assert.equal(t.mode, 'PLAN');
  assert.match(t.reason, /Sicherheit: unter Untergrenze/);
  assert.ok(t.target >= 20);
});

test('Plan heizt nicht → Ventil zu; steht Loxone schon sicher darunter, bleibt der Sollwert (kein neuer Befehl)', () => {
  const its = items([[room('a'), 21.0, { setpoint: 20.5 }]]);
  const st = planStandAus(planRow([{ id: 'a' }]), { modus: 'steuern', now: at('11:05') });
  const t = byId(planAnwenden({ items: its, stand: st, settings: S, grenze: 'normal', pvFreiW: 0, now: at('11:05') })).a;
  assert.equal(t.mode, 'PLAN_ZU');
  assert.equal(t.target, 20.5);
});

test('Netzgrenze gilt: höchstens max_grid_circuits Räume ohne Sonne', () => {
  const S2 = { ...S, max_grid_circuits: 1 };
  const its = items([[room('a', 1), 20.4], [room('b', 2), 20.4]]);
  const st = planStandAus(planRow([{ id: 'a', h: '1'.repeat(96) }, { id: 'b', h: '1'.repeat(96) }]), { modus: 'steuern', now: at('11:05') });
  const res = planAnwenden({ items: its, stand: st, settings: S2, grenze: 'normal', pvFreiW: 0, now: at('11:05') });
  assert.equal(byId(res).a.mode, 'PLAN');
  assert.equal(byId(res).b.mode, 'PLAN_ZU');
  assert.match(byId(res).b.reason, /Netzgrenze 1 Kreise voll/);
});

test('Manuell übersteuert bleibt unberührt', () => {
  const r = room('a', 2, { override_temp: 23, override_until: at('13:00').toISOString() });
  const its = items([[r, 20.4]]);
  const st = planStandAus(planRow([{ id: 'a' }]), { modus: 'steuern', now: at('11:05') });
  const res = planAnwenden({ items: its, stand: st, settings: S, grenze: 'normal', pvFreiW: 0, now: at('11:05') });
  assert.equal(byId(res).a.mode, 'OVERRIDE');
  assert.deepEqual(res.planRaeume, []);
});

test('Über Höchstwert + 0,3 → Ventil zu, auch wenn der Plan heizt', () => {
  const its = items([[room('a'), 22.4]]);
  const st = planStandAus(planRow([{ id: 'a', h: '1'.repeat(96) }]), { modus: 'steuern', now: at('11:05') });
  const t = byId(planAnwenden({ items: its, stand: st, settings: S, grenze: 'normal', pvFreiW: 5000, now: at('11:05') })).a;
  assert.equal(t.mode, 'PLAN_ZU');
});

test('Netzgrenze aus dem Tagesmodus, Sonnenstrom unter pv_min_soc nur aus Einspeisung', () => {
  assert.equal(grenzeAus('grid'), 'normal');
  for (const m of ['night', 'evening', 'wait']) assert.equal(grenzeAus(m), 'min');
  assert.equal(pvFreiAus({ pvW: 3000, gridW: -500, soc: 80 }, S), 3000 - S.baseload_w);
  assert.equal(pvFreiAus({ pvW: 3000, gridW: -500, soc: 40 }, S), 500);
  assert.equal(pvFreiAus(null, S), 0);
});
