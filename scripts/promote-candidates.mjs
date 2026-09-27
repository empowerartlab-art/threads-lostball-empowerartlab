#!/usr/bin/env node
// candidate(draft-bank-candidates.json) → draft-bank.json への唯一の昇格経路。
// 人間が --index と --approvedBy と --yes を明示して実行した場合のみ発生する。
// AIが自動的にapproved:trueを埋めて呼び出すことは想定していない。
// Threads/Meta APIへは一切接続しない(ローカルファイルI/Oのみ)。

import fs from "node:fs/promises";
import { promoteCandidate } from "../lib/approval-gate.mjs";
import { checkBilingualBody } from "../lib/bilingual-guard.mjs";

const CANDIDATES_PATH = new URL("../data/draft-bank-candidates.json", import.meta.url);
const BANK_PATH = new URL("../data/draft-bank.json", import.meta.url);

function argValue(flag) {
  const arg = process.argv.find((a) => a.startsWith(`--${flag}=`));
  return arg ? arg.split("=").slice(1).join("=") : null;
}

async function readJson(url, fallback) {
  try {
    return JSON.parse(await fs.readFile(url, "utf8"));
  } catch {
    return fallback;
  }
}

const index = Number(argValue("index"));
const approvedBy = argValue("approvedBy");
const yes = process.argv.includes("--yes");

if (Number.isNaN(index) || !approvedBy || !yes) {
  console.error(
    "使い方: node scripts/promote-candidates.mjs --index=0 --approvedBy=\"名前またはメールアドレス\" --yes"
  );
  process.exit(1);
}

const candidatesFile = await readJson(CANDIDATES_PATH, { items: [] });
const candidate = candidatesFile.items[index];
if (!candidate) {
  console.error(`--index=${index} に該当するcandidateがありません。`);
  process.exit(1);
}

const bilingualCheck = checkBilingualBody(candidate);
if (!bilingualCheck.ok) {
  console.error(`併記フォーマットチェックに失敗したため昇格を中止しました: ${bilingualCheck.errors.join(", ")}`);
  process.exit(1);
}

const promoted = promoteCandidate(candidate, {
  approved: true,
  approvedBy,
  approvedAt: new Date().toISOString()
});

const bankFile = await readJson(BANK_PATH, { items: [] });
bankFile.items.push(promoted);
await fs.writeFile(BANK_PATH, `${JSON.stringify(bankFile, null, 2)}\n`);

candidatesFile.items.splice(index, 1);
await fs.writeFile(CANDIDATES_PATH, `${JSON.stringify(candidatesFile, null, 2)}\n`);

console.log(`昇格しました: ${promoted.id} (approvedBy=${promoted.approvedBy})`);
