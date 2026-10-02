#!/usr/bin/env node
// data/threads-posts.json に記録されている投稿済みの threadsPostId を使って、
// Threads APIから投稿単位のInsights(views/likes/replies/reposts/quotes/shares)を
// 取得し、data/threads-insights-history.json へ取得日時付きのスナップショットとして
// 追記するだけのCLI。
//
// 安全設計:
//   - GET(読み取り専用)のみ。投稿・削除・編集は一切行わない(lib/threads-client.mjsの
//     getMediaInsightsはGETしか呼ばない。POSTする関数は一切importしていない)。
//   - 1投稿のAPIエラーで処理全体を止めない。try/catchで個別に捕捉し、
//     取得できた投稿だけをまとめて1回のatomic writeで保存する。
//   - 新しいSecretsは追加しない。既存のTHREADS_ACCESS_TOKENをそのまま使う。
//   - エラーメッセージは必ずredact()を通してからログへ出す(アクセストークンの露出防止)。
//   - git add/commit/pushはここでは一切行わない(呼び出し側のworkflowの責務)。

import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { loadLocalEnv, mergeWithProcessEnv } from "../lib/load-local-env.mjs";
import { createSecretRedactor } from "../lib/redact.mjs";
import { getMediaInsights } from "../lib/threads-client.mjs";
import { parseMediaInsightsResponse, MEDIA_INSIGHTS_METRICS } from "../lib/insights-metrics.mjs";
import { appendInsightsSnapshots } from "../lib/threads-insights-store.mjs";

const POSTS_PATH = new URL("../data/threads-posts.json", import.meta.url);
const HISTORY_PATH = new URL("../data/threads-insights-history.json", import.meta.url);
const HISTORY_PATH_STR = fileURLToPath(HISTORY_PATH);

async function readJson(url, fallback) {
  try {
    return JSON.parse(await fs.readFile(url, "utf8"));
  } catch {
    return fallback;
  }
}

export async function fetchAllInsights({ posts, accessToken, redact = (x) => x, fetchOne = defaultFetchOne, now = () => new Date().toISOString() }) {
  const succeeded = [];
  const failed = [];

  for (const post of posts) {
    try {
      const metrics = await fetchOne({ threadsPostId: post.threadsPostId, accessToken, redact });
      succeeded.push({
        threadsPostId: post.threadsPostId,
        sourceItemId: post.sourceItemId ?? null,
        fetchedAt: now(),
        ...metrics
      });
    } catch (err) {
      // 1投稿の失敗は記録するだけで、他の投稿の取得は継続する。
      failed.push({ threadsPostId: post.threadsPostId, sourceItemId: post.sourceItemId ?? null, error: redact(err.message ?? String(err)) });
    }
  }

  return { succeeded, failed };
}

async function defaultFetchOne({ threadsPostId, accessToken, redact }) {
  const response = await getMediaInsights(
    { threadsPostId, accessToken, metrics: MEDIA_INSIGHTS_METRICS.join(",") },
    { redact }
  );
  return parseMediaInsightsResponse(response);
}

async function main() {
  const env = mergeWithProcessEnv(loadLocalEnv());
  const redact = createSecretRedactor([env.THREADS_ACCESS_TOKEN]);

  if (!env.THREADS_ACCESS_TOKEN) {
    console.error("THREADS_ACCESS_TOKEN が .env.local に見つかりません(キー名のみ表示)。Insights取得をスキップします。");
    process.exit(1);
  }

  const postsFile = await readJson(POSTS_PATH, { posts: [] });
  const posts = (postsFile.posts || []).filter((p) => p.threadsPostId);

  console.log(`対象投稿数: ${posts.length}`);
  if (posts.length === 0) {
    console.log("投稿記録が無いため、Insights取得を行いません(エラーではありません)。");
    return;
  }

  const { succeeded, failed } = await fetchAllInsights({ posts, accessToken: env.THREADS_ACCESS_TOKEN, redact });

  console.log(`成功: ${succeeded.length}件 / 失敗: ${failed.length}件`);
  for (const f of failed) {
    console.warn(`  失敗: sourceItemId=${f.sourceItemId ?? "-"} threadsPostId=${f.threadsPostId} : ${f.error}`);
  }

  if (succeeded.length > 0) {
    await appendInsightsSnapshots(HISTORY_PATH_STR, succeeded);
    console.log(`data/threads-insights-history.json へ${succeeded.length}件のスナップショットを追記しました。`);
  } else {
    console.log("取得に成功した投稿が無いため、data/threads-insights-history.json は更新していません。");
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
