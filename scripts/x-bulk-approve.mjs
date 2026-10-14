#!/usr/bin/env node
// X の1日3本（2026-10-20〜。朝07:10・昼12:10・夜20:10）を、1日分・1週間分まとめて人間が承認する。
// data/x-queue.json の approved を false → true にするだけ。X の API へは一切接続しない（ローカルファイルI/Oのみ）。
// （Threads の scripts/bulk-approve.mjs と同じ使い方）
//
// 見るだけ（何も書き換えない）:
//   node scripts/x-bulk-approve.mjs --week 2026-10-20     （その日を含む火〜月の1週間）
//   node scripts/x-bulk-approve.mjs --date 2026-10-21
// 承認する（--by 名前 と --yes の両方が必要）:
//   node scripts/x-bulk-approve.mjs --week 2026-10-20 --by 承認者 --yes
//   node scripts/x-bulk-approve.mjs --week 2026-10-20 --exclude id1,id2 --by 承認者 --yes
// 1件でも問題があれば、何も書き換えずに理由を表示して終わる（全部OKのときだけ書き込む）。

import fs from 'node:fs/promises';
import { jstDateKey } from '../lib/target-date.mjs';
import { datesFor } from '../lib/bulk-approve.mjs';
import { planXBulkApproval, formatXBulkList } from '../lib/x-bulk-approve.mjs';

const path = (p) => new URL(`../${p}`, import.meta.url);
const argv = process.argv.slice(2);
function arg(name) {
  const eq = argv.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? undefined : argv[i + 1];
}
const exclude = argv
  .flatMap((a, i) => (a === '--exclude' ? [argv[i + 1]] : a.startsWith('--exclude=') ? [a.slice(10)] : []))
  .flatMap((v) => String(v ?? '').split(','))
  .map((s) => s.trim())
  .filter(Boolean);

async function readJson(p, fallback) {
  try {
    return JSON.parse(await fs.readFile(path(p), 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    throw err;
  }
}

let dates;
try {
  dates = datesFor({ date: arg('date'), week: arg('week'), from: arg('from'), to: arg('to') });
} catch (err) {
  console.error(`${err.message}\n使い方: node scripts/x-bulk-approve.mjs (--week YYYY-MM-DD | --date YYYY-MM-DD | --from YYYY-MM-DD --to YYYY-MM-DD) [--exclude id[,id]] [--by 名前 --yes]`);
  process.exit(1);
}

const queue = await readJson('data/x-queue.json', []);
const posted = await readJson('data/x-posts.json', []);
const bank = (await readJson('data/draft-bank.json', { items: [] })).items ?? [];
const candidates = (await readJson('data/draft-bank-candidates.json', { items: [] })).items ?? [];
const threadsPosts = (await readJson('data/threads-posts.json', { posts: [] })).posts ?? [];
const facts = (await readJson('data/verified-facts.json', { facts: [] })).facts ?? [];
const texts = (list) => list.flatMap((p) => [p.bodyJa, p.bodyEn]).filter(Boolean);

const by = arg('by');
const approvedAt = new Date().toISOString();
const plan = planXBulkApproval({
  queue,
  posted,
  threadsItems: [...bank, ...candidates],
  threadsTexts: [...texts(bank), ...texts(candidates), ...texts(threadsPosts)],
  facts,
  dates,
  exclude,
  approvedBy: by || '(未指定)',
  approvedAt,
  todayKey: jstDateKey(),
});

console.log(formatXBulkList({ dates, rows: plan.rows }));
for (const n of plan.notices) console.log(`お知らせ: ${n}`);

if (!by || !argv.includes('--yes')) {
  if (plan.problems.length) {
    console.log('\n承認するには、先に次の問題を直すか --exclude で外してください:');
    for (const p of plan.problems) for (const r of p.reasons) console.log(`  ${p.id}: ${r}`);
  }
  console.log('\n（表示だけです。承認するには --by 名前 --yes を付けて実行してください）');
  process.exit(0);
}

if (!plan.ok) {
  console.error('\n承認していません（何も書き換えていません）:');
  for (const p of plan.problems) for (const r of p.reasons) console.error(`  ${p.id}: ${r}`);
  process.exit(1);
}

const ids = new Set(plan.approveIds);
for (const p of queue) if (ids.has(p.id)) Object.assign(p, { approved: true, approvedBy: by, approvedAt });
await fs.writeFile(path('data/x-queue.json'), `${JSON.stringify(queue, null, 2)}\n`);
console.log(`\nX ${ids.size}件を承認しました（${dates[0]} 〜 ${dates.at(-1)}、承認者: ${by}）。`);
for (const p of queue.filter((q) => ids.has(q.id))) console.log(`  ${p.date} ${p.slot}  ${p.id}`);
console.log('次: npm run x:validate → git add data/x-queue.json → commit / push');
