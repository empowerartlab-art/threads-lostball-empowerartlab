// fetchAllInsightsは依存注入(fetchOne)でテストする。実際のThreads APIへは一切接続しない。
import { test } from "node:test";
import assert from "node:assert/strict";
import { fetchAllInsights } from "../scripts/fetch-threads-insights.mjs";
import { createSecretRedactor } from "../lib/redact.mjs";

const posts = [
  { sourceItemId: "lostball-day1-brand-intro", threadsPostId: "post-1" },
  { sourceItemId: "lostball-day2-japan-origin", threadsPostId: "post-2" },
  { sourceItemId: "lostball-day3-hand-polishing-process", threadsPostId: "post-3" }
];

test("fetchAllInsights: 全件成功したらsucceededにすべて入り、failedは空", async () => {
  const fetchOne = async ({ threadsPostId }) => ({ views: 10, likes: 1, replies: 0, reposts: 0, quotes: 0, shares: 0, _id: threadsPostId });
  const result = await fetchAllInsights({ posts, accessToken: "t", fetchOne, now: () => "2026-10-04T00:00:00.000Z" });
  assert.equal(result.succeeded.length, 3);
  assert.equal(result.failed.length, 0);
  assert.equal(result.succeeded[0].threadsPostId, "post-1");
  assert.equal(result.succeeded[0].sourceItemId, "lostball-day1-brand-intro");
  assert.equal(result.succeeded[0].fetchedAt, "2026-10-04T00:00:00.000Z");
  assert.equal(result.succeeded[0].views, 10);
});

test("fetchAllInsights: 1投稿がAPIエラーでも、残りの投稿の取得は継続する(安全な部分失敗)", async () => {
  const fetchOne = async ({ threadsPostId }) => {
    if (threadsPostId === "post-2") throw new Error("Threads APIエラー (HTTP 400): bad request");
    return { views: 1, likes: 0, replies: 0, reposts: 0, quotes: 0, shares: 0 };
  };
  const result = await fetchAllInsights({ posts, accessToken: "t", fetchOne });
  assert.equal(result.succeeded.length, 2);
  assert.equal(result.failed.length, 1);
  assert.equal(result.failed[0].threadsPostId, "post-2");
  assert.deepEqual(
    result.succeeded.map((s) => s.threadsPostId),
    ["post-1", "post-3"]
  );
});

test("fetchAllInsights: 全件失敗してもエラーを投げず、succeeded=[]を返す(呼び出し側が判断できる)", async () => {
  const fetchOne = async () => {
    throw new Error("network error");
  };
  const result = await fetchAllInsights({ posts, accessToken: "t", fetchOne });
  assert.equal(result.succeeded.length, 0);
  assert.equal(result.failed.length, 3);
});

test("fetchAllInsights: エラーメッセージはredact()を通してからfailedに格納され、Secretsが残らない", async () => {
  const accessToken = "super-secret-access-token";
  const redact = createSecretRedactor([accessToken]);
  const fetchOne = async () => {
    throw new Error(`token ${accessToken} rejected`);
  };
  const result = await fetchAllInsights({ posts: [posts[0]], accessToken, redact, fetchOne });
  assert.equal(result.failed.length, 1);
  assert.doesNotMatch(result.failed[0].error, new RegExp(accessToken));
  assert.match(result.failed[0].error, /\[REDACTED\]/);
});

test("fetchAllInsights: 投稿が0件ならsucceeded/failedともに空配列", async () => {
  const fetchOne = async () => ({ views: 1 });
  const result = await fetchAllInsights({ posts: [], accessToken: "t", fetchOne });
  assert.deepEqual(result, { succeeded: [], failed: [] });
});
