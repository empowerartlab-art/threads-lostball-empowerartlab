// fetchは必ずスタブし、実際のThreads/Meta APIへは一切接続しない。
// runLivePostはpublishPost(実装)を既定で使うため、ここでもfetchをスタブすることで
// 「publish処理をmock/stubする」要件を満たす(threads-publish.mjs自体は既にfetchしか
// 副作用を持たないことがStage 1のテストで検証済み)。
import { test } from "node:test";
import assert from "node:assert/strict";
import { runLivePost, OUTCOME } from "../lib/live-post-runner.mjs";
import { createSecretRedactor } from "../lib/redact.mjs";

function stubFetch(handler) {
  const original = globalThis.fetch;
  let callCount = 0;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    callCount += 1;
    calls.push({ url: String(url), init });
    return handler(url, init);
  };
  return {
    restore: () => {
      globalThis.fetch = original;
    },
    getCallCount: () => callCount,
    getCalls: () => calls
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

const facts = [{ id: "fact-a", verified: true }];

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

test("候補なし(bankItems=[]) → NO_CANDIDATE。fetchは一度も呼ばれない", async () => {
  const { restore, getCallCount } = stubFetch(async () => {
    throw new Error("fetchが呼ばれてはいけない");
  });
  try {
    const result = await runLivePost({ bankItems: [], postedPosts: [], facts, live: false, env: {} });
    assert.equal(result.outcome, OUTCOME.NO_CANDIDATE);
    assert.equal(getCallCount(), 0);
  } finally {
    restore();
  }
});

test("通常dry-run(LIVE_POST未設定・live=false) → DRY_RUN。fetchは呼ばれない", async () => {
  const { restore, getCallCount } = stubFetch(async () => {
    throw new Error("fetchが呼ばれてはいけない");
  });
  try {
    const result = await runLivePost({
      bankItems: [makeItem()],
      postedPosts: [],
      facts,
      live: false,
      env: {}
    });
    assert.equal(result.outcome, OUTCOME.DRY_RUN);
    assert.equal(result.report.id, "item-1");
    assert.equal(getCallCount(), 0);
  } finally {
    restore();
  }
});

test("LIVE_POST=trueのみ(live=false) → DRY_RUN。APIを呼ばない", async () => {
  const { restore, getCallCount } = stubFetch(async () => {
    throw new Error("fetchが呼ばれてはいけない");
  });
  try {
    const result = await runLivePost({
      bankItems: [makeItem()],
      postedPosts: [],
      facts,
      live: false,
      env: { LIVE_POST: "true" }
    });
    assert.equal(result.outcome, OUTCOME.DRY_RUN);
    assert.equal(getCallCount(), 0);
  } finally {
    restore();
  }
});

test("--liveのみ(LIVE_POST未設定) → DRY_RUN。APIを呼ばない", async () => {
  const { restore, getCallCount } = stubFetch(async () => {
    throw new Error("fetchが呼ばれてはいけない");
  });
  try {
    const result = await runLivePost({
      bankItems: [makeItem()],
      postedPosts: [],
      facts,
      live: true,
      env: {}
    });
    assert.equal(result.outcome, OUTCOME.DRY_RUN);
    assert.equal(getCallCount(), 0);
  } finally {
    restore();
  }
});

test("LIVE_POST=true + live=true → mockされたpublish処理(fetch)へ進み、threadsPostIdをrunner側で受け取れる", async () => {
  const { restore, getCallCount } = stubFetch(containerThenPublishHandler({ threadsPostId: "post-999" }));
  try {
    const result = await runLivePost({
      bankItems: [makeItem()],
      postedPosts: [],
      facts,
      live: true,
      env: { LIVE_POST: "true" },
      userId: "999",
      accessToken: "secret-token"
    });
    assert.equal(result.outcome, OUTCOME.POSTED_STATE_SAVED);
    assert.equal(result.threadsPostId, "post-999");
    assert.equal(result.record.threadsPostId, "post-999");
    assert.equal(result.record.sourceItemId, "item-1");
    assert.equal(getCallCount(), 2);
  } finally {
    restore();
  }
});

test("承認済みmedia(path+approvedBy+approvedAt)を持つ候補 → lib/media-url.mjsで解決したimageUrlがpublishPostまで渡り、IMAGE投稿になる", async () => {
  let capturedContainerUrl;
  const { restore, getCallCount } = stubFetch(async (url) => {
    const u = new URL(String(url));
    if (u.pathname.endsWith("/threads")) {
      capturedContainerUrl = u;
      return jsonResponse(200, { id: "container-img" });
    }
    if (u.pathname.endsWith("/threads_publish")) return jsonResponse(200, { id: "post-img-999" });
    throw new Error(`unexpected URL requested in test: ${u}`);
  });
  try {
    const itemWithMedia = makeItem({
      id: "day7-item",
      day: 7,
      media: {
        type: "PRODUCT_PHOTO",
        required: true,
        aiVisualAllowed: false,
        path: "assets/lost-ball-product/day7-product-photo.png",
        altText: "商品写真",
        approvedBy: "empower.artlab@gmail.com",
        approvedAt: "2026-10-02T00:00:00.000Z"
      }
    });
    const result = await runLivePost({
      bankItems: [itemWithMedia],
      postedPosts: [],
      facts,
      live: true,
      env: { LIVE_POST: "true", GITHUB_REPOSITORY: "owner/repo", GITHUB_REF_NAME: "main" },
      userId: "999",
      accessToken: "secret-token"
    });
    assert.equal(result.outcome, OUTCOME.POSTED_STATE_SAVED);
    assert.equal(result.threadsPostId, "post-img-999");
    assert.equal(capturedContainerUrl.searchParams.get("media_type"), "IMAGE");
    assert.equal(
      capturedContainerUrl.searchParams.get("image_url"),
      "https://raw.githubusercontent.com/owner/repo/main/assets/lost-ball-product/day7-product-photo.png"
    );
    assert.equal(getCallCount(), 2);
  } finally {
    restore();
  }
});

test("media.pathはあるが未承認の候補 → imageUrlは解決されず、従来どおりTEXT投稿になる", async () => {
  let capturedContainerUrl;
  const { restore } = stubFetch(async (url) => {
    const u = new URL(String(url));
    if (u.pathname.endsWith("/threads")) {
      capturedContainerUrl = u;
      return jsonResponse(200, { id: "container-txt" });
    }
    if (u.pathname.endsWith("/threads_publish")) return jsonResponse(200, { id: "post-txt-1" });
    throw new Error(`unexpected URL requested in test: ${u}`);
  });
  try {
    const itemWithUnapprovedMedia = makeItem({
      media: {
        type: "PRODUCT_PHOTO",
        required: true,
        aiVisualAllowed: false,
        path: "assets/lost-ball-product/day7-product-photo.png",
        altText: null,
        approvedBy: null,
        approvedAt: null
      }
    });
    const result = await runLivePost({
      bankItems: [itemWithUnapprovedMedia],
      postedPosts: [],
      facts,
      live: true,
      env: { LIVE_POST: "true" },
      userId: "999",
      accessToken: "secret-token"
    });
    // media.required=trueかつ未承認のため、実際には既存のmedia-guard(selectDailyCandidate)で
    // 選出自体がブロックされ、NO_CANDIDATEになる(これはTEXT投稿フォールバックではなく、
    // 既存のcanSelectForProductionの構造的ゲートがそのまま効いていることの確認)。
    assert.equal(result.outcome, OUTCOME.NO_CANDIDATE);
    assert.equal(capturedContainerUrl, undefined);
  } finally {
    restore();
  }
});

test("media.required=falseでpathはあるが未承認の候補 → 選出はブロックされず、画像無しのTEXT投稿になる(imageUrlはnullに解決される)", async () => {
  let capturedContainerUrl;
  const { restore, getCallCount } = stubFetch(async (url) => {
    const u = new URL(String(url));
    if (u.pathname.endsWith("/threads")) {
      capturedContainerUrl = u;
      return jsonResponse(200, { id: "container-txt-2" });
    }
    if (u.pathname.endsWith("/threads_publish")) return jsonResponse(200, { id: "post-txt-2" });
    throw new Error(`unexpected URL requested in test: ${u}`);
  });
  try {
    const item = makeItem({
      media: {
        type: "REAL_PHOTO",
        required: false,
        aiVisualAllowed: true,
        path: "assets/some-not-yet-approved-photo.png",
        altText: null,
        approvedBy: null,
        approvedAt: null
      }
    });
    const result = await runLivePost({
      bankItems: [item],
      postedPosts: [],
      facts,
      live: true,
      env: { LIVE_POST: "true" },
      userId: "999",
      accessToken: "secret-token"
    });
    assert.equal(result.outcome, OUTCOME.POSTED_STATE_SAVED);
    assert.equal(capturedContainerUrl.searchParams.get("media_type"), "TEXT");
    assert.equal(capturedContainerUrl.searchParams.has("image_url"), false);
    assert.equal(getCallCount(), 2);
  } finally {
    restore();
  }
});

test("ガード失敗(500文字超過)＋LIVE_POST=true+live=true → PRE_POST_FAILURE。fetchは一切呼ばれない", async () => {
  const tooLong = "A".repeat(600);
  const { restore, getCallCount } = stubFetch(async () => {
    throw new Error("fetchが呼ばれてはいけない");
  });
  try {
    const result = await runLivePost({
      bankItems: [makeItem({ bodyEn: tooLong })],
      postedPosts: [],
      facts,
      live: true,
      env: { LIVE_POST: "true" }
    });
    assert.equal(result.outcome, OUTCOME.PRE_POST_FAILURE);
    assert.equal(result.reason, "guard-check-failed");
    assert.equal(result.report.guardsOk, false);
    assert.equal(getCallCount(), 0);
  } finally {
    restore();
  }
});

test("重複候補(1件目が投稿済みと同一本文)＋LIVE_POST=true+live=true → 1件目はスキップされ、2件目でのみpublishが呼ばれる", async () => {
  const items = [
    makeItem({ id: "dup-item", bodyEn: "Already posted.", bodyJa: "投稿済み。" }),
    makeItem({ id: "fresh-item", bodyEn: "Fresh content.", bodyJa: "新しい内容。" })
  ];
  const postedPosts = [{ bodyEn: "Already posted.", bodyJa: "投稿済み。" }];
  const { restore, getCalls, getCallCount } = stubFetch(containerThenPublishHandler());
  try {
    const result = await runLivePost({
      bankItems: items,
      postedPosts,
      facts,
      live: true,
      env: { LIVE_POST: "true" },
      userId: "999",
      accessToken: "secret-token"
    });
    assert.equal(result.outcome, OUTCOME.POSTED_STATE_SAVED);
    assert.equal(result.selected.id, "fresh-item");
    assert.equal(result.skipped.length, 1);
    assert.equal(result.skipped[0].item.id, "dup-item");
    const containerCall = getCalls().find((c) => new URL(c.url).pathname.endsWith("/threads"));
    assert.match(decodeURIComponent(new URL(containerCall.url).searchParams.get("text")), /Fresh content\./);
    assert.equal(getCallCount(), 2);
  } finally {
    restore();
  }
});

test("全件重複(候補すべてが投稿済み)＋LIVE_POST=true+live=true → NO_CANDIDATE。fetchは呼ばれない", async () => {
  const items = [makeItem({ id: "dup-item", bodyEn: "Already posted.", bodyJa: "投稿済み。" })];
  const postedPosts = [{ bodyEn: "Already posted.", bodyJa: "投稿済み。" }];
  const { restore, getCallCount } = stubFetch(async () => {
    throw new Error("fetchが呼ばれてはいけない");
  });
  try {
    const result = await runLivePost({
      bankItems: items,
      postedPosts,
      facts,
      live: true,
      env: { LIVE_POST: "true" }
    });
    assert.equal(result.outcome, OUTCOME.NO_CANDIDATE);
    assert.equal(getCallCount(), 0);
  } finally {
    restore();
  }
});

test("コンテナ作成が2回とも失敗 → PRE_POST_FAILURE(container-creation-failed-after-retry)。fetchは2回だけ呼ばれ、publishは呼ばれない", async () => {
  const { restore, getCallCount } = stubFetch(async (url) => {
    const u = new URL(String(url));
    if (u.pathname.endsWith("/threads")) return jsonResponse(400, { error: { message: "bad request", type: "Err" } });
    throw new Error("コンテナ作成失敗後にthreads_publishが呼ばれてはいけない");
  });
  try {
    const result = await runLivePost({
      bankItems: [makeItem()],
      postedPosts: [],
      facts,
      live: true,
      env: { LIVE_POST: "true" },
      userId: "999",
      accessToken: "secret-token",
      delay: async () => {} // 実時間を待たないためテストでは即時resolve
    });
    assert.equal(result.outcome, OUTCOME.PRE_POST_FAILURE);
    assert.ok(result.error);
    // コンテナ作成(リトライ込み)で尽きた場合は、publishContainer由来の失敗と区別できる
    // reasonになる(Discord通知等で「一時的エラーで自動リトライも失敗した」と分かるようにするため)。
    assert.equal(result.reason, "container-creation-failed-after-retry");
    assert.equal(result.error.retryExhausted, true);
    assert.equal(getCallCount(), 2);
  } finally {
    restore();
  }
});

test("コンテナ作成が1回目失敗・2回目成功 → POSTED_STATE_SAVED。containerRetry情報を保持する", async () => {
  let attempts = 0;
  const { restore, getCallCount } = stubFetch(async (url) => {
    const u = new URL(String(url));
    if (u.pathname.endsWith("/threads")) {
      attempts += 1;
      if (attempts === 1) return jsonResponse(400, { error: { message: "temporary OAuthException", type: "OAuthException" } });
      return jsonResponse(200, { id: "container-1" });
    }
    if (u.pathname.endsWith("/threads_publish")) return jsonResponse(200, { id: "post-retry-ok" });
    throw new Error(`unexpected URL requested in test: ${u}`);
  });
  try {
    const result = await runLivePost({
      bankItems: [makeItem()],
      postedPosts: [],
      facts,
      live: true,
      env: { LIVE_POST: "true" },
      userId: "999",
      accessToken: "secret-token",
      delay: async () => {}
    });
    assert.equal(result.outcome, OUTCOME.POSTED_STATE_SAVED);
    assert.equal(result.threadsPostId, "post-retry-ok");
    assert.equal(result.containerRetry.attempted, true);
    assert.equal(result.containerRetry.count, 1);
    assert.match(result.containerRetry.firstAttemptError.message, /temporary OAuthException/);
    assert.equal(getCallCount(), 3);
  } finally {
    restore();
  }
});

test("publish失敗(publishContainer由来) → PRE_POST_FAILURE。reasonはcontainer-creation-failed-after-retryにならず、リトライもしない", async () => {
  const { restore, getCallCount } = stubFetch(async (url) => {
    const u = new URL(String(url));
    if (u.pathname.endsWith("/threads")) return jsonResponse(200, { id: "container-1" });
    return jsonResponse(500, { error: { message: "server error", type: "Err" } });
  });
  try {
    const result = await runLivePost({
      bankItems: [makeItem()],
      postedPosts: [],
      facts,
      live: true,
      env: { LIVE_POST: "true" },
      userId: "999",
      accessToken: "secret-token"
    });
    assert.equal(result.outcome, OUTCOME.PRE_POST_FAILURE);
    assert.ok(result.error);
    assert.equal(result.reason, "publish-error");
    assert.equal(getCallCount(), 2);
  } finally {
    restore();
  }
});

test("アクセストークンがrunnerのログ出力に露出しない", async () => {
  const accessToken = "super-secret-access-token";
  const { restore } = stubFetch(async () =>
    jsonResponse(400, { error: { message: `token ${accessToken} rejected`, type: "Err" } })
  );
  const loggedLines = [];
  try {
    const redact = createSecretRedactor([accessToken]);
    const result = await runLivePost({
      bankItems: [makeItem()],
      postedPosts: [],
      facts,
      live: true,
      env: { LIVE_POST: "true" },
      userId: "999",
      accessToken,
      redact,
      log: (...args) => loggedLines.push(args.join(" ")),
      delay: async () => {}
    });
    assert.equal(result.outcome, OUTCOME.PRE_POST_FAILURE);
    const allLogs = loggedLines.join("\n");
    assert.doesNotMatch(allLogs, new RegExp(accessToken));
  } finally {
    restore();
  }
});

test("saveStateが失敗した場合はPOSTED_STATE_SAVE_FAILEDになり、再投稿すべきでないことが分かる", async () => {
  const { restore } = stubFetch(containerThenPublishHandler({ threadsPostId: "post-abc" }));
  try {
    const result = await runLivePost({
      bankItems: [makeItem()],
      postedPosts: [],
      facts,
      live: true,
      env: { LIVE_POST: "true" },
      userId: "999",
      accessToken: "secret-token",
      saveState: async () => {
        throw new Error("disk full");
      }
    });
    assert.equal(result.outcome, OUTCOME.POSTED_STATE_SAVE_FAILED);
    assert.equal(result.threadsPostId, "post-abc");
    assert.ok(result.error);
  } finally {
    restore();
  }
});
