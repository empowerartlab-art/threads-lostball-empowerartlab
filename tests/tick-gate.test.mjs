// lib/tick-gate.mjs: the window and the tick gates (identical in every posting repository).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SLOT_WINDOW, TICK_MODE, runKind, jstDateOf, minutesFromSlot, checkWindow, checkTick, decideRun, envLines, oneLine,
} from '../lib/tick-gate.mjs';

// 2026-10-21 12:25 JST = 03:25 UTC
const at = (jst) => new Date(`${jst}+09:00`);
const SLOTS = { morning: '07:25', noon: '12:25', night: '20:25' };
const okQueue = async () => ({ ok: true, detail: 'post p1' });

test('SLOT_WINDOW is the single tunable: 3 min early .. 60 min late', () => {
  assert.deepEqual({ ...SLOT_WINDOW }, { earlyMinutes: 3, lateMinutes: 60 });
  assert.ok(Object.isFrozen(SLOT_WINDOW));
  assert.equal(TICK_MODE, 'tick');
});

test('runKind: schedule / tick / manual', () => {
  assert.equal(runKind({ eventName: 'schedule' }), 'schedule');
  assert.equal(runKind({ eventName: 'schedule', mode: 'tick' }), 'schedule');
  assert.equal(runKind({ eventName: 'workflow_dispatch', mode: 'tick' }), 'tick');
  assert.equal(runKind({ eventName: 'workflow_dispatch', mode: 'live' }), 'manual');
  assert.equal(runKind({ eventName: 'workflow_dispatch', mode: '' }), 'manual');
  assert.equal(runKind({ eventName: 'workflow_dispatch' }), 'manual');
  assert.equal(runKind({ eventName: 'push', mode: 'tick' }), 'manual');
  assert.equal(runKind({}), 'manual');
});

test('jstDateOf / minutesFromSlot use JST', () => {
  assert.equal(jstDateOf(new Date('2026-10-20T15:00:00Z')), '2026-10-21');
  assert.equal(jstDateOf(new Date('2026-10-20T14:59:59Z')), '2026-10-20');
  assert.equal(minutesFromSlot({ date: '2026-10-21', time: '12:25', now: at('2026-10-21T12:35:00') }), 10);
  assert.equal(minutesFromSlot({ date: '2026-10-21', time: '12:25', now: at('2026-10-21T12:22:00') }), -3);
  assert.throws(() => minutesFromSlot({ date: '2026-10-21', time: '25:00', now: new Date() }));
  assert.throws(() => minutesFromSlot({ date: 'today', time: '12:25', now: new Date() }));
});

test('checkWindow: inside, both edges, too early, too late', () => {
  const w = (t) => checkWindow({ date: '2026-10-21', time: '12:25', now: at(`2026-10-21T${t}`) });
  assert.equal(w('12:22:00').ok, true); // -3 min edge
  assert.equal(w('12:25:00').ok, true);
  assert.equal(w('13:25:00').ok, true); // +60 min edge
  assert.equal(w('12:21:59').reason, 'too-early');
  assert.equal(w('13:25:01').reason, 'too-late');
  assert.equal(w('17:12:00').reason, 'too-late'); // a 5-hour-late GitHub cron
  assert.match(w('17:12:00').detail, /287 min after/);
  // a custom window is honoured
  assert.equal(checkWindow({ date: '2026-10-21', time: '12:25', now: at('2026-10-21T15:00:00'), window: { earlyMinutes: 0, lateMinutes: 600 } }).ok, true);
});

test('checkWindow: a night run that GitHub starts after midnight is too late', () => {
  const r = checkWindow({ date: '2026-10-21', time: '20:25', now: at('2026-10-22T00:40:00') });
  assert.equal(r.reason, 'too-late');
});

