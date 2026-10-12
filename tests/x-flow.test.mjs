// X flow: counting, signing, validation, and the claim-then-publish safety cases.
// No git, network or repository access: the harness stands in for all of them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runXClaim, runXPublish, runXResolve, selectXToday, validateXQueue, X_QUEUE_PATH, X_POSTED_PATH, X_JOURNAL_PATH } from '../lib/x-flow.mjs';
import { xWeight, hasLink, oauthHeader } from '../lib/x-api.mjs';
import * as J from '../lib/ig-journal.mjs';
import { readFileSync } from 'node:fs';

const SECRET = 'XSECRET-must-never-appear';
const creds = { apiKey: 'key-1', apiSecret: SECRET, accessToken: 'tok-1', accessSecret: 'tsec-1' };
const DATE = '2026-10-14';
const clone = (v) => JSON.parse(JSON.stringify(v));
const post = (extra = {}) => ({ id: 'x-1', date: DATE, text: 'まだハーレーを持っていなくてもいい。', approved: true, approvedBy: 'KEITA', approvedAt: 'x', ...extra });

function harness({ queue = [post()], posted = [], journal = [], api = 'ok' } = {}) {
  const local = { [X_QUEUE_PATH]: clone(queue), [X_POSTED_PATH]: clone(posted), [X_JOURNAL_PATH]: clone(journal) };
  const remote = { [X_JOURNAL_PATH]: clone(journal), [X_POSTED_PATH]: clone(posted) };
  let staged = [];
  const out = [];
  const calls = [];
  const io = {
    async readJson(path, fallback) { return path in local ? clone(local[path]) : fallback; },
    async writeJson(path, value) { local[path] = clone(value); },
  };
  const git = async (args) => {
    const [cmd] = args;
    if (cmd === 'fetch' || cmd === 'commit') return '';
    if (cmd === 'show') {
      const path = args[1].split(':')[1];
      if (!(path in remote)) throw new Error('missing');
      return JSON.stringify(remote[path]);
    }
    if (cmd === 'add') { staged = args.slice(2); return ''; }
    if (cmd === 'diff') return staged.join('\n');
    if (cmd === 'push') { for (const p of staged) remote[p] = clone(local[p]); staged = []; return ''; }
    throw new Error(`unexpected git ${args.join(' ')}`);
  };
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });
    if (api === 'throw') throw new Error('socket hang up');
    if (api === '403') return { ok: false, status: 403, text: async () => `{"detail":"echo ${init.headers.Authorization}"}` };
    if (api === '503') return { ok: false, status: 503, text: async () => 'busy' };
    if (api === 'noid') return { ok: true, status: 201, text: async () => '{}' };
    return { ok: true, status: 201, text: async () => '{"data":{"id":"1840000000000000001","text":"x"}}' };
  };
  const deps = {
    io, git, branch: 'main', today: DATE, runId: 'r1', runAttempt: '1', now: () => '2026-10-14T03:10:00Z',
    log: (m) => out.push(m), errLog: (m) => out.push(m), fetchImpl, creds, live: true,
  };
  return { deps, local, remote, out, calls };
}

async function claimThenPublish(h) {
  const c = await runXClaim(h.deps);
  assert.equal(c.code, 0, h.out.join('\n'));
  return runXPublish(h.deps);
}

test('xWeight: Japanese counts 2, URLs count 23', () => {
  assert.equal(xWeight('abc'), 3);
  assert.equal(xWeight('あいう'), 6);
  assert.equal(xWeight('見て zero-riders.netlify.app'), 4 + 1 + 23);
  assert.equal(xWeight('https://example.com/very/long/path/that/is/long'), 23);
  assert.equal(hasLink('zero-riders.netlify.app'), true);
  assert.equal(hasLink('No.000'), false);
});

test('oauthHeader: matches the documented OAuth 1.0a signature example', () => {
  const { signature } = oauthHeader({
    method: 'POST',
    url: 'https://api.twitter.com/1.1/statuses/update.json',
    consumerKey: 'xvz1evFS4wEEPTGEFPHBog',
    consumerSecret: 'kAcSOqF21Fu85e7zjz7ZN2U4ZRhfV3WpwPAoE3Z7kBw',
    token: '370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb',
    tokenSecret: 'LswwdoUaIvS8ltyTt5jkRh4J50vUPVVHtR2YPi5kE',
    nonce: 'kYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg',
    timestamp: 1318622958,
    extraParams: { include_entities: 'true', status: 'Hello Ladies + Gentlemen, a signed OAuth request!' },
  });
  assert.equal(signature, 'hCtSmYh+iHYCEqBWrE7C7hYmtUk=');
});

test('validateXQueue: length, copies of Threads, links and approval', () => {
  const long = 'あ'.repeat(141);
  const errs = validateXQueue([
    post({ id: 'a', date: '2026-10-13', text: long }),
    post({ id: 'b', date: '2026-10-14', text: 'Threadsと同じ文' }),
    post({ id: 'c', date: '2026-10-15', text: '詳しくは zero-riders.netlify.app' }),
    post({ id: 'd', date: '2026-10-16', approvedBy: undefined }),
  ], ['Threadsと 同じ文']);
  assert.match(errs.join('\n'), /a: 282\/280/);
  assert.match(errs.join('\n'), /b: same text as a Threads post/);
  assert.match(errs.join('\n'), /c: has a link but allowLink/);
  assert.match(errs.join('\n'), /d: approved without/);
  assert.deepEqual(validateXQueue([post({ text: '詳しくは zero-riders.netlify.app', allowLink: true })]), []);
});

