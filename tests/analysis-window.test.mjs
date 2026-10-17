// Saturday review analysis period: Sat..Fri before the run (JST); the first one is 10/12..10/23.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analysisWindow, windowLabel, under24h } from '../lib/analysis-window.mjs';

const at = (iso) => analysisWindow(new Date(iso));

test('first review on 2026-10-24 covers 2026-10-12..2026-10-23', () => {
  const w = at('2026-10-24T07:47:00+09:00');
  assert.deepEqual([w.start, w.end], ['2026-10-12', '2026-10-23']);
  assert.equal(w.since, '2026-10-11T15:00:00.000Z');
  assert.equal(w.until, '2026-10-23T15:00:00.000Z');
  assert.equal(windowLabel(w), '10/12〜10/23');
});

test('later Saturdays cover the 7 days Saturday..Friday before the run', () => {
  assert.deepEqual([at('2026-10-31T07:47:00+09:00').start, at('2026-10-31T07:47:00+09:00').end], ['2026-10-24', '2026-10-30']);
  assert.deepEqual([at('2026-11-07T07:30:00+09:00').start, at('2026-11-07T07:30:00+09:00').end], ['2026-10-31', '2026-11-06']);
});

test('a run late on Friday UTC that is already Saturday in JST counts as Saturday', () => {
  const w = at('2026-10-30T22:47:00Z'); // 2026-10-31 07:47 JST
  assert.deepEqual([w.start, w.end], ['2026-10-24', '2026-10-30']);
});

test('a manual run on another weekday analyses the last complete Saturday..Friday', () => {
  assert.deepEqual([at('2026-11-03T12:00:00+09:00').start, at('2026-11-03T12:00:00+09:00').end], ['2026-10-24', '2026-10-30']);
  // any period that ends on 2026-10-23 is the transition one (from 10/12)
  assert.deepEqual([at('2026-10-30T12:00:00+09:00').start, at('2026-10-30T12:00:00+09:00').end], ['2026-10-12', '2026-10-23']);
});

test('under24h marks posts that are less than a day old', () => {
  const now = new Date('2026-10-24T07:47:00+09:00');
  assert.equal(under24h('2026-10-23T20:45:00+09:00', now), true);
  assert.equal(under24h('2026-10-23T07:45:00+09:00', now), false);
});
