// lib/threads-claim.mjs: Threads claim-before-post. Mocks only: an in-memory io, a fake git remote,
// and a fake publish function in place of the Threads API (no fetch, no git, no network).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as J from '../lib/ig-journal.mjs';
import {
  runThreadsClaim, runThreadsPostWithClaim, runThreadsResolve, journalStageFor, claimStatus,
  THREADS_JOURNAL_PATH, THREADS_POSTED_PATH,
} from '../lib/threads-claim.mjs';
import { OUTCOME } from '../lib/live-post-runner.mjs';

const D = '2026-10-21';
const item = (over = {}) => ({
  id: `t-${over.slot ?? 'noon'}-${over.lang ?? 'ja'}`, day: 1, pillar: 'p', category: 'c',
  bodyEn: 'Lost balls get a second life.', bodyJa: 'ロストボールを一つずつ磨いています。',
  hasCta: false, hasShopLink: false, requiresVerifiedFact: false, verifiedFactIds: [],
  media: { type: 'TEXT_ONLY', required: false }, targetDate: D,
  approvedBy: 'k', approvedAt: '2026-10-18T00:00:00Z', slot: 'noon', lang: 'ja', ...over,
});

function world({ items = [item()], journal } = {}) {
  const events = [];
  const files = {
    'data/draft-bank.json': { items },
    'data/threads-posts.json': { posts: [] },
    'data/verified-facts.json': { facts: [] },
  };
  if (journal) files[THREADS_JOURNAL_PATH] = structuredClone(journal);
  const remote = journal ? { [THREADS_JOURNAL_PATH]: structuredClone(journal) } : {};
  const io = {
    async readJson(path, fallback) {
      if (!(path in files)) {
        if (fallback !== undefined) return fallback;
        throw new Error(`missing ${path}`);
      }
      return structuredClone(files[path]);
    },
    async writeJson(path, value) { files[path] = structuredClone(value); },
  };
  const ctl = { failPush: 0, failFetch: false };
  let staged = [];
  const git = async (args) => {
    const [cmd] = args;
    if (cmd === 'fetch') {
      if (ctl.failFetch) throw new Error('network down');
      return '';
    }
    if (cmd === 'show') {
      const path = args[1].slice('FETCH_HEAD:'.length);
      if (!(path in remote)) throw new Error('no such path');
      return JSON.stringify(remote[path]);
    }
    if (cmd === 'add') { staged = args.slice(2); return ''; }
    if (cmd === 'diff') return staged.join('\n');
    if (cmd === 'commit') return '';
    if (cmd === 'pull') return '';
    if (cmd === 'push') {
      if (ctl.failPush > 0) { ctl.failPush--; throw new Error('rejected'); }
      for (const f of staged) remote[f] = structuredClone(files[f]);
      events.push(`push:${staged.join(',')}`);
      return '';
    }
    throw new Error(`unexpected git ${args.join(' ')}`);
  };
  return { files, remote, io, git, ctl, events };
}

const common = (w, runId = '100') => ({
  io: w.io, git: w.git, branch: 'main', todayKey: D, run: 'noon', runId, runAttempt: '1',
  now: () => '2026-10-21T03:35:00Z', log: () => {}, sleep: async () => {},
});

const fakePublish = (w, behaviour = 'ok') => async (args) => {
  if (!(args.live === true && args.env?.LIVE_POST === 'true')) return { mode: 'dry-run', body: 'x' };
  w.events.push('api');
  if (behaviour === 'container-fail') {
    const err = new Error('container failed');
    err.containerCreationFailure = true;
    err.retryExhausted = true;
    throw err;
  }
  if (behaviour === 'publish-fail') throw new Error('threads_publish 500');
  return { mode: 'live', threadsPostId: 'T-1', body: args.bodyJa };
};

async function post(w, { behaviour = 'ok', runId = '100', claimed = true, saveFails = false, run = 'noon' } = {}) {
  const bank = await w.io.readJson('data/draft-bank.json');
  const posts = await w.io.readJson(THREADS_POSTED_PATH);
  return runThreadsPostWithClaim({
    ...common(w, runId), run, claimed, errLog: () => {},
    runnerArgs: {
      bankItems: bank.items, postedPosts: posts.posts, facts: [], todayKey: D, run,
      userId: 'u', accessToken: 'tok', live: true, env: { LIVE_POST: 'true' },
      publish: fakePublish(w, behaviour),
      saveState: async (record) => {
        if (saveFails) throw new Error('disk full');
        const cur = await w.io.readJson(THREADS_POSTED_PATH);
        await w.io.writeJson(THREADS_POSTED_PATH, { ...cur, posts: [...cur.posts, record] });
      },
    },
  });
}

const remoteJournal = (w) => w.remote[THREADS_JOURNAL_PATH] ?? [];

