#!/usr/bin/env node
// 週次レビューCLI(毎週土曜日の.github/workflows/weekly-review.ymlから呼ばれる想定)。
//
// 行うこと:
//   1. data/threads-posts.json・data/threads-insights-history.json・data/draft-bank.json・
//      data/content-ideas.json・data/category-profile.json を読み込み、週次分析を行う
//      (lib/weekly-analysis.mjs。ネットワークには一切接続しない。全てローカルファイルI/O)。
//   2. 翌週(次の火曜日〜月曜日)7日分の「候補スケルトン」を生成する
//      (lib/weekly-candidates.mjs。本文は未執筆のプレースホルダー。verified-factsに無い
//      事実を断定したり、過去投稿を単純に言い換えたりする処理は一切行わない)。
//   3. data/draft-bank-candidates.json へ候補を保存する(アップサート。既存の承認フローを
//      迂回しない。approvedBy/approvedAtは常にnull)。
//
// 行わないこと:
//   - data/draft-bank.jsonへの書き込み(昇格はscripts/promote-candidates.mjsの人間操作のみ)。
//   - data/verified-facts.jsonへの書き込み。
//   - data/threads-posts.jsonへの書き込み(読み取りのみ)。
//   - Threads API・Discordへの接続(呼び出し側のworkflowが別stepで行う)。
//   - git add/commit/push(呼び出し側のworkflowの責務)。

import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { jstDateKey } from "../lib/target-date.mjs";
import { analyzeWeekly } from "../lib/weekly-analysis.mjs";
import { generateWeeklyCandidates, estimateNextWeekStart } from "../lib/weekly-candidates.mjs";
import { readInsightsHistoryFile } from "../lib/threads-insights-store.mjs";
import { upsertCandidates, readCandidatesFile } from "../lib/draft-bank-candidates-store.mjs";

const POSTS_PATH = new URL("../data/threads-posts.json", import.meta.url);
const BANK_PATH = new URL("../data/draft-bank.json", import.meta.url);
const CONTENT_IDEAS_PATH = new URL("../data/content-ideas.json", import.meta.url);
const CATEGORY_PROFILE_PATH = new URL("../data/category-profile.json", import.meta.url);
const INSIGHTS_HISTORY_PATH = new URL("../data/threads-insights-history.json", import.meta.url);
const CANDIDATES_PATH = new URL("../data/draft-bank-candidates.json", import.meta.url);
const INSIGHTS_HISTORY_PATH_STR = fileURLToPath(INSIGHTS_HISTORY_PATH);
const CANDIDATES_PATH_STR = fileURLToPath(CANDIDATES_PATH);

async function readJson(url, fallback) {
  try {
    return JSON.parse(await fs.readFile(url, "utf8"));
  } catch {
    return fallback;
  }
}

function printAnalysis(analysis) {
  console.log("=== 週次分析: 事実 ===");
  for (const f of analysis.facts) console.log(`- ${f}`);
  console.log("\n=== 週次分析: 暫定的な傾向(断定ではありません) ===");
  if (analysis.tentativeTrends.length === 0) console.log("(現時点では暫定的な傾向と呼べるものもありません)");
  for (const t of analysis.tentativeTrends) console.log(`- ${t}`);
  console.log("\n=== 週次分析: まだ判断できないこと ===");
  for (const q of analysis.openQuestions) console.log(`- ${q}`);
}

function printCandidates(candidates) {
  console.log("\n=== 翌週7投稿の候補(未承認・プレースホルダー) ===");
  for (const c of candidates) {
    console.log(`- ${c.targetDate} (day=${c.day}) pillar=${c.pillar} category=${c.category} suggestedTopic=${c.suggestedTopic?.labelJa ?? "(未定)"}`);
  }
}

function argValue(flag) {
  const arg = process.argv.find((a) => a.startsWith(`--${flag}=`));
  return arg ? arg.split("=").slice(1).join("=") : null;
}

async function writeGithubOutput(name, value) {
  const file = process.env.GITHUB_OUTPUT;
  if (!file) return;
  const text = String(value ?? "");
  if (text.includes("\n")) {
    const delimiter = `ghadelim_${Math.random().toString(36).slice(2)}`;
    await fs.appendFile(file, `${name}<<${delimiter}\n${text}\n${delimiter}\n`);
  } else {
    await fs.appendFile(file, `${name}=${text}\n`);
  }
}

async function main() {
  const postsFile = await readJson(POSTS_PATH, { posts: [] });
  const bankFile = await readJson(BANK_PATH, { items: [] });
  const contentIdeas = await readJson(CONTENT_IDEAS_PATH, { themes: [] });
  const categoryProfile = await readJson(CATEGORY_PROFILE_PATH, { week2PlusCandidateCategories: [] });
  const insightsHistory = await readInsightsHistoryFile(INSIGHTS_HISTORY_PATH_STR);

  const analysis = analyzeWeekly({
    posts: postsFile.posts,
    bankItems: bankFile.items,
    insightsHistory,
    contentIdeas
  });
  printAnalysis(analysis);

  // 通常(毎週土曜日の自動実行)は「次の火曜日」を自動計算するが、
  // --weekStart=YYYY-MM-DD を明示した場合はそれを優先する
  // (例: DAY1〜22登録済みの初回だけ、実際の次回土曜日を待たずに10/20〜10/26分を
  // 作成するための手動実行。本番の毎週自動実行はこのフラグを使わず自動計算のみに頼る)。
  //
  // 2026-10-03判明の不具合修正: 単純にnextTuesdayDateKey(todayKey)だけを使うと、
  // 既存の承認済み予定(draft-bank.json)・既存の未承認候補(draft-bank-candidates.json)・
  // targetDateを持たないFIFOキューの残り件数のいずれも考慮せず、重複する週の候補を
  // 生成してしまう(実際に発生した事象: lib/weekly-candidates.mjsのコメント参照)。
  // estimateNextWeekStartが、この3つを踏まえた「重複しない次の火曜日」を計算する。
  const todayKey = jstDateKey();
  const existingCandidatesFile = await readCandidatesFile(CANDIDATES_PATH_STR);
  const weekStartOverride = argValue("weekStart");
  const weekStartDateKey =
    weekStartOverride ||
    estimateNextWeekStart(todayKey, {
      bankItems: bankFile.items,
      existingCandidates: existingCandidatesFile.items,
      postedPosts: postsFile.posts
    });
  const maxDay = bankFile.items.reduce((max, item) => Math.max(max, item.day ?? 0), 0);

  const candidates = generateWeeklyCandidates({
    bankItems: bankFile.items,
    categoryProfile,
    unusedContentIdeas: analysis.unusedContentIdeas,
    weekStartDateKey,
    startDay: maxDay + 1
  });
  printCandidates(candidates);

  await upsertCandidates(CANDIDATES_PATH_STR, candidates);
  console.log(`\ndata/draft-bank-candidates.json へ${candidates.length}件の候補を保存しました(承認はまだ行われていません)。`);

  await writeGithubOutput("weekStartDateKey", weekStartDateKey);
  await writeGithubOutput("weekEndDateKey", candidates[candidates.length - 1]?.targetDate ?? "");
  await writeGithubOutput("candidateCount", String(candidates.length));
  await writeGithubOutput("postedCount", String(analysis.postedCount));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
