#!/usr/bin/env node
// Phase 3 Stage 3: 候補選出→既存ガード→二重ゲート→publishPost→結果判定→(成功時のみ)state保存
// のオーケストレーションは lib/live-post-runner.mjs に委譲する薄いCLIシェル。選出・ガード・
// 二重ゲート・API呼び出し・state永続化のロジックはこのファイルには一切書かない
// (lib/live-post-runner.mjs / lib/threads-publish.mjs / lib/threads-client.mjs /
// lib/threads-posts-store.mjs 参照)。このファイルの責務はファイルI/Oのパス解決と
// 出力(コンソール表示)のみ。git add/commit/pushはここでも一切行わない
// (commit/pushはlive-post-manual workflow側の別責務)。
//
// 安全設計は変更していない(Phase 2から維持):
//   env.LIVE_POST が文字列 "true" と厳密一致し、かつ CLI引数に --live が明示的に渡された
//   場合にのみ、lib/threads-publish.mjsの二重ゲートを通過してThreads APIへ実際に接続する。
//   どちらか一方だけ、または両方falseの場合は常にdry-run(Threads APIへは一切接続しない)。
//   この判定はlib/threads-publish.mjsのisLivePostAllowed()に一元化されており、
//   このファイルでは再実装しない。
//
// data/threads-posts.jsonへの永続書き込みは、Threads投稿(publish)が実際に成功した場合
// (lib/live-post-runner.mjsのOUTCOME.POSTED_STATE_SAVED/POSTED_STATE_SAVE_FAILEDの分岐)
// にのみ発生する。dry-run(OUTCOME.DRY_RUN/NO_CANDIDATE)では一切書き込まれない。
//
// アクセストークン等のSecretsは、dry-run(このゲートを満たさない場合)には不要
// (dry-runはローカルdataのみで完結する)。二重ゲートを満たしてlive投稿を試みる場合のみ
// env.THREADS_ACCESS_TOKEN / env.THREADS_USER_ID を使用する。
//
// GITHUB_OUTPUT(存在する場合のみ)へ outcome 等を書き出す。.github/workflows/live-post-manual.yml /
// daily-live-post.yml がこれを見て、POSTED_STATE_SAVEDの時だけ data/threads-posts.json を
// commit/pushし、Discord通知の本文組み立てにも使う(このファイル自身はgit操作・Discord送信を
// 一切行わない。値はThreads投稿本文や既にredact済みのエラーメッセージのみで、
// アクセストークン等のSecretsは一切含まない)。

import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { jstDateKey } from "../lib/target-date.mjs";
import { loadLocalEnv, mergeWithProcessEnv } from "../lib/load-local-env.mjs";
import { createSecretRedactor } from "../lib/redact.mjs";
import { buildDiscordDryRunMessage } from "../lib/discord-notifier.mjs";
import { runLivePost, OUTCOME } from "../lib/live-post-runner.mjs";
import { appendPostRecord } from "../lib/threads-posts-store.mjs";

const BANK_PATH = new URL("../data/draft-bank.json", import.meta.url);
const POSTS_PATH = new URL("../data/threads-posts.json", import.meta.url);
const FACTS_PATH = new URL("../data/verified-facts.json", import.meta.url);
const POSTS_PATH_STR = fileURLToPath(POSTS_PATH);

// GitHub Actions上で実行された場合のみ実行URLを組み立てる(追加のSecrets等は不要。
// ローカル実行時はundefinedのままで、buildPostRecordがnullを補う)。
function currentWorkflowRunUrl(env) {
  if (!env.GITHUB_SERVER_URL || !env.GITHUB_REPOSITORY || !env.GITHUB_RUN_ID) return undefined;
  return `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`;
}

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

// Stage 4修正: live投稿を実際に試みる場合(二重ゲートが揃っている場合)にまで
// 「実投稿は一切行いません」と表示してしまう問題を避けるため、見出し文言をここで分離する。
// dry-run側の文言はPhase 2から一文字も変えていない(GitHub Actions側の文字列依存は
// 「最終結果: DRY_RUN」等、末尾の結果行のみを見ているため、この見出し自体には依存しない)。
export function buildHeaderLine(attemptingLive) {
  return attemptingLive
    ? '=== Threads投稿 LIVE (LIVE_POST="true" かつ --live が指定されたため、実際にThreads APIへの投稿を試みます) ==='
    : "=== Threads投稿 dry-run (Phase 2: 実投稿は一切行いません) ===";
}

// GitHub Actions以外(ローカル実行)ではGITHUB_OUTPUTが無いので何もしない。
// 改行を含む値(投稿本文等)はGitHub Actionsのheredoc区切り構文で書き出す
// (単純な "name=value" 形式は値に改行が入ると壊れるため)。
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

