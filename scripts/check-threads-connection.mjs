#!/usr/bin/env node
// Threads API接続確認の正式スクリプト。GET /me を叩いて接続を確認するだけ。
// 投稿・書き込みは一切行わない。.env.localの内容やアクセストークンはログに出さない。

import { loadLocalEnv } from "../lib/load-local-env.mjs";
import { verifyConnection } from "../lib/threads-client.mjs";
import { createSecretRedactor } from "../lib/redact.mjs";

const env = loadLocalEnv();
const redact = createSecretRedactor([env.THREADS_ACCESS_TOKEN]);

if (!env.THREADS_ACCESS_TOKEN) {
  console.error("THREADS_ACCESS_TOKEN が .env.local に見つかりません（キー名のみ表示）。");
  console.error("先に scripts/threads-auth-url.mjs → scripts/exchange-threads-token.mjs を実行してください。");
  process.exit(1);
}

try {
  const profile = await verifyConnection(env.THREADS_ACCESS_TOKEN, { redact });
  console.log("接続確認(GET /me): OK");
  console.log("username:", profile.username);
  console.log("user_id:", profile.id);
} catch (err) {
  console.error("接続確認に失敗しました:", redact(err.message));
  process.exit(1);
}
