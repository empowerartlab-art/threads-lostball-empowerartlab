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
    if (u.searchParams.get("fields") === "status,error_message") return jsonResponse(200, { status: "FINISHED" }); // コンテナ準備確認(読み取りのみ)
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
    assert.equal(getCallCount(), 3); // +1 = 公開前のコンテナ準備確認(GET)
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

test("publishPost: imageUrl未指定なら従来どおりTEXT投稿(usedImage=false)", async () => {
  const { restore } = stubFetch(containerThenPublishHandler());
  try {
    const result = await publishPost({
      bodyEn: "Hello.",
      bodyJa: "こんにちは。",
      userId: "999",
      accessToken: "secret-token",
      live: true,
      env: { LIVE_POST: "true" }
    });
    assert.equal(result.usedImage, false);
  } finally {
    restore();
  }
});

test("publishPost: imageUrl指定時はIMAGE投稿(media_type=IMAGE/image_url付き)でコンテナ作成し、usedImage=trueを返す", async () => {
  let capturedContainerUrl;
  const { restore, getCallCount } = stubFetch(async (url) => {
    const u = new URL(String(url));
    if (u.searchParams.get("fields") === "status,error_message") return jsonResponse(200, { status: "FINISHED" }); // コンテナ準備確認(読み取りのみ)
    if (u.pathname.endsWith("/threads")) {
      capturedContainerUrl = u;
      return jsonResponse(200, { id: "container-img" });
    }
    if (u.pathname.endsWith("/threads_publish")) return jsonResponse(200, { id: "post-img-1" });
    throw new Error(`unexpected URL requested in test: ${u}`);
  });
  try {
    const imageUrl = "https://raw.githubusercontent.com/empowerartlab-art/threads-lostball-empowerartlab/main/assets/lost-ball-product/day7-product-photo.png";
    const result = await publishPost({
      bodyEn: "Our lost balls are in the shop.",
      bodyJa: "ロストボールがショップに並びました。",
      userId: "999",
      accessToken: "secret-token",
      live: true,
      env: { LIVE_POST: "true" },
      imageUrl
    });
    assert.equal(result.mode, "live");
    assert.equal(result.threadsPostId, "post-img-1");
    assert.equal(result.usedImage, true);
    assert.equal(capturedContainerUrl.searchParams.get("media_type"), "IMAGE");
    assert.equal(capturedContainerUrl.searchParams.get("image_url"), imageUrl);
    assert.equal(getCallCount(), 3); // +1 = 公開前のコンテナ準備確認(GET)
  } finally {
    restore();
  }
});

test("publishPost: 画像コンテナ作成が1回目失敗・2回目成功なら1回だけリトライし、threads_publishはIMAGE用のcontainerIdで1回だけ呼ばれる", async () => {
  let attempts = 0;
  const { restore, getCallCount } = stubFetch(async (url) => {
    const u = new URL(String(url));
    if (u.searchParams.get("fields") === "status,error_message") return jsonResponse(200, { status: "FINISHED" }); // コンテナ準備確認(読み取りのみ)
    if (u.pathname.endsWith("/threads")) {
      attempts += 1;
      if (attempts === 1) return jsonResponse(400, { error: { message: "temporary error", type: "Err" } });
      return jsonResponse(200, { id: "container-img-retry" });
    }
    if (u.pathname.endsWith("/threads_publish")) return jsonResponse(200, { id: "post-img-retry" });
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
      imageUrl: "https://raw.githubusercontent.com/empowerartlab-art/threads-lostball-empowerartlab/main/assets/lost-ball-product/day7-product-photo.png",
      delay: noopDelay
    });
    assert.equal(result.threadsPostId, "post-img-retry");
    assert.equal(result.containerRetry.attempted, true);
    assert.equal(result.containerRetry.count, 1);
    assert.equal(getCallCount(), 4); // +1 = 公開前のコンテナ準備確認(GET)
  } finally {
    restore();
  }
});

test("publishPost: 画像コンテナ作成が2回とも失敗したらエラーを投げ(stage=createImageContainer)、threads_publishは一切呼ばれない", async () => {
  const { restore, getCallCount } = stubFetch(async (url) => {
    const u = new URL(String(url));
    if (u.searchParams.get("fields") === "status,error_message") return jsonResponse(200, { status: "FINISHED" }); // コンテナ準備確認(読み取りのみ)
    if (u.pathname.endsWith("/threads")) return jsonResponse(400, { error: { message: "bad image_url", type: "Err" } });
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
          imageUrl: "https://raw.githubusercontent.com/empowerartlab-art/threads-lostball-empowerartlab/main/assets/lost-ball-product/day7-product-photo.png",
          delay: noopDelay
        }),
      (err) => {
        assert.equal(err.stage, "createImageContainer");
        assert.equal(err.containerCreationFailure, true);
        assert.equal(err.retryExhausted, true);
        return true;
      }
    );
    assert.equal(getCallCount(), 2);
  } finally {
    restore();
  }
});

