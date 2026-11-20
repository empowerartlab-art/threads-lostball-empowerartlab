import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main, hide } from '../scripts/token-refresh.mjs';

function setup() { const d = mkdtempSync(join(tmpdir(), 'tr-')); mkdirSync(join(d, 'data')); process.chdir(d); return d; }
const res = (o, ok = true) => ({ ok, status: ok ? 200 : 400, json: async () => o });
const NOW = new Date('2026-11-24T00:00:00Z');

test('Threads と Instagram を延ばし、Secrets を上書きして期限を書く。ログに通行証が出ない', async () => {
  setup();
  const sets = []; const logs = [];
  const fetchImpl = async (u) => {
    if (u.includes('refresh_access_token')) return res({ access_token: u.includes('threads') ? 'NEW_T' : 'NEW_I', expires_in: 5184000 });
    return res({ username: 'acct' });
  };
  const run = (cmd, args, opt) => { sets.push([args[2], opt.input]); return { status: 0, stdout: '', stderr: '' }; };
  const r = await main({ env: { REPO: 'o/r', GH_TOKEN: 'g', THREADS_ACCESS_TOKEN: 'OLD_T', IG_ACCESS_TOKEN: 'OLD_I' }, fetchImpl, run, now: NOW, log: (l) => logs.push(l) });
  assert.deepEqual(r.errors, []);
  assert.deepEqual(sets, [['THREADS_ACCESS_TOKEN', 'NEW_T'], ['IG_ACCESS_TOKEN', 'NEW_I']]);
  const meta = JSON.parse(readFileSync('data/token-meta.json', 'utf8'));
  assert.equal(meta.tokenExpiresAt.slice(0, 10), '2027-01-23');
  assert.equal(meta.igTokenExpiresAt.slice(0, 10), '2027-01-23');
  for (const l of logs) for (const s of ['OLD_T', 'OLD_I', 'NEW_T', 'NEW_I']) assert.ok(!l.includes(s), l);
});

test('Instagram の通行証が無いリポジトリは Threads だけ', async () => {
  setup();
  const sets = [];
  await main({ env: { REPO: 'o/r', GH_TOKEN: 'g', THREADS_ACCESS_TOKEN: 'OLD_T' }, now: NOW, log: () => {},
    fetchImpl: async (u) => res(u.includes('refresh') ? { access_token: 'N', expires_in: 100 } : { username: 'a' }),
    run: (c, a) => { sets.push(a[2]); return { status: 0 }; } });
  assert.deepEqual(sets, ['THREADS_ACCESS_TOKEN']);
});

test('延ばせなかったら Secrets を触らず失敗を返す（エラー文に通行証を出さない）', async () => {
  setup();
  const sets = [];
  const r = await main({ env: { REPO: 'o/r', GH_TOKEN: 'g', THREADS_ACCESS_TOKEN: 'OLD_T' }, now: NOW, log: () => {},
    fetchImpl: async () => res({ error: { message: 'Invalid token OLD_T' } }, false),
    run: (c, a) => { sets.push(a); return { status: 0 }; } });
  assert.equal(sets.length, 0);
  assert.equal(r.errors.length, 1);
  assert.ok(!r.errors[0].includes('OLD_T'));
});

test('新しい通行証でつながらなければ Secrets を上書きしない', async () => {
  setup();
  const sets = [];
  const r = await main({ env: { REPO: 'o/r', GH_TOKEN: 'g', THREADS_ACCESS_TOKEN: 'OLD_T' }, now: NOW, log: () => {},
    fetchImpl: async (u) => (u.includes('refresh') ? res({ access_token: 'N', expires_in: 100 }) : res({ error: { message: 'bad' } }, false)),
    run: (c, a) => { sets.push(a); return { status: 0 }; } });
  assert.equal(sets.length, 0);
  assert.equal(r.errors.length, 1);
});

test('試し（DRY_RUN）は延ばさず Secrets も変えない', async () => {
  setup();
  const calls = [];
  const r = await main({ env: { REPO: 'o/r', GH_TOKEN: 'g', THREADS_ACCESS_TOKEN: 'OLD_T', DRY_RUN: 'true' }, now: NOW, log: () => {},
    fetchImpl: async (u) => { calls.push(u); return res({ username: 'a' }); },
    run: (c, a) => { assert.equal(a[1], 'list'); return { status: 0 }; } });
  assert.deepEqual(r.errors, []);
  assert.ok(calls.every((u) => !u.includes('refresh')));
});

test('書き込み用の鍵が無ければ止まる', async () => {
  setup();
  await assert.rejects(() => main({ env: { REPO: 'o/r', THREADS_ACCESS_TOKEN: 'x' }, log: () => {} }), /SECRETS_WRITE_TOKEN/);
});

test('hide は通行証を伏せる', () => { assert.equal(hide('a SECRET b', ['SECRET']), 'a [REDACTED] b'); });
