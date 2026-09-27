// live投稿オーケストレーション(候補選出→既存ガード→重複チェック→二重ゲート確認→publishPost→結果判定)。
// 既存ロジック(選出・各種ガード・重複防止・二重ゲート・API呼び出し)はこのファイルでは再実装せず、
// scripts/select-daily-candidate.mjs / lib/post-report.mjs / lib/threads-publish.mjs を
// そのまま呼び出すだけに徹する。
//
// data/threads-posts.jsonへの永続書き込み・git commit/pushはこのモジュール自身では行わない
// (Stage 2時点ではsaveStateのデフォルトはno-op)。呼び出し側がsaveStateを注入することで
// 後続ステージ(実ファイルI/O・commit/push)を安全に差し込める構造にしている。
//
// OUTCOMEの意味:
//   NO_CANDIDATE            : 選出可能な承認済み候補が無い(全件投稿済み/重複/未検証事実等で除外された場合を含む)。
//                             publishPostは一切呼ばれない。
//   DRY_RUN                 : Threadsへの投稿は行っていない(--live未指定 or env.LIVE_POST!=="true")。
//                             publishPost自体は呼ぶが、内部の二重ゲートでThreads APIへは接続しない。
//   PRE_POST_FAILURE        : Threadsへの投稿を試みる前、または試みた呼び出し自体が失敗した。
//                             (a) live投稿を実際に試みる状況(二重ゲートが揃っている)で、
//                                 既存ガード再検証(併記フォーマット・verified-facts・重複・メディア)がNGのため
//                                 publishPostを一切呼ばずに中断した場合。
//                             (b) publishPost呼び出し自体(コンテナ作成/publish)が例外を投げた場合。
//                             いずれもThreadsへの投稿は発生していない。
//   POSTED_STATE_SAVED      : Threadsへの投稿が成功し、state保存(saveState)も成功した。
//   POSTED_STATE_SAVE_FAILED: Threadsへの投稿は成功したが、state保存に失敗した。
//                             この状態のときは絶対に投稿をやり直してはいけない
//                             (Threads側には既に投稿が存在するため、再実行は二重投稿になる)。

import { jstDateKey } from "./target-date.mjs";
import { buildPostedBodySet } from "./duplicate-guard.mjs";
import { buildDryRunReport } from "./post-report.mjs";
import { isLivePostAllowed, publishPost, buildPostRecord } from "./threads-publish.mjs";
import { selectDailyCandidate } from "../scripts/select-daily-candidate.mjs";

export const OUTCOME = Object.freeze({
  NO_CANDIDATE: "NO_CANDIDATE",
  DRY_RUN: "DRY_RUN",
  PRE_POST_FAILURE: "PRE_POST_FAILURE",
  POSTED_STATE_SAVED: "POSTED_STATE_SAVED",
  POSTED_STATE_SAVE_FAILED: "POSTED_STATE_SAVE_FAILED"
});

export async function runLivePost({
  bankItems,
  postedPosts,
  facts,
  todayKey = jstDateKey(),
  userId,
  accessToken,
  live = false,
  env = {},
  redact = (x) => x,
  workflowRunUrl = null,
  // 依存注入: デフォルトは実装(threads-publish.mjs)そのもの。テストでは差し替えて
  // fetchへ一切到達しない形で検証できる(このモジュール自体はfetchを直接呼ばない)。
  publish = publishPost,
  // Stage 2時点ではデフォルトで何もしない(data/threads-posts.jsonへの永続書き込みは未実装)。
  // Stage 3以降で実ファイルI/O・commit/pushを行う関数をここに差し込む想定。
  saveState = async () => {},
  // 既定は無出力(このモジュールは副作用を持たない設計)。呼び出し側(CLI等)が
  // 必要なら console.log/console.warn 等を注入する。
  log = () => {},
  warn = () => {}
}) {
  const { selected, skipped } = await selectDailyCandidate({ bankItems, postedPosts, facts, todayKey });

  for (const { item, reason } of skipped) {
    warn(`SKIP: day=${item.day ?? "?"} category=${item.category || "?"} reason=${reason}`);
  }

  if (!selected) {
    return { outcome: OUTCOME.NO_CANDIDATE, skipped };
  }

  // 選出済み候補について、既存ガード(併記フォーマット・verified-facts・重複・メディア)を
  // まとめて再確認する(selectDailyCandidate側で一部は既に確認済みだが、
  // 併記フォーマット500文字/生URLチェックはここで初めて確認する)。
  const postedBodySet = buildPostedBodySet(postedPosts);
  const report = buildDryRunReport(selected, { postedBodySet, facts });

  // 二重ゲートが実際に揃っている(=live投稿を本気で試みる)場合に限り、
  // ガードNGでThreads APIを一切呼ばずに確実に止める(既存ガードを迂回できない)。
  // 揃っていない場合(通常のdry-run)は、従来通りpublishPostを呼んで
  // dry-runレポートを生成する(ガードNGはレポート内にそのまま反映されるだけで、
  // Phase 2の挙動を変えない)。
  if (isLivePostAllowed({ live, env }) && !report.guardsOk) {
    return { outcome: OUTCOME.PRE_POST_FAILURE, selected, skipped, report, reason: "guard-check-failed" };
  }

  let publishResult;
  try {
    publishResult = await publish({
      bodyEn: selected.bodyEn,
      bodyJa: selected.bodyJa,
      userId,
      accessToken,
      live,
      env,
      redact
    });
  } catch (err) {
    log("投稿処理でエラーが発生しました:", redact(err.message));
    return { outcome: OUTCOME.PRE_POST_FAILURE, selected, skipped, report, error: err };
  }

  if (publishResult.mode === "dry-run") {
    return { outcome: OUTCOME.DRY_RUN, selected, skipped, report, publishResult };
  }

  // ここに到達した時点でThreadsへの投稿自体は成功済み(threadsPostIdを取得済み)。
  // 以降はstate保存だけが対象で、これが失敗しても絶対に投稿をやり直してはいけない。
  const record = buildPostRecord({
    sourceItemId: selected.id,
    threadsPostId: publishResult.threadsPostId,
    bodyEn: selected.bodyEn,
    bodyJa: selected.bodyJa,
    pillar: selected.pillar ?? null,
    category: selected.category ?? null,
    workflowRunUrl
  });

  try {
    await saveState(record);
  } catch (err) {
    log(
      "投稿は成功しましたが、state保存でエラーが発生しました。再実行しないでください(二重投稿の危険があります):",
      redact(err.message)
    );
    return {
      outcome: OUTCOME.POSTED_STATE_SAVE_FAILED,
      selected,
      skipped,
      report,
      threadsPostId: publishResult.threadsPostId,
      record,
      error: err
    };
  }

  return {
    outcome: OUTCOME.POSTED_STATE_SAVED,
    selected,
    skipped,
    report,
    threadsPostId: publishResult.threadsPostId,
    record
  };
}
