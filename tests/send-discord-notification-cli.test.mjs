// scripts/send-discord-notification.mjs を別プロセスとして起動して確認する
// (外部依存・ネットワークは使わない。node自身のみ)。
//
// 注意: LIVE_DISCORD=true + --live が両方揃うケース(実際にWebhookへ接続しようとするケース)は
// このファイルでは意図的にテストしていない。実プロセスなのでfetchをスタブできず、
// 誤って本物のWebhookへ到達するリスクがあるため。その組み合わせの安全性は
// tests/discord-notifier.test.mjs(同一プロセス内でglobalThis.fetchを差し替え)で検証済み。
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SCRIPT = fileURLToPath(new URL("../scripts/send-discord-notification.mjs", import.meta.url));

function run(args, envOverrides) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: ROOT,
    env: { ...process.env, ...envOverrides },
    encoding: "utf8"
  });
}

test("--content無しならエラーで終了する(Webhookへは接続しない)", () => {
  const result = run([], { DISCORD_WEBHOOK_URL: "" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /使い方/);
});

test("LIVE_DISCORD未設定なら--liveを付けてもdry-runのまま正常終了する", () => {
  const result = run(["--content=test message", "--live"], {
    DISCORD_WEBHOOK_URL: "https://discord.com/api/webhooks/xxx/yyy",
    LIVE_DISCORD: ""
  });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /DRY RUN/);
});

test("--live未指定ならLIVE_DISCORD=trueでもdry-runのまま正常終了する", () => {
  const result = run(["--content=test message"], {
    DISCORD_WEBHOOK_URL: "https://discord.com/api/webhooks/xxx/yyy",
    LIVE_DISCORD: "true"
  });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /DRY RUN/);
});
