// scripts/run-gate.mjs: schedule window / tick gates / queue check, per medium (Threads, X, Instagram).
// Mocks only: an in-memory io, a fixed clock. No git, no network, no repository data.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { planGate, MEDIA, IG_SLOT, IG_TIME } from '../scripts/run-gate.mjs';
import { RUNS } from '../lib/slots.mjs';
import { X_RUNS } from '../lib/x-slots.mjs';

const at = (jst) => new Date(`${jst}+09:00`);
const D = '2026-10-21';

function memIo(files) {
  return {
    files,
    async readJson(path, fallback) {
      if (!(path in files)) {
        if (fallback !== undefined) return fallback;
        throw new Error(`missing ${path}`);
      }
      return structuredClone(files[path]);
    },
    async writeJson(path, value) { files[path] = structuredClone(value); },
  };
}

// ---- fixtures ----
const threadsItem = (over = {}) => ({
  id: `t-${over.slot ?? 'noon'}-${over.lang ?? 'ja'}`, day: 1, pillar: 'p', category: 'c',
  bodyEn: 'Lost balls get a second life.', bodyJa: 'ロストボールを一つずつ磨いています。',
  hasCta: false, hasShopLink: false, requiresVerifiedFact: false, verifiedFactIds: [],
  media: { type: 'TEXT_ONLY', required: false }, targetDate: D,
  approvedBy: 'k', approvedAt: '2026-10-18T00:00:00Z', slot: 'noon', lang: 'ja', ...over,
});
const threadsFiles = ({ items = [threadsItem()], posts = [], journal } = {}) => ({
  'data/draft-bank.json': { items },
  'data/threads-posts.json': { posts },
  'data/verified-facts.json': { facts: [] },
  ...(journal ? { 'data/threads-journal.json': journal } : {}),
});
const xItem = (over = {}) => ({ id: `x-${D}-noon`, date: D, slot: 'noon', text: 'ロストボールの話', approved: true, approvedBy: 'k', approvedAt: '2026-10-18', ...over });
const xFiles = ({ queue = [xItem()], posted = [], journal } = {}) => ({
  'data/x-queue.json': queue, 'data/x-posts.json': posted, ...(journal ? { 'data/x-journal.json': journal } : {}),
});
const igItem = (over = {}) => ({ id: `ig-${D}`, date: D, approved: true, ...over });
const igFiles = ({ queue = [igItem()], posted = [], journal } = {}) => ({
  'data/ig-queue.json': queue, 'data/ig-posts.json': posted, ...(journal ? { 'data/ig-journal.json': journal } : {}),
});
const openEntry = (postId) => [{ postId, date: '2026-10-20', stage: 'unknown', runId: '9', runAttempt: '1', at: 'x', threadsId: null, note: null }];

const tickEnv = (slot, over = {}) => ({ GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_RUN_ATTEMPT: '1', RUN_MODE: 'tick', TICK_SLOT: slot, TICK_DATE: D, TICK_ID: 't1', ...over });

// Each medium: the slot a tick names, its time, the resolver's pin, and fixture builders.
const CASES = {
  threads: {
    slot: 'noon', time: '12:35', pin: { RUN_SLOT: 'noon', RUN_DATE: D },
    files: threadsFiles,
    posted: () => threadsFiles({ posts: [{ sourceItemId: 't-noon-ja', bodyEn: 'other', bodyJa: '別の文' }] }),
    unapproved: () => threadsFiles({ items: [threadsItem({ approvedBy: undefined, approvedAt: undefined })] }),
    open: () => threadsFiles({ journal: openEntry('t-old') }),
  },
  x: {
    slot: 'noon', time: '12:10', pin: { RUN_SLOT: 'noon', RUN_DATE: D },
    files: xFiles,
    posted: () => xFiles({ posted: [{ id: `x-${D}-noon`, date: D, slot: 'noon', text: 'ロストボールの話' }] }),
    unapproved: () => xFiles({ queue: [xItem({ approved: false })] }),
    open: () => xFiles({ journal: openEntry('x-old') }),
  },
  ig: {
    slot: IG_SLOT, time: IG_TIME, pin: {},
    files: igFiles,
    posted: () => igFiles({ posted: [{ id: `ig-${D}`, date: D }] }),
    unapproved: () => igFiles({ queue: [igItem({ approved: false })] }),
    open: () => igFiles({ journal: openEntry('ig-old') }),
  },
};

