// fetchは必ずスタブし、実際のThreads/Meta APIへは一切接続しない。
// LIVE_POST/liveの二重ゲートが揃わない組み合わせでは、fetch自体が呼ばれないことを検証する。
import { test } from "node:test";
import assert from "node:assert/strict";
import { isLivePostAllowed, publishPost, buildPostRecord } from "../lib/threads-publish.mjs";
import { createSecretRedactor } from "../lib/redact.mjs";

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

function containerThenPublishHandler({ containerId = "container-1", threadsPostId = "post-1" } = {}) {
  return async (url) => {
    const u = new URL(String(url));
    if (u.pathname.endsWith("/threads")) return jsonResponse(200, { id: containerId });
    if (u.pathname.endsWith("/threads_publish")) return jsonResponse(200, { id: threadsPostId });
    throw new Error(`unexpected URL requested in test: ${u}`);
  };
}

test("isLivePostAllowed: live===true かつ env.LIVE_POST===\"true\" の時だけtrue", () => {
  assert.equal(isLivePostAllowed({ live: true, env: { LIVE_POST: "true" } }), true);
  assert.equal(isLivePostAllowed({ live: false, env: { LIVE_POST: "true" } }), false);
  assert.equal(isLivePostAllowed({ live: true, env: { LIVE_POST: "false" } }), false);
  assert.equal(isLivePostAllowed({ live: false, env: { LIVE_POST: "false" } }), false);
  assert.equal(isLivePostAllowed({ live: true, env: {} }), false);
});

test("publishPost: LIVE_POST=true かつ live=true → 投稿処理(fetch)へ進み、threadsPostIdを返す", async () => {
  const { restore, getCallCount } = stubFetch(containerThenPublishHandler());
  try {
    const result = await publishPost({
      bodyEn: "Hello.",
      bodyJa: "こんにちは。",
      userId: "999",
      accessToken: "secret-token",
      live: true,
      env: { LIVE_POST: "true" }
    });
    assert.equal(result.mode, "live");
    assert.equal(result.wouldPost, false);
    assert.equal(result.threadsPostId, "post-1");
    assert.match(result.body, /Hello\.\n\nこんにちは。/);
    assert.equal(getCallCount(), 2);
  } finally {
    restore();
  }
});

test("publishPost: LIVE_POST=true かつ live=false → 投稿しない(fetchは呼ばれない)", async () => {
  const { restore, getCallCount } = stubFetch(async () => {
    throw new Error("fetchが呼ばれてはいけない");
  });
  try {
    const result = await publishPost({
      bodyEn: "Hello.",
      bodyJa: "こんにちは。",
      userId: "999",
      accessToken: "secret-token",
      live: false,
      env: { LIVE_POST: "true" }
    });
    assert.equal(result.mode, "dry-run");
    assert.equal(result.wouldPost, true);
    assert.equal(getCallCount(), 0);
  } finally {
    restore();
  }
});

test("publishPost: LIVE_POST=false かつ live=true → 投稿しない(fetchは呼ばれない)", async () => {
  const { restore, getCallCount } = stubFetch(async () => {
    throw new Error("fetchが呼ばれてはいけない");
  });
  try {
    const result = await publishPost({
      bodyEn: "Hello.",
      bodyJa: "こんにちは。",
      userId: "999",
      accessToken: "secret-token",
      live: true,
      env: { LIVE_POST: "false" }
    });
    assert.equal(result.mode, "dry-run");
    assert.equal(getCallCount(), 0);
  } finally {
    restore();
  }
});

test("publishPost: LIVE_POST=false かつ live=false → 投稿しない(fetchは呼ばれない)", async () => {
  const { restore, getCallCount } = stubFetch(async () => {
    throw new Error("fetchが呼ばれてはいけない");
  });
  try {
    const result = await publishPost({
      bodyEn: "Hello.",
      bodyJa: "こんにちは。",
      userId: "999",
      accessToken: "secret-token",
      live: false,
      env: { LIVE_POST: "false" }
    });
    assert.equal(result.mode, "dry-run");
    assert.equal(getCallCount(), 0);
  } finally {
    restore();
  }
});

