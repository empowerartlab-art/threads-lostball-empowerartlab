// fetchは必ずスタブし、実際のDiscord Webhookへは一切接続しない。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildDiscordDryRunMessage,
  isLiveDiscordAllowed,
  sendDiscordNotification,
  splitIntoDiscordChunks
} from "../lib/discord-notifier.mjs";
import { buildDryRunReport } from "../lib/post-report.mjs";
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

const facts = [{ id: "fact-a", verified: true }];
const item = {
  id: "item-1",
  day: 1,
  pillar: "JAPAN",
  category: "BRAND_INTRO",
  bodyEn: "Hello.",
  bodyJa: "こんにちは。",
  hasCta: false,
  hasShopLink: false,
  requiresVerifiedFact: false,
  verifiedFactIds: [],
  targetDate: null,
  media: { type: "TEXT_ONLY", required: false }
};

test("buildDiscordDryRunMessage: dry-runであることと未送信であることを明記する", () => {
  const report = buildDryRunReport(item, { postedBodySet: new Set(), facts });
  const message = buildDiscordDryRunMessage(report);
  assert.match(message, /DRY-RUN/);
  assert.match(message, /実際のDiscord送信は行っていません/);
  assert.match(message, new RegExp(item.id));
});

test("splitIntoDiscordChunks: 上限以下ならそのまま1件で返す", () => {
  assert.deepEqual(splitIntoDiscordChunks("hello"), ["hello"]);
});

test("splitIntoDiscordChunks: 上限を超える場合は改行境界で分割する", () => {
  const line = "a".repeat(10);
  const text = Array.from({ length: 5 }, () => line).join("\n"); // 10*5+4 = 54文字
  const chunks = splitIntoDiscordChunks(text, 25);
  assert.ok(chunks.length > 1);
  assert.equal(chunks.join("\n"), text);
  for (const chunk of chunks) assert.ok(chunk.length <= 25);
});

test("isLiveDiscordAllowed: live===true かつ env.LIVE_DISCORD===\"true\" の時だけtrue", () => {
  assert.equal(isLiveDiscordAllowed({ live: true, env: { LIVE_DISCORD: "true" } }), true);
  assert.equal(isLiveDiscordAllowed({ live: false, env: { LIVE_DISCORD: "true" } }), false);
  assert.equal(isLiveDiscordAllowed({ live: true, env: { LIVE_DISCORD: "false" } }), false);
  assert.equal(isLiveDiscordAllowed({ live: true, env: {} }), false);
});

test("sendDiscordNotification: LIVE_DISCORD=trueのみ(live=false) → 送信しない(fetchは呼ばれない)", async () => {
  const { restore, getCallCount } = stubFetch(async () => {
    throw new Error("fetchが呼ばれてはいけない");
  });
  try {
    const result = await sendDiscordNotification({
      content: "hello",
      webhookUrl: "https://discord.com/api/webhooks/xxx/yyy",
      live: false,
      env: { LIVE_DISCORD: "true" }
    });
    assert.equal(result.mode, "dry-run");
    assert.equal(getCallCount(), 0);
  } finally {
    restore();
  }
});

test("sendDiscordNotification: --liveのみ(LIVE_DISCORD未設定) → 送信しない(fetchは呼ばれない)", async () => {
  const { restore, getCallCount } = stubFetch(async () => {
    throw new Error("fetchが呼ばれてはいけない");
  });
  try {
    const result = await sendDiscordNotification({
      content: "hello",
      webhookUrl: "https://discord.com/api/webhooks/xxx/yyy",
      live: true,
      env: {}
    });
    assert.equal(result.mode, "dry-run");
    assert.equal(getCallCount(), 0);
  } finally {
    restore();
  }
});

test("sendDiscordNotification: live=true + LIVE_DISCORD=true → Webhookへ実際にPOSTする", async () => {
  let capturedUrl;
  let capturedInit;
  const { restore, getCallCount } = stubFetch(async (url, init) => {
    capturedUrl = url;
    capturedInit = init;
    return { ok: true, status: 204 };
  });
  try {
    const result = await sendDiscordNotification({
      content: "hello world",
      webhookUrl: "https://discord.com/api/webhooks/xxx/yyy",
      live: true,
      env: { LIVE_DISCORD: "true" }
    });
    assert.equal(result.mode, "live");
    assert.equal(getCallCount(), 1);
    assert.equal(capturedUrl, "https://discord.com/api/webhooks/xxx/yyy");
    assert.equal(capturedInit.method, "POST");
    assert.deepEqual(JSON.parse(capturedInit.body), { content: "hello world" });
  } finally {
    restore();
  }
});

test("sendDiscordNotification: Webhookが404等を返したら例外を投げ、Webhook URLは露出しない", async () => {
  const webhookUrl = "https://discord.com/api/webhooks/xxx/super-secret-token";
  const { restore } = stubFetch(async () => ({ ok: false, status: 404, text: async () => "Unknown Webhook" }));
  try {
    const redact = createSecretRedactor([webhookUrl]);
    await assert.rejects(
      () => sendDiscordNotification({ content: "hello", webhookUrl, live: true, env: { LIVE_DISCORD: "true" }, redact }),
      (err) => {
        assert.match(err.message, /Discord webhookエラー/);
        assert.doesNotMatch(err.message, /super-secret-token/);
        return true;
      }
    );
  } finally {
    restore();
  }
});

test("sendDiscordNotification: webhookUrl未指定なら例外を投げる(fetchは呼ばれない)", async () => {
  const { restore, getCallCount } = stubFetch(async () => {
    throw new Error("fetchが呼ばれてはいけない");
  });
  try {
    await assert.rejects(
      () => sendDiscordNotification({ content: "hello", webhookUrl: "", live: true, env: { LIVE_DISCORD: "true" } }),
      /DISCORD_WEBHOOK_URLが指定されていません/
    );
    assert.equal(getCallCount(), 0);
  } finally {
    restore();
  }
});

test("sendDiscordNotification: webhookUrlがURLとして不正なら例外を投げ、値自体は露出しない", async () => {
  const { restore, getCallCount } = stubFetch(async () => {
    throw new Error("fetchが呼ばれてはいけない");
  });
  try {
    await assert.rejects(
      () => sendDiscordNotification({ content: "hello", webhookUrl: "not-a-valid-url", live: true, env: { LIVE_DISCORD: "true" } }),
      (err) => {
        assert.match(err.message, /形式が不正/);
        assert.doesNotMatch(err.message, /not-a-valid-url/);
        return true;
      }
    );
    assert.equal(getCallCount(), 0);
  } finally {
    restore();
  }
});
