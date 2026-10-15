// Threads実投稿の二重ゲート＋オーケストレーション(テーマ非依存)。
// デフォルトは必ずdry-run。livePost===true(CLI引数等の明示指定)かつ
// 環境変数 env.LIVE_POST==="true" の両方が揃わない限り、
// lib/threads-client.mjsのAPI呼び出しには絶対に進まない
// (approval-gate.mjsと同じ「複数の明示条件が揃わない限り実行しない」設計思想。
// 片方だけでは投稿できない二重ゲート)。
//
// 本文の妥当性チェック(重複・verified-facts・claim等の各ガード)は
// 呼び出し側が事前に通す想定で、このモジュールはAPI呼び出しと安全ゲートのみを担当する。

import { createTextContainer, createImageContainer, publishContainer, getContainerStatus } from "./threads-client.mjs";
import { buildPostBody } from "./bilingual-guard.mjs";

export function isLivePostAllowed({ live, env }) {
  return live === true && env?.LIVE_POST === "true";
}

// コンテナ作成(POST /{userId}/threads)専用のリトライ設定。
// 対象はコンテナ作成のみ(=この呼び出しが成功・失敗いずれであってもThreads上に
// 公開された投稿は一切発生しない。最悪でも未使用のunpublishedコンテナが残るだけで、
// 一定時間後に自動失効する)。
// publishContainer(POST /{userId}/threads_publish。実際の公開操作)には絶対に適用しない。
// 公開操作はレスポンスが得られなくても実際にはThreads側で成功している可能性を排除できず、
// ここをリトライすると二重投稿の実リスクがあるため(PRE_POST_FAILURE再発防止の設計時に明示的に除外)。
const MAX_CONTAINER_CREATE_RETRY = 1;
const CONTAINER_CREATE_RETRY_DELAY_MS = 4000;

function defaultDelay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 失敗したエラーから、Secretsを含まない診断情報のみを取り出す(redact済み)。
// error.code/error_subcode/fbtrace_idはSecretsではないため、そのまま保持してよい
// (lib/threads-client.mjsのbuildError・既存のdiagnose-threads-connection.mjsと同じ考え方)。
function extractErrorInfo(err, redact) {
  return {
    message: redact(String(err?.message ?? "(詳細不明)")),
    status: err?.status ?? null,
    code: err?.code ?? null,
    errorSubcode: err?.errorSubcode ?? null,
    fbtraceId: err?.fbtraceId ?? null
  };
}

// コンテナ作成(createTextContainer/createImageContainerのいずれか)のみを対象にした、
// 最大1回・約4秒待機の単純リトライ。publishContainerはこの関数の範囲外
// (呼び出し側で別途1回だけ呼ぶ。リトライしない)。
// createFn: createTextContainer または createImageContainer(lib/threads-client.mjs)。
// stageName: リトライ尽きた際にerr.stageへ記録する識別子(診断用。"createTextContainer"
//            または"createImageContainer")。
async function createContainerWithRetry(createFn, args, stageName, { redact, delay = defaultDelay } = {}) {
  let firstAttemptError = null;

  for (let attempt = 0; attempt <= MAX_CONTAINER_CREATE_RETRY; attempt++) {
    try {
      const result = await createFn(args, { redact });
      return {
        ...result,
        containerRetry: {
          attempted: attempt > 0,
          count: attempt,
          firstAttemptError
        }
      };
    } catch (err) {
      if (attempt < MAX_CONTAINER_CREATE_RETRY) {
        // 1回目失敗: この時点ではコンテナ作成しか呼んでいないため、
        // Threads上に投稿は一切存在しないと安全に判断できる(TEXT/IMAGEいずれも同じ)。
        // Secretsを含まない診断情報だけ保持し、短時間待機してもう1回だけ試みる。
        firstAttemptError = extractErrorInfo(err, redact);
        await delay(CONTAINER_CREATE_RETRY_DELAY_MS);
        continue;
      }
      // リトライも失敗。呼び出し側(lib/live-post-runner.mjs)がPRE_POST_FAILUREの理由を
      // 「コンテナ作成で尽きた(=Threadsへの投稿は発生していないと確実に言える)」と
      // 区別できるよう、情報を付与してから再送出する。publishContainerへは一切進んでいない。
      err.stage = stageName;
      err.containerCreationFailure = true;
      err.retryExhausted = attempt > 0;
      err.firstAttemptError = firstAttemptError;
      throw err;
    }
  }
}

