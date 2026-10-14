// 似すぎた投稿（ほぼ同じ内容の言い換え）を防ぐガード。1日4本（2026-10-20〜）に合わせて追加。
// ファイルI/O・ネットワークなし。
//
// duplicate-guard.mjs は「正規化して完全一致」しか見ないため、語順や句読点を少し変えただけの
// 言い換えは通ってしまう。1日4本・週28本になると、同じ日・同じ週に似た投稿が並ぶ危険が増える。
//
// 比べるのは「実際に投稿される言語の本文」だけ（日本語の枠は bodyJa、英語の枠は bodyEn）。
// 日本語どうし・英語どうしを比べ、日本語と英語は比べない（夜の英語が同じ日の日本語の訳でもよい）。
//   日本語: 2文字ずつの組（文字bigram）の Jaccard 係数（0〜1）
//   英語  : 2単語ずつの組（単語bigram）の Jaccard 係数（文字bigramだと英語は共通の綴りで高く出すぎる）
//
// しきい値（2026-10-14、このリポジトリの承認済み29件で実測）:
//   日本語: 別々の投稿どうしの中央値0.08・上位10%0.18。最大0.48は同じ話題の撮り直し（day11とday20）。
//   英語  : 最大0.30（day18と10/15）、次が0.28（day11とday20）。
//   → 同じ日 : 日本語0.25以上は不可。さらに同じカテゴリー・同じ書き出しも不可。
//   → 同じ週（7日以内）: 日本語0.35以上・英語0.30以上は不可
//   → 投稿済み（直近60日）: 日本語0.45以上・英語0.40以上は不可（言い換えの再投稿を防ぐ）
// 事実の裏付け（verified-facts.json）はこのガードの役目ではなく、verified-fact-guard /
// fact-fabrication-guard が引き続き担当する。

import { normalizeBody } from "./duplicate-guard.mjs";

export const THRESHOLDS = Object.freeze({
  ja: Object.freeze({ sameDay: 0.25, sameWeek: 0.35, posted: 0.45 }),
  en: Object.freeze({ sameDay: 0.25, sameWeek: 0.3, posted: 0.4 })
});
export const WEEK_WINDOW_DAYS = 7;
export const POSTED_WINDOW_DAYS = 60;
export const OPENING_LENGTH = 8;