test("publishPost: 画像投稿でpublishContainer(threads_publish)が失敗した場合もリトライせず、テキスト投稿へのフォールバックも行わない", async () => {
  const { restore, getCallCount } = stubFetch(async (url) => {
    const u = new URL(String(url));
    if (u.searchParams.get("fields") === "status,error_message") return jsonResponse(200, { status: "FINISHED" }); // コンテナ準備確認(読み取りのみ)
    if (u.pathname.endsWith("/threads")) return jsonResponse(200, { id: "container-img-ok" });
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
        env: { LIVE_POST: "true" },
        imageUrl: "https://raw.githubusercontent.com/empowerartlab-art/threads-lostball-empowerartlab/main/assets/lost-ball-product/day7-product-photo.png",
        delay: noopDelay
      })
    );
    // コンテナ作成成功1回(IMAGE) + threads_publish失敗1回 = 合計2回。
    // 失敗後にTEXTでの再試行(=合計3回目の/threads呼び出し)が発生していないことを確認する。
    // +1 = 公開前のコンテナ準備確認(GET)、+1 = 失敗後の自分の投稿の確認(失敗→やり直さない)。
    assert.equal(getCallCount(), 4);
  } finally {
    restore();
  }
});

test("publishPost: コンテナ作成が2回とも失敗したらエラーを投げ、threads_publishは一切呼ばれない(リトライは最大1回)", async () => {
  const { restore, getCallCount } = stubFetch(async (url) => {
    const u = new URL(String(url));
    if (u.searchParams.get("fields") === "status,error_message") return jsonResponse(200, { status: "FINISHED" }); // コンテナ準備確認(読み取りのみ)
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
    if (u.searchParams.get("fields") === "status,error_message") return jsonResponse(200, { status: "FINISHED" }); // コンテナ準備確認(読み取りのみ)
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
    assert.equal(getCallCount(), 4); // +1 = 公開前のコンテナ準備確認(GET)
  } finally {
    restore();
  }
});

test("publishPost: publishContainer(threads_publish)が失敗したらエラーを投げ、一切リトライしない", async () => {
  const { restore, getCallCount } = stubFetch(async (url) => {
    const u = new URL(String(url));
    if (u.searchParams.get("fields") === "status,error_message") return jsonResponse(200, { status: "FINISHED" }); // コンテナ準備確認(読み取りのみ)
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
    // コンテナ作成成功1回 + threads_publish失敗1回 + 準備確認1回 + 失敗後の自分の投稿の確認1回(失敗)。
    // 確認ができないときは公開をやり直さない(従来どおり unknown)。
    assert.equal(getCallCount(), 4);
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

// 2026-10-16: コンテナ作成直後に threads_publish を呼ぶと
// 「HTTP 400 code=24 error_subcode=4279009 The requested resource does not exist」になった。
// 公開前に status=FINISHED を待ち、準備できなければ公開を呼ばない。
test("publishPost: コンテナがまだ見つからない(400)間は待ち、FINISHEDになってから1回だけ公開する", async () => {
  let statusChecks = 0;
  let publishCalls = 0;
  const delays = [];
  const { restore } = stubFetch(async (url) => {
    const u = new URL(String(url));
    if (u.searchParams.get("fields") === "status,error_message") {
      statusChecks += 1;
      if (statusChecks < 3) return jsonResponse(400, { error: { message: "The requested resource does not exist", type: "OAuthException", code: 24, error_subcode: 4279009 } });
      return jsonResponse(200, { status: "FINISHED" });
    }
    if (u.pathname.endsWith("/threads")) return jsonResponse(200, { id: "container-slow" });
    if (u.pathname.endsWith("/threads_publish")) {
      publishCalls += 1;
      return jsonResponse(200, { id: "post-slow" });
    }
    throw new Error(`unexpected URL requested in test: ${u}`);
  });
  try {
    const result = await publishPost({
      bodyEn: "Hello.", bodyJa: "こんにちは。", userId: "999", accessToken: "secret-token",
      live: true, env: { LIVE_POST: "true" }, delay: async (ms) => { delays.push(ms); }
    });
    assert.equal(result.threadsPostId, "post-slow");
    assert.equal(statusChecks, 3);
    assert.equal(publishCalls, 1);
    assert.deepEqual(delays, [3000, 3000]);
  } finally {
    restore();
  }
});

test("publishPost: コンテナがERRORなら公開(threads_publish)を呼ばずにエラー(投稿は行われていない)", async () => {
  const { restore } = stubFetch(async (url) => {
    const u = new URL(String(url));
    if (u.searchParams.get("fields") === "status,error_message") return jsonResponse(200, { status: "ERROR", error_message: "FAILED_PROCESSING" });
    if (u.pathname.endsWith("/threads")) return jsonResponse(200, { id: "container-bad" });
    if (u.pathname.endsWith("/threads_publish")) throw new Error("準備できていないコンテナを公開してはいけない");
    throw new Error(`unexpected URL requested in test: ${u}`);
  });
  try {
    await assert.rejects(
      publishPost({
        bodyEn: "Hello.", bodyJa: "こんにちは。", userId: "999", accessToken: "secret-token",
        live: true, env: { LIVE_POST: "true" }, delay: async () => {}
      }),
      (err) => err.stage === "waitForContainerReady" && err.containerCreationFailure === true && /status=ERROR/.test(err.message)
    );
  } finally {
    restore();
  }
});


// ---- 公開(threads_publish)失敗後の確認とやり直し(2026-11-26) ----
function recoveryHandler({ publishResults, listings, containerStatusAfter = "FINISHED" }) {
  const calls = { publish: 0, list: 0, status: 0 };
  let readyChecked = false;
  const handler = async (url) => {
    const u = new URL(String(url));
    if (u.searchParams.get("fields") === "status,error_message") {
      calls.status += 1;
      if (!readyChecked) { readyChecked = true; return jsonResponse(200, { status: "FINISHED" }); }
      return jsonResponse(200, { status: containerStatusAfter });
    }
    if (u.pathname.endsWith("/me/threads")) {
      const body = listings[Math.min(calls.list, listings.length - 1)];
      calls.list += 1;
      return jsonResponse(200, { data: body });
    }
    if (u.pathname.endsWith("/threads_publish")) {
      const r = publishResults[Math.min(calls.publish, publishResults.length - 1)];
      calls.publish += 1;
      return r;
    }
    if (u.pathname.endsWith("/threads")) return jsonResponse(200, { id: "container-1" });
    throw new Error(`unexpected URL requested in test: ${u}`);
  };
  return { handler, calls };
}
const code24 = jsonResponse(400, { error: { message: "The requested resource does not exist", type: "OAuthException", code: 24, error_subcode: 4279009 } });
const livePost = (extra = {}) => publishPost({ bodyEn: "", bodyJa: "こんにちは。", lang: "ja", userId: "999", accessToken: "secret-token", live: true, env: { LIVE_POST: "true" }, delay: noopDelay, ...extra });

test("公開失敗後: 自分の投稿に無く、コンテナが未公開なら、同じコンテナで1回だけやり直して成功", async () => {
  const { handler, calls } = recoveryHandler({ publishResults: [code24, jsonResponse(200, { id: "post-retry" })], listings: [[]] });
  const { restore } = stubFetch(handler);
  try {
    const r = await livePost();
    assert.equal(r.threadsPostId, "post-retry");
    assert.equal(r.publishRecovery.result, "retried-same-container");
    assert.equal(calls.publish, 2);
  } finally { restore(); }
});

test("公開失敗後: 自分の投稿に同じ本文があれば、やり直さず成功扱い(二重投稿しない)", async () => {
  const { handler, calls } = recoveryHandler({ publishResults: [code24], listings: [[{ id: "post-real", text: "こんにちは。", timestamp: new Date().toISOString() }]] });
  const { restore } = stubFetch(handler);
  try {
    const r = await livePost();
    assert.equal(r.threadsPostId, "post-real");
    assert.equal(r.publishRecovery.result, "found-after-error");
    assert.equal(calls.publish, 1);
  } finally { restore(); }
});

test("公開失敗後: やり直しも失敗し、自分の投稿にも無ければ verifiedNotPublished で投げる", async () => {
  const { handler, calls } = recoveryHandler({ publishResults: [code24, code24], listings: [[], []] });
  const { restore } = stubFetch(handler);
  try {
    await assert.rejects(() => livePost(), (err) => err.verifiedNotPublished === true);
    assert.equal(calls.publish, 2);
    assert.equal(calls.list, 2);
  } finally { restore(); }
});

test("公開失敗後: コンテナが PUBLISHED なら公開はやり直さない(投稿が見つからなければ従来どおり不明で投げる)", async () => {
  const { handler, calls } = recoveryHandler({ publishResults: [code24], listings: [[], []], containerStatusAfter: "PUBLISHED" });
  const { restore } = stubFetch(handler);
  try {
    await assert.rejects(() => livePost(), (err) => err.verifiedNotPublished !== true && err.code === 24);
    assert.equal(calls.publish, 1);
  } finally { restore(); }
});

test("公開失敗後: 同じ本文でも10分より前の投稿は見つかった扱いにしない", async () => {
  const old = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const { handler, calls } = recoveryHandler({ publishResults: [code24, jsonResponse(200, { id: "post-retry" })], listings: [[{ id: "post-old", text: "こんにちは。", timestamp: old }]] });
  const { restore } = stubFetch(handler);
  try {
    const r = await livePost();
    assert.equal(r.threadsPostId, "post-retry");
    assert.equal(calls.publish, 2);
  } finally { restore(); }
});