const plus = (time, minutes) => {
  const [h, m] = time.split(':').map(Number);
  const t = h * 60 + m + minutes;
  return `${D}T${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}:00`;
};

for (const [media, c] of Object.entries(CASES)) {
  const gate = (env, now, files = c.files()) => planGate({ media, env, now: at(now), io: memIo(files) });

  test(`${media}: tick inside the window -> go`, async () => {
    for (const offset of [-3, 0, 10, 60]) {
      const d = await gate(tickEnv(c.slot, c.pin), plus(c.time, offset));
      assert.equal(d.go, true, `offset ${offset}: ${d.reason} ${d.detail}`);
      assert.equal(d.reason, 'tick-ok');
      assert.equal(d.kind, 'tick');
    }
  });

  test(`${media}: tick outside the window (early / late) -> skip`, async () => {
    assert.equal((await gate(tickEnv(c.slot, c.pin), plus(c.time, -4))).reason, 'too-early');
    assert.equal((await gate(tickEnv(c.slot, c.pin), plus(c.time, 61))).reason, 'too-late');
    assert.equal((await gate(tickEnv(c.slot, c.pin), plus(c.time, 300))).go, false);
  });

  test(`${media}: tick for another date, re-run attempt 2, unknown slot -> skip`, async () => {
    const now = plus(c.time, 1);
    assert.equal((await gate(tickEnv(c.slot, { ...c.pin, TICK_DATE: '2026-10-20' }), now)).reason, 'not-today');
    assert.equal((await gate(tickEnv(c.slot, { ...c.pin, TICK_DATE: '' }), now)).reason, 'bad-date');
    assert.equal((await gate(tickEnv(c.slot, { ...c.pin, GITHUB_RUN_ATTEMPT: '2' }), now)).reason, 'not-first-attempt');
    assert.equal((await gate(tickEnv('legacy', c.pin), now)).reason, 'unknown-slot');
    assert.equal((await gate(tickEnv('', c.pin), now)).reason, 'unknown-slot');
  });

  test(`${media}: tick when already posted / open claim / unapproved -> skip`, async () => {
    const now = plus(c.time, 1);
    const posted = await gate(tickEnv(c.slot, c.pin), now, c.posted());
    assert.equal(posted.go, false);
    assert.match(posted.reason, /already-posted/);
    const open = await gate(tickEnv(c.slot, c.pin), now, c.open());
    assert.equal(open.go, false);
    assert.equal(open.reason, 'open-claim');
    const unapproved = await gate(tickEnv(c.slot, c.pin), now, c.unapproved());
    assert.equal(unapproved.go, false);
    assert.equal(unapproved.reason, 'not-approved');
    assert.equal((await gate(tickEnv(c.slot, c.pin), now, c.files({ queue: [], items: [] }))).go, false);
  });

  test(`${media}: manual runs are unchanged (RUN_GO=true, nothing read)`, async () => {
    for (const mode of ['dry-run', 'live', '']) {
      const d = await planGate({ media, env: { GITHUB_EVENT_NAME: 'workflow_dispatch', RUN_MODE: mode, GITHUB_RUN_ATTEMPT: '3' }, now: at(`${D}T03:00:00`), io: memIo({}) });
      assert.equal(d.go, true);
      assert.equal(d.kind, 'manual');
    }
  });
}

test('threads / x: a tick whose resolved slot or date differs from the tick is skipped (decide-mismatch)', async () => {
  for (const media of ['threads', 'x']) {
    const c = CASES[media];
    const d = await planGate({ media, env: tickEnv(c.slot, { RUN_SLOT: 'morning', RUN_DATE: D }), now: at(plus(c.time, 1)), io: memIo(c.files()) });
    assert.equal(d.reason, 'decide-mismatch');
    const e = await planGate({ media, env: tickEnv(c.slot, { RUN_SLOT: '', RUN_DATE: '' }), now: at(plus(c.time, 1)), io: memIo(c.files()) });
    assert.equal(e.reason, 'decide-mismatch');
  }
});

