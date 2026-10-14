// X（@LostBallempower）の1日3本（2026-10-20〜）の「枠（slot）」の定義と、
// 実行がどの枠のものかを決めるロジック、data/x-queue.json の枠の検査。
// ファイルI/O・ネットワークは一切行わない（テストで時刻・cron文字列を注入して全分岐を確かめる）。
// 設計は Threads の lib/slots.mjs と同じ（枠は「どのcronで起動されたか」= github.event.schedule で決める）。
//
// 枠（すべて日本語・文字のみ）:
//   朝 morning … JST 07:10（cron "10 22 * * *"。UTCでは前日22:10）
//   昼 noon    … JST 12:10（cron "10 3 * * *"）
//   夜 night   … JST 20:10（cron "10 11 * * *"）
//
// 従来の形（slot を持たない item）＝legacy:
//   2026-10-19までの承認済み X 投稿。これまでどおり JST 05:53（cron "53 20 * * *"）に1本だけ出す。
//   05:53 の cron は 2026-10-20 以降は何もしない。

import { SLOTS_START, addDays } from './slots.mjs';

export const X_SLOTS_START = SLOTS_START; // "2026-10-20"

export const X_SLOTS = Object.freeze([
  Object.freeze({ slot: 'morning', time: '07:10', label: '朝' }),
  Object.freeze({ slot: 'noon', time: '12:10', label: '昼' }),
  Object.freeze({ slot: 'night', time: '20:10', label: '夜' }),
]);
export const X_SLOT_NAMES = Object.freeze(X_SLOTS.map((s) => s.slot));
export const X_POSTS_PER_DAY = X_SLOTS.length;

// workflow の実行（cron 1本 = run 1種類）。この cron 文字列は x-post.yml と一字一句同じ（tests で確認）。
export const X_RUNS = Object.freeze([
  Object.freeze({ id: 'legacy', slot: null, time: '05:53', cron: '53 20 * * *', label: '従来の1日1本' }),
  Object.freeze({ id: 'morning', slot: 'morning', time: '07:10', cron: '10 22 * * *', label: '朝' }),
  Object.freeze({ id: 'noon', slot: 'noon', time: '12:10', cron: '10 3 * * *', label: '昼' }),
  Object.freeze({ id: 'night', slot: 'night', time: '20:10', cron: '10 11 * * *', label: '夜' }),
]);
export const X_RUN_IDS = Object.freeze(X_RUNS.map((r) => r.id));

export const isXSlotItem = (item) => item?.slot !== undefined && item?.slot !== null;
export const xRunInfo = (id) => X_RUNS.find((r) => r.id === id) || null;
export const xSlotInfo = (slot) => X_SLOTS.find((s) => s.slot === slot) || null;
export function xSlotRank(item) {
  const i = X_SLOT_NAMES.indexOf(item?.slot);
  return i === -1 ? 9 : i;
}

export function xRunForCron(cron) {
  const normalized = String(cron || '').trim().replace(/\s+/g, ' ');
  return X_RUNS.find((r) => r.cron === normalized)?.id ?? null;
}

/**
 * この実行（run）が、この日（JST）に何をするか。
 *   { kind: 'legacy' }        … slot の無い item を1本（10/19まで）
 *   { kind: 'slot', slot }    … その日・その枠の item を1本（10/20から）
 *   { kind: 'none', reason }  … 何もしない
 */
export function planXRun(runId, dateKey) {
  const run = xRunInfo(runId);
  if (!run) return { kind: 'none', reason: `unknown-run:${runId}` };
  if (dateKey < X_SLOTS_START) return run.slot ? { kind: 'none', reason: 'x-slots-start-on-2026-10-20' } : { kind: 'legacy' };
  return run.slot ? { kind: 'slot', slot: run.slot } : { kind: 'none', reason: 'legacy-run-ended' };
}

export class XRunResolutionError extends Error {}

