#!/usr/bin/env node
// 1日4本（2026-10-20〜）の Threads 投稿を、1日分・1週間分まとめて人間が承認する。
// 候補（data/draft-bank-candidates.json）→ 承認済み（data/draft-bank.json）への昇格だけを行う。
// Threads/Meta API へは一切接続しない（ローカルファイルI/Oのみ）。承認するのは人間だけ。
//
// 見るだけ（何も書き換えない）:
//   node scripts/bulk-approve.mjs --week 2026-10-20     （その日を含む火〜月の1週間）
//   node scripts/bulk-approve.mjs --date 2026-10-21
// 承認する（--by 名前 と --yes の両方が必要）:
//   node scripts/bulk-approve.mjs --week 2026-10-20 --by 承認者 --yes
//   node scripts/bulk-approve.mjs --week 2026-10-20 --exclude id1,id2 --by 承認者 --yes
//   （--exclude は1件ずつでもカンマ区切りでもよく、何回でも書ける。--week=2026-10-20 の形でもよい）
// 1件でも問題があれば、何も書き換えずに理由を表示して終わる（全部OKのときだけ書き込む）。

import fs from "node:fs/promises";
import { jstDateKey } from "../lib/target-date.mjs";
import { datesFor, planBulkApproval, formatBulkList } from "../lib/bulk-approve.mjs";

const BANK_PATH = new URL("../data/draft-bank.json", import.meta.url);
const CANDIDATES_PATH = new URL("../data/draft-bank-candidates.json", import.meta.url);
const POSTS_PATH = new URL("../data/threads-posts.json", import.meta.url);
const FACTS_PATH = new URL("../data/verified-facts.json", import.meta.url);

const argv = process.argv.slice(2);
function arg(name) {
  const eq = argv.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? undefined : argv[i + 1];
}
const exclude = argv
  .flatMap((a, i) => (a === "--exclude" ? [argv[i + 1]] : a.startsWith("--exclude=") ? [a.slice(10)] : []))
  .flatMap((v) => String(v ?? "").split(","))
  .map((s) => s.trim())
  .filter(Boolean);

async function readJson(url, fallback) {
  try {
    return JSON.parse(await fs.readFile(url, "utf8"));
  } catch {
    return fallback;
  }
}

let dates;
try {
  dates = datesFor({ date: arg("date"), week: arg("week"), from: arg("from"), to: arg("to") });
} catch (err) {
  console.error(`${err.message}\n使い方: node scripts/bulk-approve.mjs (--week YYYY-MM-DD | --date YYYY-MM-DD | --from YYYY-MM-DD --to YYYY-MM-DD) [--exclude id[,id]] [--by 名前 --yes]`);
  process.exit(1);
}

const bankFile = await readJson(BANK_PATH, { items: [] });
const candidatesFile = await readJson(CANDIDATES_PATH, { items: [] });
const postsFile = await readJson(POSTS_PATH, { posts: [] });
const factsFile = await readJson(FACTS_PATH, { facts: [] });

const by = arg("by");
const plan = planBulkApproval({
  candidates: candidatesFile.items,
  bankItems: bankFile.items,
  postedPosts: postsFile.posts,
  facts: factsFile.facts,
  dates,
  exclude,
  approvedBy: by || "(未指定)",
  approvedAt: new Date().toISOString(),
  todayKey: jstDateKey()
});

console.log(formatBulkList({ dates, rows: plan.rows, bankItems: bankFile.items }));
for (const n of plan.notices) console.log(`お知らせ: ${n}`);

if (!by || !argv.includes("--yes")) {
  if (plan.problems.length) {
    console.log("\n承認するには、先に次の問題を直すか --exclude で外してください:");
    for (const p of plan.problems) for (const r of p.reasons) console.log(`  ${p.id}: ${r}`);
  }
  console.log("\n（表示だけです。承認するには --by 名前 --yes を付けて実行してください）");
  process.exit(0);
}

if (!plan.ok) {
  console.error("\n承認していません（何も書き換えていません）:");
  for (const p of plan.problems) for (const r of p.reasons) console.error(`  ${p.id}: ${r}`);
  process.exit(1);
}

const approvedIds = new Set(plan.approvedIds);
bankFile.items = [...bankFile.items, ...plan.toApprove];
candidatesFile.items = candidatesFile.items.filter((c) => !approvedIds.has(c.id));
await fs.writeFile(BANK_PATH, `${JSON.stringify(bankFile, null, 2)}\n`);
await fs.writeFile(CANDIDATES_PATH, `${JSON.stringify(candidatesFile, null, 2)}\n`);
console.log(`\n${plan.toApprove.length}件を承認しました（${dates[0]} 〜 ${dates.at(-1)}、承認者: ${by}）。`);
for (const p of plan.toApprove) console.log(`  ${p.targetDate} ${p.slot}/${p.lang}  ${p.id}`);
console.log("次: npm run lostball:validate-data → git add data/draft-bank.json data/draft-bank-candidates.json → commit / push");
