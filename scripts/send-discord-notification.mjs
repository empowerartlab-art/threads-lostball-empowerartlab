#!/usr/bin/env node
// Discord通知の汎用エントリポイント。デフォルトは必ずdry-run。
// live送信は --live(CLI引数)かつ環境変数 LIVE_DISCORD="true" の両方が揃わない限り発生しない
// (lib/discord-notifier.mjsのisLiveDiscordAllowedに一元化。ここでは再実装しない)。
// DISCORD_WEBHOOK_URLは環境変数からのみ取得する。値はログに一切出さない。
// 本文はこのスクリプト自体では生成しない(呼び出し側が --content で渡す)。
//
// ~/threads-harley-solo/scripts/send-discord-notification.mjs と同じ設計(読み取り専用で参照し、
// Harley側のファイルは変更していない)。

import { createSecretRedactor } from "../lib/redact.mjs";
import { sendDiscordNotification } from "../lib/discord-notifier.mjs";

function argValue(flag) {
  const arg = process.argv.find((a) => a.startsWith(`--${flag}=`));
  return arg ? arg.split("=").slice(1).join("=") : null;
}

const live = process.argv.includes("--live");
const content = argValue("content");

if (!content) {
  console.error('使い方: node scripts/send-discord-notification.mjs --content="本文" [--live]');
  console.error('--live を付けても、環境変数 LIVE_DISCORD="true" が無い限りdry-runのままです。');
  process.exit(1);
}

const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
const redact = createSecretRedactor([webhookUrl]);

try {
  const result = await sendDiscordNotification({
    content,
    webhookUrl,
    live,
    env: process.env,
    redact
  });

  if (result.mode === "dry-run") {
    console.log("=== DRY RUN(Discordへ送信していません) ===");
    console.log(result.note);
    console.log(`本文チャンク数: ${result.chunkCount}`);
    process.exit(0);
  }

  console.log("=== Discord送信完了 ===");
  console.log(`送信チャンク数: ${result.chunkCount}`);
} catch (err) {
  console.error("Discord送信でエラーが発生しました:", redact(err.message));
  process.exit(1);
}