function printReport(report) {
  console.log(
    `投稿対象: ${report.id} (day=${report.day ?? "-"}, pillar=${report.pillar ?? "-"}, category=${report.category ?? "-"})`
  );
  console.log(`targetDate: ${report.targetDate ?? "(未指定)"}`);
  console.log(`文字数: ${report.combinedLength}/${report.maxLength}`);
  console.log(`CTA有無: ${report.hasCta ? "あり" : "なし"} / ショップリンク: ${report.hasShopLink ? "あり" : "なし"}`);
  console.log(
    `画像: type=${report.media.type} required=${report.media.required} 承認済み=${report.media.approved} 画像あり=${report.media.hasImage}`
  );

  console.log("");
  console.log("--- ガード結果 ---");
  console.log(
    `併記フォーマット(英語→空行→日本語・500文字以内・生URL禁止): ${
      report.guards.bilingual.ok ? "OK" : `NG(${report.guards.bilingual.errors.join(", ")})`
    }`
  );
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
}

async function main() {
  const env = mergeWithProcessEnv(loadLocalEnv());
  const redact = createSecretRedactor([env.THREADS_ACCESS_TOKEN]);
  const livePostEnvRequested = truthyFlag(env.LIVE_POST);
  const liveDiscordEnvRequested = truthyFlag(env.LIVE_DISCORD);
  const liveFlagRequested = process.argv.includes("--live");
  // 二重ゲートが実際に揃っているか(=これから本当にThreads APIへ接続を試みるか)は、
  // 呼び出し結果を待たなくてもこの時点で確定する(lib/threads-publish.mjsのisLivePostAllowedと同じ条件)。
  // ここが揃っていない限り「実投稿は一切行いません」という見出しは常に正しいので、
  // dry-runの表示はPhase 2から一切変更していない。
  const attemptingLive = livePostEnvRequested && liveFlagRequested;

  console.log(buildHeaderLine(attemptingLive));
  console.log(`LIVE_POST(検出値): ${livePostEnvRequested ? "true" : "false"} / --live指定: ${liveFlagRequested}`);
  console.log(`LIVE_DISCORD(検出値): ${liveDiscordEnvRequested ? "true" : "false"}`);
  console.log("");

  const bank = await readJson(BANK_PATH, { items: [] });
  const postsFile = await readJson(POSTS_PATH, { posts: [] });
  const factsFile = await readJson(FACTS_PATH, { facts: [] });

  const todayKey = jstDateKey();
  console.log(`実行日(JST): ${todayKey}`);

  const result = await runLivePost({
    bankItems: bank.items,
    postedPosts: postsFile.posts,
    facts: factsFile.facts,
    todayKey,
    userId: env.THREADS_USER_ID,
    accessToken: env.THREADS_ACCESS_TOKEN,
    live: liveFlagRequested,
    env,
    redact,
    workflowRunUrl: currentWorkflowRunUrl(env),
    // Threads投稿(publish)が実際に成功した場合にのみ呼ばれる。dry-run/失敗時は一切呼ばれないため、
    // data/threads-posts.jsonはここでは書き換わらない(lib/live-post-runner.mjs参照)。
    saveState: (record) => appendPostRecord(POSTS_PATH_STR, record)
  });

  // Discord通知の本文組み立て用に、workflow側から参照できる形でいくつか追加出力する。
  // ここに書き出すのは投稿本文・候補ID・投稿ID・(既にredact済みの)エラーメッセージのみで、
  // アクセストークン等のSecretsは一切含まない。
  const sourceItemId = result.selected?.id ?? "";
  const failureReason = result.reason ?? "";
  const errorMessage = result.error ? redact(result.error.message ?? "") : "";
  const postBody = result.report?.body ?? result.publishResult?.body ?? "";

  // コンテナ作成(POST /{userId}/threads)のリトライ情報。成功時はresult.containerRetryに、
  // リトライも尽きて失敗した場合はresult.error(lib/threads-publish.mjsのcreateContainerWithRetryが
  // err.stage/err.firstAttemptErrorを付与済み)に入っている。どちらにも無ければリトライ自体
  // 発生していない(dry-run・guard-check-failed・publishContainer失敗など)。
  // firstAttemptErrorのmessageは取得元ですでにredact済みだが、念のためここでも通す。
  const containerRetry =
    result.containerRetry ??
    (result.error?.stage === "createTextContainer"
      ? { attempted: true, count: 1, firstAttemptError: result.error.firstAttemptError ?? null }
      : null);
  const containerRetryAttempted = containerRetry?.attempted ? "true" : "false";
  const containerRetryCount = String(containerRetry?.count ?? 0);
  const containerFirstAttemptErrorMessage = containerRetry?.firstAttemptError?.message
    ? redact(containerRetry.firstAttemptError.message)
    : "";

  await writeGithubOutput("outcome", result.outcome);
  await writeGithubOutput("sourceItemId", sourceItemId);
  await writeGithubOutput("threadsPostId", result.threadsPostId ?? "");
  await writeGithubOutput("failureReason", failureReason);
  await writeGithubOutput("errorMessage", errorMessage);
  await writeGithubOutput("body", postBody);
  await writeGithubOutput("containerRetryAttempted", containerRetryAttempted);
  await writeGithubOutput("containerRetryCount", containerRetryCount);
  await writeGithubOutput("containerFirstAttemptErrorMessage", containerFirstAttemptErrorMessage);

  for (const { item, reason } of result.skipped || []) {
    console.warn(`SKIP: day=${item.day ?? "?"} category=${item.category || "?"} reason=${reason}`);
  }

  if (result.outcome === OUTCOME.NO_CANDIDATE) {
    console.log("");
    console.log("本日投稿できる候補がありません(全件投稿済み、または選出条件を満たしていません)。");
    console.log("最終結果: DRY_RUN (対象なし・実投稿は行っていません)");
    return;
  }

  if (result.outcome === OUTCOME.PRE_POST_FAILURE && result.reason === "guard-check-failed") {
    // live投稿を実際に試みる直前、既存ガード再検証によるブロック(Threads APIへは一切接続していない)。
    console.log("");
    printReport(result.report);
    console.log("");
    console.log("最終結果: PRE_POST_FAILURE (既存ガードでNGが検出されたため、投稿を行っていません)");
    process.exitCode = 1;
    return;
  }

  if (result.outcome === OUTCOME.PRE_POST_FAILURE) {
    // publishPost呼び出し自体(コンテナ作成/publish)が失敗。Threadsへの投稿は行われていない。
    console.log("");
    if (result.report) printReport(result.report);
    console.log("");
    console.log(`エラー: ${redact(result.error?.message ?? "(詳細不明)")}`);
    console.log("最終結果: PRE_POST_FAILURE (Threadsへの投稿は行われていません)");
    process.exitCode = 1;
    return;
  }

  if (result.outcome === OUTCOME.DRY_RUN) {
    console.log("");
    printReport(result.report);

    console.log("");
    console.log("--- Discord通知プレビュー(dry-run。実送信は行っていません) ---");
    console.log(buildDiscordDryRunMessage(result.report));

    console.log("");
    if (!result.report.guardsOk) {
      // 通常はselectDailyCandidate側の各ガードで既に除外されているため到達しない想定だが、
      // 念のためレポート側でも再確認し、NGがあれば最終結果に明示する(従来のPhase 2と同じ挙動)。
      console.log("最終結果: DRY_RUN (一部ガードNGを検出。実投稿は行っていません)");
    } else {
      console.log("最終結果: DRY_RUN (実投稿は行っていません)");
    }
    return;
  }

  // ここから下(POSTED_STATE_SAVED / POSTED_STATE_SAVE_FAILED)は、
  // env.LIVE_POST==="true" かつ --live の両方が揃い、かつ既存ガードもすべてOKで、
  // 実際にThreads APIへの投稿が成功した場合にのみ到達する。
  console.log("");
  console.log("=== LIVE投稿完了(Threadsへの投稿自体は成功しています) ===");
  console.log(`threadsPostId: ${result.threadsPostId}`);

  if (result.outcome === OUTCOME.POSTED_STATE_SAVED) {
    console.log(`data/threads-posts.json への記録に成功しました(sourceItemId=${result.record?.sourceItemId ?? "-"})。`);
    console.log("最終結果: POSTED_STATE_SAVED");
    return;
  }

  // POSTED_STATE_SAVE_FAILED: Threads側には投稿が存在するが、ローカルのstate保存に失敗した状態。
  // ここで自動的に再投稿・自動リトライは一切行わない(二重投稿になるため)。
  console.log("");
  console.log("!!! 警告: Threadsへの投稿自体は成功しましたが、data/threads-posts.jsonへの記録(state保存)に失敗しました。 !!!");
  console.log(`エラー: ${redact(result.error?.message ?? "(詳細不明)")}`);
  console.log("");
  console.log("【再実行禁止】このままこのスクリプトを再実行すると、Threadsへの二重投稿になる可能性があります。");
  console.log("人間がThreadsの実アカウント(@lost_ball_empowerartlab)を直接確認し、");
  console.log(`threadsPostId=${result.threadsPostId} の投稿が実際に存在することを確認したうえで、`);
  console.log("data/threads-posts.json へ手動で記録を追記してください(自動再実行はしないでください)。");
  console.log("最終結果: POSTED_STATE_SAVE_FAILED");
  process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