test('the claim is pushed to the remote before the Threads API is called; success records published', async () => {
  const w = world();
  const c = await runThreadsClaim(common(w));
  assert.equal(c.code, 0);
  assert.equal(c.postId, 't-noon-ja');
  assert.deepEqual(remoteJournal(w).map((e) => e.stage), ['claimed']);
  assert.equal(remoteJournal(w)[0].run, 'noon');

  const r = await post(w);
  assert.equal(r.result.outcome, OUTCOME.POSTED_STATE_SAVED);
  assert.equal(r.journalStage, 'published');
  assert.deepEqual(w.events, [`push:${THREADS_JOURNAL_PATH}`, 'api']);
  // published is written locally next to the posted record; the workflow's commit/push step pushes both.
  assert.deepEqual(w.files[THREADS_JOURNAL_PATH].map((e) => e.stage), ['claimed', 'published']);
  assert.equal(w.files[THREADS_JOURNAL_PATH][1].threadsId, 'T-1');
  assert.equal(w.files[THREADS_POSTED_PATH].posts.length, 1);
  assert.equal(J.openEntries(w.files[THREADS_JOURNAL_PATH]).length, 0);
  // until that push lands, the remote still has the claim open (later slots would halt)
  assert.equal(J.openEntries(remoteJournal(w)).length, 1);
});

test('a claim that cannot be pushed means no API call at all', async () => {
  const w = world();
  w.ctl.failPush = 5;
  const c = await runThreadsClaim(common(w));
  assert.equal(c.code, 1);
  assert.equal(c.reason, 'claim-not-persisted');
  const r = await post(w, { claimed: false });
  assert.equal(r.result.outcome, OUTCOME.PRE_POST_FAILURE);
  assert.equal(r.result.reason, 'claim-check-failed');
  assert.equal(r.journalStage, 'left-open');
  assert.ok(!w.events.includes('api'), 'Threads API must not be called');
});

test('the claim push is retried up to 5 times with pull --rebase (guarded) before giving up', async () => {
  const w = world();
  w.ctl.failPush = 4;
  assert.equal((await runThreadsClaim(common(w))).code, 0);
});

test('an unreadable remote journal means no claim and no post', async () => {
  const w = world();
  w.ctl.failFetch = true;
  assert.equal((await runThreadsClaim(common(w))).reason, 'remote-unreadable');
  const r = await post(w, { claimed: false });
  assert.equal(r.result.reason, 'claim-check-failed');
  assert.ok(!w.events.includes('api'));
});

test('an open entry halts every later live Threads run (other slots and night_en), with no API call', async () => {
  const open = [{ postId: 't-morning-ja', date: D, stage: 'unknown', runId: '90', runAttempt: '1', at: 'x', threadsId: null, note: null }];
  for (const [run, it] of [['noon', item()], ['night_en', item({ slot: 'night', lang: 'en', bodyEn: 'Polished lost balls, ready again.' })]]) {
    const w = world({ items: [it], journal: open });
    const c = await runThreadsClaim({ ...common(w), run });
    assert.equal(c.code, 1, run);
    assert.equal(c.halted, true);
    assert.equal(c.reason, 'open-claim');
    assert.deepEqual(remoteJournal(w).map((e) => e.stage), ['unknown'], 'nothing appended');
    const r = await post(w, { claimed: false, run });
    assert.equal(r.result.reason, 'claim-check-failed');
    assert.ok(!w.events.includes('api'), `${run}: no API call`);
  }
});

test('a claim made by another run is not mine: the publish step refuses', async () => {
  const w = world();
  await runThreadsClaim(common(w, '100'));
  const r = await post(w, { runId: '101' });
  assert.equal(r.result.reason, 'claim-check-failed');
  assert.ok(!w.events.includes('api'));
});

test('publish call error -> unknown: the claim stays open and is never auto-reposted', async () => {
  const w = world();
  await runThreadsClaim(common(w));
  const r = await post(w, { behaviour: 'publish-fail' });
  assert.equal(r.result.outcome, OUTCOME.PRE_POST_FAILURE);
  assert.equal(r.journalStage, 'unknown');
  assert.equal(r.persisted, true);
  assert.deepEqual(remoteJournal(w).map((e) => e.stage), ['claimed', 'unknown']);
  assert.equal(J.openEntries(remoteJournal(w)).length, 1, 'unknown stays open');
  // the next run (same item, a re-run, or the next slot) halts instead of posting again
  w.events.length = 0;
  const again = await runThreadsClaim(common(w, '200'));
  assert.equal(again.halted, true);
  assert.ok(!w.events.includes('api'));
});

test('container creation failure -> aborted: the claim is closed and the next run proceeds', async () => {
  const w = world();
  await runThreadsClaim(common(w));
  const r = await post(w, { behaviour: 'container-fail' });
  assert.equal(r.journalStage, 'aborted');
  assert.deepEqual(remoteJournal(w).map((e) => e.stage), ['claimed', 'aborted']);
  assert.equal(J.openEntries(remoteJournal(w)).length, 0);
  assert.equal((await runThreadsClaim(common(w, '300'))).code, 0, 'not halted');
});

test('an aborted outcome that cannot be pushed leaves the claim open (halts later slots)', async () => {
  const w = world();
  await runThreadsClaim(common(w));
  w.ctl.failPush = 5;
  const r = await post(w, { behaviour: 'container-fail' });
  assert.equal(r.journalStage, 'aborted');
  assert.equal(r.persisted, false);
  assert.equal(J.openEntries(remoteJournal(w)).length, 1);
});

