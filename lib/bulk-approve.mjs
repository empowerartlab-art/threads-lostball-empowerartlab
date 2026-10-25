// 1日4本（2026-10-20〜）の候補を、日付ごと・1週間ぶんまとめて人間が承認するためのロジック。
// ファイルI/O・ネットワークは一切しない（scripts/bulk-approve.mjs が読み書きを担当する）。
//
// 承認の原則は従来と同じ:
//   - 承認は人間だけ。--by（承認者名）と --yes が無い限り書き込まない（scripts側）。
//   - draft-bank.json に入る項目は、必ず lib/approval-gate.mjs の promoteCandidate を通す。
//   - 事実は verified-facts.json にあるものだけ（verified-fact-guard / fact-fabrication-guard）。
//   - 英語・日本語の両方を持ち、合計500文字以内・生URLなし（bilingual-guard。英語の枠も日本語訳を持つ）。
//   - まとめて承認するときは「全部OKのときだけ書き込む」。1件でも問題があれば何も書かず、
//     問題のidを表示する。人間が --exclude で外すか、候補を直してからやり直す。
//   - 承認後の draft-bank.json 全体が lib/slots.mjs の validateBankSlots を通ること
//     （2026-10-20以降の日付は4枠ちょうど1件ずつ）。1日の途中までの承認はできない。

import { promoteCandidate, ApprovalError } from "./approval-gate.mjs";
import { canUseCandidate } from "./verified-fact-guard.mjs";
import { checkFactFabricationSignals } from "./fact-fabrication-guard.mjs";
import { checkBilingualBody } from "./bilingual-guard.mjs";
import { checkClaims } from "./claim-guard.mjs";
import { checkMedia } from "./media-guard.mjs";
import { buildPostedBodySet, isDuplicateBody, normalizeBody } from "./duplicate-guard.mjs";
import { checkScheduleSimilarity, checkAgainstPosted, isPostedTextDuplicate, postTextOf } from "./similarity-guard.mjs";
import {
  SLOTS_START,
  DAILY_SLOTS,
  DAILY_SLOT_KEYS,
  isSlotItem,
  itemSlotKey,
  slotRankOf,
  addDays,
  weekdayJa,
  cycleWeekStart,
  validateBankSlots,
  slotMediaProblem,
  hasSlotImage
} from "./slots.mjs";

const isDateKey = (v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);

// --date D | --week D（D を含む火〜月の1週間） | --from A --to B（最大31日）
export function datesFor({ date, week, from, to }) {
  const range = (a, b) => {
    const out = [];
    for (let d = a; d <= b; d = addDays(d, 1)) out.push(d);
    return out;
  };
  if (date) {
    if (!isDateKey(date)) throw new Error(`--date の形式が不正です: ${date}`);
    return [date];
  }
  if (week) {
    if (!isDateKey(week)) throw new Error(`--week の形式が不正です: ${week}`);
    const start = cycleWeekStart(week);
    return range(start, addDays(start, 6));
  }
  if (from || to) {
    if (!isDateKey(from) || !isDateKey(to) || from > to) throw new Error(`--from / --to の指定が不正です: ${from} 〜 ${to}`);
    const out = range(from, to);
    if (out.length > 31) throw new Error("一度に扱えるのは31日分までです");
    return out;
  }
  throw new Error("--date か --week（または --from と --to）で対象日を指定してください");
}

// 週次レビューが自動で作る「下書き前のスケルトン」（本文が未執筆）。承認の対象外として扱う。
export function isDraftSkeleton(candidate) {
  const text = `${candidate?.bodyEn ?? ""}\n${candidate?.bodyJa ?? ""}`;
  return candidate?.status === "needs_human_draft" || /DRAFT PLACEHOLDER|下書き未作成/.test(text);
}

function jstKey(iso) {
  const t = Date.parse(iso || "");
  return Number.isFinite(t) ? new Date(t + 9 * 60 * 60 * 1000).toISOString().slice(0, 10) : null;
}

