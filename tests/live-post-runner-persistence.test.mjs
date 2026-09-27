// runLivePost + 実際の永続化(lib/threads-posts-store.mjs)を組み合わせた統合テスト。
// 一時ディレクトリ・一時ファイルのみを使い、実データのdata/threads-posts.jsonには一切触れない。
// fetchは必ずスタブし、Threads/Meta APIへは一切接続しない。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runLivePost, OUTCOME } from "../lib/live-post-runner.mjs";
import { appendPostRecord } from "../lib/threads-posts-store.mjs";

function stubFetch(handler) {
  const original = globalThis.fetch;
  let callCount = 0;
  globalThis.fetch = async (...args) => {
    callCount += 1;
    return handler(...args);
  };
  return {
    restore: () => {
      globalThis.fetch = original;
    },
    getCallCount: () => callCount
  };
}

function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function containerThenPublishHandler({ threadsPostId = "post-1" } = {}) {
  return async (url) => {
    const u = new URL(String(url));
    if (u.pathname.endsWith("/threads")) return jsonResponse(200, { id: "container-1" });
    if (u.pathname.endsWith("/threads_publish")) return jsonResponse(200, { id: threadsPostId });
    throw new Error(`unexpected URL requested in test: ${u}`);
  };
}

async function makeTmpPostsFile(initial = { updatedAt: null, count: 0, posts: [] }) {
  const dir = await mkdtemp(join(tmpdir(), "lostball-live-post-runner-"));
  const filePath = join(dir, "threads-posts.json");
  await writeFile(filePath, `${JSON.stringify(initial, null, 2)}\n`, "utf8");
  return { dir, filePath };
}

const facts = [];

function makeItem(overrides = {}) {
  return {
    id: "item-1",
    day: 1,
    pillar: "JAPAN",
    category: "BRAND_INTRO",
    bodyEn: "Hello there.",
    bodyJa: "こんにちは。",
    hasCta: false,
    hasShopLink: false,
    requiresVerifiedFact: false,
    verifiedFactIds: [],
    targetDate: null,
    media: { type: "TEXT_ONLY", required: false },
    ...overrides
  };
}

test("publish失敗 → state保存されない(実ファイルの内容は一切変更されない)", async () => {
  const { dir, filePath } = await makeTmpPostsFile();
  const originalContent = await readFile(filePath, "utf8");
  const { restore } = stubFetch(async () => jsonResponse(500, { error: { message: "server error", type: "Err" } }));
  try {
    const result = await runLivePost({
      bankItems: [makeItem()],
      postedPosts: [],
      facts,
      live: true,
      env: { LIVE_POST: "true" },
      userId: "999",
      accessToken: "secret-token",
      saveState: (record) => appendPostRecord(filePath, record)
    });
    assert.equal(result.outcome, OUTCOME.PRE_POST_FAILURE);
    const afterContent = await readFile(filePath, "utf8");
    assert.equal(afterContent, originalContent);
  } finally {
    restore();
    await rm(dir, { recursive: true, force: true });
  }
});

test("publish成功 + state保存成功 → POSTED_STATE_SAVEDで実ファイルに1件追加される", async () => {
  const { dir, filePath } = await makeTmpPostsFile();
  const { restore } = stubFetch(containerThenPublishHandler({ threadsPostId: "post-777" }));
  try {
    const result = await runLivePost({
      bankItems: [makeItem()],
      postedPosts: [],
      facts,
      live: true,
      env: { LIVE_POST: "true" },
      userId: "999",
      accessToken: "secret-token",
      saveState: (record) => appendPostRecord(filePath, record)
    });
    assert.equal(result.outcome, OUTCOME.POSTED_STATE_SAVED);
    assert.equal(result.threadsPostId, "post-777");

    const saved = JSON.parse(await readFile(filePath, "utf8"));
    assert.equal(saved.posts.length, 1);
    assert.equal(saved.posts[0].threadsPostId, "post-777");
    assert.equal(saved.posts[0].sourceItemId, "item-1");
    assert.equal(saved.posts[0].bodyEn, "Hello there.");
    assert.equal(saved.posts[0].bodyJa, "こんにちは。");
  } finally {
    restore();
    await rm(dir, { recursive: true, force: true });
  }
});

test("publish成功 + state保存失敗(書き込み先ディレクトリを読み取り専用に) → POSTED_STATE_SAVE_FAILED。publishは再実行されない", async () => {
  const { dir, filePath } = await makeTmpPostsFile();
  const { restore, getCallCount } = stubFetch(containerThenPublishHandler({ threadsPostId: "post-888" }));
  try {
    await chmod(dir, 0o555);
    const result = await runLivePost({
      bankItems: [makeItem()],
      postedPosts: [],
      facts,
      live: true,
      env: { LIVE_POST: "true" },
      userId: "999",
      accessToken: "secret-token",
      saveState: (record) => appendPostRecord(filePath, record)
    });
    assert.equal(result.outcome, OUTCOME.POSTED_STATE_SAVE_FAILED);
    assert.equal(result.threadsPostId, "post-888");
    // コンテナ作成1回+publish1回=2回のみ。state保存失敗を検知した後にpublishが再度呼ばれていないことを確認する。
    assert.equal(getCallCount(), 2);
  } finally {
    await chmod(dir, 0o755);
    restore();
    await rm(dir, { recursive: true, force: true });
  }
});

test("dry-run(LIVE_POST未設定)では実ファイルが一切変更されない", async () => {
  const { dir, filePath } = await makeTmpPostsFile();
  const originalContent = await readFile(filePath, "utf8");
  const { restore, getCallCount } = stubFetch(async () => {
    throw new Error("fetchが呼ばれてはいけない");
  });
  try {
    const result = await runLivePost({
      bankItems: [makeItem()],
      postedPosts: [],
      facts,
      live: false,
      env: {},
      saveState: (record) => appendPostRecord(filePath, record)
    });
    assert.equal(result.outcome, OUTCOME.DRY_RUN);
    assert.equal(getCallCount(), 0);
    const afterContent = await readFile(filePath, "utf8");
    assert.equal(afterContent, originalContent);
  } finally {
    restore();
    await rm(dir, { recursive: true, force: true });
  }
});
