// X の1日3本（2026-10-20〜）のまとめて承認（lib/x-bulk-approve.mjs）。ファイルI/O・ネットワークなし。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planXBulkApproval, formatXBulkList } from '../lib/x-bulk-approve.mjs';
import { datesFor } from '../lib/bulk-approve.mjs';

const POOL = [
  'おはようございます。林の奥で見つかったボールが、またコースへ戻ります。',
  '昼休みにひとつ質問です。池越えのホール、刻みますか、狙いますか。',
  '今日もおつかれさまでした。次のラウンドで試したい一打はありますか。',
  '雨上がりの朝のコースは、芝の匂いが少し濃い気がします。',
  'ランチのあとの練習場、つい打ちすぎてしまう派です。',
  '夜のパター練習、カップの音が気持ちいいんですよね。',
];
const SLOTS = ['morning', 'noon', 'night'];
const textFor = (date, slot) => POOL[((Number(date.slice(8)) - 20) % 2) * 3 + SLOTS.indexOf(slot)];
const draft = (date, slot, extra = {}) => ({
  id: `x-${date}-${slot}`, date, slot, pillar: 'GOLF', text: textFor(date, slot),
  threadsItemId: `lb-${date}-${slot}-ja`, approved: false, ...extra,
});
const day = (date) => SLOTS.map((s) => draft(date, s));
const threadsItem = (date, slot) => ({ id: `lb-${date}-${slot}-ja`, targetDate: date, slot, lang: 'ja', bodyJa: `Threads の長い日本語の本文（${date} ${slot}）。ここから X 用に短く書き直します。` });
const threadsItems = ['2026-10-20', '2026-10-21'].flatMap((d) => SLOTS.map((s) => threadsItem(d, s)));
const base = {
  posted: [], threadsItems, threadsTexts: threadsItems.map((i) => i.bodyJa), facts: [{ id: 'f1', verified: true }],
  dates: ['2026-10-20', '2026-10-21'], approvedBy: 'KEITA', approvedAt: '2026-10-17T01:00:00Z', todayKey: '2026-10-17', now: new Date('2026-10-17T01:00:00Z'),
};

test('全部OKなら2日分6本を承認できる（一覧に枠・時刻・本文・画像・元の Threads）', () => {
  const plan = planXBulkApproval({ ...base, queue: [...day('2026-10-20'), ...day('2026-10-21')] });
  assert.equal(plan.ok, true, JSON.stringify(plan.problems));
  assert.equal(plan.approveIds.length, 6);
  const list = formatXBulkList({ dates: base.dates, rows: plan.rows });
  assert.match(list, /==== 2026-10-20（火）X ====/);
  assert.match(list, /\[朝 07:10\] ⏳ 承認する {2}id=x-2026-10-20-morning/);
  assert.match(list, /\[昼 12:10\]/);
  assert.match(list, /\[夜 20:10\]/);
  assert.match(list, /│ 昼休みにひとつ質問です/);
  assert.match(list, /画像なし（文字のみ）・\d+\/280・元の Threads: lb-2026-10-20-morning-ja/);
});

test('1件でも問題があれば何も承認しない（全部OKのときだけ）。--exclude は1日まるごと外すなら可', () => {
  const q = [...day('2026-10-20'), ...day('2026-10-21')];
  q[4] = { ...q[4], text: 'あ'.repeat(141) };
  const plan = planXBulkApproval({ ...base, queue: q });
  assert.equal(plan.ok, false);
  assert.deepEqual(plan.approveIds, []);
  assert.match(plan.problems.map((p) => `${p.id}: ${p.reasons.join()}`).join('\n'), /x-2026-10-21-noon: 長すぎます/);

  // 1件だけ外すと、その日が途中までの承認になるので不可
  const partial = planXBulkApproval({ ...base, queue: q, exclude: ['x-2026-10-21-noon'] });
  assert.equal(partial.ok, false);
  assert.match(JSON.stringify(partial.problems), /1日の途中までは承認できません/);

  // 外しても、x-queue.json に検査を通らない文が残っていれば承認しない（投稿の workflow も止まるため）
  const stillBad = planXBulkApproval({ ...base, queue: q, exclude: ['x-2026-10-21-morning', 'x-2026-10-21-noon', 'x-2026-10-21-night'] });
  assert.match(JSON.stringify(stillBad.problems), /承認後のx-queue.json.*282\/280/);

  // その日の3本とも外せば、もう1日分だけ承認できる。外した日は投稿なしのお知らせ
  const wholeDay = planXBulkApproval({ ...base, queue: [...day('2026-10-20'), ...day('2026-10-21')], exclude: ['x-2026-10-21-morning', 'x-2026-10-21-noon', 'x-2026-10-21-night'] });
  assert.equal(wholeDay.ok, true, JSON.stringify(wholeDay.problems));
  assert.deepEqual(wholeDay.approveIds, ['x-2026-10-20-morning', 'x-2026-10-20-noon', 'x-2026-10-20-night']);
  assert.match(wholeDay.notices.join(), /2026-10-21（水）: 承認済みの X 投稿がありません/);

  const unknown = planXBulkApproval({ ...base, queue: q, exclude: ['nope'] });
  assert.match(JSON.stringify(unknown.problems), /対象日の X 投稿に無いidです: nope/);
});

