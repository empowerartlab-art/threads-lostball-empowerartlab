// 未確認の断定表現・環境効果の数値断定・福祉の同情訴求を検知する(警告のみ・ハード制約ではない)。
// verified-facts.jsonで裏付けられた事実に基づく断定(例:「すべての商品にステッカーが付く」)は
// 実際には問題ないため、投稿を止めるのではなく人間が最終判断する材料として警告を出す設計にする
// (lib/ai-tone-guard.mjs等、既存の"警告のみ"ガードと同じ考え方)。

const ABSOLUTE_WORDS_JA = ["すべて", "全て", "必ず", "絶対に"];
const ABSOLUTE_PATTERNS_EN = [/\ball\b/i, /\bevery\b/i, /\balways\b/i, /\bnever\b/i, /\bguaranteed?\b/i];

// 根拠のない環境効果の数値化(例:「〇%削減」「〇トン」等)を検知する簡易パターン。
const ENV_STAT_PATTERNS = [/\d+\s*(%|パーセント|トン|tons?)/i];

// 福祉の同情訴求になりやすい表現の簡易パターン。
const WELFARE_PITY_PATTERNS_JA = [/障害者だから/, /かわいそう/, /支援してあげ/];

export function checkAbsoluteClaims({ bodyEn, bodyJa }) {
  const warnings = [];
  for (const word of ABSOLUTE_WORDS_JA) {
    if ((bodyJa || "").includes(word)) {
      warnings.push({ family: "absolute-claim", lang: "ja", match: word });
    }
  }
  for (const pattern of ABSOLUTE_PATTERNS_EN) {
    const match = (bodyEn || "").match(pattern);
    if (match) warnings.push({ family: "absolute-claim", lang: "en", match: match[0] });
  }
  return warnings;
}

export function checkUnfoundedEnvironmentalStats({ bodyEn, bodyJa }) {
  const warnings = [];
  for (const pattern of ENV_STAT_PATTERNS) {
    const enMatch = (bodyEn || "").match(pattern);
    if (enMatch) warnings.push({ family: "env-stat", lang: "en", match: enMatch[0] });
    const jaMatch = (bodyJa || "").match(pattern);
    if (jaMatch) warnings.push({ family: "env-stat", lang: "ja", match: jaMatch[0] });
  }
  return warnings;
}

export function checkWelfarePityAppeal({ bodyJa }) {
  const warnings = [];
  for (const pattern of WELFARE_PITY_PATTERNS_JA) {
    const match = (bodyJa || "").match(pattern);
    if (match) warnings.push({ family: "welfare-pity", lang: "ja", match: match[0] });
  }
  return warnings;
}

export function checkClaims(item) {
  return [
    ...checkAbsoluteClaims(item),
    ...checkUnfoundedEnvironmentalStats(item),
    ...checkWelfarePityAppeal(item)
  ];
}
