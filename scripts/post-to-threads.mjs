#!/usr/bin/env node
// Phase 2: 投稿処理のdry-run専用スクリプト。
//
// 安全設計(誤操作・設定ミスでも実投稿されないための二重ゲート):
//   1. env.LIVE_POST が文字列 "true" と厳密一致すること
//   2. CLI引数に --live が明示的に渡されていること
//   のどちらも満たさない限り、常にdry-runとして動作する。
//   さらに、上記2つが両方揃った場合でも、Threadsへ実際にPOSTする処理(publish)は
//   このPhase 2のコードには一切実装していないため、そのまま明示的に失敗する。
//   本番投稿の実装はPhase 3で人間の明示承認のもとに行う。
//
// Threads/Discordへの書き込みは一切行わない(fetch呼び出しを含まない)。
// アクセストークン等のSecretsはこのスクリプトの実行に不要(dry-runはローカルdataのみで完結する)。

import fs from "node:fs/promises";
import { jstDateKey } from "../lib/target-date.mjs";
import { buildPostedBodySet } from "../lib/duplicate-guard.mjs";
import { loadLocalEnv, mergeWithProcessEnv } from "../lib/load-local-env.mjs";
import { buildDryRunReport } from "../lib/post-report.mjs";
import { buildDiscordDryRunMessage } from "../lib/discord-notifier.mjs";
import { selectDailyCandidate } from "./select-daily-candidate.mjs";

const BANK_PATH = new URL("../data/draft-bank.json", import.meta.url);
const POSTS_PATH = new URL("../data/threads-posts.json", import.meta.url);
const FACTS_PATH = new URL("../data/verified-facts.json", import.meta.url);

async function readJson(url, fallback) {
  try {
    return JSON.parse(await fs.readFile(url, "utf8"));
  } catch {
    return fallback;
  }
}

function truthyFlag(value) {
  return String(value ?? "").trim() === "true";
}

async function main() {
  // Secrets(THREADS_ACCESS_TOKEN等)はここでは読まない。dry-runに不要なため要求しない。
  const env = mergeWithProcessEnv(loadLocalEnv());
  const livePostEnvRequested = truthyFlag(env.LIVE_POST);
  const liveDiscordEnvRequested = truthyFlag(env.LIVE_DISCORD);
  const liveFlagRequested = process.argv.includes("--live");

  console.log("=== Threads投稿 dry-run (Phase 2: 実投稿は一切行いません) ===");
  console.log(`LIVE_POST(検出値): ${livePostEnvRequested ? "true" : "false"} / --live指定: ${liveFlagRequested}`);
  console.log(`LIVE_DISCORD(検出値): ${liveDiscordEnvRequested ? "true" : "false"}`);
  console.log("");

  // 二重ゲート: 両方揃わない限りここを通過しない。揃った場合も、実装が無いため必ず失敗する。
  if (livePostEnvRequested && liveFlagRequested) {
    console.error("LIVE_POST=true と --live が両方指定されました。");
    console.error("しかしPhase 2にはThreadsへ実際にPOSTするコードを実装していません(安全のため意図的に未実装)。");
    console.error("本番投稿はPhase 3で人間の明示承認のもとに実装します。ここでは処理を中断します。");
    process.exitCode = 1;
    return;
  }

  const bank = await readJson(BANK_PATH, { items: [] });
  const postsFile = await readJson(POSTS_PATH, { posts: [] });
  const factsFile = await readJson(FACTS_PATH, { facts: [] });

  const todayKey = jstDateKey();
  const { selected, skipped } = await selectDailyCandidate({
    bankItems: bank.items,
    postedPosts: postsFile.posts,
    facts: factsFile.facts,
    todayKey
  });

  console.log(`実行日(JST): ${todayKey}`);
  for (const { item, reason } of skipped) {
    console.warn(`SKIP: day=${item.day ?? "?"} category=${item.category || "?"} reason=${reason}`);
  }

  if (!selected) {
    console.log("");
    console.log("本日投稿できる候補がありません(全件投稿済み、または選出条件を満たしていません)。");
    console.log("最終結果: DRY_RUN (対象なし・実投稿は行っていません)");
    return;
  }

  const postedBodySet = buildPostedBodySet(postsFile.posts);
  const report = buildDryRunReport(selected, { postedBodySet, facts: factsFile.facts });

  console.log("");
  console.log(`投稿対象: ${report.id} (day=${report.day ?? "-"}, pillar=${report.pillar ?? "-"}, category=${report.category ?? "-"})`);
  console.log(`targetDate: ${report.targetDate ?? "(未指定)"}`);
  console.log(`文字数: ${report.combinedLength}/${report.maxLength}`);
  console.log(`CTA有無: ${report.hasCta ? "あり" : "なし"} / ショップリンク: ${report.hasShopLink ? "あり" : "なし"}`);
  console.log(
    `画像: type=${report.media.type} required=${report.media.required} 承認済み=${report.media.approved} 画像あり=${report.media.hasImage}`
  );

  console.log("");
  console.log("--- ガード結果 ---");
  console.log(`併記フォーマット(英語→空行→日本語・500文字以内・生URL禁止): ${report.guards.bilingual.ok ? "OK" : `NG(${report.guards.bilingual.errors.join(", ")})`}`);
  console.log(`verified-facts整合(捏造防止): ${report.guards.verifiedFact.ok ? "OK" : `NG(${report.guards.verifiedFact.reason})`}`);
  console.log(`重複投稿チェック: ${report.guards.duplicate.isDuplicate ? "NG(投稿済みと重複)" : "OK"}`);
  console.log(
    `メディアガード: ${report.guards.media.errors.length === 0 ? "OK" : `NG(${report.guards.media.errors.join(", ")})`}` +
      (report.guards.media.warnings.length ? ` / warning: ${report.guards.media.warnings.join(", ")}` : "")
  );
  if (report.guards.claimWarnings.length) {
    console.log("表現チェック警告(未確認の断定表現・福祉の同情訴求等。投稿はブロックしません、人間の確認材料です):");
    for (const w of report.guards.claimWarnings) {
      console.log(`  [${w.family}:${w.lang}] "${w.match}"`);
    }
  }

  console.log("");
  console.log("--- 投稿本文プレビュー ---");
  console.log(report.body);

  console.log("");
  console.log("--- Discord通知プレビュー(dry-run。実送信は行っていません) ---");
  console.log(buildDiscordDryRunMessage(report));

  console.log("");
  if (!report.guardsOk) {
    // 通常はselectDailyCandidate側の各ガードで既に除外されているため到達しない想定だが、
    // 念のためレポート側でも再確認し、NGがあれば最終結果に明示する。
    console.log("最終結果: DRY_RUN (一部ガードNGを検出。実投稿は行っていません)");
  } else {
    console.log("最終結果: DRY_RUN (実投稿は行っていません)");
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
