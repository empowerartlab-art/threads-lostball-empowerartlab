// X の1日3本（2026-10-20〜）: 枠の定義・実行の枠の決め方・x-queue.json の枠の検査・
// 枠ごとの claim → publish・結果不明で全枠停止・記録の push の5回やり直し・従来（10/19まで）との互換。
// ネットワーク・git・リポジトリへの書き込みは一切しない（すべてスタブ）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { X_RUNS, X_SLOTS, X_SLOTS_START, planXRun, resolveXRun, xRunForCron, validateXSlots, XRunResolutionError } from '../lib/x-slots.mjs';
import {
  runXClaim, runXPublish, selectXForRun, validateXQueue, linkCostWarnings, nearCopyOf, isShopPost,
  X_QUEUE_PATH, X_POSTED_PATH, X_JOURNAL_PATH, X_PUSH_ATTEMPTS,
} from '../lib/x-flow.mjs';
import { xRunFromEnv } from '../lib/x-run-env.mjs';
import * as J from '../lib/ig-journal.mjs';

const clone = (v) => JSON.parse(JSON.stringify(v));
const TEXT = {
  morning: 'おはようございます。林の奥で見つかったボールが、またコースへ戻ります。',
  noon: '昼休みにひとつ質問です。池越えのホール、刻みますか、狙いますか。',
  night: '今日もおつかれさまでした。次のラウンドで試したい一打はありますか。',
};
// 日付ごとに違う、互いに似ていない文（同じ週に並べても似すぎの検査に掛からない）。
const POOL = [
  TEXT.morning, TEXT.noon, TEXT.night,
  '雨上がりの朝のコースは、芝の匂いが少し濃い気がします。',
  'ランチのあとの練習場、つい打ちすぎてしまう派です。',
  '夜のパター練習、カップの音が気持ちいいんですよね。',
  '朝一番のティーショット、緊張しますか。',
  '新品じゃなくても、ちゃんと飛ぶボールがあります。',
  'みなさんの得意クラブを教えてください。',
];
const SLOT_INDEX = { morning: 0, noon: 1, night: 2 };
const textFor = (date, slot) => POOL[((Number(date.slice(8)) - 20 + 30) % 3) * 3 + (SLOT_INDEX[slot] ?? 0)];
const xItem = (date, slot, extra = {}) => ({
  id: `x-${date}-${slot}`, date, slot, pillar: 'GOLF', text: textFor(date, slot),
  approved: true, approvedBy: 'KEITA', approvedAt: '2026-10-17T00:00:00Z', ...extra,
});
const xDay = (date, extra = {}) => X_SLOTS.map((s) => xItem(date, s.slot, extra));
const legacy = (date, extra = {}) => ({ id: `x-${date}`, date, text: `従来の1日1本の投稿です（${date}）。`, approved: true, approvedBy: 'KEITA', approvedAt: 'x', ...extra });

// ---- 枠の定義と cron ----

