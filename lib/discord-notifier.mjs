// Discord通知の dry-run 用の構造だけを用意する(テーマ非依存)。
// Phase 2ではWebhookへ実際に送信するコード(fetch等)を一切実装しない。
// LIVE_DISCORD=falseを前提とし、「実装が無い」ことそのものを誤送信防止のゲートにする。
// 実送信の実装はPhase 3以降、人間の明示承認のもとで追加する。

export function buildDiscordDryRunMessage(report) {
  const lines = [
    `[DRY-RUN] Threads投稿プレビュー: ${report.id ?? "(候補なし)"}`,
    `day=${report.day ?? "-"} pillar=${report.pillar ?? "-"} category=${report.category ?? "-"} targetDate=${report.targetDate ?? "(未指定)"}`,
    `文字数=${report.combinedLength}/${report.maxLength} CTA=${report.hasCta ? "あり" : "なし"}`,
    `画像: type=${report.media.type} required=${report.media.required} 承認済み=${report.media.approved} 画像あり=${report.media.hasImage}`,
    `ガード結果: ${report.guardsOk ? "OK" : "NG"}`,
    "実際のDiscord送信は行っていません(Phase 2はLIVE_DISCORD=false前提・送信コード未実装)。"
  ];
  return lines.join("\n");
}