function jstParts(now) {
  const iso = new Date(now.getTime() + 9 * 3600 * 1000).toISOString();
  return { date: iso.slice(0, 10), time: iso.slice(11, 16) };
}

/**
 * この workflow 実行の run と対象日（JST）を決める（scripts/x-resolve-run.mjs から使う）。
 *   input    : 手動実行で選んだ run（auto / legacy / morning / noon / night）
 *   schedule : github.event.schedule（cron で起動したときだけ値が入る）
 *   date     : 手動実行（dry-run）で確認したい日付
 * cron で起動した実行の対象日は「その枠の時刻が最後に来た日」（遅れて0時を過ぎても前日の分）。
 */
export function resolveXRun({ input = '', schedule = '', date = '', now = new Date() } = {}) {
  const { date: today, time } = jstParts(now);
  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new XRunResolutionError(`日付の形式が不正です: ${date}`);

  const cron = String(schedule || '').trim();
  if (cron) {
    const run = xRunForCron(cron);
    if (!run) throw new XRunResolutionError(`起動したcron "${cron}" に対応する枠がありません（lib/x-slots.mjs と x-post.yml を揃えてください）`);
    const day = time >= xRunInfo(run).time ? today : addDays(today, -1);
    return { run, date: day, source: 'schedule' };
  }

  const explicit = String(input || '').trim();
  if (explicit && explicit !== 'auto') {
    if (!X_RUN_IDS.includes(explicit)) throw new XRunResolutionError(`run の値が不正です: ${explicit}（auto / ${X_RUN_IDS.join(' / ')}）`);
    return { run: explicit, date: date || today, source: 'input' };
  }

  const target = date || today;
  const passed = X_RUNS.filter((r) => planXRun(r.id, target).kind !== 'none' && r.time <= time);
  return { run: passed.at(-1)?.id ?? null, date: target, source: 'auto' };
}

/**
 * data/x-queue.json の枠の検査（エラーは投稿を止める）。
 *   - slot は morning / noon / night のどれか。slot を持つ item は 2026-10-20 以降だけ。
 *   - slot の無い item（従来の形）は 2026-10-19 まで。
 *   - 1つの日付に従来の item と slot 付きの item を混ぜない。
 *   - slot を持つ日付は、3つの枠がちょうど1件ずつ。
 */
export function validateXSlots(queue) {
  const errors = [];
  const byDate = new Map();
  for (const p of queue || []) {
    if (isXSlotItem(p)) {
      if (!X_SLOT_NAMES.includes(p.slot)) errors.push(`${p.id}: slot が不正です: ${p.slot}（morning / noon / night）`);
      if (typeof p.date === 'string' && p.date < X_SLOTS_START) errors.push(`${p.id}: slot を持つ X 投稿は ${X_SLOTS_START} 以降だけです（date=${p.date}）`);
    } else if (typeof p?.date === 'string' && p.date >= X_SLOTS_START) {
      errors.push(`${p.id}: ${X_SLOTS_START} 以降の X 投稿には slot（morning / noon / night）が必要です`);
    }
    if (typeof p?.date === 'string') {
      if (!byDate.has(p.date)) byDate.set(p.date, []);
      byDate.get(p.date).push(p);
    }
  }
  for (const [date, items] of [...byDate.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const slotItems = items.filter(isXSlotItem);
    if (!slotItems.length) continue;
    if (slotItems.length !== items.length) errors.push(`${date}: 従来の1日1本の X 投稿と、枠(slot)付きの X 投稿が混ざっています`);
    for (const s of X_SLOTS) {
      const n = slotItems.filter((p) => p.slot === s.slot).length;
      if (n === 0) errors.push(`${date}: X の${s.label}(${s.time})の投稿がありません（1日3本そろえてください）`);
      if (n > 1) errors.push(`${date}: X の${s.label}(${s.time})の投稿が${n}件あります（1件だけにしてください）`);
    }
  }
  return errors;
}