test('checkTick: every gate', () => {
  const base = { runAttempt: '1', slot: 'noon', date: '2026-10-21', slotTimes: SLOTS, start: '2026-10-20', now: at('2026-10-21T12:25:30') };
  assert.equal(checkTick(base).ok, true);
  assert.equal(checkTick({ ...base, runAttempt: '2' }).reason, 'not-first-attempt');
  assert.equal(checkTick({ ...base, runAttempt: 2 }).reason, 'not-first-attempt');
  assert.equal(checkTick({ ...base, runAttempt: '' }).reason, 'not-first-attempt');
  assert.equal(checkTick({ ...base, runAttempt: 1 }).ok, true);
  assert.equal(checkTick({ ...base, slot: 'legacy' }).reason, 'unknown-slot');
  assert.equal(checkTick({ ...base, slot: 'auto' }).reason, 'unknown-slot');
  assert.equal(checkTick({ ...base, slot: '' }).reason, 'unknown-slot');
  assert.equal(checkTick({ ...base, slot: 'toString' }).reason, 'unknown-slot');
  assert.equal(checkTick({ ...base, date: '' }).reason, 'bad-date');
  assert.equal(checkTick({ ...base, date: '2026/10/21' }).reason, 'bad-date');
  assert.equal(checkTick({ ...base, date: '2026-10-20' }).reason, 'not-today'); // yesterday
  assert.equal(checkTick({ ...base, date: '2026-10-22' }).reason, 'not-today'); // tomorrow
  assert.equal(checkTick({ ...base, slotTimes: { noon: '12:25' }, start: '2026-10-22', date: '2026-10-21' }).reason, 'before-start');
  assert.equal(checkTick({ ...base, now: at('2026-10-21T12:21:00') }).reason, 'too-early');
  assert.equal(checkTick({ ...base, now: at('2026-10-21T13:26:00') }).reason, 'too-late');
  assert.equal(checkTick({ ...base, slot: 'morning' }).reason, 'too-late'); // morning tick at noon
  assert.equal(checkTick({ ...base, slot: 'night' }).reason, 'too-early');
});

test('decideRun: manual keeps the existing behaviour', async () => {
  const d = await decideRun({ kind: 'manual', now: at('2026-10-21T03:00:00') });
  assert.equal(d.go, true);
  assert.equal(d.reason, 'manual');
});

test('decideRun: schedule inside / outside the window; no queue check needed', async () => {
  let called = 0;
  const q = async () => { called++; return { ok: false, reason: 'x' }; };
  const s = (t) => decideRun({ kind: 'schedule', slot: 'noon', date: '2026-10-21', time: '12:25', now: at(`2026-10-21T${t}`), queueCheck: q });
  assert.equal((await s('12:40:00')).go, true);
  const late = await s('17:12:00');
  assert.equal(late.go, false);
  assert.equal(late.reason, 'too-late');
  assert.equal(called, 0);
  assert.equal((await decideRun({ kind: 'schedule', slot: 'x', date: '2026-10-21', time: undefined, now: at('2026-10-21T12:25:00') })).reason, 'unknown-slot');
});

test('decideRun: tick passes only when every gate and the queue check pass', async () => {
  const base = { kind: 'tick', runAttempt: '1', slot: 'noon', date: '2026-10-21', slotTimes: SLOTS, now: at('2026-10-21T12:25:10') };
  const ok = await decideRun({ ...base, queueCheck: okQueue });
  assert.equal(ok.go, true);
  assert.equal(ok.reason, 'tick-ok');

  const seen = [];
  await decideRun({ ...base, queueCheck: async (a) => { seen.push(a); return { ok: true }; } });
  assert.deepEqual(seen, [{ slot: 'noon', date: '2026-10-21' }]);

  for (const reason of ['already-posted-slot', 'open-claim', 'not-approved', 'no-post-scheduled']) {
    const d = await decideRun({ ...base, queueCheck: async () => ({ ok: false, reason, detail: 'd' }) });
    assert.equal(d.go, false);
    assert.equal(d.reason, reason);
  }
  // gates before the queue: the queue is not even read
  let read = 0;
  const q = async () => { read++; return { ok: true }; };
  assert.equal((await decideRun({ ...base, runAttempt: '2', queueCheck: q })).reason, 'not-first-attempt');
  assert.equal((await decideRun({ ...base, date: '2026-10-20', queueCheck: q })).reason, 'not-today');
  assert.equal((await decideRun({ ...base, now: at('2026-10-21T14:00:00'), queueCheck: q })).reason, 'too-late');
  assert.equal(read, 0);
  // no queue check given: never go
  assert.equal((await decideRun({ ...base })).go, false);
});

test('envLines: one line each, no newline injection', () => {
  assert.deepEqual(envLines({ kind: 'tick', go: true, reason: 'tick-ok', detail: 'x' }), ['RUN_KIND=tick', 'RUN_GO=true', 'SKIP_REASON=']);
  const lines = envLines({ kind: 'tick', go: false, reason: 'too-late', detail: 'a\nRUN_GO=true' });
  assert.equal(lines[1], 'RUN_GO=false');
  assert.equal(lines.length, 3);
  assert.ok(!lines[2].includes('\n'));
  assert.equal(oneLine('a\r\nb'), 'a b');
});
