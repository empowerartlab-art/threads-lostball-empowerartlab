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

// テストでは4秒の実待機を避けるため、即時resolveするdelayを注入する
// (本番の既定値・4秒待機自体はこのファイル内の専用テストで別途検証する)。
const noopDelay = async () => {};

test("publishPost: コンテナ作成が2回とも失敗したらエラーを投げ、threads_publishは一切呼ばれない(リトライは最大1回)", async () => {
  const { restore, getCallCount } = stubFetch(async (url) => {
    const u = new URL(String(url));
    if (u.pathname.endsWith("/threads")) return jsonResponse(400, { error: { message: "bad request", type: "Err" } });
    throw new Error("コンテナ作成失敗後にthreads_publishが呼ばれてはいけない");
  });
  try {
    await assert.rejects(
      () =>
        publishPost({
          bodyEn: "Hello.",
          bodyJa: "こんにちは。",
          userId: "999",
          accessToken: "secret-token",
          live: true,
          env: { LIVE_POST: "true" },
          delay: noopDelay
        }),
      (err) => {
        // リトライが尽きたことを、呼び出し側(lib/live-post-runner.mjs)が区別できる
        // ようにする情報が付与されていること。
        assert.equal(err.stage, "createTextContainer");
        assert.equal(err.retryExhausted, true);
        assert.ok(err.firstAttemptError, "1回目の失敗情報が保持されていない");
        assert.match(err.firstAttemptError.message, /bad request/);
        return true;
      }
    );
    // 1回目の失敗 + 1回だけのリトライ = 合計2回。threads_publishは一切呼ばれていない。
    assert.equal(getCallCount(), 2);
  } finally {
    restore();
  }
});

test("publishPost: コンテナ作成が1回目失敗・2回目成功なら、1回だけ4秒待機してリトライし、containerRetry情報を返す", async () => {
  let attempts = 0;
  const delayCalls = [];
  const { restore, getCallCount } = stubFetch(async (url) => {
    const u = new URL(String(url));
    if (u.pathname.endsWith("/threads")) {
      attempts += 1;
      if (attempts === 1) return jsonResponse(400, { error: { message: "temporary OAuthException", type: "OAuthException" } });
      return jsonResponse(200, { id: "container-1" });
    }
    if (u.pathname.endsWith("/threads_publish")) return jsonResponse(200, { id: "post-1" });
    throw new Error(`unexpected URL requested in test: ${u}`);
  });
  try {
    const result = await publishPost({
      bodyEn: "Hello.",
      bodyJa: "こんにちは。",
      userId: "999",
      accessToken: "secret-token",
      live: true,
      env: { LIVE_POST: "true" },
      delay: async (ms) => {
        delayCalls.push(ms);
      }
    });
    assert.equal(result.mode, "live");
    assert.equal(result.threadsPostId, "post-1");
    assert.equal(result.containerRetry.attempted, true);
    assert.equal(result.containerRetry.count, 1);
    assert.match(result.containerRetry.firstAttemptError.message, /temporary OAuthException/);
    // 待機は1回だけ、かつ約4秒(4000ms)であること。
    assert.deepEqual(delayCalls, [4000]);
    // コンテナ作成2回(失敗+成功) + threads_publish 1回 = 合計3回。
    assert.equal(getCallCount(), 3);
  } finally {
    restore();
  }
});

test("publishPost: publishContainer(threads_publish)が失敗したらエラーを投げ、一切リトライしない", async () => {
  const { restore, getCallCount } = stubFetch(async (url) => {
    const u = new URL(String(url));
    if (u.pathname.endsWith("/threads")) return jsonResponse(200, { id: "container-1" });
    return jsonResponse(500, { error: { message: "server error", type: "Err" } });
  });
  try {
    await assert.rejects(
      () =>
        publishPost({
          bodyEn: "Hello.",
          bodyJa: "こんにちは。",
          userId: "999",
          accessToken: "secret-token",
          live: true,
          env: { LIVE_POST: "true" },
          delay: noopDelay
        }),
      (err) => {
        // publishContainer由来の失敗には、createTextContainer用のリトライ情報を一切付与しない。
        assert.notEqual(err.stage, "createTextContainer");
        return true;
      }
    );
    // コンテナ作成成功1回 + threads_publish失敗1回 = 合計2回。リトライで3回目が呼ばれないこと。
    assert.equal(getCallCount(), 2);
  } finally {
    restore();
  }
});

test("publishPost: エラーログにアクセストークンが露出しない(コンテナ作成リトライの1回目失敗情報にも露出しない)", async () => {
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
          redact,
          delay: noopDelay
        }),
      (err) => {
        assert.doesNotMatch(err.message, new RegExp(accessToken));
        assert.doesNotMatch(err.firstAttemptError.message, new RegExp(accessToken));
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