test('posted but the record could not be saved -> claim left open, nothing closed', async () => {
  const w = world();
  await runThreadsClaim(common(w));
  const r = await post(w, { saveFails: true });
  assert.equal(r.result.outcome, OUTCOME.POSTED_STATE_SAVE_FAILED);
  assert.equal(r.journalStage, 'left-open');
  assert.deepEqual(remoteJournal(w).map((e) => e.stage), ['claimed']);
});

test('nothing to claim (no item for this slot) -> quiet skip, no journal file is created', async () => {
  const w = world({ items: [] });
  const c = await runThreadsClaim(common(w));
  assert.equal(c.code, 0);
  assert.equal(c.skip, true);
  assert.equal(w.files[THREADS_JOURNAL_PATH], undefined);
  const r = await post(w, { claimed: false });
  assert.equal(r.result.outcome, OUTCOME.NO_CANDIDATE);
  assert.equal(r.journalStage, 'none');
});

test('a dry run (LIVE_POST not "true") never checks or writes the journal', async () => {
  const w = world();
  const bank = await w.io.readJson('data/draft-bank.json');
  const r = await runThreadsPostWithClaim({
    ...common(w), claimed: false, errLog: () => {},
    runnerArgs: { bankItems: bank.items, postedPosts: [], facts: [], todayKey: D, run: 'noon', live: true, env: {}, publish: fakePublish(w) },
  });
  assert.equal(r.result.outcome, OUTCOME.DRY_RUN);
  assert.equal(r.journalStage, 'none');
  assert.deepEqual(w.events, []);
  assert.equal(w.files[THREADS_JOURNAL_PATH], undefined);
});

test('journalStageFor / claimStatus', () => {
  assert.equal(journalStageFor({ outcome: OUTCOME.POSTED_STATE_SAVED }), 'published');
  assert.equal(journalStageFor({ outcome: OUTCOME.POSTED_STATE_SAVE_FAILED }), 'left-open');
  assert.equal(journalStageFor({ outcome: OUTCOME.PRE_POST_FAILURE, reason: 'guard-check-failed' }), 'aborted');
  assert.equal(journalStageFor({ outcome: OUTCOME.PRE_POST_FAILURE, reason: 'claim-check-failed' }), 'left-open');
  assert.equal(journalStageFor({ outcome: OUTCOME.PRE_POST_FAILURE, reason: 'publish-error', error: {} }, { apiCalled: true }), 'unknown');
  assert.equal(journalStageFor({ outcome: OUTCOME.PRE_POST_FAILURE, reason: 'publish-error', error: { containerCreationFailure: true } }, { apiCalled: true }), 'aborted');
  assert.equal(journalStageFor({ outcome: OUTCOME.NO_CANDIDATE }, { claimed: true }), 'aborted');
  assert.equal(journalStageFor({ outcome: OUTCOME.NO_CANDIDATE }), 'none');
  const claim = { postId: 'a', stage: 'claimed', runId: '1', runAttempt: '1' };
  assert.equal(claimStatus([claim], 'a', '1', '1').ok, true);
  assert.equal(claimStatus([claim], 'a', '1', '2').reason, 'open-claim');
  assert.equal(claimStatus([], 'a', '1', '1').reason, 'no-claim');
});

test('threads-resolve: published closes the entry and adds the posted record; not-published closes it', async () => {
  const w = world();
  await runThreadsClaim(common(w));
  await post(w, { behaviour: 'publish-fail' });
  // a human pulls the remote journal, checks Threads, and resolves
  w.files[THREADS_JOURNAL_PATH] = structuredClone(remoteJournal(w));
  const res = await runThreadsResolve({ io: w.io, id: 't-noon-ja', outcome: 'published', threadsId: 'T-9', by: 'keita', now: () => 'now', log: () => {} });
  assert.equal(res.code, 0);
  assert.equal(J.openEntries(w.files[THREADS_JOURNAL_PATH]).length, 0);
  const rec = w.files[THREADS_POSTED_PATH].posts.find((p) => p.sourceItemId === 't-noon-ja');
  assert.equal(rec.threadsPostId, 'T-9');
  assert.equal(rec.slot, 'noon');
  assert.equal(rec.lang, 'ja');
  assert.equal(rec.recoveredBy, 'keita');
  assert.equal((await runThreadsResolve({ io: w.io, id: 't-noon-ja', outcome: 'published', by: 'k', now: () => 'n', log: () => {} })).code, 1, 'nothing open any more');

  const w2 = world();
  await runThreadsClaim(common(w2));
  w2.files[THREADS_JOURNAL_PATH] = structuredClone(remoteJournal(w2));
  assert.equal((await runThreadsResolve({ io: w2.io, id: 't-noon-ja', outcome: 'not-published', by: 'keita', now: () => 'n', log: () => {} })).code, 0);
  assert.deepEqual(w2.files[THREADS_JOURNAL_PATH].map((e) => e.stage), ['claimed', 'resolved']);
  assert.equal(w2.files[THREADS_POSTED_PATH].posts.length, 0);
});