test("publishPost: コンテナ作成が失敗したらエラーを投げ、threads_publishは呼ばれない", async () => {
  const { restore, getCallCount } = stubFetch(async (url) => {
    const u = new URL(String(url));
    if (u.pathname.endsWith("/threads")) return jsonResponse(400, { error: { message: "bad request", type: "Err" } });
    throw new Error("コンテナ作成失敗後にthreads_publishが呼ばれてはいけない");
  });
  try {
    await assert.rejects(() =>
      publishPost({
        bodyEn: "Hello.",
        bodyJa: "こんにちは。",
        userId: "999",
        accessToken: "secret-token",
        live: true,
        env: { LIVE_POST: "true" }
      })
    );
    assert.equal(getCallCount(), 1);
  } finally {
    restore();
  }
});

test("publishPost: publishが失敗したらエラーを投げる", async () => {
  const { restore } = stubFetch(async (url) => {
    const u = new URL(String(url));
    if (u.pathname.endsWith("/threads")) return jsonResponse(200, { id: "container-1" });
    return jsonResponse(500, { error: { message: "server error", type: "Err" } });
  });
  try {
    await assert.rejects(() =>
      publishPost({
        bodyEn: "Hello.",
        bodyJa: "こんにちは。",
        userId: "999",
        accessToken: "secret-token",
        live: true,
        env: { LIVE_POST: "true" }
      })
    );
  } finally {
    restore();
  }
});

test("publishPost: エラーログにアクセストークンが露出しない", async () => {
  const accessToken = "super-secret-access-token";
  const { restore } = stubFetch(async () =>
    jsonResponse(400, { error: { message: `token ${accessToken} rejected`, type: "Err" } })
  );
  try {
    const redact = createSecretRedactor([accessToken]);
    await assert.rejects(
      () =>
        publishPost({
          bodyEn: "Hi.",
          bodyJa: "やあ。",
          userId: "999",
          accessToken,
          live: true,
          env: { LIVE_POST: "true" },
          redact
        }),
      (err) => {
        assert.doesNotMatch(err.message, new RegExp(accessToken));
        return true;
      }
    );
  } finally {
    restore();
  }
});

test("buildPostRecord: 指定フィールドをそのまま組み立てる", () => {
  const record = buildPostRecord({
    sourceItemId: "lostball-day1-brand-intro",
    threadsPostId: "post-1",
    bodyEn: "Hello.",
    bodyJa: "こんにちは。",
    pillar: "JAPAN",
    category: "BRAND_INTRO",
    postedAt: "2026-09-28T00:00:00.000Z",
    mode: "live",
    workflowRunUrl: "https://github.com/example/repo/actions/runs/1"
  });
  assert.deepEqual(record, {
    sourceItemId: "lostball-day1-brand-intro",
    threadsPostId: "post-1",
    bodyEn: "Hello.",
    bodyJa: "こんにちは。",
    pillar: "JAPAN",
    category: "BRAND_INTRO",
    postedAt: "2026-09-28T00:00:00.000Z",
    mode: "live",
    workflowRunUrl: "https://github.com/example/repo/actions/runs/1"
  });
});

test("buildPostRecord: pillar/category/workflowRunUrl省略時はnull、mode省略時は'live'、postedAtは自動生成される", () => {
  const before = Date.now();
  const record = buildPostRecord({ sourceItemId: "id-1", threadsPostId: "post-2", bodyEn: "A", bodyJa: "あ" });
  assert.equal(record.pillar, null);
  assert.equal(record.category, null);
  assert.equal(record.workflowRunUrl, null);
  assert.equal(record.mode, "live");
  assert.ok(new Date(record.postedAt).getTime() >= before);
});
