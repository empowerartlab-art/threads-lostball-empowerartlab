// .env.local を読み込むだけの共通ローダー。値は一切ログに出さない・出させない。
// プロジェクトルート直下の .env.local を前提とする(テーマ非依存)。

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ENV_PATH = join(__dirname, "..", ".env.local");

export function parseEnvContent(content) {
  const map = {};
  for (const rawLine of String(content || "").split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    map[key] = value;
  }
  return map;
}

// ファイルが無い場合は空オブジェクトを返す(未接続状態として扱う。例外にしない)。
export function loadLocalEnv(path = DEFAULT_ENV_PATH) {
  let content;
  try {
    content = readFileSync(path, "utf8");
  } catch {
    return {};
  }
  return parseEnvContent(content);
}

// .env.local(ローカル開発用)の値をベースに、実際のprocess.env
// (将来GitHub ActionsのSecretsが注入される想定)で上書きする。後勝ち(processEnvが優先)。
export function mergeWithProcessEnv(localEnv, processEnv = process.env) {
  return { ...localEnv, ...processEnv };
}
