// Discord通知(テーマ非依存)。
// dry-run用のプレビュー文字列生成(buildDiscordDryRunMessage)と、
// 実際にWebhookへ送信する処理(sendDiscordNotification)の両方をここに持つ。
//
// 実送信の二重ゲート(~/threads-harley-solo/lib/discord-notify.mjsと同じ設計。読み取り専用で
// 参照し、Harley側のファイルは変更していない):
//   live===true(呼び出し側の明示指定)かつ 環境変数 LIVE_DISCORD==="true" の
//   両方が揃わない限り、Webhookへは絶対に接続しない(lib/threads-publish.mjsの
//   isLivePostAllowedと同じ「複数の明示条件が揃わない限り実行しない」設計思想)。
// Webhook URLは呼び出し側が環境変数 DISCORD_WEBHOOK_URL から取得して渡す想定
// (このモジュール自体は環境変数を直接読まない)。値はログに一切出力しない。
//
// Threads投稿の成否そのものにDiscord通知の成否は一切影響しない
// (呼び出し側であるworkflow/CLIが、Discord送信の例外を握りつぶして副次処理として扱う想定。
// このモジュール自身は例外を投げるだけで、それを揉み消すかどうかは呼び出し側の責務)。

const DISCORD_MAX_CONTENT_LENGTH = 2000; // Discordの1メッセージあたりのcontent文字数上限

// 長文を複数メッセージに分割する。改行境界を優先し、1行自体が上限を超える場合のみ強制分割する。
export function splitIntoDiscordChunks(text, maxLength = DISCORD_MAX_CONTENT_LENGTH) {
  const content = String(text ?? "");
  if (content.length <= maxLength) return [content];

  const lines = content.split("\n");
  const chunks = [];
  let current = "";

  for (const line of lines) {
    const candidate = current ? `${current}\n${line}` : line;
    if (candidate.length <= maxLength) {
      current = candidate;
      continue;
    }
    if (current) chunks.push(current);
    if (line.length > maxLength) {
      for (let i = 0; i < line.length; i += maxLength) {
        chunks.push(line.slice(i, i + maxLength));
      }
      current = "";
    } else {
      current = line;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

export function isLiveDiscordAllowed({ live, env }) {
  return live === true && env?.LIVE_DISCORD === "true";
}

export async function sendDiscordNotification({
  content,
  webhookUrl,
  live = false,
  env = {},
  redact = (x) => x,
  fetchImpl = fetch
}) {
  const chunks = splitIntoDiscordChunks(content);

  if (!isLiveDiscordAllowed({ live, env })) {
    return {
      mode: "dry-run",
      wouldSend: true,
      chunkCount: chunks.length,
      note: 'live===true かつ 環境変数 LIVE_DISCORD="true" の両方が明示されていないため送信していません(dry-run)。'
    };
  }

  // Secret経由の値は末尾に改行/空白が混入することがある(例: コピー&ペースト経由)ため、
  // 値そのものはログに出さずにtrimして使う。
  const trimmedWebhookUrl = typeof webhookUrl === "string" ? webhookUrl.trim() : webhookUrl;

  if (!trimmedWebhookUrl) {
    throw new Error("DISCORD_WEBHOOK_URLが指定されていません(値は表示しません)。");
  }

  try {
    // eslint-disable-next-line no-new
    new URL(trimmedWebhookUrl);
  } catch {
    // 値自体は絶対に出力しない。原因切り分けに必要な構造情報(長さ・空白混入有無等)のみを出す。
    throw new Error(
      `DISCORD_WEBHOOK_URLの形式が不正でURLとして解釈できません(値は表示しません。` +
        `文字数=${trimmedWebhookUrl.length}、https開始=${trimmedWebhookUrl.startsWith("https://")}、` +
        `空白文字を含む=${/\s/.test(trimmedWebhookUrl)})。`
    );
  }

  const results = [];
  for (const chunk of chunks) {
    const res = await fetchImpl(trimmedWebhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: chunk })
    });
    if (!res.ok) {
      const bodyText = await (res.text ? res.text().catch(() => "") : Promise.resolve(""));
      throw new Error(`Discord webhookエラー (HTTP ${res.status}): ${redact(String(bodyText)).slice(0, 300)}`);
    }
    results.push({ status: res.status });
  }
  return { mode: "live", wouldSend: false, chunkCount: chunks.length, results };
}

// dry-runプレビュー用(Phase 2から継続使用。scripts/post-to-threads.mjsのDRY_RUN表示専用)。
export function buildDiscordDryRunMessage(report) {
  const lines = [
    `[DRY-RUN] Threads投稿プレビュー: ${report.id ?? "(候補なし)"}`,
    `day=${report.day ?? "-"} pillar=${report.pillar ?? "-"} category=${report.category ?? "-"} targetDate=${report.targetDate ?? "(未指定)"}`,
    `文字数=${report.combinedLength}/${report.maxLength} CTA=${report.hasCta ? "あり" : "なし"}`,
    `画像: type=${report.media.type} required=${report.media.required} 承認済み=${report.media.approved} 画像あり=${report.media.hasImage}`,
    `ガード結果: ${report.guardsOk ? "OK" : "NG"}`,
    "実際のDiscord送信は行っていません(このプレビュー自体は常にdry-run表示専用)。"
  ];
  return lines.join("\n");
}
