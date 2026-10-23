// lib/record-push.mjs: the Threads record push re-applies this run's JSON appends
// on top of the latest remote file instead of failing on a rebase conflict
// (2026-10-21: night ja and night_en both appended to data/threads-posts.json).
// In-memory git and files only: no git, no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addedEntries, mergeRecords, pushRecords, RECORD_PUSH_ATTEMPTS } from '../lib/record-push.mjs';

const POSTS = 'data/threads-posts.json';
const JOURNAL = 'data/threads-journal.json';
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const postsDoc = (posts, updatedAt) => ({ updatedAt, count: posts.length, _note: 'n', posts });
const rec = (id, run) => ({ threadsPostId: id, run, bodyJa: `本文${id}` });
const ev = (postId, stage) => ({ postId, stage, runId: 'r', runAttempt: '1' });

// A tiny fake git: `remote` is the branch tip; pushes fail while `rejectNext` > 0,
// and `beforePush` lets another run land first (the 10/21 race).
function fakeRepo({ head, remote, local, rejectNext = 0, beforePush = null }) {
  const state = { head: clone(head), remote: clone(remote), fetched: null, local: clone(local), staged: [], commits: [], pushes: 0, log: [] };
  const run = async (args) => {
    const [cmd] = args;
    state.log.push(args.join(' '));
    if (cmd === 'fetch') { state.fetched = clone(state.remote); return ''; }
    if (cmd === 'reset') { assert.deepEqual(args, ['reset', '-q', '--mixed', 'FETCH_HEAD']); state.head = clone(state.fetched); return ''; }
    if (cmd === 'add') { state.staged = args.slice(2); return ''; }
    if (cmd === 'commit') { state.commits.push(Object.fromEntries(state.staged.map((p) => [p, clone(state.local[p])]))); return ''; }
    if (cmd === 'push') {
      state.pushes++;
      if (beforePush) beforePush(state);
      if (rejectNext > 0 || JSON.stringify(state.remote) !== JSON.stringify(state.head)) {
        rejectNext = Math.max(0, rejectNext - 1);
        throw new Error('rejected (fetch first)');
      }
      const c = state.commits.at(-1);
      for (const [p, v] of Object.entries(c)) state.remote[p] = clone(v);
      state.head = clone(state.remote);
      return '';
    }
    throw new Error(`unexpected git ${args.join(' ')}`);
  };
  const readAt = async (ref, path) => {
    const tree = ref === 'HEAD' ? state.head : state.fetched;
    return path in tree ? clone(tree[path]) : null;
  };
  const opts = {
    run, branch: 'main', files: [POSTS, JOURNAL], message: 'chore(lostball): record Threads post (2026-10-21 night_en)',
    readAt, readLocal: async (p) => (p in state.local ? clone(state.local[p]) : null), writeLocal: async (p, v) => { state.local[p] = clone(v); },
    sleep: async () => {}, log: (m) => state.log.push(m),
  };
  return { state, opts };
}

test('addedEntries: what this run appended (multiset difference, order kept)', () => {
  const a = rec('1', 'night'); const b = rec('2', 'night_en');
  assert.deepEqual(addedEntries(postsDoc([a], 't0'), postsDoc([a, b], 't1')), [b]);
  assert.deepEqual(addedEntries(null, [ev('x', 'claimed')]), [ev('x', 'claimed')]);
  assert.deepEqual(addedEntries([ev('x', 'claimed')], [ev('x', 'claimed'), ev('x', 'claimed')]), [ev('x', 'claimed')]);
});

test('mergeRecords: appends to the latest remote, keeps other fields, recomputes count, never duplicates', () => {
  const a = rec('1', 'night'); const b = rec('2', 'night_en');
  const m = mergeRecords({ remote: postsDoc([a], '2026-10-21T12:31:00Z'), additions: [b], local: postsDoc([b], '2026-10-21T12:05:00Z') });
  assert.deepEqual(m.doc, { updatedAt: '2026-10-21T12:31:00Z', count: 2, _note: 'n', posts: [a, b] });
  assert.equal(m.appended, 1);
  assert.equal(mergeRecords({ remote: postsDoc([a, b], 't'), additions: [b], local: postsDoc([b], 't') }).appended, 0);
  assert.deepEqual(mergeRecords({ remote: null, additions: [ev('p', 'published')], local: [ev('p', 'published')] }).doc, [ev('p', 'published')]);
});

