import test from 'node:test';
import assert from 'node:assert/strict';
import { planDue, learnDue, Planer, PLAN_EVERY_MS } from '../src/planer.js';

test('Planer: alle 15 Minuten planen', () => {
  const t = Date.parse('2026-11-12T10:00:00Z');
  assert.equal(planDue(t, 0), true);
  assert.equal(planDue(t, t - 60_000), false);
  assert.equal(planDue(t, t - PLAN_EVERY_MS), true);
  assert.equal(planDue(t, t - PLAN_EVERY_MS + 20_000), true);   // Takt des Collectors schwankt um Sekunden
});

test('Planer: einmal täglich ab 03:00 lernen, bis 05:00 nachholen', () => {
  assert.equal(learnDue({ today: '2026-11-12', minutes: 2 * 60 + 59, lastLearnDay: null }), false);
  assert.equal(learnDue({ today: '2026-11-12', minutes: 3 * 60, lastLearnDay: '2026-11-11' }), true);
  assert.equal(learnDue({ today: '2026-11-12', minutes: 4 * 60 + 30, lastLearnDay: null }), true);
  assert.equal(learnDue({ today: '2026-11-12', minutes: 5 * 60, lastLearnDay: null }), false);
  assert.equal(learnDue({ today: '2026-11-12', minutes: 3 * 60 + 5, lastLearnDay: '2026-11-12' }), false);
});

test('Planer: ruft die Edge Function auf, nie zwei Läufe gleichzeitig', async () => {
  const calls = [];
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, opt) => { calls.push({ url, body: JSON.parse(opt.body) }); return { ok: true, text: async () => '{"ok":true}' }; };
  try {
    const p = new Planer({ url: 'https://x.supabase.co/', key: 'k', log: () => {} });
    const rooms = [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }];
    p.tick({ now: new Date('2026-11-12T02:01:00Z'), today: '2026-11-12', minutes: 3 * 60 + 1, rooms });
    p.tick({ now: new Date('2026-11-12T02:02:00Z'), today: '2026-11-12', minutes: 3 * 60 + 2, rooms });   // busy → nichts
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(calls[0].url, 'https://x.supabase.co/functions/v1/heizplaner-muenchen');
    assert.deepEqual(calls.map((c) => c.body.aktion), ['lernen', 'lernen', 'pv_lernen', 'vergleich', 'planen']);
    assert.deepEqual(calls.slice(0, 2).map((c) => c.body.raum), ['a', 'b']);
  } finally {
    globalThis.fetch = orig;
  }
});

test('Planer: ohne Supabase aus', () => {
  const p = new Planer({ url: null, key: null, log: () => {} });
  assert.equal(p.enabled, false);
  p.tick({ now: new Date(), today: '2026-11-12', minutes: 200, rooms: [] });
});
