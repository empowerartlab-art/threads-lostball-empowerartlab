#!/usr/bin/env node
// Threads投稿の初回LIVE失敗(HTTP 400 OAuthException "The requested resource does not exist")の
// 原因切り分け専用の診断スクリプト。実際の投稿(threads_publish)は一切呼ばない。
//
// 目的(ローカルでは成功・GitHub Actionsでは失敗、という差分の特定):
//   1. THREADS_USER_ID / THREADS_ACCESS_TOKEN が正しく読み込めているか
//      (値そのものは一切出力しない。長さ・空白混入の有無などのメタ情報のみ)
//   2. .env.local の生テキスト時点で、値の前後に空白・CR・LF等が混入していないか
//      (lib/load-local-env.mjsのparseEnvContentがtrim()する"前"の生の行を見て検出する)
//   3. Node.js / fetch実装のバージョン情報
//   4. 実際に生成されるAPIエンドポイント(access_token等の値は含めず、ホスト・パス・
//      バージョン・クエリパラメータ名のみ)
//   5. GET /me (verifyConnection) が成功するか、失敗する場合は
//      HTTP status / error.type / error.code / error.error_subcode / error.message / error.fbtrace_id
//   6. コンテナ作成のみ(createTextContainer)を診断用テキストで試行し、成功/失敗を同様に報告
//      (threads_publishは絶対に呼ばないため、これ自体でThreadsに投稿が作られることはない)
//
// 候補選出(select-daily-candidate)・各種ガード・重複投稿防止(duplicate-guard)・
// data/threads-posts.jsonには一切触れない(このスクリプトはそれらを一切importしていない)。
// git操作・Discord通知も行わない。

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadLocalEnv, mergeWithProcessEnv } from "../lib/load-local-env.mjs";
import { createSecretRedactor } from "../lib/redact.mjs";
import { verifyConnection, createTextContainer, GRAPH_BASE, API_VERSION } from "../lib/threads-client.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ENV_LOCAL_PATH = join(__dirname, "..", ".env.local");

function section(title) {
  console.log("");
  console.log(`=== ${title} ===`);
}

// .env.local の生テキストから、指定キーの「trim前」の値を取り出す(空白混入検出用)。
// ファイルが無い場合(GitHub Actions以外の想定外の実行など)はnullを返す。
function readRawValue(key) {
  let content;
  try {
    content = readFileSync(ENV_LOCAL_PATH, "utf8");
  } catch {
    return null;
  }
  for (const rawLine of content.split("\n")) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine; // 行末CRは別途検出するのでここでは剥がさない判定用に保持
    const eq = rawLine.indexOf("=");
    if (eq === -1) continue;
    const rawKey = rawLine.slice(0, eq).trim();
    if (rawKey !== key) continue;
    return rawLine.slice(eq + 1); // trimしない生の値(末尾CRや空白を含みうる)
  }
  return null;
}

