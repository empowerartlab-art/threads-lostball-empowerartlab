#!/usr/bin/env node
// 認可コード → 短期トークン → 長期トークンの交換を行い、GET /me で確認したうえで
// 結果を .env.local へ安全に保存する(値はログに出力しない)。
// scripts/threads-auth-url.mjs で取得した認可コードを --code= で渡して実行する。

import fs from "node:fs/promises";
import { loadLocalEnv, mergeWithProcessEnv } from "../lib/load-local-env.mjs";
import { createSecretRedactor } from "../lib/redact.mjs";
import { verifyConnection } from "../lib/threads-client.mjs";

const ENV_PATH = new URL("../.env.local", import.meta.url);

function argValue(flag) {
  const arg = process.argv.find((a) => a.startsWith(`--${flag}=`));
  return arg ? arg.split("=").slice(1).join("=") : null;
}

function requiredEnv(env, name) {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} が .env.local に見つかりません。`);
  return value;
}

async function parseJsonResponse(response, label, redact) {
  const text = await response.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`${label} がJSON以外を返しました (HTTP ${response.status}): ${redact(text).slice(0, 300)}`);
  }
  if (!response.ok) {
    throw new Error(`${label} に失敗しました (HTTP ${response.status}): ${redact(JSON.stringify(json))}`);
  }
  return json;
}

// .env.local の該当キーだけを安全に更新する(他の行は保持する)。値はログに出さない。
async function upsertEnvFile(path, updates) {
  let content = "";
  try {
    content = await fs.readFile(path, "utf8");
  } catch {
    content = "";
  }
  const lines = content.length ? content.split("\n") : [];
  const keys = Object.keys(updates);
  const seen = new Set();

  const nextLines = lines.map((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) return line;
    const key = trimmed.slice(0, trimmed.indexOf("=")).trim();
    if (keys.includes(key)) {
      seen.add(key);
      return `${key}=${updates[key]}`;
    }
    return line;
  });

  for (const key of keys) {
    if (!seen.has(key)) nextLines.push(`${key}=${updates[key]}`);
  }

  const finalContent = nextLines.join("\n").replace(/\n{3,}/g, "\n\n");
  await fs.writeFile(path, finalContent.endsWith("\n") ? finalContent : `${finalContent}\n`);
}

const env = mergeWithProcessEnv(loadLocalEnv());
const redactSecret = createSecretRedactor([env.THREADS_CLIENT_SECRET]);

const clientId = requiredEnv(env, "THREADS_CLIENT_ID");
const clientSecret = requiredEnv(env, "THREADS_CLIENT_SECRET");
const redirectUri = requiredEnv(env, "THREADS_REDIRECT_URI");
const code = argValue("code") || env.THREADS_AUTH_CODE;

if (!code) {
  console.error('使い方: node scripts/exchange-threads-token.mjs --code="<scripts/threads-auth-url.mjsで取得した認可コード>"');
  process.exit(1);
}

try {
  const shortLivedRes = await fetch("https://graph.threads.net/oauth/access_token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "authorization_code",
      redirect_uri: redirectUri,
      code
    })
  });
  const shortLived = await parseJsonResponse(shortLivedRes, "短期トークン交換", redactSecret);

  const longLivedUrl = new URL("https://graph.threads.net/access_token");
  longLivedUrl.searchParams.set("grant_type", "th_exchange_token");
  longLivedUrl.searchParams.set("client_secret", clientSecret);
  longLivedUrl.searchParams.set("access_token", shortLived.access_token);

  const redactShortLived = createSecretRedactor([env.THREADS_CLIENT_SECRET, shortLived.access_token]);
  const longLived = await parseJsonResponse(await fetch(longLivedUrl), "長期トークン交換", redactShortLived);

  const redactAll = createSecretRedactor([env.THREADS_CLIENT_SECRET, shortLived.access_token, longLived.access_token]);
  const profile = await verifyConnection(longLived.access_token, { redact: redactAll });

  const expiresAt = longLived.expires_in
    ? new Date(Date.now() + Number(longLived.expires_in) * 1000).toISOString()
    : "";

  await upsertEnvFile(ENV_PATH, {
    THREADS_ACCESS_TOKEN: longLived.access_token,
    THREADS_USER_ID: profile.id,
    THREADS_USERNAME: profile.username || "",
    THREADS_TOKEN_TYPE: "long_lived",
    THREADS_TOKEN_EXPIRES_AT: expiresAt
  });

  console.log("トークン交換に成功し、.env.local へ保存しました(値はログに出力していません)。");
  console.log(`username: ${profile.username}`);
  console.log(`user_id: ${profile.id}`);
  if (expiresAt) console.log(`有効期限: ${expiresAt}`);
  console.log("");
  console.log("次に npm run lostball:check-connection で接続確認できます。");
} catch (err) {
  console.error("トークン交換に失敗しました:", redactSecret(err.message));
  process.exit(1);
}