/**
 * 承認の計画を立てる（書き込みはしない）。
 * @returns {{ ok, toApprove, approvedIds, rows, problems, notices }}
 *   ok が true のときだけ toApprove を draft-bank.json に追記し、approvedIds を候補から外してよい。
 *   rows: 対象日の候補（status: approve | excluded | draft | problem）
 */
export function planBulkApproval({ candidates, bankItems, postedPosts = [], facts = [], dates, exclude = [], approvedBy, approvedAt, todayKey, now = new Date() }) {
  const dateSet = new Set(dates);
  const excludeSet = new Set(exclude);
  const bank = Array.isArray(bankItems) ? bankItems : [];
  const bankIds = new Set(bank.map((i) => i.id));
  const bankKeys = new Set(bank.filter(isSlotItem).map((i) => `${i.targetDate}|${itemSlotKey(i)}`));
  const postedBodies = buildPostedBodySet(postedPosts);

  const inRange = (candidates || [])
    .filter((c) => c && dateSet.has(c.targetDate))
    .sort((a, b) => (a.targetDate !== b.targetDate ? (a.targetDate < b.targetDate ? -1 : 1) : slotRankOf(a) - slotRankOf(b)));

  const rows = [];
  const problems = [];
  const notices = [];

  const unknownExcludes = [...excludeSet].filter((id) => !inRange.some((c) => c.id === id));
  if (unknownExcludes.length) problems.push({ id: "(--exclude)", reasons: [`対象日の候補に無いidです: ${unknownExcludes.join(", ")}`] });

  const seenKeys = new Set();
  const seenIds = new Set();
  const chosen = [];

  for (const c of inRange) {
    const row = { id: c.id ?? "(idなし)", candidate: c, status: "approve", reasons: [], warnings: [] };
    rows.push(row);
    if (excludeSet.has(c.id)) {
      row.status = "excluded";
      continue;
    }
    if (isDraftSkeleton(c)) {
      row.status = "draft";
      continue;
    }
    const reasons = row.reasons;
    if (!c.id) reasons.push("id がありません");
    else if (bankIds.has(c.id)) reasons.push(`同じidが承認済み(draft-bank.json)にあります: ${c.id}`);
    else if (seenIds.has(c.id)) reasons.push(`同じidの候補が2件あります: ${c.id}`);
    seenIds.add(c.id);

    const key = itemSlotKey(c);
    if (!key || !DAILY_SLOT_KEYS.includes(key)) {
      reasons.push(`枠(slot)と言語(lang)が不正です: slot=${c.slot ?? "(なし)"} lang=${c.lang ?? "(なし)"}（朝/昼/夜×ja と 夜×en だけ）`);
    }
    if (c.targetDate < SLOTS_START) reasons.push(`1日4本の枠は ${SLOTS_START} 以降だけです`);
    if (todayKey && c.targetDate < todayKey) reasons.push(`過去の日付です（今日は ${todayKey}）`);
    if (key) {
      const k = `${c.targetDate}|${key}`;
      if (bankKeys.has(k)) reasons.push(`${c.targetDate} の ${key} は承認済みの別の投稿で埋まっています`);
      if (seenKeys.has(k)) reasons.push(`${c.targetDate} の ${key} に候補が2件以上あります`);
      seenKeys.add(k);
    }
    const mediaProblem = slotMediaProblem(c, { requireApproved: false });
    if (mediaProblem) reasons.push(mediaProblem);

    // 従来と同じ関所（英日併記・事実・メディア）。
    const bilingual = checkBilingualBody(c);
    if (!bilingual.ok) reasons.push(`併記フォーマットNG（${bilingual.errors.join(", ")}）`);
    const fact = canUseCandidate(c, facts);
    if (!fact.ok) reasons.push(`verified-facts.json との整合NG（${fact.reason}）`);
    if (c.requiresVerifiedFact !== true) {
      for (const w of checkFactFabricationSignals(c).warnings) {
        reasons.push(`裏付けの無い具体的な事実（${w.family}/${w.lang}: "${w.excerpt}"）`);
      }
    }
    for (const e of checkMedia(c).errors) reasons.push(`メディアNG（${e}）`);

    // 重複・似すぎ（投稿される言語の本文で比べる）。
    if (key && (c.lang === "ja" || c.lang === "en")) {
      if (isDuplicateBody(c, postedBodies) || isPostedTextDuplicate(c, c.lang, postedPosts)) reasons.push("投稿済みの本文と同じです");
      const mine = normalizeBody(postTextOf(c, c.lang));
      if (bank.some((i) => isSlotItem(i) && i.lang === c.lang && normalizeBody(postTextOf(i, c.lang)) === mine)) {
        reasons.push("承認済み(draft-bank.json)の本文と同じです");
      }
      const posted = checkAgainstPosted({ id: c.id, lang: c.lang, text: postTextOf(c, c.lang) }, postedPosts, { now });
      for (const p of posted.problems) reasons.push(p.detail);
    }

    for (const w of checkClaims(c)) row.warnings.push(`表現チェック [${w.family}:${w.lang}] "${w.match}"`);

    if (reasons.length === 0) {
      try {
        row.promoted = promoteCandidate(c, { approved: true, approvedBy, approvedAt });
        // 画像は一覧（formatBulkList の 🖼 行）で本文と一緒に見て承認するので、同じ承認で画像も承認済みにする。
        if (hasSlotImage(c)) row.promoted.media = { ...c.media, approvedBy, approvedAt };
      } catch (err) {
        if (!(err instanceof ApprovalError)) throw err;
        reasons.push(err.message);
      }
    }
    if (reasons.length) row.status = "problem";
    else chosen.push(row);
  }

  // 似すぎ: 今回承認するもの＋承認済みの枠付き投稿（前後6日）をまとめて比べ、今回の候補が絡む組だけを問題にする。
  if (dates.length) {
    const minDate = addDays(dates[0], -6);
    const maxDate = addDays(dates[dates.length - 1], 6);
    const mineIds = new Set(chosen.map((r) => r.id));
    const scheduled = [
      ...chosen.map((r) => ({ id: r.id, targetDate: r.candidate.targetDate, lang: r.candidate.lang, text: postTextOf(r.candidate, r.candidate.lang), category: r.candidate.category })),
      ...bank
        .filter((i) => isSlotItem(i) && i.targetDate >= minDate && i.targetDate <= maxDate)
        .map((i) => ({ id: `承認済み:${i.id}`, targetDate: i.targetDate, lang: i.lang, text: postTextOf(i, i.lang), category: i.category }))
    ];
    for (const p of checkScheduleSimilarity(scheduled).problems) {
      for (const id of p.ids.filter((x) => mineIds.has(x))) {
        const row = rows.find((r) => r.id === id);
        row.reasons.push(`${p.detail}（相手: ${p.ids.find((x) => x !== id)}）`);
        row.status = "problem";
      }
    }
  }

  for (const row of rows) if (row.status === "problem") problems.push({ id: row.id, reasons: row.reasons });

  const toApprove = rows.filter((r) => r.status === "approve").map((r) => r.promoted);
  if (problems.length === 0 && toApprove.length === 0) problems.push({ id: "(対象なし)", reasons: ["承認できる候補がありません（下書き前・除外・承認済みのみ）"] });

  // 承認後の draft-bank.json 全体が枠のルールを満たすか（4枠そろい・混在なし・似すぎなし）。
  if (problems.length === 0) {
    const { errors } = validateBankSlots([...bank, ...toApprove]);
    if (errors.length) problems.push({ id: "(承認後のdraft-bank.json)", reasons: errors });
  }

  for (const d of dates) {
    if (d < SLOTS_START) continue;
    const filled = new Set([
      ...bank.filter((i) => i.targetDate === d && isSlotItem(i)).map(itemSlotKey),
      ...rows.filter((r) => r.candidate.targetDate === d && r.status === "approve").map((r) => itemSlotKey(r.candidate))
    ]);
    if (filled.size === 0) notices.push(`${d}（${weekdayJa(d)}）: 承認済みの投稿がありません。この日はThreadsに投稿されません。`);
  }

  const ok = problems.length === 0;
  return { ok, toApprove: ok ? toApprove : [], approvedIds: ok ? toApprove.map((p) => p.id) : [], rows, problems, notices };
}

