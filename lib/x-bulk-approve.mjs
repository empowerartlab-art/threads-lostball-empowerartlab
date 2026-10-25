// X の1日3本（2026-10-20〜）を、日付ごと・1週間ぶんまとめて人間が承認するためのロジック。
// ファイルI/O・ネットワークは一切しない（scripts/x-bulk-approve.mjs が読み書きを担当する）。
// 設計は Threads の lib/bulk-approve.mjs と同じ:
//   - 承認は人間だけ。--by（承認者名）と --yes が無い限り書き込まない（scripts側）。
//   - 全部OKのときだけ書き込む。1件でも問題があれば何も書かず、問題のidと理由を表示する。
//     人間が --exclude で外すか、投稿を直してからやり直す。
//   - 1日の途中まで（例：夜だけ無い）では承認できない。その日の3件をそろえるか、3件とも外す。
//   - 承認後の x-queue.json 全体が validateXQueue を通ること（枠・長さ・Threadsの写し・リンク・ショップ週1回）。
//   - 事実は verified-facts.json にあるものだけ。URL 入りは料金が約13倍なので大きく警告する。
// X の投稿データは data/x-queue.json の中で approved:false → true に変えるだけ（別ファイルへは移さない）。

import { checkClaims } from './claim-guard.mjs';
import { checkProjectName } from './project-name-guard.mjs';
import { checkFactFabricationSignals } from './fact-fabrication-guard.mjs';
import { checkAgainstPosted } from './similarity-guard.mjs';
import { xWeight, hasLink, X_MAX_WEIGHT } from './x-api.mjs';
import { validateXQueue, nearCopyOf, isShopPost, imageFieldsOf, xImageProblem, hasXImage, X_COST_LINK_USD, X_COST_PLAIN_USD } from './x-flow.mjs';
import { X_SLOTS, X_SLOT_NAMES, X_SLOTS_START, X_POSTS_PER_DAY, isXSlotItem, xSlotRank } from './x-slots.mjs';
import { weekdayJa } from './slots.mjs';

const squash = (t) => String(t ?? '').replace(/\s+/g, '').toLowerCase();
const round2 = (x) => Math.round(x * 100) / 100;

// X の投稿記録（x-posts.json）を similarity-guard が読める形にする。
const postedForSimilarity = (posted) => (posted || []).map((p) => ({ sourceItemId: p.id, lang: 'ja', bodyJa: p.text, postedAt: p.publishedAt }));

/**
 * 承認の計画を立てる（書き込みはしない）。
 *   queue        : data/x-queue.json
 *   posted       : data/x-posts.json
 *   threadsItems : Threads の投稿（draft-bank.json の items と draft-bank-candidates.json の items）
 *   threadsTexts : Threads のすべての文（日本語・英語。承認済み・候補・投稿済み）
 *   facts        : data/verified-facts.json の facts
 * @returns {{ ok, approveIds, rows, problems, notices }}
 */
