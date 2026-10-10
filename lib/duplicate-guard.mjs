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

// 併記本文での重複比較は、1投稿に両言語をまとめていた従来の記録(langなし/"both")だけを対象にする。
// 言語別に投稿した記録(lang: "ja"/"en")は同じアイテムの片方の言語にすぎないので、
// ここに含めると「もう片方の言語」まで投稿済み扱いになってしまう。言語別の判定はisPostedInLangで行う。
function isCombinedRecord(post) {
  return !post?.lang || post.lang === "both";
}

export function buildPostedBodySet(posts) {
  return new Set((posts || []).filter(isCombinedRecord).map((post) => normalizeBilingualBody(post)));
}

// そのアイテムが、指定した言語ですでに投稿済みか。従来の併記投稿(langなし/"both")は両言語とも投稿済みとみなす。
export function isPostedInLang(item, posts, lang) {
  return (posts || []).some(
    (post) => post?.sourceItemId === item?.id && (isCombinedRecord(post) || post.lang === lang)
  );
}

export function isDuplicateBody(item, postedBodySet) {
  return postedBodySet.has(normalizeBilingualBody(item));
}