test('threads: tick slots are the four real runs only (night_en 21:00, no legacy_ja)', () => {
  assert.deepEqual(MEDIA.threads.slotTimes, { morning: '07:35', noon: '12:35', night: '20:35', night_en: '21:00' });
  assert.deepEqual(MEDIA.x.slotTimes, { morning: '07:10', noon: '12:10', night: '20:10' });
  assert.deepEqual(MEDIA.ig.slotTimes, { daily: '07:00' });
});

test('threads: night_en tick at 21:05 posts the English night item', async () => {
  const files = threadsFiles({ items: [threadsItem({ slot: 'night', lang: 'en', bodyEn: 'Polished lost balls, ready again.' })] });
  const d = await planGate({ media: 'threads', env: tickEnv('night_en', { RUN_SLOT: 'night_en', RUN_DATE: D }), now: at(`${D}T21:05:00`), io: memIo(files) });
  assert.equal(d.go, true, d.detail);
  assert.match(d.detail, /post t-night-en/);
});

test('threads: a tick is skipped when the journal already says published for the item', async () => {
  const journal = [{ postId: 't-noon-ja', date: D, stage: 'published', runId: '1', runAttempt: '1', at: 'x', threadsId: 'T', note: null }];
  const d = await planGate({ media: 'threads', env: tickEnv('noon', CASES.threads.pin), now: at(`${D}T12:36:00`), io: memIo(threadsFiles({ journal })) });
  assert.equal(d.reason, 'already-posted');
});

// ---- schedule ----
const schedEnv = (slot, date = D) => ({ GITHUB_EVENT_NAME: 'schedule', GITHUB_RUN_ATTEMPT: '1', RUN_SLOT: slot, RUN_DATE: date });

test('threads schedule: on time -> go, GitHub-late beyond +60 min -> skip (every run incl. night_en and legacy_ja)', async () => {
  for (const r of RUNS) {
    const on = await planGate({ media: 'threads', env: schedEnv(r.id), now: at(plus(r.time, 5)), io: memIo({}) });
    assert.equal(on.go, true, `${r.id} on time`);
    const late = await planGate({ media: 'threads', env: schedEnv(r.id), now: at(plus(r.time, 61)), io: memIo({}) });
    assert.equal(late.go, false, `${r.id} late`);
    assert.equal(late.reason, 'too-late');
  }
  // 21:00 English started by GitHub after midnight: resolved to the previous day -> far too late.
  const d = await planGate({ media: 'threads', env: schedEnv('night_en', D), now: at('2026-10-22T00:20:00'), io: memIo({}) });
  assert.equal(d.reason, 'too-late');
  // a schedule run never reads the queue (the claim step and the existing guards decide as before)
  assert.equal((await planGate({ media: 'threads', env: schedEnv('noon'), now: at(`${D}T12:40:00`), io: memIo({}) })).reason, 'in-window');
});

test('x schedule: on time -> go, late -> skip; ig schedule uses 07:00 today', async () => {
  for (const r of X_RUNS) {
    assert.equal((await planGate({ media: 'x', env: schedEnv(r.id), now: at(plus(r.time, 2)), io: memIo({}) })).go, true, r.id);
    assert.equal((await planGate({ media: 'x', env: schedEnv(r.id), now: at(plus(r.time, 90)), io: memIo({}) })).reason, 'too-late', r.id);
  }
  assert.equal((await planGate({ media: 'ig', env: { GITHUB_EVENT_NAME: 'schedule' }, now: at(`${D}T07:30:00`), io: memIo({}) })).go, true);
  assert.equal((await planGate({ media: 'ig', env: { GITHUB_EVENT_NAME: 'schedule' }, now: at(`${D}T10:15:00`), io: memIo({}) })).reason, 'too-late');
});

test('schedule without a resolved slot is an internal error (job fails, nothing posts)', async () => {
  await assert.rejects(planGate({ media: 'threads', env: { GITHUB_EVENT_NAME: 'schedule' }, now: at(`${D}T12:40:00`), io: memIo({}) }));
  await assert.rejects(planGate({ media: 'nope', env: {}, now: new Date(), io: memIo({}) }));
});

