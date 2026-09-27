// Threads Graph API 低レベルクライアント。
// GET /me による接続確認、およびテキスト投稿(2段階: コンテナ作成→publish)を担当する。
// 呼び出すかどうかの判断(dry-run/liveの二重ゲート)は一切ここでは行わない
// (lib/threads-publish.mjs側の責務。このファイルはAPI呼び出しの実装のみを持つ)。
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

// テキスト投稿用のコンテナを作成する(投稿の1段階目)。まだTheadsには公開されない。
// mediaType: 現時点ではTEXTのみサポート(画像投稿はPhase 3の対象外。将来拡張時に追加する)。
export async function createTextContainer({ userId, accessToken, text }, { redact = (x) => x } = {}) {
  const url = new URL(`${GRAPH_BASE}/v1.0/${userId}/threads`);
  url.searchParams.set("media_type", "TEXT");
  url.searchParams.set("text", text);
  url.searchParams.set("access_token", accessToken);

  const res = await fetch(url, { method: "POST" });
  const json = await res.json();
  if (!res.ok || !json.id) throw buildError(res, json, redact);
  return { containerId: json.id };
}

// 作成済みのコンテナをThreadsへ公開する(投稿の2段階目)。成功すると実際の投稿IDが返る。
export async function publishContainer({ userId, accessToken, containerId }, { redact = (x) => x } = {}) {
  const url = new URL(`${GRAPH_BASE}/v1.0/${userId}/threads_publish`);
  url.searchParams.set("creation_id", containerId);
  url.searchParams.set("access_token", accessToken);

  const res = await fetch(url, { method: "POST" });
  const json = await res.json();
  if (!res.ok || !json.id) throw buildError(res, json, redact);
  return { threadsPostId: json.id };
}