test('the 10/21 race: another run appended to the same files after our checkout -> both records survive, no conflict', async () => {
  const base = rec('0', 'noon');
  const night = rec('1', 'night');
  const nightEn = rec('2', 'night_en');
  const head = { [POSTS]: postsDoc([base], 't0'), [JOURNAL]: [ev('ja', 'claimed'), ev('en', 'claimed')] };
  // While we posted, the night (ja) run recorded its post and its 'published' entry.
  const remote = { [POSTS]: postsDoc([base, night], 't1'), [JOURNAL]: [ev('ja', 'claimed'), ev('en', 'claimed'), ev('ja', 'published')] };
  const local = { [POSTS]: postsDoc([base, nightEn], 't2'), [JOURNAL]: [ev('ja', 'claimed'), ev('en', 'claimed'), ev('en', 'published')] };
  const { state, opts } = fakeRepo({ head, remote, local });
  const r = await pushRecords(opts);
  assert.deepEqual([r.pushed, r.attempts, r.appended], [true, 1, 2]);
  assert.deepEqual(state.remote[POSTS].posts, [base, night, nightEn]);
  assert.equal(state.remote[POSTS].count, 3);
  assert.deepEqual(state.remote[JOURNAL], [ev('ja', 'claimed'), ev('en', 'claimed'), ev('ja', 'published'), ev('en', 'published')]);
  assert.ok(!state.log.some((l) => /rebase|merge/.test(l)), 'no rebase, so no rebase conflict');
});

test('a push rejected because someone landed in between -> re-read the newer remote and append again', async () => {
  const base = rec('0', 'noon');
  const mine = rec('2', 'night_en');
  const other = rec('9', 'x-unrelated');
  const head = { [POSTS]: postsDoc([base], 't0') };
  const { state, opts } = fakeRepo({
    head, remote: clone(head), local: { [POSTS]: postsDoc([base, mine], 't2') },
    beforePush: (s) => { if (s.pushes === 1) s.remote[POSTS] = postsDoc([base, other], 't1'); },
  });
  const r = await pushRecords(opts);
  assert.deepEqual([r.pushed, r.attempts], [true, 2]);
  assert.deepEqual(state.remote[POSTS].posts, [base, other, mine]);
  assert.equal(state.log.filter((l) => l === 'fetch origin main').length, 2);
});

test('gives up (throws) after 5 rejected pushes; never calls anything but git', async () => {
  const { opts } = fakeRepo({ head: { [POSTS]: postsDoc([], 't0') }, remote: { [POSTS]: postsDoc([], 't0') }, local: { [POSTS]: postsDoc([rec('1', 'night')], 't1') }, rejectNext: 99 });
  await assert.rejects(pushRecords(opts), /rejected 5 times/);
  assert.equal(RECORD_PUSH_ATTEMPTS, 5);
});

test('nothing new, or already on the remote -> no commit, no push', async () => {
  const doc = postsDoc([rec('1', 'night')], 't1');
  const same = fakeRepo({ head: { [POSTS]: doc }, remote: { [POSTS]: doc }, local: { [POSTS]: doc } });
  assert.deepEqual(await pushRecords(same.opts), { pushed: false, attempts: 0, appended: 0 });
  assert.equal(same.state.pushes, 0);
  const landed = fakeRepo({ head: { [POSTS]: postsDoc([], 't0') }, remote: { [POSTS]: doc }, local: { [POSTS]: doc } });
  const r = await pushRecords(landed.opts);
  assert.equal(r.pushed, false);
  assert.equal(landed.state.pushes, 0);
});
