// Threads Graph API 低レベルクライアント。
// GET /me による接続確認、およびテキスト投稿(2段階: コンテナ作成→publish)を担当する。
// 呼び出すかどうかの判断(dry-run/liveの二重ゲート)は一切ここでは行わない
// (lib/threads-publish.mjs側の責務。このファイルはAPI呼び出しの実装のみを持つ)。
// SECRETS: access_tokenを引数で受け取るだけで、ログに出力しない。
// 呼び出し側は必ず createSecretRedactor で作った redact() をエラーメッセージに通すこと
// (Metaのエラーレスポンスが受け取った値をそのままエコーすることがあるため)。

const GRAPH_BASE = "https://graph.threads.net";
const API_VERSION = "v1.0";

// 診断スクリプト(scripts/diagnose-threads-connection.mjs)がAPIエンドポイント/バージョンを
// 実際の投稿コードと完全に同じ値で報告できるよう、定数をそのままexportする
// (診断スクリプト側で文字列を再定義してドリフトしないようにするため)。
export { GRAPH_BASE, API_VERSION };

// 診断用: Threads/Graph APIのエラーレスポンスから原因特定に必要なフィールド
// (message/type に加えて code / error_subcode / fbtrace_id)を拾う。
// これらはアクセストークン等のSecretsではないため、そのままログに出してよい値だが、
// 呼び出し側が既存の redact() を通す運用を維持できるよう、念のためこの関数内でも
// redact() を通してから message・err.details に格納する(Metaのエラーメッセージが
// 受け取った値をそのままエコーすることがあるため)。
function buildError(res, json, redact) {
  const message = json?.error?.message ?? json?.error_message ?? "(詳細なし)";
  const type = json?.error?.type ?? json?.error_type ?? "(不明)";
  const code = json?.error?.code ?? null;
  const errorSubcode = json?.error?.error_subcode ?? null;
  const fbtraceId = json?.error?.fbtrace_id ?? null;

  const detailParts = [`type=${redact(String(type))}`];
  if (code !== null) detailParts.push(`code=${redact(String(code))}`);
  if (errorSubcode !== null) detailParts.push(`error_subcode=${redact(String(errorSubcode))}`);
  if (fbtraceId !== null) detailParts.push(`fbtrace_id=${redact(String(fbtraceId))}`);

  const err = new Error(`Threads APIエラー (HTTP ${res.status}, ${detailParts.join(", ")}): ${redact(String(message))}`);
  err.status = res.status;
  err.type = type;
  err.code = code;
  err.errorSubcode = errorSubcode;
  err.fbtraceId = fbtraceId;
  return err;
}

export async function verifyConnection(accessToken, { redact = (x) => x } = {}) {
  const url = new URL(`${GRAPH_BASE}/${API_VERSION}/me`);
  url.searchParams.set("fields", "id,username");
  url.searchParams.set("access_token", accessToken);

  const res = await fetch(url, { method: "GET" });
  const json = await res.json();
  if (!res.ok || !json.id) throw buildError(res, json, redact);
  return { id: json.id, username: json.username };
}

// テキスト投稿用のコンテナを作成する(投稿の1段階目)。まだTheadsには公開されない。
export async function createTextContainer({ userId, accessToken, text }, { redact = (x) => x } = {}) {
  const url = new URL(`${GRAPH_BASE}/${API_VERSION}/${userId}/threads`);
  url.searchParams.set("media_type", "TEXT");
  url.searchParams.set("text", text);
  url.searchParams.set("access_token", accessToken);

  const res = await fetch(url, { method: "POST" });
  const json = await res.json();
  if (!res.ok || !json.id) throw buildError(res, json, redact);
  return { containerId: json.id };
}

// 画像付き投稿用のコンテナを作成する(投稿の1段階目)。まだThreadsには公開されない。
// imageUrlはMeta側がcURLでアクセスできる公開URLである必要がある(Threads公式仕様:
// JPEG/PNG、8MB以内、幅320〜1440px(超過/不足分はMeta側で自動スケール)、
// アスペクト比10:1以内)。呼び出し側(lib/media-url.mjs)が、承認済みmedia.pathから
// このリポジトリのraw.githubusercontent.com URLを組み立てて渡す想定。
export async function createImageContainer({ userId, accessToken, text, imageUrl }, { redact = (x) => x } = {}) {
  const url = new URL(`${GRAPH_BASE}/${API_VERSION}/${userId}/threads`);
  url.searchParams.set("media_type", "IMAGE");
  url.searchParams.set("image_url", imageUrl);
  if (text) url.searchParams.set("text", text);
  url.searchParams.set("access_token", accessToken);

  const res = await fetch(url, { method: "POST" });
  const json = await res.json();
  if (!res.ok || !json.id) throw buildError(res, json, redact);
  return { containerId: json.id };
}

// 作成済みのコンテナをThreadsへ公開する(投稿の2段階目)。成功すると実際の投稿IDが返る。
export async function publishContainer({ userId, accessToken, containerId }, { redact = (x) => x } = {}) {
  const url = new URL(`${GRAPH_BASE}/${API_VERSION}/${userId}/threads_publish`);
  url.searchParams.set("creation_id", containerId);
  url.searchParams.set("access_token", accessToken);

  const res = await fetch(url, { method: "POST" });
  const json = await res.json();
  if (!res.ok || !json.id) throw buildError(res, json, redact);
  return { threadsPostId: json.id };
}

// 投稿単位のInsightsを取得する(読み取り専用のGETのみ。投稿・削除・編集は一切行わない)。
// metricsは "views,likes,replies,reposts,quotes,shares" のようなカンマ区切り文字列。
// 返り値は Threads API のレスポンス({data: [...]})をそのまま返す(集計・整形は
// 呼び出し側(scripts/fetch-threads-insights.mjs)の責務とする)。
export async function getMediaInsights({ threadsPostId, accessToken, metrics }, { redact = (x) => x } = {}) {
  const url = new URL(`${GRAPH_BASE}/${API_VERSION}/${threadsPostId}/insights`);
  url.searchParams.set("metric", metrics);
  url.searchParams.set("access_token", accessToken);

  const res = await fetch(url, { method: "GET" });
  const json = await res.json();
  if (!res.ok || !Array.isArray(json.data)) throw buildError(res, json, redact);
  return { data: json.data };
}
