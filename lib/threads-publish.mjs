// Threads実投稿の二重ゲート＋オーケストレーション(テーマ非依存)。
// デフォルトは必ずdry-run。livePost===true(CLI引数等の明示指定)かつ
// 環境変数 env.LIVE_POST==="true" の両方が揃わない限り、
// lib/threads-client.mjsのAPI呼び出しには絶対に進まない
// (approval-gate.mjsと同じ「複数の明示条件が揃わない限り実行しない」設計思想。
// 片方だけでは投稿できない二重ゲート)。
//
// 本文の妥当性チェック(重複・verified-facts・claim等の各ガード)は
// 呼び出し側が事前に通す想定で、このモジュールはAPI呼び出しと安全ゲートのみを担当する。

import { createTextContainer, publishContainer } from "./threads-client.mjs";
import { buildBilingualBody } from "./bilingual-guard.mjs";

export function isLivePostAllowed({ live, env }) {
  return live === true && env?.LIVE_POST === "true";
}

export async function publishPost({
  bodyEn,
  bodyJa,
  userId,
  accessToken,
  live = false,
  env = {},
  redact = (x) => x
}) {
  const body = buildBilingualBody(bodyEn, bodyJa);

  if (!isLivePostAllowed({ live, env })) {
    return {
      mode: "dry-run",
      wouldPost: true,
      body,
      note: 'live===true かつ 環境変数 LIVE_POST="true" の両方が明示されていないため投稿していません(dry-run)。'
    };
  }

  const { containerId } = await createTextContainer({ userId, accessToken, text: body }, { redact });
  const { threadsPostId } = await publishContainer({ userId, accessToken, containerId }, { redact });
  return { mode: "live", wouldPost: false, threadsPostId, body };
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
  workflowRunUrl = null
}) {
  return { sourceItemId, threadsPostId, bodyEn, bodyJa, pillar, category, postedAt, mode, workflowRunUrl };
}