const PUNCT = /[\s、。，．,.!！?？…・「」『』（）()［］[\]【】\-ー—〜~：:；;"'“”‘’]/g;

// その言語で実際に投稿される本文。
export function postTextOf(item, lang) {
  return lang === "en" ? String(item?.bodyEn ?? "") : String(item?.bodyJa ?? "");
}

function compact(text) {
  return normalizeBody(text).normalize("NFKC").replace(PUNCT, "").toLowerCase();
}

function charBigrams(text) {
  const chars = [...compact(text)];
  const set = new Set();
  if (chars.length === 1) set.add(chars[0]);
  for (let i = 0; i < chars.length - 1; i++) set.add(chars[i] + chars[i + 1]);
  return set;
}

function wordBigrams(text) {
  const words = normalizeBody(text)
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^a-z0-9' ]+/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  const set = new Set();
  if (words.length === 1) set.add(words[0]);
  for (let i = 0; i < words.length - 1; i++) set.add(`${words[i]} ${words[i + 1]}`);
  return set;
}

// 0（まったく違う）〜1（同じ）。
export function textSimilarity(a, b, lang = "ja") {
  const grams = lang === "en" ? wordBigrams : charBigrams;
  const A = grams(a);
  const B = grams(b);
  if (A.size === 0 && B.size === 0) return 1;
  let inter = 0;
  for (const g of A) if (B.has(g)) inter++;
  return inter / (A.size + B.size - inter);
}

export function openingOf(text) {
  return [...compact(text)].slice(0, OPENING_LENGTH).join("");
}

function daysBetween(a, b) {
  return Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / (24 * 60 * 60 * 1000);
}

const round2 = (x) => Math.round(x * 100) / 100;
const LANG_LABEL = { ja: "日本語", en: "英語" };

/**
 * 予定された投稿どうし（同じ日・同じ週、同じ言語）を比べる。
 * items: [{ id, targetDate, lang, text, category? }]
 * 戻り値: { ok, problems: [{ ids: [a, b], rule, detail }] }
 */
export function checkScheduleSimilarity(items) {
  const list = (items || []).filter((i) => i && typeof i.targetDate === "string" && typeof i.text === "string" && THRESHOLDS[i.lang]);
  const problems = [];
  for (let x = 0; x < list.length; x++) {
    for (let y = x + 1; y < list.length; y++) {
      const a = list[x];
      const b = list[y];
      if (a.lang !== b.lang) continue;
      const gap = daysBetween(a.targetDate, b.targetDate);
      if (gap >= WEEK_WINDOW_DAYS) continue;
      const t = THRESHOLDS[a.lang];
      const ids = [a.id, b.id];
      const sim = textSimilarity(a.text, b.text, a.lang);
      const lang = LANG_LABEL[a.lang];
      if (gap === 0) {
        if (sim >= t.sameDay) problems.push({ ids, rule: "same-day-similar", detail: `同じ日の${lang}の本文が似ています（類似度${round2(sim)} ≥ ${t.sameDay}）` });
        if (a.category && a.category === b.category) problems.push({ ids, rule: "same-day-category", detail: `同じ日に同じカテゴリー（${a.category}）が2本あります` });
        const opening = openingOf(a.text);
        if (opening && opening === openingOf(b.text)) problems.push({ ids, rule: "same-day-opening", detail: `同じ日に同じ書き出し（「${opening}」）があります` });
      } else if (sim >= t.sameWeek) {
        problems.push({ ids, rule: "same-week-similar", detail: `7日以内の${lang}の本文が似ています（類似度${round2(sim)} ≥ ${t.sameWeek}）` });
      }
    }
  }
  return { ok: problems.length === 0, problems };
}

// 投稿記録（threads-posts.json の1件）のうち、指定した言語で実際に出した本文。
// 従来の併記投稿（lang なし / "both"）は両方の言語を出しているので、その言語の部分を返す。
// その言語では出していない記録は null。
function postedTextIn(record, lang) {
  const recLang = record?.lang ?? "both";
  if (recLang !== "both" && recLang !== lang) return null;
  return postTextOf(record, lang);
}

/**
 * 1本を、投稿済み（直近60日・同じ言語）と比べる。自分自身の投稿記録（sourceItemId が同じ）は除く。
 * item: { id, lang, text }
 */
export function checkAgainstPosted(item, postedPosts, { now = new Date(), windowDays = POSTED_WINDOW_DAYS } = {}) {
  const t = THRESHOLDS[item?.lang];
  const problems = [];
  if (!t) return { ok: true, problems };
  const cutoff = now.getTime() - windowDays * 24 * 60 * 60 * 1000;
  for (const post of postedPosts || []) {
    if (post?.sourceItemId && post.sourceItemId === item.id) continue;
    const text = postedTextIn(post, item.lang);
    if (!text) continue;
    const at = Date.parse(post.postedAt || "");
    if (Number.isFinite(at) && at < cutoff) continue;
    const sim = textSimilarity(item.text, text, item.lang);
    if (sim >= t.posted) {
      problems.push({
        rule: "similar-to-posted",
        detail: `投稿済み（${String(post.postedAt || "日時不明").slice(0, 10)}・${post.sourceItemId ?? "id不明"}）と${LANG_LABEL[item.lang]}の本文が似ています（類似度${round2(sim)} ≥ ${t.posted}）`
      });
    }
  }
  return { ok: problems.length === 0, problems };
}

// 同じ言語で、まったく同じ本文（正規化後）がすでに投稿されているか。
export function isPostedTextDuplicate(item, lang, postedPosts) {
  const mine = normalizeBody(postTextOf(item, lang));
  if (!mine) return false;
  return (postedPosts || []).some((post) => {
    if (post?.sourceItemId && post.sourceItemId === item?.id) return false;
    const text = postedTextIn(post, lang);
    return text !== null && normalizeBody(text) === mine;
  });
}