export function planXBulkApproval({ queue, posted = [], threadsItems = [], threadsTexts = [], facts = [], dates, exclude = [], approvedBy, approvedAt, todayKey, now = new Date() }) {
  const list = Array.isArray(queue) ? queue : [];
  const dateSet = new Set(dates);
  const excludeSet = new Set(exclude);
  const factMap = new Map((facts || []).map((f) => [f.id, f]));
  const threadsById = new Map((threadsItems || []).filter((i) => i?.id).map((i) => [i.id, i]));
  const postedTexts = new Set((posted || []).map((p) => squash(p.text)));

  const inRange = list
    .filter((p) => p && dateSet.has(p.date))
    .sort((a, b) => (a.date !== b.date ? (a.date < b.date ? -1 : 1) : xSlotRank(a) - xSlotRank(b)));

  const rows = [];
  const problems = [];
  const notices = [];

  const unknownExcludes = [...excludeSet].filter((id) => !inRange.some((p) => p.id === id));
  if (unknownExcludes.length) problems.push({ id: '(--exclude)', reasons: [`対象日の X 投稿に無いidです: ${unknownExcludes.join(', ')}`] });

  for (const p of inRange) {
    const row = { id: p.id ?? '(idなし)', post: p, status: 'approve', reasons: [], warnings: [] };
    rows.push(row);
    if (p.approved === true) {
      row.status = 'approved';
      continue;
    }
    if (excludeSet.has(p.id)) {
      row.status = 'excluded';
      continue;
    }
    const reasons = row.reasons;
    if (!p.id) reasons.push('id がありません');
    if (!isXSlotItem(p)) reasons.push(`枠(slot)がありません（${X_SLOTS_START} 以降は morning / noon / night のどれか。従来の形は scripts/x-approve.mjs で1件ずつ）`);
    else if (!X_SLOT_NAMES.includes(p.slot)) reasons.push(`枠(slot)が不正です: ${p.slot}`);
    if (p.date < X_SLOTS_START && isXSlotItem(p)) reasons.push(`1日3本の枠は ${X_SLOTS_START} 以降だけです`);
    if (todayKey && p.date < todayKey) reasons.push(`過去の日付です（今日は ${todayKey}）`);

    const text = typeof p.text === 'string' ? p.text : '';
    if (!text.trim()) reasons.push('本文が空です');
    else {
      const w = xWeight(text);
      if (w > X_MAX_WEIGHT) reasons.push(`長すぎます（${w}/${X_MAX_WEIGHT}。日本語は1文字2と数えるので約140字まで）`);
      if (hasLink(text)) {
        if (p.allowLink !== true) reasons.push(`URL が入っていますが allowLink: true がありません（URL入りは1本 $${X_COST_LINK_USD}。URLなし $${X_COST_PLAIN_USD} の約13倍）`);
        else row.warnings.push(`⚠️⚠️ URL入り: 1本 $${X_COST_LINK_USD}（URLなしは $${X_COST_PLAIN_USD}。約13倍）。本当に必要か確認してください`);
      }
      if (isShopPost(p)) row.warnings.push('ショップ誘導あり（週1回まで）');

      // Threads の丸写し・ほぼ写しは不可（X 用に書き直す）。
      if (threadsTexts.some((t) => squash(t) === squash(text))) reasons.push('Threads の投稿と同じ文です（X 用に書き直してください）');
      else {
        const near = nearCopyOf(text, threadsTexts);
        if (near) reasons.push(`Threads の投稿とほぼ同じです（類似度${round2(near.sim)}・含まれる割合${round2(near.contained)}）。X 用に書き直してください`);
      }
      // X の投稿済みと同じ・似すぎ（直近60日）。
      if (postedTexts.has(squash(text))) reasons.push('X に投稿済みの文と同じです');
      for (const pr of checkAgainstPosted({ id: p.id, lang: 'ja', text }, postedForSimilarity(posted), { now }).problems) reasons.push(`X の${pr.detail}`);
    }
    for (const k of imageFieldsOf(p)) reasons.push(`画像（${k}）は未対応です。画像は image に Instagram の画像（assets/instagram/）を1枚だけ`);
    const imageProblem = xImageProblem(p);
    if (imageProblem) reasons.push(imageProblem);

    // 事実は verified-facts.json の verified:true だけ。
    const ids = Array.isArray(p.verifiedFactIds) ? p.verifiedFactIds : [];
    if (p.verifiedFactIds !== undefined && !Array.isArray(p.verifiedFactIds)) reasons.push('verifiedFactIds はリストで書いてください');
    for (const id of ids) if (factMap.get(id)?.verified !== true) reasons.push(`verified-facts.json に無い（未確認の）事実です: ${id}`);
    if (p.requiresVerifiedFact === true && ids.length === 0) reasons.push('requiresVerifiedFact: true なのに verifiedFactIds がありません');
    if (p.requiresVerifiedFact !== true) {
      for (const w of checkFactFabricationSignals({ bodyJa: text }).warnings) reasons.push(`裏付けの無い具体的な事実（${w.family}: "${w.excerpt}"）。verified-facts.json の事実なら requiresVerifiedFact: true と verifiedFactIds を付けてください`);
    }
    for (const e of checkProjectName({ text })) reasons.push(`プロジェクト名（${e}）`);
    for (const w of checkClaims({ bodyJa: text })) row.warnings.push(`表現チェック [${w.family}] "${w.match}"`);

    // 元にした Threads（同じ日・同じ枠の日本語）があるか。無くても止めない（確認材料）。
    const src = p.threadsItemId ? threadsById.get(p.threadsItemId) : null;
    if (!p.threadsItemId) row.warnings.push('threadsItemId がありません（同じ日・同じ枠の日本語 Threads から作るのが基本）');
    else if (!src) row.warnings.push(`元の Threads 投稿が見つかりません: ${p.threadsItemId}`);
    else if (src.targetDate !== p.date || (src.slot && src.slot !== p.slot) || (src.lang && src.lang !== 'ja')) {
      row.warnings.push(`元の Threads（${src.targetDate} ${src.slot ?? '-'}/${src.lang ?? '-'}）が、この X（${p.date} ${p.slot}）と同じ日・同じ枠の日本語ではありません`);
    }

    if (reasons.length) row.status = 'problem';
  }

  for (const row of rows) if (row.status === 'problem') problems.push({ id: row.id, reasons: row.reasons });

  const approveIds = rows.filter((r) => r.status === 'approve').map((r) => r.id);
  if (problems.length === 0 && approveIds.length === 0) problems.push({ id: '(対象なし)', reasons: ['承認できる X 投稿がありません（承認済み・除外のみ）'] });

  // 承認後の姿で、1日3本そろっているか（途中までの承認は不可）と、x-queue.json 全体の検査。
  if (problems.length === 0) {
    const approveSet = new Set(approveIds);
    const after = list.map((p) => (approveSet.has(p.id) ? { ...p, approved: true, approvedBy, approvedAt } : p));
    for (const d of dates) {
      if (d < X_SLOTS_START) continue;
      const n = after.filter((p) => p.date === d && isXSlotItem(p) && p.approved === true).length;
      if (n !== 0 && n !== X_POSTS_PER_DAY) {
        problems.push({ id: `(${d})`, reasons: [`承認済みが${n}本になります。1日の途中までは承認できません（3本そろえるか、3本とも外す）`] });
      }
    }
    const errors = validateXQueue(after, { threadsTexts, facts });
    if (errors.length) problems.push({ id: '(承認後のx-queue.json)', reasons: errors });
  }

  for (const d of dates) {
    if (d < X_SLOTS_START) continue;
    const approvedNow = list.some((p) => p.date === d && p.approved === true);
    const approving = rows.some((r) => r.post.date === d && r.status === 'approve');
    if (!approvedNow && !approving) notices.push(`${d}（${weekdayJa(d)}）: 承認済みの X 投稿がありません。この日は X に投稿されません。`);
  }

  const ok = problems.length === 0;
  return { ok, approveIds: ok ? approveIds : [], rows, problems, notices };
}

