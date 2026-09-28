// fetchは必ずスタブし、実際のThreads/Meta APIへは一切接続しない。
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTextContainer, publishContainer } from "../lib/threads-client.mjs";
import { createSecretRedactor } from "../lib/redact.mjs";

function stubFetch(handler) {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  return () => {
    globalThis.fetch = original;
  };
}

function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

test("createTextContainer: 成功時にcontainerIdを返し、正しいURL/パラメータでPOSTする", async () => {
  let capturedUrl;
  let capturedInit;
  const restore = stubFetch(async (url, init) => {
    capturedUrl = url;
    capturedInit = init;
    return jsonResponse(200, { id: "container-123" });
  });
  try {
    const result = await createTextContainer({ userId: "999", accessToken: "secret-token", text: "hello world" });
    assert.equal(result.containerId, "container-123");
    assert.equal(capturedInit.method, "POST");
    const url = new URL(String(capturedUrl));
    assert.equal(url.origin + url.pathname, "https://graph.threads.net/v1.0/999/threads");
    assert.equal(url.searchParams.get("media_type"), "TEXT");
    assert.equal(url.searchParams.get("text"), "hello world");
    assert.equal(url.searchParams.get("access_token"), "secret-token");
  } finally {
    restore();
  }
});

test("createTextContainer: 失敗時はエラーを投げ、access_tokenはエラーメッセージに露出しない", async () => {
  const restore = stubFetch(async () =>
    jsonResponse(400, { error: { message: "invalid token abc-secret-token", type: "OAuthException" } })
  );
  try {
    const redact = createSecretRedactor(["abc-secret-token"]);
    await assert.rejects(
      () => createTextContainer({ userId: "999", accessToken: "abc-secret-token", text: "hello" }, { redact }),
      (err) => {
        assert.match(err.message, /Threads APIエラー/);
        assert.doesNotMatch(err.message, /abc-secret-token/);
        assert.match(err.message, /\[REDACTED\]/);
        return true;
      }
    );
  } finally {
    restore();
  }
});

test("publishContainer: 成功時にthreadsPostIdを返し、正しいURL/パラメータでPOSTする", async () => {
  let capturedUrl;
  let capturedInit;
  const restore = stubFetch(async (url, init) => {
    capturedUrl = url;
    capturedInit = init;
    return jsonResponse(200, { id: "post-456" });
  });
  try {
    const result = await publishContainer({ userId: "999", accessToken: "secret-token", containerId: "container-123" });
    assert.equal(result.threadsPostId, "post-456");
    assert.equal(capturedInit.method, "POST");
    const url = new URL(String(capturedUrl));
    assert.equal(url.origin + url.pathname, "https://graph.threads.net/v1.0/999/threads_publish");
    assert.equal(url.searchParams.get("creation_id"), "container-123");
    assert.equal(url.searchParams.get("access_token"), "secret-token");
  } finally {
    restore();
  }
});

test("publishContainer: 失敗時はエラーを投げ、access_tokenはエラーメッセージに露出しない", async () => {
  const restore = stubFetch(async () => jsonResponse(500, { error: { message: "server error xyz-secret", type: "APIError" } }));
  try {
    const redact = createSecretRedactor(["xyz-secret"]);
    await assert.rejects(
      () => publishContainer({ userId: "999", accessToken: "another-secret", containerId: "container-123" }, { redact }),
      (err) => {
        assert.match(err.message, /Threads APIエラー/);
        assert.doesNotMatch(err.message, /xyz-secret/);
        return true;
      }
    );
  } finally {
    restore();
  }
});

test("createTextContainer: 失敗時にHTTP status/type/code/error_subcode/fbtrace_idを err に格納する(診断用)", async () => {
  const restore = stubFetch(async () =>
    jsonResponse(400, {
      error: {
        message: "The requested resource does not exist",
        type: "OAuthException",
        code: 100,
        error_subcode: 33,
        fbtrace_id: "AbCdEfGhIjK"
      }
    })
  );
  try {
    await assert.rejects(
      () => createTextContainer({ userId: "999", accessToken: "t", text: "hello" }),
      (err) => {
        assert.equal(err.status, 400);
        assert.equal(err.type, "OAuthException");
        assert.equal(err.code, 100);
        assert.equal(err.errorSubcode, 33);
        assert.equal(err.fbtraceId, "AbCdEfGhIjK");
        assert.match(err.message, /code=100/);
        assert.match(err.message, /error_subcode=33/);
        assert.match(err.message, /fbtrace_id=AbCdEfGhIjK/);
        return true;
      }
    );
  } finally {
    restore();
  }
});

test("createTextContainer: レスポンスにidが無ければ(res.okがtrueでも)エラーを投げる", async () => {
  const restore = stubFetch(async () => jsonResponse(200, {}));
  try {
    await assert.rejects(() => createTextContainer({ userId: "999", accessToken: "t", text: "x" }));
  } finally {
    restore();
  }
});