test('validateXQueue: at most two link posts a week', () => {
  const link = (id, date) => post({ id, date, text: `${id} zero-riders.netlify.app`, allowLink: true });
  assert.deepEqual(validateXQueue([link('a', '2026-10-12'), link('b', '2026-10-14')]), []);
  assert.match(validateXQueue([link('a', '2026-10-12'), link('b', '2026-10-14'), link('c', '2026-10-18')]).join(), /3 posts with links/);
  assert.deepEqual(validateXQueue([link('a', '2026-10-12'), link('b', '2026-10-14'), link('c', '2026-10-19')]), []);
});

test('selectXToday: quiet days, approval, duplicates', () => {
  assert.equal(selectXToday([post()], [], DATE).post.id, 'x-1');
  assert.equal(selectXToday([], [], DATE).reason, 'no-post-scheduled');
  assert.equal(selectXToday([post({ approved: false })], [], DATE).reason, 'not-approved');
  assert.equal(selectXToday([post()], [{ id: 'old', date: '2026-10-01', text: post().text }], DATE).reason, 'duplicate-text');
  assert.equal(selectXToday([post({ text: 'zero-riders.netlify.app' })], [], DATE).reason, 'link-not-allowed');
});

test('dry run never calls the API', async () => {
  const h = harness();
  const r = await runXPublish({ ...h.deps, live: false });
  assert.equal(r.stage, 'dry-run');
  assert.equal(h.calls.length, 0);
});

test('happy path: claim, publish, record', async () => {
  const h = harness();
  const r = await claimThenPublish(h);
  assert.equal(r.code, 0);
  assert.equal(r.xId, '1840000000000000001');
  assert.equal(h.remote[X_POSTED_PATH][0].xId, '1840000000000000001');
  assert.equal(J.openEntries(h.remote[X_JOURNAL_PATH]).length, 0);
  const auth = h.calls[0].init.headers.Authorization;
  assert.match(auth, /^OAuth oauth_consumer_key="key-1"/);
  assert.deepEqual(JSON.parse(h.calls[0].init.body), { text: post().text });
});

test('no claim on the remote: refuses to publish', async () => {
  const h = harness();
  const r = await runXPublish(h.deps);
  assert.equal(r.reason, 'no-claim');
  assert.equal(h.calls.length, 0);
});

test('4xx: aborted, not halted, and secrets are redacted', async () => {
  const h = harness({ api: '403' });
  const r = await claimThenPublish(h);
  assert.equal(r.stage, J.ABORTED);
  assert.equal(J.openEntries(h.remote[X_JOURNAL_PATH]).length, 0);
  assert.doesNotMatch(h.out.join('\n'), /oauth_signature="(?!\[REDACTED\])/);
  assert.doesNotMatch(h.out.join('\n'), /key-1|tok-1/);
});

for (const api of ['throw', '503', 'noid']) {
  test(`${api}: unknown result halts later runs`, async () => {
    const h = harness({ api });
    const r = await claimThenPublish(h);
    assert.equal(r.stage, J.UNKNOWN);
    assert.equal(J.openEntries(h.remote[X_JOURNAL_PATH]).length, 1);
    const next = harness({ journal: h.remote[X_JOURNAL_PATH], queue: [post({ id: 'x-2', date: DATE, text: '別の文' })] });
    const c = await runXClaim(next.deps);
    assert.equal(c.halted, true);
    assert.equal(next.calls.length, 0);
  });
}

test('missing credentials: no API call', async () => {
  const h = harness();
  await runXClaim(h.deps);
  const r = await runXPublish({ ...h.deps, creds: { ...creds, accessSecret: '' } });
  assert.equal(r.reason, 'missing-credentials');
  assert.equal(h.calls.length, 0);
});

test('resolve: a human closes an unknown entry', async () => {
  const h = harness({ api: 'throw' });
  await claimThenPublish(h);
  h.local[X_JOURNAL_PATH] = clone(h.remote[X_JOURNAL_PATH]);
  const r = await runXResolve({ io: h.deps.io, id: 'x-1', outcome: 'published', xId: '99', by: 'KEITA', now: h.deps.now, log: () => {} });
  assert.equal(r.code, 0);
  assert.equal(J.openEntries(h.local[X_JOURNAL_PATH]).length, 0);
  assert.equal(h.local[X_POSTED_PATH][0].xId, '99');
});

// ---- ロストボール固有 ----
test('data/x-queue.json は検査を通り、Threads(日本語・英語)の丸写しが無い', () => {
  const read = (p) => JSON.parse(readFileSync(new URL(`../${p}`, import.meta.url), 'utf8'));
  const texts = (list) => (list ?? []).flatMap((p) => [p.bodyJa, p.bodyEn]).filter(Boolean);
  const threads = [...texts(read('data/draft-bank.json').items), ...texts(read('data/threads-posts.json').posts)];
  assert.deepEqual(validateXQueue(read('data/x-queue.json'), threads), []);
  assert.ok(validateXQueue([post({ text: threads[0] })], threads).some((e) => e.includes('same text as a Threads post')));
});