// ---- workflow wiring (text + YAML-free checks) ----
const wf = (name) => readFileSync(fileURLToPath(new URL(`../.github/workflows/${name}`, import.meta.url)), 'utf8');
const strip = (s) => s.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');

test('every posting workflow declares mode(tick) / slot / date / tick_id, a quoted run-name, and the gate', () => {
  for (const [name, media] of [['daily-live-post.yml', 'threads'], ['x-post.yml', 'x'], ['ig-post.yml', 'ig']]) {
    const c = strip(wf(name));
    assert.match(c, /^run-name: "\$\{\{ inputs\.mode == 'tick' && format\(.*\}\}"$/m, `${name}: run-name`);
    for (const input of ['mode', 'slot', 'date', 'tick_id']) assert.match(c, new RegExp(`^      ${input}:\\s*$`, 'm'), `${name}: input ${input}`);
    assert.match(c, /- tick\b/, `${name}: mode option tick`);
    assert.match(c, new RegExp(`node scripts/run-gate\\.mjs --media ${media}`), `${name}: gate`);
    assert.match(c, /TICK_ID: \$\{\{ (github\.event\.)?inputs\.tick_id \|\| '' \}\}/);
    assert.ok(c.indexOf('run-gate.mjs') < c.indexOf('claim.mjs'), `${name}: gate before claim`);
  }
});

test('claim / publish / record steps run only when RUN_GO is true; a tick never uses the dry-run date', () => {
  const threads = strip(wf('daily-live-post.yml'));
  for (const id of ['claim', 'publish', 'commit-state']) {
    const block = threads.slice(threads.indexOf(`id: ${id}`), threads.indexOf(`id: ${id}`) + 300);
    assert.match(block, /env\.RUN_GO == 'true'/, `threads ${id}`);
  }
  assert.ok(threads.indexOf('threads-claim.mjs') < threads.indexOf('post-to-threads.mjs'), 'claim before publish');
  assert.match(threads, /RUN_DATE_INPUT: \$\{\{ \(github\.event_name == 'workflow_dispatch' && github\.event\.inputs\.mode == 'dry-run'\)/);
  // every Threads notification / warning step after the publish step is gated
  for (const block of threads.split(/^\s{6}- name:/m).filter((b) => /steps\.publish\.outputs\.outcome ==|steps\.claim\.outcome/.test(b.split('\n').find((l) => l.trim().startsWith('if:')) ?? ''))) {
    assert.match(block, /env\.RUN_GO == 'true'/, block.split('\n')[0]);
  }

  const x = strip(wf('x-post.yml'));
  for (const id of ['claim', 'publish']) assert.match(x.slice(x.indexOf(`id: ${id}`), x.indexOf(`id: ${id}`) + 200), /env\.RUN_GO == 'true'/, `x ${id}`);
  assert.match(x, /RUN_DATE_INPUT: \$\{\{ github\.event_name == 'workflow_dispatch' && inputs\.mode != 'tick'/);
  assert.match(x, /\(github\.event_name == 'schedule' \|\| \(github\.event_name == 'workflow_dispatch' && \(inputs\.mode == 'tick' \|\| \(inputs\.confirm == 'POST LIVE' && github\.run_attempt == '1'\)\)\)\) && secrets\.X_LIVE_POST == 'true'/);

  const ig = strip(wf('ig-post.yml'));
  for (const id of ['claim', 'publish']) assert.match(ig.slice(ig.indexOf(`id: ${id}`), ig.indexOf(`id: ${id}`) + 200), /env\.RUN_GO == 'true'/, `ig ${id}`);
  assert.match(ig, /TARGET_DATE: \$\{\{ \(github\.event_name == 'workflow_dispatch' && inputs\.mode == 'dry-run'\) && inputs\.target_date \|\| '' \}\}/);
  assert.match(ig, /inputs\.mode == 'tick'\)\) && secrets\.IG_LIVE_POST == 'true'/);
  // notifications never fire for a skipped run
  for (const c of [x, ig]) assert.match(c, /always\(\) && env\.LIVE_POST == 'true' && env\.RUN_GO != 'false'/);
});