// コンテナ作成後、公開(threads_publish)の前に status=FINISHED を待つ(Meta推奨の手順)。
// ここで呼ぶのは読み取り専用のGETだけなので、何回呼んでもThreadsに投稿は発生しない。
// 作成直後は「存在しない」(HTTP 400)が返ることがあるため、その場合も待ってから確認し直す。
// 待っても FINISHED にならない/ERROR・EXPIRED になった場合は、公開を呼ばずにエラーにする
// (=Threadsへの投稿は行われていないと確実に言える。containerCreationFailureとして扱う)。
const CONTAINER_READY_MAX_CHECKS = 20;
const CONTAINER_READY_POLL_MS = 3000;

async function waitForContainerReady({ containerId, accessToken }, { redact, delay = defaultDelay } = {}) {
  let lastState = "(未確認)";
  for (let check = 0; check < CONTAINER_READY_MAX_CHECKS; check++) {
    if (check > 0) await delay(CONTAINER_READY_POLL_MS);
    let result;
    try {
      result = await getContainerStatus({ containerId, accessToken }, { redact });
    } catch (err) {
      lastState = redact(String(err?.message ?? "(詳細不明)"));
      continue;
    }
    if (result.status === "FINISHED") return { checks: check + 1 };
    lastState = `status=${result.status ?? "(なし)"}${result.errorMessage ? ` error_message=${redact(String(result.errorMessage))}` : ""}`;
    if (result.status === "ERROR" || result.status === "EXPIRED" || result.status === "PUBLISHED") break;
  }
  const err = new Error(`Threadsのコンテナが公開できる状態になりませんでした(公開は呼んでいません): ${lastState}`);
  err.stage = "waitForContainerReady";
  err.containerCreationFailure = true;
  err.retryExhausted = true;
  throw err;
}

export async function publishPost({
  bodyEn,
  bodyJa,
  userId,
  accessToken,
  live = false,
  env = {},
  redact = (x) => x,
  delay,
  // 承認済みmedia.pathから組み立てた公開URL(lib/media-url.mjsのresolvePublicMediaUrl)。
  // 未指定/nullなら従来通りテキストのみの投稿(TEXT)。指定があれば画像付き投稿(IMAGE)を試みる。
  // ここでは「imageUrlが渡されたら画像投稿を試みる」という分岐のみを担い、
  // 「どの投稿にimageUrlを渡すか」の判断(承認済みかどうか等)は呼び出し側の責務のままにする。
  imageUrl = null,
  // "ja" / "en" なら、その言語の本文だけを投稿する。"both"(既定)は従来の英語→日本語の併記。
  lang = "both"
}) {
  const body = buildPostBody(bodyEn, bodyJa, lang);

  if (!isLivePostAllowed({ live, env })) {
    return {
      mode: "dry-run",
      wouldPost: true,
      body,
      usedImage: Boolean(imageUrl),
      note: 'live===true かつ 環境変数 LIVE_POST="true" の両方が明示されていないため投稿していません(dry-run)。'
    };
  }

  const { containerId, containerRetry } = imageUrl
    ? await createContainerWithRetry(
        createImageContainer,
        { userId, accessToken, text: body, imageUrl },
        "createImageContainer",
        { redact, delay }
      )
    : await createContainerWithRetry(
        createTextContainer,
        { userId, accessToken, text: body },
        "createTextContainer",
        { redact, delay }
      );
  // 実際の公開操作(threads_publish)はここで1回だけ呼ぶ。TEXT/IMAGEいずれの場合も
  // リトライは絶対に行わない(成功したかどうか不明なケースを二重に試みると
  // 二重投稿の実リスクがあるため)。画像投稿失敗時にテキストのみへ自動フォールバックする
  // 処理もここには無い(失敗はそのまま例外として呼び出し側に伝播する)。
  await waitForContainerReady({ containerId, accessToken }, { redact, delay });
  const { threadsPostId } = await publishContainer({ userId, accessToken, containerId }, { redact });
  return { mode: "live", wouldPost: false, threadsPostId, body, containerRetry, usedImage: Boolean(imageUrl) };
}

// data/threads-posts.json の posts[] に追記する形へ変換するだけ。ファイルI/Oは呼び出し側(Stage 2以降)が行う。
export function buildPostRecord({
  sourceItemId,
  threadsPostId,
  bodyEn,
  bodyJa,
  pillar = null,
  category = null,
  postedAt = new Date().toISOString(),
  mode = "live",
  workflowRunUrl = null,
  lang = "both",
  // 1日4本（2026-10-20〜）の枠。枠付きの投稿だけ slot と targetDate を残す。
  slot = null,
  targetDate = null
}) {
  const record = { sourceItemId, threadsPostId, bodyEn, bodyJa, pillar, category, postedAt, mode, workflowRunUrl };
  // 言語別に投稿した場合だけlangを残す(従来の併記投稿の記録形式は変えない)。
  const withLang = lang === "both" ? record : { ...record, lang };
  return slot ? { ...withLang, slot, targetDate } : withLang;
}