test('Threads のほぼ写し・未確認の事実・画像・X 投稿済みと同じ文は承認できない', () => {
  const q = day('2026-10-20');
  q[0] = { ...q[0], text: threadsItems[0].bodyJa.replace('。', '') };
  q[1] = { ...q[1], text: 'このゴルフ場で回収したボールです。', requiresVerifiedFact: false };
  q[2] = { ...q[2], images: ['assets/instagram/x.jpg'], verifiedFactIds: ['unknown-fact'] };
  const plan = planXBulkApproval({ ...base, dates: ['2026-10-20'], queue: q });
  assert.equal(plan.ok, false);
  const byId = Object.fromEntries(plan.problems.map((p) => [p.id, p.reasons.join('\n')]));
  assert.match(byId['x-2026-10-20-morning'], /Threads の投稿とほぼ同じです/);
  assert.match(byId['x-2026-10-20-noon'], /裏付けの無い具体的な事実/);
  assert.match(byId['x-2026-10-20-night'], /画像（images）は未対応/);
  assert.match(byId['x-2026-10-20-night'], /verified-facts.json に無い（未確認の）事実です: unknown-fact/);

  const posted = [{ id: 'x-old', date: '2026-10-10', text: textFor('2026-10-20', 'noon'), publishedAt: '2026-10-10T00:00:00Z' }];
  const dup = planXBulkApproval({ ...base, dates: ['2026-10-20'], queue: day('2026-10-20'), posted });
  assert.match(JSON.stringify(dup.problems), /X に投稿済みの文と同じです/);
});

test('URL 入りは allowLink が無ければ不可、あれば $0.20 と大きく警告。ショップ誘導は週1回まで', () => {
  const q = day('2026-10-20');
  q[1] = { ...q[1], text: '詳しくは example.com/shop から' };
  const noFlag = planXBulkApproval({ ...base, dates: ['2026-10-20'], queue: q });
  assert.match(JSON.stringify(noFlag.problems), /allowLink: true がありません（URL入りは1本 \$0\.2/);

  q[1] = { ...q[1], allowLink: true };
  const ok = planXBulkApproval({ ...base, dates: ['2026-10-20'], queue: q });
  assert.equal(ok.ok, true, JSON.stringify(ok.problems));
  const list = formatXBulkList({ dates: ['2026-10-20'], rows: ok.rows });
  assert.match(list, /⚠️⚠️ URL入り: 1本 \$0\.2（URLなしは \$0\.015。約13倍）/);
  assert.match(list, /⚠️ URL入り（\$0\.2\/本）/);

  const shop = [...day('2026-10-20'), ...day('2026-10-21')];
  shop[0] = { ...shop[0], text: `${shop[0].text}\n販売中です。プロフィールのリンクから` };
  shop[4] = { ...shop[4], text: `${shop[4].text}\nプロフィールのリンクからどうぞ` };
  const twice = planXBulkApproval({ ...base, queue: shop });
  assert.equal(twice.ok, false);
  assert.match(JSON.stringify(twice.problems), /2 shop posts \(max 1 a week\)/);
});

test('元の Threads が同じ日・同じ枠の日本語でなければ警告（止めない）。承認済み・過去日・枠なしの扱い', () => {
  const q = day('2026-10-20');
  q[0] = { ...q[0], threadsItemId: 'lb-2026-10-21-noon-ja' };
  q[1] = { ...q[1], threadsItemId: undefined };
  q[2] = { ...q[2], approved: true, approvedBy: 'KEITA', approvedAt: 'x' };
  const plan = planXBulkApproval({ ...base, dates: ['2026-10-20'], queue: q });
  assert.equal(plan.ok, true, JSON.stringify(plan.problems));
  assert.deepEqual(plan.approveIds, ['x-2026-10-20-morning', 'x-2026-10-20-noon']);
  const list = formatXBulkList({ dates: ['2026-10-20'], rows: plan.rows });
  assert.match(list, /同じ日・同じ枠の日本語ではありません/);
  assert.match(list, /threadsItemId がありません/);
  assert.match(list, /\[夜 20:10\] ✅ 承認済み/);

  const past = planXBulkApproval({ ...base, dates: ['2026-10-20'], queue: day('2026-10-20'), todayKey: '2026-10-21' });
  assert.match(JSON.stringify(past.problems), /過去の日付です/);
  const noSlot = planXBulkApproval({ ...base, dates: ['2026-10-20'], queue: [{ ...draft('2026-10-20', 'morning'), slot: undefined }] });
  assert.match(JSON.stringify(noSlot.problems), /枠\(slot\)がありません/);
  assert.match(formatXBulkList({ dates: ['2026-10-20'], rows: noSlot.rows }), /\[昼 12:10\] ❌ まだありません/);
});

test('--week は火〜月の7日（1週間で21本）', () => {
  const dates = datesFor({ week: '2026-10-22' });
  assert.equal(dates.length, 7);
  const queue = dates.flatMap((d, i) => SLOTS.map((s, j) => ({ ...draft(d, s), text: `第${i + 1}日の${['朝', '昼', '夜'][j]}の投稿。${'ゴルフ場の木陰で一息つくボールたちの話'.slice(i * 2 + j, i * 2 + j + 6)}${i}${j}` })));
  const plan = planXBulkApproval({ ...base, dates, queue, threadsItems: [] });
  assert.equal(plan.rows.length, 21);
});
