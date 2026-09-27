// 「英語→日本語」併記フォーマットの構造チェック(テーマ非依存)。
// ネットワーク・秘密情報は一切扱わない、純粋なテキスト検査のみ。

export const MAX_COMBINED_LENGTH = 500;

// Threadsへ実際に投稿する本文の組み立て方(英語ブロック→空行→日本語ブロック)。
// この関数を通した結果でのみ文字数・URL等をチェックする。
export function buildBilingualBody(bodyEn, bodyJa) {
  return `${bodyEn || ""}\n\n${bodyJa || ""}`;
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