const STATUS_LABEL = {
  approve: "⏳ 承認する",
  excluded: "⏭ 今回は承認しない（--exclude）",
  draft: "✏️ 下書き前（承認の対象外）",
  problem: "❌ 問題あり（承認できません）"
};

/**
 * 人が読む一覧（日付ごとに 枠・時刻・言語・本文）。英語の枠は日本語訳も並べる。
 */
export function formatBulkList({ dates, rows, bankItems = [] }) {
  const lines = [];
  const bank = Array.isArray(bankItems) ? bankItems : [];
  for (const d of dates) {
    const dayBank = bank.filter((i) => i.targetDate === d);
    const dayRows = rows.filter((r) => r.candidate.targetDate === d);
    if (d < SLOTS_START) {
      lines.push(`==== ${d}（${weekdayJa(d)}）従来の1日1本（日本語05:00・英語21:00）====`);
      for (const i of dayBank) lines.push(`  ✅ 承認済み  id=${i.id}`);
      if (!dayBank.length) lines.push("  （承認済みの投稿なし）");
      lines.push("");
      continue;
    }
    lines.push(`==== ${d}（${weekdayJa(d)}）====`);
    for (const s of DAILY_SLOTS) {
      const head = `  [${s.label} ${s.time}]`;
      const approved = dayBank.filter((i) => itemSlotKey(i) === s.key);
      const cands = dayRows.filter((r) => itemSlotKey(r.candidate) === s.key);
      if (!approved.length && !cands.length) {
        lines.push(`${head} ❌ まだありません`);
        continue;
      }
      for (const i of approved) {
        lines.push(`${head} ✅ 承認済み  id=${i.id}`);
        pushBody(lines, i, s.lang);
      }
      for (const r of cands) {
        lines.push(`${head} ${STATUS_LABEL[r.status]}  id=${r.id}  ${r.candidate.pillar ?? "?"} / ${r.candidate.category ?? "?"}`);
        pushBody(lines, r.candidate, s.lang);
        for (const x of r.reasons) lines.push(`      ✗ ${x}`);
        for (const w of r.warnings) lines.push(`      △ ${w}`);
      }
    }
    // 枠が不正な候補（slot/lang なし等）も見えるようにする。
    for (const r of dayRows.filter((x) => !DAILY_SLOT_KEYS.includes(itemSlotKey(x.candidate)))) {
      if (r.status === "draft") {
        lines.push(`  [テーマ案] ✏️ 下書き前（承認の対象外）  id=${r.id}  ${r.candidate.pillar ?? "?"} / ${r.candidate.suggestedTopic?.labelJa ?? r.candidate.category ?? "?"}`);
        continue;
      }
      lines.push(`  [枠不明 slot=${r.candidate.slot ?? "なし"} lang=${r.candidate.lang ?? "なし"}] ${STATUS_LABEL[r.status]}  id=${r.id}`);
      for (const x of r.reasons) lines.push(`      ✗ ${x}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

function pushBody(lines, item, lang) {
  if (hasSlotImage(item)) lines.push(`      🖼 画像: ${item.media.path ?? "(なし)"}`);
  if (item.replyLink === true && lang === "ja") {
    lines.push(item.replyLinkKind === "plain"
      ? "      ↩️ ふつうの投稿（返信リンクの候補）：伸びたら（約2時間後・約6時間後に表示300以上。夜は約2時間後だけ）自分の返信でお店のリンクを付ける。返信は質問の投稿と合わせて1日1回まで"
      : "      ↩️ 質問の投稿：伸びたら（約2時間後・約6時間後に表示300以上。夜は約2時間後だけ）自分の返信でお店のリンクを付ける。返信はふつうの投稿と合わせて1日1回まで");
  }
  for (const l of postTextOf(item, lang).split("\n")) lines.push(`      │ ${l}`);
  if (lang === "en") {
    lines.push("      （日本語訳）");
    for (const l of String(item.bodyJa ?? "").split("\n")) lines.push(`      │ ${l}`);
  }
}
