// 「英語→日本語」併記フォーマットの構造チェック(テーマ非依存)。
// ネットワーク・秘密情報は一切扱わない、純粋なテキスト検査のみ。

export const MAX_COMBINED_LENGTH = 500;

// Threadsへ実際に投稿する本文の組み立て方(英語ブロック→空行→日本語ブロック)。
// この関数を通した結果でのみ文字数・URL等をチェックする。
export function buildBilingualBody(bodyEn, bodyJa) {
  return `${bodyEn || ""}\n\n${bodyJa || ""}`;
}

// 投稿スロットの言語(2026-10-10〜)。承認済みアイテムは常にbodyEn/bodyJaの両方を持ち、
// 朝(JST 05:00)は日本語だけ、夜(JST 21:00)は英語だけを、それぞれ別の投稿として出す。
// "both" は従来の「英語→空行→日本語」を1投稿にまとめる形(手動実行・後方互換用)。
export const POST_LANGS = Object.freeze(["both", "ja", "en"]);

export function buildPostBody(bodyEn, bodyJa, lang = "both") {
  if (lang === "ja") return bodyJa || "";
  if (lang === "en") return bodyEn || "";
  return buildBilingualBody(bodyEn, bodyJa);
}

export function checkBilingualBody({ bodyEn, bodyJa }) {
  const errors = [];

  if (!bodyEn || !bodyEn.trim()) errors.push("bodyEn-empty");
  if (!bodyJa || !bodyJa.trim()) errors.push("bodyJa-empty");

  const combined = buildBilingualBody(bodyEn, bodyJa);

  if ([...combined].length > MAX_COMBINED_LENGTH) {
    errors.push(`combined-length-exceeds-${MAX_COMBINED_LENGTH}`);
  }

  // ショップ誘導は常にプロフィールのリンク経由とし、本文に生URLを含めない。
  if (/https?:\/\//i.test(combined)) {
    errors.push("raw-url-in-body");
  }

  return { ok: errors.length === 0, errors, combinedLength: [...combined].length };
}
