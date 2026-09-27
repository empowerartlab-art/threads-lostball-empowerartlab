#!/usr/bin/env node
// 認可URLを生成して表示するだけ。Threads APIへの接続・書き込みは一切行わない。

import { loadLocalEnv } from "../lib/load-local-env.mjs";

const DEFAULT_SCOPES = ["threads_basic", "threads_content_publish", "threads_manage_insights"];

const env = loadLocalEnv();

function requiredEnv(name) {
  const value = env[name];
  if (!value) {
    throw new Error(`${name} が .env.local に見つかりません。先に .env.example を参考に .env.local を作成してください。`);
  }
  return value;
}

try {
  const clientId = requiredEnv("THREADS_CLIENT_ID");
  const redirectUri = requiredEnv("THREADS_REDIRECT_URI");
  const scopes = (env.THREADS_SCOPES || DEFAULT_SCOPES.join(",")).split(/[,\s]+/).filter(Boolean);
  const state = env.THREADS_AUTH_STATE || `threads-lostball-${Date.now()}`;

  const url = new URL("https://threads.net/oauth/authorize");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", scopes.join(","));
  url.searchParams.set("response_type", "code");
  url.searchParams.set("state", state);

  console.log("以下のURLを、@lost_ball_empowerartlab としてログインした状態のブラウザで開いてください:");
  console.log(url.toString());
  console.log("");
  console.log("承認後にリダイレクトされたURLの `code` クエリパラメータの値をコピーし、");
  console.log('node scripts/exchange-threads-token.mjs --code="<コピーした値>" を実行してください。');
  console.log(`state: ${state}`);
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
