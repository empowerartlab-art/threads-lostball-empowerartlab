// 投稿済み本文との重複防止(テーマ非依存)。英語+日本語の併記本文を正規化して比較する。

export function normalizeBody(value) {
  return String(value || "")
    .split("\n")
    .filter((line) => !line.trim().startsWith("#"))
    .join("\n")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// bodyEn/bodyJaを持つアイテムを1つの比較キーに正規化する。
export function normalizeBilingualBody(item) {
  const en = normalizeBody(item?.bodyEn || "");
  const ja = normalizeBody(item?.bodyJa || "");
  return `${en}\n${ja}`;
}

export function buildPostedBodySet(posts) {
  return new Set((posts || []).map((post) => normalizeBilingualBody(post)));
}

export function isDuplicateBody(item, postedBodySet) {
  return postedBodySet.has(normalizeBilingualBody(item));
}
