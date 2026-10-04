#!/usr/bin/env node
// candidate(draft-bank-candidates.json) → draft-bank.json への唯一の昇格経路。
// 人間が --index と --approvedBy と --yes を明示して実行した場合のみ発生する。
// AIが自動的にapproved:trueを埋めて呼び出すことは想定していない。
// Threads/Meta APIへは一切接続しない(ローカルファイルI/Oのみ)。

import fs from "node:fs/promises";
import { promoteCandidate } from "../lib/approval-gate.mjs";
import { checkBilingualBody } from "../lib/bilingual-guard.mjs";
import { checkFactFabricationSignals } from "../lib/fact-fabrication-guard.mjs";

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

// verified-fact-guard(lib/verified-fact-guard.mjs)はrequiresVerifiedFact:trueの候補しか
// 検証しない。そのため、本文に具体的な未確認事実(特定ゴルフ場での回収・回収数/販売数/寄付数の
// 数字・架空の取引先・利用者の架空エピソード・障害/症状の創作・架空の環境効果・架空の寄付実績)を
// 書いてしまった場合、requiresVerifiedFactをtrueにし忘れていると素通りしてしまう抜け道がある。
// ここで追加チェックし、該当すれば昇格自体を止める(承認済みでも本文がこのまま昇格することはない)。
if (candidate.requiresVerifiedFact !== true) {
  const fabrication = checkFactFabricationSignals(candidate);
  if (!fabrication.ok) {
    console.error("未確認の具体的事実を含む可能性があるため昇格を中止しました(requiresVerifiedFact:trueではありません):");
    for (const w of fabrication.warnings) {
      console.error(`  - [${w.family}/${w.lang}] "${w.excerpt}" (${w.description})`);
    }
    console.error(
      "本文を修正して確認できる事実だけにするか、verified-facts.jsonに事実を登録したうえで" +
        "requiresVerifiedFact:true + verifiedFactIdsを設定してから再度実行してください。"
    );
    process.exit(1);
  }
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