test('X_RUNS: cron は JST の時刻を UTC に直したもの。朝07:10・昼12:10・夜20:10・従来05:53', () => {
  for (const r of X_RUNS) {
    const [min, hour] = r.cron.split(' ').map(Number);
    const jst = `${String((hour + 9) % 24).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
    assert.equal(jst, r.time, r.id);
  }
  assert.deepEqual(X_RUNS.map((r) => [r.id, r.time, r.cron]), [
    ['legacy', '05:53', '53 20 * * *'],
    ['morning', '07:10', '10 22 * * *'],
    ['noon', '12:10', '10 3 * * *'],
    ['night', '20:10', '10 11 * * *'],
  ]);
  assert.equal(xRunForCron(' 10  3 * * * '), 'noon');
  assert.equal(xRunForCron('35 3 * * *'), null, 'Threads の cron は X の枠ではない');
});

test('x-post.yml の cron は lib/x-slots.mjs の4本と一致する', () => {
  const yml = readFileSync(new URL('../.github/workflows/x-post.yml', import.meta.url), 'utf8');
  const crons = [...yml.matchAll(/^\s*-\s*cron:\s*"([^"]+)"/gm)].map((m) => m[1]).sort();
  assert.deepEqual(crons, X_RUNS.map((r) => r.cron).sort());
});

test('planXRun: 10/19 までは 05:53 の従来だけ、10/20 からは3枠だけ', () => {
  assert.deepEqual(planXRun('legacy', '2026-10-19'), { kind: 'legacy' });
  assert.equal(planXRun('morning', '2026-10-19').kind, 'none');
  assert.equal(planXRun('legacy', '2026-10-20').kind, 'none');
  for (const s of ['morning', 'noon', 'night']) assert.deepEqual(planXRun(s, '2026-10-20'), { kind: 'slot', slot: s });
  assert.equal(planXRun('bogus', '2026-10-20').kind, 'none');
});

test('resolveXRun: schedule は cron で枠が決まり、遅れて0時を過ぎても前日の分', () => {
  assert.deepEqual(resolveXRun({ schedule: '10 22 * * *', now: new Date('2026-10-19T22:12:00Z') }), { run: 'morning', date: '2026-10-20', source: 'schedule' });
  assert.deepEqual(resolveXRun({ schedule: '10 3 * * *', now: new Date('2026-10-20T03:40:00Z') }), { run: 'noon', date: '2026-10-20', source: 'schedule' });
  // 夜 20:10 の実行が混雑で 10/21 00:20 JST に始まった → 10/20 の夜の分
  assert.deepEqual(resolveXRun({ schedule: '10 11 * * *', now: new Date('2026-10-20T15:20:00Z') }), { run: 'night', date: '2026-10-20', source: 'schedule' });
  // 従来の 05:53（10/19 まで）は今までと同じ日付
  assert.deepEqual(resolveXRun({ schedule: '53 20 * * *', now: new Date('2026-10-18T20:55:00Z') }), { run: 'legacy', date: '2026-10-19', source: 'schedule' });
  assert.throws(() => resolveXRun({ schedule: '0 12 * * *' }), XRunResolutionError);
});

test('resolveXRun: 手動実行は入力の枠、auto は今の時刻までに来た最後の枠', () => {
  assert.deepEqual(resolveXRun({ input: 'noon', date: '2026-10-22', now: new Date('2026-10-14T00:00:00Z') }), { run: 'noon', date: '2026-10-22', source: 'input' });
  assert.equal(resolveXRun({ input: 'auto', now: new Date('2026-10-20T04:00:00Z') }).run, 'noon'); // 13:00 JST
  assert.equal(resolveXRun({ input: 'auto', now: new Date('2026-10-19T21:00:00Z') }).run, null); // 10/20 06:00 JST
  assert.equal(resolveXRun({ input: 'auto', now: new Date('2026-10-18T21:30:00Z') }).run, 'legacy'); // 10/19 06:30 JST
  assert.throws(() => resolveXRun({ input: 'lunch' }), XRunResolutionError);
  assert.throws(() => resolveXRun({ input: 'noon', date: '10/20' }), XRunResolutionError);
});

test('scripts/x-resolve-run.mjs: GITHUB_OUTPUT に run / date / has_run を書く（読み取りのみ）', () => {
  const script = fileURLToPath(new URL('../scripts/x-resolve-run.mjs', import.meta.url));
  const ok = spawnSync(process.execPath, [script], { env: { ...process.env, RUN_INPUT: 'night', RUN_DATE_INPUT: '2026-10-21', RUN_SCHEDULE: '', GITHUB_OUTPUT: '' }, encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /night（夜 20:10 JST） 対象日: 2026-10-21/);
  const none = spawnSync(process.execPath, [script], { env: { ...process.env, RUN_INPUT: 'legacy', RUN_DATE_INPUT: '2026-10-21', RUN_SCHEDULE: '', GITHUB_OUTPUT: '' }, encoding: 'utf8' });
  assert.equal(none.status, 0);
  assert.match(none.stdout, /legacy-run-ended/);
  const bad = spawnSync(process.execPath, [script], { env: { ...process.env, RUN_INPUT: '', RUN_SCHEDULE: '1 1 * * *', GITHUB_OUTPUT: '' }, encoding: 'utf8' });
  assert.equal(bad.status, 1);
});

test('xRunFromEnv: X_RUN と TARGET_DATE から plan を作る', () => {
  assert.deepEqual(xRunFromEnv({ X_RUN: 'noon', TARGET_DATE: '2026-10-20' }), { today: '2026-10-20', run: 'noon', plan: { kind: 'slot', slot: 'noon' } });
  assert.deepEqual(xRunFromEnv({ X_RUN: 'legacy', TARGET_DATE: '2026-10-19' }).plan, { kind: 'legacy' });
  assert.equal(xRunFromEnv({ X_RUN: 'morning', TARGET_DATE: '2026-10-19' }).plan.kind, 'none');
});

// ---- x-queue.json の枠の検査 ----

test('validateXSlots / validateXQueue: 10/20 以降は1日3枠ちょうど1件ずつ、従来と混ぜない', () => {
  assert.deepEqual(validateXQueue([legacy('2026-10-19'), ...xDay('2026-10-20'), ...xDay('2026-10-21')]), []);
  const missing = validateXSlots(xDay('2026-10-20').slice(0, 2)).join('\n');
  assert.match(missing, /2026-10-20: X の夜\(20:10\)の投稿がありません/);
  const dup = validateXSlots([...xDay('2026-10-20'), xItem('2026-10-20', 'noon', { id: 'dup', text: '別の文章です。' })]).join('\n');
  assert.match(dup, /昼\(12:10\)の投稿が2件/);
  const mixed = validateXSlots([...xDay('2026-10-20'), legacy('2026-10-20')]).join('\n');
  assert.match(mixed, /混ざっています/);
  assert.match(mixed, /x-2026-10-20: 2026-10-20 以降の X 投稿には slot/);
  assert.match(validateXSlots([xItem('2026-10-19', 'noon')]).join(), /2026-10-20 以降だけ/);
  assert.match(validateXSlots([xItem('2026-10-20', 'lunch')]).join(), /slot が不正/);
});

test('validateXQueue: Threads のほぼ写し・抜き書きは不可（書き直しは可）', () => {
  const threadsJa = '日本のゴルフ場の近くに残るロストボールは、推定5億〜10億球とも言われています。\nそのうちの一部を、私たちは一球ずつ手で磨いて、もう一度使えるようにしています。';
  // 句読点だけ変えた写し
  const copy = xItem('2026-10-20', 'morning', { text: '日本のゴルフ場の近くに残るロストボールは推定5億〜10億球とも言われています。そのうちの一部を、私たちは一球ずつ手で磨いて、もう一度使えるようにしています' });
  // 前半だけの抜き書き
  const excerpt = xItem('2026-10-20', 'morning', { text: '日本のゴルフ場の近くに残るロストボールは、推定5億〜10億球とも言われています。' });
  const rewrite = xItem('2026-10-20', 'morning', { text: 'ゴルフ場のまわりに眠るボール、5億〜10億球という推定も。\n\n自分の1球も、きっとその中に。' });
  assert.ok(nearCopyOf(copy.text, [threadsJa]));
  assert.ok(nearCopyOf(excerpt.text, [threadsJa]));
  assert.equal(nearCopyOf(rewrite.text, [threadsJa]), null);
  const day = (m) => [m, xItem('2026-10-20', 'noon'), xItem('2026-10-20', 'night')];
  assert.match(validateXQueue(day(copy), { threadsTexts: [threadsJa] }).join(), /almost a copy of a Threads post/);
  assert.match(validateXQueue(day(excerpt), { threadsTexts: [threadsJa] }).join(), /almost a copy of a Threads post/);
  assert.deepEqual(validateXQueue(day(rewrite), { threadsTexts: [threadsJa] }), []);
});

test('validateXQueue: ショップ誘導は週1回まで、画像は未対応、事実は verified のものだけ', () => {
  const shop = (date, slot) => xItem(date, slot, { text: `${textFor(date, slot)}\n販売中です。プロフィールのリンクから` });
  const week = [...xDay('2026-10-20'), ...xDay('2026-10-21')];
  week[0] = shop('2026-10-20', 'morning');
  assert.deepEqual(validateXQueue(week), []);
  week[4] = shop('2026-10-21', 'noon');
  assert.match(validateXQueue(week).join(), /2 shop posts \(max 1 a week\)/);
  assert.equal(isShopPost({ text: 'プロフィールのリンクから' }), true);
  assert.equal(isShopPost({ text: '池越えのホール' }), false);

  const img = xDay('2026-10-20');
  img[1] = { ...img[1], images: ['assets/instagram/a.jpg'] };
  assert.match(validateXQueue(img).join(), /"images" is not supported/);
  const textOnly = xDay('2026-10-20');
  textOnly[1] = { ...textOnly[1], media: { type: 'TEXT_ONLY' } };
  assert.deepEqual(validateXQueue(textOnly), []);

  const facts = [{ id: 'ok', verified: true }, { id: 'pending', verified: false }];
  const f = xDay('2026-10-20');
  f[0] = { ...f[0], verifiedFactIds: ['ok'] };
  assert.deepEqual(validateXQueue(f, { facts }), []);
  f[1] = { ...f[1], verifiedFactIds: ['pending', 'nope'] };
  const errs = validateXQueue(f, { facts }).join('\n');
  assert.match(errs, /unverified fact pending/);
  assert.match(errs, /unverified fact nope/);
});

test('validateXQueue: 枠付きの X どうしが同じ日に似すぎ・同じ書き出しは不可', () => {
  const d = xDay('2026-10-20');
  d[2] = { ...d[2], text: d[0].text.replace('またコースへ', 'もう一度コースへ') };
  assert.match(validateXQueue(d).join(), /同じ日の日本語の本文が似ています|同じ書き出し/);
});

test('linkCostWarnings: URL 入りの投稿は1本 $0.20（通常 $0.015）と大きく警告する', () => {
  const w = linkCostWarnings([xItem('2026-10-20', 'noon', { text: '詳しくは example.com/shop', allowLink: true }), xItem('2026-10-20', 'night')]);
  assert.equal(w.length, 1);
  assert.match(w[0], /⚠️⚠️ URL入り.*x-2026-10-20-noon.*\$0\.2.*\$0\.015/);
});

// ---- 枠ごとの選出・claim → publish ----

function harness({ queue, posted = [], journal = [], api = 'ok', pushFailures = 0 } = {}) {
  const local = { [X_QUEUE_PATH]: clone(queue), [X_POSTED_PATH]: clone(posted), [X_JOURNAL_PATH]: clone(journal) };
  const remote = { [X_JOURNAL_PATH]: clone(journal), [X_POSTED_PATH]: clone(posted) };
  let staged = [];
  let failuresLeft = pushFailures;
  const out = [];
  const calls = [];
  const gitLog = [];
  const sleeps = [];
  const io = {
    async readJson(path, fallback) { return path in local ? clone(local[path]) : fallback; },
    async writeJson(path, value) { local[path] = clone(value); },
  };
  const git = async (args) => {
    const [cmd] = args;
    gitLog.push(cmd);
    if (cmd === 'fetch' || cmd === 'commit' || cmd === 'pull') return '';
    if (cmd === 'show') {
      const path = args[1].split(':')[1];
      if (!(path in remote)) throw new Error('missing');
      return JSON.stringify(remote[path]);
    }
    if (cmd === 'add') { staged = args.slice(2); return ''; }
    if (cmd === 'diff') return staged.join('\n');
    if (cmd === 'push') {
      if (failuresLeft > 0) { failuresLeft--; throw new Error('rejected (fetch first)'); }
      for (const p of staged) remote[p] = clone(local[p]);
      staged = [];
      return '';
    }
    throw new Error(`unexpected git ${args.join(' ')}`);
  };
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(init.body) });
    if (api === 'throw') throw new Error('socket hang up');
    return { ok: true, status: 201, text: async () => `{"data":{"id":"19000000000000000${calls.length}"}}` };
  };
  const deps = (today, run) => ({
    io, git, branch: 'main', today, plan: planXRun(run, today), runId: `r-${run}`, runAttempt: '1', now: () => '2026-10-20T00:00:00Z',
    log: (m) => out.push(m), errLog: (m) => out.push(m), fetchImpl, live: true, sleep: async (ms) => { sleeps.push(ms); },
    creds: { apiKey: 'k', apiSecret: 's', accessToken: 't', accessSecret: 'ts' },
  });
  return { deps, local, remote, out, calls, gitLog, sleeps, sync() { local[X_JOURNAL_PATH] = clone(remote[X_JOURNAL_PATH]); local[X_POSTED_PATH] = clone(remote[X_POSTED_PATH]); } };
}

async function claimThenPublish(h, today, run) {
  const c = await runXClaim(h.deps(today, run));
  if (c.code !== 0 || c.skip) return c;
  return runXPublish(h.deps(today, run));
}

test('selectXForRun: その日・その枠の1件だけ。前の枠の取り残しは出さない', () => {
  const q = [legacy('2026-10-19'), ...xDay('2026-10-20')];
  assert.equal(selectXForRun(q, [], '2026-10-19', planXRun('legacy', '2026-10-19')).post.id, 'x-2026-10-19');
  assert.equal(selectXForRun(q, [], '2026-10-20', planXRun('noon', '2026-10-20')).post.id, 'x-2026-10-20-noon');
  assert.equal(selectXForRun(q, [], '2026-10-20', planXRun('legacy', '2026-10-20')).reason, 'no-run-for-this-time');
  // 朝が未承認でも、昼の実行は昼だけを見る
  const q2 = [xItem('2026-10-20', 'morning', { approved: false }), xItem('2026-10-20', 'noon'), xItem('2026-10-20', 'night')];
  assert.equal(selectXForRun(q2, [], '2026-10-20', { kind: 'slot', slot: 'noon' }).post.id, 'x-2026-10-20-noon');
  assert.equal(selectXForRun(q2, [], '2026-10-20', { kind: 'slot', slot: 'morning' }).reason, 'not-approved');
  // その枠を出し済みなら何もしない
  assert.equal(selectXForRun(q2, [{ id: 'x-2026-10-20-noon', date: '2026-10-20', slot: 'noon', text: 'x' }], '2026-10-20', { kind: 'slot', slot: 'noon' }).reason, 'already-posted-today');
});

test('1日3本: 朝・昼・夜がそれぞれ claim → publish され、journal と x-posts.json に slot が残る', async () => {
  const h = harness({ queue: xDay('2026-10-20') });
  for (const run of ['morning', 'noon', 'night']) {
    const r = await claimThenPublish(h, '2026-10-20', run);
    assert.equal(r.code, 0, h.out.join('\n'));
    assert.equal(r.postId, `x-2026-10-20-${run}`);
    h.sync();
  }
  assert.deepEqual(h.calls.map((c) => c.body.text), [TEXT.morning, TEXT.noon, TEXT.night]);
  assert.deepEqual(h.remote[X_POSTED_PATH].map((p) => p.slot), ['morning', 'noon', 'night']);
  const claims = h.remote[X_JOURNAL_PATH].filter((e) => e.stage === J.CLAIMED);
  assert.deepEqual(claims.map((e) => e.slot), ['morning', 'noon', 'night']);
  assert.equal(J.openEntries(h.remote[X_JOURNAL_PATH]).length, 0);
  // 同じ枠がもう一度動いても出さない
  const again = await runXClaim(h.deps('2026-10-20', 'noon'));
  assert.equal(again.reason, 'already-posted-today');
  assert.equal(again.code, 0);
  assert.equal(h.calls.length, 3);
});

test('朝の結果が不明なら、昼・夜は投稿せず止まる（自動で投稿し直さない）', async () => {
  const h = harness({ queue: xDay('2026-10-20'), api: 'throw' });
  const r = await claimThenPublish(h, '2026-10-20', 'morning');
  assert.equal(r.stage, J.UNKNOWN);
  h.sync();
  const noon = await runXClaim(h.deps('2026-10-20', 'noon'));
  assert.equal(noon.halted, true);
  const morningAgain = await runXClaim(h.deps('2026-10-20', 'morning'));
  assert.equal(morningAgain.halted, true);
  assert.equal(h.calls.length, 1, 'X の API は最初の1回だけ');
});

test('journal に published があるのに x-posts.json に無い投稿は、もう一度出さない', async () => {
  const journal = [J.event({ postId: 'x-2026-10-20-noon', date: '2026-10-20', stage: J.PUBLISHED, runId: 'old', runAttempt: '1', at: 'x', threadsId: '1' })];
  const h = harness({ queue: xDay('2026-10-20'), journal });
  const c = await runXClaim(h.deps('2026-10-20', 'noon'));
  assert.equal(c.reason, 'already-published-in-journal');
  assert.equal(c.code, 1);
  assert.equal(h.calls.length, 0);
});

test('記録の push は pull --rebase して最大5回やり直す（X への投稿はやり直さない）', async () => {
  assert.equal(X_PUSH_ATTEMPTS, 5);
  const h = harness({ queue: xDay('2026-10-20'), pushFailures: 4 });
  const c = await runXClaim(h.deps('2026-10-20', 'morning'));
  assert.equal(c.code, 0, h.out.join('\n'));
  assert.equal(h.gitLog.filter((g) => g === 'push').length, 5);
  assert.equal(h.gitLog.filter((g) => g === 'pull').length, 4);
  assert.deepEqual(h.sleeps, [10000, 15000, 20000]);

  const h2 = harness({ queue: xDay('2026-10-20'), pushFailures: 5 });
  const c2 = await runXClaim(h2.deps('2026-10-20', 'morning'));
  assert.equal(c2.reason, 'claim-not-persisted');
  assert.equal(h2.gitLog.filter((g) => g === 'push').length, 5);
  const p2 = await runXPublish(h2.deps('2026-10-20', 'morning'));
  assert.equal(p2.reason, 'no-claim');
  assert.equal(h2.calls.length, 0);
});

test('従来（10/19まで）: 05:53 の実行は slot の無い1本だけを今までどおり出し、枠の実行は何もしない', async () => {
  const h = harness({ queue: [legacy('2026-10-19'), ...xDay('2026-10-20')] });
  for (const run of ['morning', 'noon', 'night']) {
    const r = await runXClaim(h.deps('2026-10-19', run));
    assert.equal(r.code, 0);
    assert.equal(r.skip, true);
  }
  const r = await claimThenPublish(h, '2026-10-19', 'legacy');
  assert.equal(r.code, 0);
  assert.equal(r.postId, 'x-2026-10-19');
  h.sync();
  assert.equal(h.remote[X_POSTED_PATH][0].slot, undefined, '従来の記録の形は変わらない');
  assert.equal(h.remote[X_JOURNAL_PATH][0].slot, undefined);
  // 10/20 の 05:53 は何もしない
  const after = await runXClaim(h.deps('2026-10-20', 'legacy'));
  assert.equal(after.reason, 'no-run-for-this-time');
  assert.equal(h.calls.length, 1);
});

test('dry-run は API を呼ばず、URL 入りなら GitHub の警告を出す', async () => {
  const q = xDay('2026-10-20');
  q[1] = { ...q[1], text: '詳しくは example.com/shop', allowLink: true };
  const h = harness({ queue: q });
  const r = await runXPublish({ ...h.deps('2026-10-20', 'noon'), live: false });
  assert.equal(r.stage, 'dry-run');
  assert.equal(h.calls.length, 0);
  assert.match(h.out.join('\n'), /::warning::X post x-2026-10-20-noon contains a URL: about \$0\.2 instead of \$0\.015/);
});

test('今の data/x-queue.json は新しい検査（枠・ほぼ写し・ショップ週1回・事実）も通る', () => {
  const read = (p) => JSON.parse(readFileSync(new URL(`../${p}`, import.meta.url), 'utf8'));
  const texts = (list) => (list ?? []).flatMap((p) => [p.bodyJa, p.bodyEn]).filter(Boolean);
  const threadsTexts = [...texts(read('data/draft-bank.json').items), ...texts(read('data/draft-bank-candidates.json').items), ...texts(read('data/threads-posts.json').posts)];
  assert.deepEqual(validateXQueue(read('data/x-queue.json'), { threadsTexts, facts: read('data/verified-facts.json').facts }), []);
  assert.ok(X_SLOTS_START === '2026-10-20');
});
