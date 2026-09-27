// Threads Graph API 低レベルクライアント。
// Phase 1のスコープは GET /me による接続確認のみ。投稿・Insights等はPhase 2以降で追加する。
// SECRETS: access_tokenを引数で受け取るだけで、ログに出力しない。
// 呼び出し側は必ず createSecretRedactor で作った redact() をエラーメッセージに通すこと
// (Metaのエラーレスポンスが受け取った値をそのままエコーすることがあるため)。

const GRAPH_BASE = "https://graph.threads.net";

function buildError(res, json, redact) {
  const message = json?.error?.message ?? json?.error_message ?? "(詳細なし)";
  const type = json?.error?.type ?? json?.error_type ?? "(不明)";
  const err = new Error(`Threads APIエラー (HTTP ${res.status}, type=${redact(String(type))}): ${redact(String(message))}`);
  err.status = res.status;
  err.type = type;
  return err;
}

export async function verifyConnection(accessToken, { redact = (x) => x } = {}) {
  const url = new URL(`${GRAPH_BASE}/v1.0/me`);
  url.searchParams.set("fields", "id,username");
  url.searchParams.set("access_token", accessToken);

  const res = await fetch(url, { method: "GET" });
  const json = await res.json();
  if (!res.ok || !json.id) throw buildError(res, json, redact);
  return { id: json.id, username: json.username };
}
