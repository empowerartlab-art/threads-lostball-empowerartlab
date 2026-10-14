// Comment watch: first-run seeding, seen dedup, quiet skip without permission,
// own accounts skipped, envelopes decryptable only with the private key.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, privateDecrypt, createDecipheriv, constants } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { watchComments, fetchThreadsComments, fetchInstagramComments, applyComments, pruneInbox, encryptPayload, SEEN_CAP } from '../lib/comment-watch.mjs';

const TOKEN = 'TOKEN-must-never-appear';
const NOW = Date.parse('2026-10-15T03:00:00Z');
const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });

function decrypt(enc) {
  const key = privateDecrypt({ key: privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, Buffer.from(enc.key, 'base64'));
  const d = createDecipheriv('aes-256-gcm', key, Buffer.from(enc.iv, 'base64'));
  d.setAuthTag(Buffer.from(enc.tag, 'base64'));
  return JSON.parse(Buffer.concat([d.update(Buffer.from(enc.data, 'base64')), d.final()]).toString('utf8'));
}

const reply = (status, body) => ({ ok: status === 200, status, text: async () => JSON.stringify(body) });

function threadsFetch({ replies = [], status = 200, errorCode } = {}) {
  return async (url) => {
    if (status !== 200) return reply(status, { error: { code: errorCode, message: `denied ${url}` } });
    if (url.includes('/threads?')) return reply(200, { data: [
      { id: 'p1', text: '池に呼ばれる体質です', permalink: 'https://www.threads.com/@x/post/1', timestamp: '2026-10-14T21:00:00+0000' },
      { id: 'old', text: '古い投稿', permalink: 'https://www.threads.com/@x/post/0', timestamp: '2026-09-01T21:00:00+0000' },
    ] });
    if (url.includes('/p1/replies')) return reply(200, { data: replies });
    throw new Error(`unexpected ${url}`);
  };
}

const r1 = { id: 'r1', text: 'わかります！', username: 'golfer_a', timestamp: '2026-10-14T22:00:00+0000', is_reply_owned_by_me: false };
const r2 = { id: 'r2', text: '次は入りますよ', username: 'golfer_b', timestamp: '2026-10-14T23:00:00+0000' };
const ownReply = { id: 'r3', text: 'ありがとう', username: 'hetarou.golf2026', timestamp: '2026-10-14T23:30:00+0000', is_reply_owned_by_me: true };
const officialReply = { id: 'r4', text: '公式です', username: 'Lost_Ball_EmpowerArtLab', timestamp: '2026-10-14T23:40:00+0000' };

const channelsWith = (fetchImpl) => [{ key: 'threads', label: 'Threads', fetch: (o) => fetchThreadsComments({ ...o, fetchImpl, token: TOKEN, userId: 'u', ownUsernames: ['hetarou.golf2026', 'lost_ball_empowerartlab'] }) }];
const run = (fetchImpl, seen, inbox = []) => watchComments({ channels: channelsWith(fetchImpl), seen, inbox, account: 'ヘタ郎', publicKeyPem: publicKey, now: () => NOW });

test('first run only marks what is there as seen and sends nothing', async () => {
  const out = await run(threadsFetch({ replies: [r1, r2] }), null);
  assert.equal(out.inbox.length, 0);
  assert.deepEqual(out.seen, { seeded: ['threads'], ids: ['threads:r1', 'threads:r2'] });
  assert.match(out.log[0], /2 marked seen \(first run\)/);
});

test('later runs add only unseen comments, skip our own accounts, and never repeat', async () => {
  const seen = { seeded: ['threads'], ids: ['threads:r1'] };
  const out = await run(threadsFetch({ replies: [r2, r1, ownReply, officialReply] }), seen);
  assert.equal(out.inbox.length, 1);
  assert.equal(out.inbox[0].id, 'threads:r2');
  assert.equal(out.inbox[0].fetchedAt, new Date(NOW).toISOString());
  const payload = decrypt(out.inbox[0].enc);
  assert.deepEqual(payload, { account: 'ヘタ郎', media: 'Threads', postUrl: 'https://www.threads.com/@x/post/1', postText: '池に呼ばれる体質です', commentText: '次は入りますよ', username: 'golfer_b', commentedAt: '2026-10-14T23:00:00+0000' });
  const again = await run(threadsFetch({ replies: [r2, r1] }), out.seen, out.inbox);
  assert.equal(again.inbox.length, 1);
  assert.deepEqual(again.seen, out.seen);
});

test('the envelope holds no readable comment text', async () => {
  const out = await run(threadsFetch({ replies: [r2] }), { seeded: ['threads'], ids: [] });
  const raw = JSON.stringify(out.inbox);
  assert.ok(!raw.includes('次は入りますよ') && !raw.includes('golfer_b'));
});

for (const [label, status, code] of [['403', 403, undefined], ['error code 10', 400, 10], ['expired token (190)', 400, 190]]) {
  test(`no permission (${label}): one quiet line, no state change, no token in the log`, async () => {
    const seen = { seeded: ['threads'], ids: ['threads:r1'] };
    const out = await run(threadsFetch({ status, errorCode: code }), seen);
    assert.deepEqual(out.seen, seen);
    assert.deepEqual(out.inbox, []);
    assert.deepEqual(out.log, ['Threads: 許可なし（未接続）']);
  });
}

test('missing token is the same quiet skip', async () => {
  const out = await watchComments({ channels: [{ key: 'threads', label: 'Threads', fetch: (o) => fetchThreadsComments({ ...o, token: '', userId: '' }) }], seen: null, inbox: [], account: 'x', publicKeyPem: publicKey, now: () => NOW });
  assert.deepEqual(out.log, ['Threads: 許可なし（未接続）']);
  assert.deepEqual(out.seen, { seeded: [], ids: [] });
});

test('other errors skip the channel without the URL (token) in the message', async () => {
  const out = await run(threadsFetch({ status: 500 }), { seeded: ['threads'], ids: [] });
  assert.equal(out.log.length, 1);
  assert.match(out.log[0], /読めませんでした（HTTP 500）/);
  assert.ok(!out.log[0].includes(TOKEN));
});

test('a channel connected later is seeded on its own first run', async () => {
  const seen = { seeded: ['instagram'], ids: ['instagram:c1'] };
  const out = await run(threadsFetch({ replies: [r1] }), seen);
  assert.deepEqual(out.seen.seeded, ['instagram', 'threads']);
  assert.equal(out.inbox.length, 0);
});

test('instagram comments: own account and hidden comments skipped, caption cut to 80 chars', async () => {
  const caption = 'あ'.repeat(100);
  const fetchImpl = async (url) => {
    if (url.includes('/media?')) return reply(200, { data: [{ id: 'm1', caption, permalink: 'https://www.instagram.com/p/abc/', timestamp: '2026-10-14T21:00:00+0000' }] });
    if (url.includes('/m1/comments')) return reply(200, { data: [
      { id: 'c1', text: 'ナイス！', username: 'fan_1', timestamp: '2026-10-14T22:00:00+0000' },
      { id: 'c2', text: '自分', username: 'hetarou.golf2026', timestamp: '2026-10-14T22:00:00+0000' },
      { id: 'c3', text: '隠し', from: { username: 'x' }, hidden: true, timestamp: '2026-10-14T22:00:00+0000' },
    ] });
    throw new Error(url);
  };
  const list = await fetchInstagramComments({ fetchImpl, token: TOKEN, userId: 'ig', now: NOW, ownUsernames: ['hetarou.golf2026'] });
  assert.deepEqual(list.map((c) => c.id), ['instagram:c1']);
  assert.equal(list[0].postText.length, 80);
});

test('seen list is capped and old envelopes are pruned after 7 days', () => {
  const ids = Array.from({ length: SEEN_CAP }, (_, i) => `threads:${i}`);
  const r = applyComments({ seen: { seeded: ['threads'], ids }, inbox: [], channel: 'threads', comments: [{ id: 'threads:new', media: 'Threads' }], account: 'x', publicKeyPem: publicKey, fetchedAt: 'now', encrypt: () => ({}) });
  assert.equal(r.seen.ids.length, SEEN_CAP);
  assert.equal(r.seen.ids.at(-1), 'threads:new');
  const kept = pruneInbox([{ id: 'a', fetchedAt: '2026-10-07T00:00:00Z' }, { id: 'b', fetchedAt: '2026-10-10T00:00:00Z' }], NOW);
  assert.deepEqual(kept.map((e) => e.id), ['b']);
});

test('the committed public key encrypts', () => {
  const pem = readFileSync(new URL('../config/inbox-public.pem', import.meta.url), 'utf8');
  const enc = encryptPayload(pem, { a: 1 });
  assert.equal(enc.alg, 'RSA-OAEP-256+A256GCM');
  assert.equal(Buffer.from(enc.key, 'base64').length, 384); // RSA-3072
});
