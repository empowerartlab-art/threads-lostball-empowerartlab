// Threads APIのinsightsレスポンス({data: [{name, values:[{value}]}, ...]})を、
// 扱いやすいフラットな数値オブジェクトへ変換するだけの純粋関数。
// ネットワーク・Secretsは一切扱わない。

export const MEDIA_INSIGHTS_METRICS = ["views", "likes", "replies", "reposts", "quotes", "shares"];

// name自体がmetricキーと一致しない場合(例: "thread_replies"/"thread_shares"が
// 返ることがある。2026-10-02時点のAPI挙動を参照)に備え、別名をここで吸収する。
const METRIC_NAME_ALIASES = {
  thread_replies: "replies",
  thread_shares: "shares"
};

export function parseMediaInsightsResponse(response) {
  const result = Object.fromEntries(MEDIA_INSIGHTS_METRICS.map((m) => [m, null]));
  for (const entry of response?.data || []) {
    const key = METRIC_NAME_ALIASES[entry.name] ?? entry.name;
    if (!MEDIA_INSIGHTS_METRICS.includes(key)) continue;
    const value = entry?.values?.[0]?.value;
    result[key] = typeof value === "number" ? value : null;
  }
  return result;
}