function describeWhitespace(rawValue) {
  if (rawValue == null) return "(.env.localに見つからず)";
  const trimmed = rawValue.trim();
  const hasCR = rawValue.includes("\r");
  const hasLeadingSpace = rawValue.length > 0 && /^\s/.test(rawValue);
  const hasTrailingSpace = rawValue.length > 0 && /\s$/.test(rawValue);
  const hasQuotes = /^["']|["']$/.test(trimmed);
  const hasControlChars = /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(rawValue);
  return (
    `rawLength=${rawValue.length} trimmedLength=${trimmed.length} ` +
    `CR混入=${hasCR} 先頭空白=${hasLeadingSpace} 末尾空白=${hasTrailingSpace} ` +
    `前後にクォート文字=${hasQuotes} 制御文字混入=${hasControlChars}`
  );
}

function describeShape(name, value) {
  if (!value) {
    console.log(`${name}: 未設定(空またはundefined)`);
    return;
  }
  const isNumeric = /^[0-9]+$/.test(value);
  console.log(`${name}: 設定あり / trimmed length=${value.length} / 数字のみ=${isNumeric}`);
}

async function main() {
  section("実行環境");
  console.log(`Node.jsバージョン: ${process.version}`);
  console.log(`fetch実装: ${typeof fetch === "function" ? "利用可能(グローバルfetch)" : "利用不可"}`);
  console.log(`GITHUB_ACTIONS: ${process.env.GITHUB_ACTIONS ?? "(未設定=ローカル実行と推定)"}`);
  console.log(`RUNNER_OS: ${process.env.RUNNER_OS ?? "(未設定)"}`);

  section(".env.local 生テキストでの空白・制御文字混入チェック(値そのものは出力しない)");
  console.log(`THREADS_ACCESS_TOKEN: ${describeWhitespace(readRawValue("THREADS_ACCESS_TOKEN"))}`);
  console.log(`THREADS_USER_ID: ${describeWhitespace(readRawValue("THREADS_USER_ID"))}`);

  const env = mergeWithProcessEnv(loadLocalEnv());
  const redact = createSecretRedactor([env.THREADS_ACCESS_TOKEN, env.THREADS_USER_ID]);

  section("読み込み後(loadLocalEnv→mergeWithProcessEnv)の値の形状(値そのものは出力しない)");
  describeShape("THREADS_ACCESS_TOKEN", env.THREADS_ACCESS_TOKEN);
  describeShape("THREADS_USER_ID", env.THREADS_USER_ID);

  section("生成されるAPIエンドポイント(access_token等の値は含めない)");
  console.log(`GRAPH_BASE: ${GRAPH_BASE}`);
  console.log(`API_VERSION: ${API_VERSION}`);
  console.log(`GET  接続確認: ${GRAPH_BASE}/${API_VERSION}/me?fields=id,username&access_token=(略)`);
  console.log(
    `POST コンテナ作成: ${GRAPH_BASE}/${API_VERSION}/${redact(env.THREADS_USER_ID ?? "(未設定)")}/threads?media_type=TEXT&text=(略)&access_token=(略)`
  );

  section("GET /me (verifyConnection) 診断");
  if (!env.THREADS_ACCESS_TOKEN) {
    console.log("THREADS_ACCESS_TOKENが未設定のため、GET /meをスキップします。");
  } else {
    try {
      const profile = await verifyConnection(env.THREADS_ACCESS_TOKEN, { redact });
      console.log("結果: 成功");
      console.log(`username: ${profile.username}`);
      console.log(`id: ${redact(profile.id)}`);
      if (env.THREADS_USER_ID && String(profile.id) !== String(env.THREADS_USER_ID)) {
        console.log(
          "!!! 警告: GET /meが返したidと、環境変数THREADS_USER_IDが一致しません(値は表示しません。長さ等で判断してください) !!!"
        );
      } else if (env.THREADS_USER_ID) {
        console.log("GET /meが返したidとTHREADS_USER_IDは一致しています。");
      }
    } catch (err) {
      console.log("結果: 失敗");
      console.log(`HTTP status: ${err.status ?? "(不明)"}`);
      console.log(`error.type: ${redact(String(err.type ?? "(不明)"))}`);
      console.log(`error.code: ${err.code ?? "(なし)"}`);
      console.log(`error.error_subcode: ${err.errorSubcode ?? "(なし)"}`);
      console.log(`error.fbtrace_id: ${err.fbtraceId ?? "(なし)"}`);
      console.log(`error.message: ${redact(err.message)}`);
    }
  }

  section("コンテナ作成のみ診断(createTextContainer。threads_publishは呼ばないため投稿は発生しません)");
  if (!env.THREADS_ACCESS_TOKEN || !env.THREADS_USER_ID) {
    console.log("THREADS_ACCESS_TOKENまたはTHREADS_USER_IDが未設定のため、この診断をスキップします。");
  } else {
    const diagnosticText = `[診断専用・未公開] Lost Ball diagnostics ${new Date().toISOString()}`;
    try {
      const { containerId } = await createTextContainer(
        { userId: env.THREADS_USER_ID, accessToken: env.THREADS_ACCESS_TOKEN, text: diagnosticText },
        { redact }
      );
      console.log("結果: 成功");
      console.log(`containerId: ${containerId}`);
      console.log("このcontainerはpublishしていないため、Threadsには投稿されていません(24時間で自動的に無効化されます)。");
    } catch (err) {
      console.log("結果: 失敗");
      console.log(`HTTP status: ${err.status ?? "(不明)"}`);
      console.log(`error.type: ${redact(String(err.type ?? "(不明)"))}`);
      console.log(`error.code: ${err.code ?? "(なし)"}`);
      console.log(`error.error_subcode: ${err.errorSubcode ?? "(なし)"}`);
      console.log(`error.fbtrace_id: ${err.fbtraceId ?? "(なし)"}`);
      console.log(`error.message: ${redact(err.message)}`);
    }
  }

  section("診断完了");
  console.log("このスクリプトはThreadsへの投稿(threads_publish)を一切呼び出していません。");
}

await main();