const STATUS_LABEL = {
  approved: '✅ 承認済み',
  approve: '⏳ 承認する',
  excluded: '⏭ 今回は承認しない（--exclude）',
  problem: '❌ 問題あり（承認できません）',
};

/** 人が読む一覧（日付ごとに 枠・時刻・本文・画像・文字数・元の Threads）。 */
export function formatXBulkList({ dates, rows }) {
  const lines = [];
  for (const d of dates) {
    const dayRows = rows.filter((r) => r.post.date === d);
    if (d < X_SLOTS_START) {
      lines.push(`==== ${d}（${weekdayJa(d)}）X 従来の1日1本（05:53）====`);
      for (const r of dayRows) {
        lines.push(`  [05:53] ${STATUS_LABEL[r.status]}  id=${r.id}`);
        pushDetail(lines, r);
      }
      if (!dayRows.length) lines.push('  （X 投稿なし）');
      lines.push('');
      continue;
    }
    lines.push(`==== ${d}（${weekdayJa(d)}）X ====`);
    for (const s of X_SLOTS) {
      const head = `  [${s.label} ${s.time}]`;
      const slotRows = dayRows.filter((r) => r.post.slot === s.slot);
      if (!slotRows.length) {
        lines.push(`${head} ❌ まだありません`);
        continue;
      }
      for (const r of slotRows) {
        lines.push(`${head} ${STATUS_LABEL[r.status]}  id=${r.id}  ${r.post.pillar ?? '?'}`);
        pushDetail(lines, r);
      }
    }
    for (const r of dayRows.filter((x) => !X_SLOT_NAMES.includes(x.post.slot))) {
      lines.push(`  [枠不明 slot=${r.post.slot ?? 'なし'}] ${STATUS_LABEL[r.status]}  id=${r.id}`);
      pushDetail(lines, r);
    }
    lines.push('');
  }
  return lines.join('\n');
}

function pushDetail(lines, r) {
  const p = r.post;
  const text = typeof p.text === 'string' ? p.text : '';
  for (const l of text.split('\n')) lines.push(`      │ ${l}`);
  const img = hasXImage(p) ? `🖼 画像: ${p.image}` : imageFieldsOf(p).length ? '画像あり（未対応）' : '画像なし（文字のみ）';
  lines.push(`      ${img}・${xWeight(text)}/${X_MAX_WEIGHT}${hasLink(text) ? ` ・⚠️ URL入り（$${X_COST_LINK_USD}/本）` : ''}・元の Threads: ${p.threadsItemId ?? '（未記入）'}`);
  for (const x of r.reasons) lines.push(`      ✗ ${x}`);
  for (const w of r.warnings) lines.push(`      △ ${w}`);
}
