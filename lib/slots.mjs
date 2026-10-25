// 1日4本投稿（2026-10-20〜）の「枠（slot）」と「言語（lang）」の定義、
// 実行がどの枠のものかを決めるロジック、draft-bank.json の枠の検査。
// ファイルI/O・ネットワークは一切行わない（テストで時刻・cron文字列を注入して全分岐を確かめる）。
//
// 枠（2026-10-17〜: 日本語の枠のうち1日1本だけ、その日のInstagram画像を付けられる。英語は文字のみ）:
//   朝   morning + ja … JST 07:35（cron "35 22 * * *"。UTCでは前日22:35）
//   昼   noon    + ja … JST 12:35（cron "35 3 * * *"）
//   夜   night   + ja … JST 20:35（cron "35 11 * * *"）
//   英語 night   + en … JST 21:00（cron "0 12 * * *"。今までの英語と同じ時刻）
//
// 1件の投稿（draft-bank.json の item）は slot と lang を必ず両方持つ。英語は「夜の枠の英語版」
// として slot:"night" + lang:"en" で表す（sns-growth-dashboard の data-contract と同じ表し方）。
// 2026-10-20以降の各日付は「日本語の朝・昼・夜を1件ずつ＋英語の夜を1件」のちょうど4件。
//
// 従来の形（slot・lang を持たない item）＝legacy:
//   2026-10-19までの承認済み投稿。これまでどおり、同じ item を JST 05:00 に日本語、
//   JST 21:00 に英語で出す（scripts/select-daily-candidate.mjs の selectDailyCandidate）。
//   05:00 の cron は 2026-10-20 以降は何もしない。21:00 の cron は 10/19 までは従来の英語、
//   10/20 からは「夜・英語」枠として動く。
//
// 実行の枠は「どのcronで起動されたか」（github.event.schedule）で決める。時刻から推測しないので、
// GitHubの混雑で起動が遅れても枠を取り違えない。

import { selectDueItems } from "./target-date.mjs";
import { checkScheduleSimilarity, postTextOf } from "./similarity-guard.mjs";
import { isMediaApproved, CHARACTER_HETARO, hetaroImageUrl, checkHetaroCharacterPost } from "./media-guard.mjs";

export const SLOTS_START = "2026-10-20";
export const SLOTS = Object.freeze(["morning", "noon", "night"]);
export const LANGS = Object.freeze(["ja", "en"]);

// 1日の4本（この順番で並べて表示する）。key = "slot:lang"。
export const DAILY_SLOTS = Object.freeze([
  Object.freeze({ key: "morning:ja", slot: "morning", lang: "ja", time: "07:35", label: "朝・日本語" }),
  Object.freeze({ key: "noon:ja", slot: "noon", lang: "ja", time: "12:35", label: "昼・日本語" }),
  Object.freeze({ key: "night:ja", slot: "night", lang: "ja", time: "20:35", label: "夜・日本語" }),
  Object.freeze({ key: "night:en", slot: "night", lang: "en", time: "21:00", label: "夜・英語" })
]);
export const DAILY_SLOT_KEYS = Object.freeze(DAILY_SLOTS.map((s) => s.key));

// workflow の実行（cron 1本 = run 1種類）。
//   legacy_ja: 05:00。10/19までの従来の日本語。10/20以降は何もしない。
//   night_en : 21:00。10/19までは従来の英語（slotなしのitem）、10/20からは夜・英語の枠。
export const RUNS = Object.freeze([
  Object.freeze({ id: "legacy_ja", slot: null, lang: "ja", legacyLang: "ja", time: "05:00", cron: "0 20 * * *", label: "従来の1日1本・日本語" }),
  Object.freeze({ id: "morning", slot: "morning", lang: "ja", legacyLang: null, time: "07:35", cron: "35 22 * * *", label: "朝・日本語" }),
  Object.freeze({ id: "noon", slot: "noon", lang: "ja", legacyLang: null, time: "12:35", cron: "35 3 * * *", label: "昼・日本語" }),
  Object.freeze({ id: "night", slot: "night", lang: "ja", legacyLang: null, time: "20:35", cron: "35 11 * * *", label: "夜・日本語" }),
  Object.freeze({ id: "night_en", slot: "night", lang: "en", legacyLang: "en", time: "21:00", cron: "0 12 * * *", label: "夜・英語" })
]);
export const RUN_IDS = Object.freeze(RUNS.map((r) => r.id));

export const slotKey = (slot, lang) => `${slot}:${lang}`;
export const isSlot = (value) => SLOTS.includes(value);
export const isLang = (value) => LANGS.includes(value);
export const isSlotItem = (item) => item?.slot !== undefined && item?.slot !== null;

// 画像（2026-10-17 オーナー決定）: Instagram用に作った画像（assets/instagram/）だけを使い回す。
// 新しい画像は作らない。日本語の枠だけ・1日1本まで（1日1本の上限は validateBankSlots で見る）。
// 例外: ヘタ郎の画像（hetaro-media/ig/、type CHARACTER_HETARO）は本文に「見習いアンバサダー」があれば使える。
export const SLOT_IMAGE_DIR = "assets/instagram/";
export const hasSlotImage = (item) => (item?.media?.type ?? "TEXT_ONLY") !== "TEXT_ONLY";

// 枠付き投稿の画像の問題を1つ返す（無ければ null）。requireApproved:false は承認前の候補用。
export function slotMediaProblem(item, { requireApproved = true } = {}) {
  if (!hasSlotImage(item)) return null;
  const media = item.media;
  if (item.lang !== "ja") return `英語の投稿は文字のみです（media.type=${media.type}）`;
  if (media.type === CHARACTER_HETARO) {
    // ヘタ郎の画像（2026-10-18 オーナーOK）: hetaro-media の画像だけ・本文に「見習いアンバサダー」必須。
    const hetaro = checkHetaroCharacterPost({ images: [media.path], caption: item.bodyJa });
    if (!hetaro.ok) return `ヘタ郎の画像のルールNG（${hetaro.errors.join(", ")}）`;
    if (requireApproved && !isMediaApproved(media)) return "画像が承認されていません（media.approvedBy/approvedAt）";
    return null;
  }
  if (typeof media.path !== "string" || !media.path.startsWith(SLOT_IMAGE_DIR) || media.path.includes("..")) {
    return `Threadsの画像は ${SLOT_IMAGE_DIR} のInstagram画像だけです（path=${media.path ?? "(なし)"}）`;
  }
  if (requireApproved && !isMediaApproved(media)) return "画像が承認されていません（media.approvedBy/approvedAt）";
  return null;
}

export function runInfo(id) {
  return RUNS.find((r) => r.id === id) || null;
}

export function dailySlotInfo(key) {
  return DAILY_SLOTS.find((s) => s.key === key) || null;
}

export function itemSlotKey(item) {
  return isSlotItem(item) ? slotKey(item.slot, item.lang) : null;
}

export function slotRankOf(item) {
  const i = DAILY_SLOT_KEYS.indexOf(itemSlotKey(item));
  return i === -1 ? 9 : i;
}

export function runForCron(cron) {
  const normalized = String(cron || "").trim().replace(/\s+/g, " ");
  return RUNS.find((r) => r.cron === normalized)?.id ?? null;
}

/**
 * この実行（run）が、この日（JST）に何をするか。
 *   { kind: "legacy", lang }      … 従来どおり slot の無い item を選ぶ（10/19まで）
 *   { kind: "slot", slot, lang }  … その日・その枠の item を1件だけ選ぶ（10/20から）
 *   { kind: "none", reason }      … 何もしない（投稿しない）
 */
export function planRun(runId, dateKey) {
  const run = runInfo(runId);
  if (!run) return { kind: "none", reason: `unknown-run:${runId}` };
  if (dateKey < SLOTS_START) {
    return run.legacyLang ? { kind: "legacy", lang: run.legacyLang } : { kind: "none", reason: "slots-start-on-2026-10-20" };
  }
  return run.slot ? { kind: "slot", slot: run.slot, lang: run.lang } : { kind: "none", reason: "legacy-run-ended" };
}

function jstParts(now) {
  const iso = new Date(now.getTime() + 9 * 60 * 60 * 1000).toISOString();
  return { date: iso.slice(0, 10), time: iso.slice(11, 16) };
}

export function addDays(dateKey, days) {
  const d = new Date(`${dateKey}T00:00:00.000Z`);
  return new Date(d.getTime() + days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

const WEEKDAY_JA = ["日", "月", "火", "水", "木", "金", "土"];
export function weekdayJa(dateKey) {
  return WEEKDAY_JA[new Date(`${dateKey}T00:00:00.000Z`).getUTCDay()];
}

// 投稿の週（火曜〜月曜）。週次レビュー（土曜）で翌週の火〜月を作る運用に合わせる。
export function cycleWeekStart(dateKey) {
  const day = new Date(`${dateKey}T00:00:00.000Z`).getUTCDay();
  return addDays(dateKey, -((day + 5) % 7));
}

export class RunResolutionError extends Error {}

/**
 * この workflow 実行の run と対象日（JST）を決める。
 *   input    : 手動実行で選んだ run（auto / legacy_ja / morning / noon / night / night_en）
 *   schedule : github.event.schedule（cron で起動したときだけ値が入る）
 *   date     : 手動の dry-run で確認したい日付（任意。live では workflow 側で空にする）
 * 戻り値: { run, date, source }。run が null のときは「どの枠でもない」（投稿しない）。
 *
 * cron で起動した実行の対象日は「その枠の時刻が最後に来た日」。21:00 の実行が混雑で
 * 0時を過ぎてから始まっても、前の日の夜の投稿を出す（翌日の分を出さない）。
 */
export function resolveRun({ input = "", schedule = "", date = "", now = new Date() } = {}) {
  const { date: today, time } = jstParts(now);
  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new RunResolutionError(`日付の形式が不正です: ${date}`);

  const explicit = String(input || "").trim();
  if (explicit && explicit !== "auto") {
    if (!RUN_IDS.includes(explicit)) {
      throw new RunResolutionError(`run の値が不正です: ${explicit}（auto / ${RUN_IDS.join(" / ")}）`);
    }
    return { run: explicit, date: date || today, source: "input" };
  }

  const cron = String(schedule || "").trim();
  if (cron) {
    const run = runForCron(cron);
    if (!run) throw new RunResolutionError(`起動したcron "${cron}" に対応する枠がありません（lib/slots.mjs と daily-live-post.yml を揃えてください）`);
    const day = time >= runInfo(run).time ? today : addDays(today, -1);
    return { run, date: day, source: "schedule" };
  }

  // auto（手動実行）: 対象日に動く run のうち、今の時刻（JST）までに時刻が来た最後のもの。
  const target = date || today;
  const passed = RUNS.filter((r) => planRun(r.id, target).kind !== "none" && r.time <= time);
  return { run: passed.at(-1)?.id ?? null, date: target, source: "auto" };
}

/**
 * draft-bank.json の枠の検査（errors は投稿を止める、warnings は確認材料）。
 *   - slot を持つ item は lang も必須。組み合わせは 朝/昼/夜×日本語 と 夜×英語 の4種類だけ。
 *   - slot を持つ item は 2026-10-20 以降の日付だけ。slot の無い item は 2026-10-19 まで。
 *   - 1つの日付に「slotの無いitem」と「slotを持つitem」を混ぜない。
 *   - slot を持つ日付は、4つの枠がちょうど1件ずつ（足りない・2件以上はエラー）。
 *   - 画像は日本語の枠だけ・1日1本まで・assets/instagram/ の承認済み画像だけ（slotMediaProblem）。
 *   - 同じ日・同じ週の似すぎ（lib/similarity-guard.mjs）。
 */
export function validateBankSlots(items) {
  const errors = [];
  const warnings = [];
  const list = Array.isArray(items) ? items : [];
  const byDate = new Map();

  for (const item of list) {
    const label = `draft-bank.json[${item?.id ?? "?"}]`;
    if (isSlotItem(item)) {
      if (!isSlot(item.slot)) errors.push(`${label}: slot が不正です: ${item.slot}（morning / noon / night）`);
      if (!isLang(item.lang)) errors.push(`${label}: lang が必要です（ja / en）: ${item.lang ?? "(なし)"}`);
      else if (isSlot(item.slot) && !DAILY_SLOT_KEYS.includes(itemSlotKey(item))) {
        errors.push(`${label}: 英語は夜の枠だけです（slot=${item.slot} lang=${item.lang}）`);
      }
      if (typeof item.targetDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(item.targetDate)) {
        errors.push(`${label}: slot を持つ投稿には targetDate が必要です`);
        continue;
      }
      if (item.targetDate < SLOTS_START) errors.push(`${label}: slot を持つ投稿は ${SLOTS_START} 以降だけです（targetDate=${item.targetDate}）`);
      const mediaProblem = slotMediaProblem(item);
      if (mediaProblem) errors.push(`${label}: ${mediaProblem}`);
    } else {
      if (item?.lang !== undefined && item?.lang !== null) errors.push(`${label}: lang は slot と一緒に指定してください`);
      if (typeof item?.targetDate === "string" && item.targetDate >= SLOTS_START) {
        errors.push(`${label}: ${SLOTS_START} 以降の投稿には slot と lang が必要です（従来の1日1本は ${SLOTS_START} の前日まで）`);
      }
    }
    if (typeof item?.targetDate === "string") {
      if (!byDate.has(item.targetDate)) byDate.set(item.targetDate, []);
      byDate.get(item.targetDate).push(item);
    }
  }

  for (const [date, dayItems] of [...byDate.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const slotItems = dayItems.filter(isSlotItem);
    if (slotItems.length === 0) continue;
    if (slotItems.length !== dayItems.length) {
      errors.push(`${date}: 従来の1日1本の投稿と、枠(slot)付きの投稿が混ざっています`);
    }
    for (const s of DAILY_SLOTS) {
      const n = slotItems.filter((i) => itemSlotKey(i) === s.key).length;
      if (n === 0) errors.push(`${date}: ${s.label}(${s.time})の投稿がありません（1日4本そろえてください）`);
      if (n > 1) errors.push(`${date}: ${s.label}(${s.time})の投稿が${n}件あります（1件だけにしてください）`);
    }
    const withImage = slotItems.filter(hasSlotImage).length;
    if (withImage > 1) errors.push(`${date}: 画像付きの投稿が${withImage}件あります（画像は1日1本まで）`);
  }

  errors.push(...replyLinkErrors(list));

  const scheduled = list
    .filter((i) => isSlotItem(i) && isLang(i.lang) && typeof i.targetDate === "string")
    .map((i) => ({ id: i.id, targetDate: i.targetDate, lang: i.lang, text: postTextOf(i, i.lang), category: i.category }));
  for (const p of checkScheduleSimilarity(scheduled).problems) {
    errors.push(`${p.ids.join(" と ")}: ${p.detail}`);
  }

  return { errors, warnings };
}

// "replyLink": true = 質問の投稿の印（2026-10-25 代表者決定。lib/reply-link.mjs）。
// 本文にはリンクを入れない。伸びたら（約2時間後・約6時間後に表示300以上）自分の返信でお店のリンクを1回だけ付ける。
// 付けられるのは日本語の朝・昼・夜の枠だけ（英語は対象外）・1日1本まで。
const LINK_IN_TEXT_RE = /https?:\/\/|\b[\w-]+\.(?:base\.shop|com|jp|net|org|app|io|me|shop)\b/i;
export function replyLinkErrors(items) {
  const errors = [];
  const perDate = new Map();
  for (const item of Array.isArray(items) ? items : []) {
    if (item?.replyLink === undefined || item?.replyLink === null) continue;
    const label = `draft-bank.json[${item?.id ?? "?"}]`;
    if (typeof item.replyLink !== "boolean") {
      errors.push(`${label}: replyLink は true か false です`);
      continue;
    }
    if (!item.replyLink) continue;
    if (!isSlotItem(item) || !isSlot(item.slot) || item.lang !== "ja") {
      errors.push(`${label}: replyLink（返信でリンク）は日本語の朝・昼・夜の枠の投稿だけです（slot=${item.slot ?? "なし"} lang=${item.lang ?? "なし"}）`);
    }
    if (LINK_IN_TEXT_RE.test(String(item.bodyJa ?? ""))) {
      errors.push(`${label}: replyLink の投稿の本文にリンクは入れません（リンクは返信のほうに付けます）`);
    }
    const day = item.targetDate ?? "(日付なし)";
    perDate.set(day, [...(perDate.get(day) ?? []), item.id]);
  }
  for (const [date, ids] of perDate) {
    if (ids.length > 1) errors.push(`${date}: replyLink の投稿が${ids.length}件あります（${ids.join(", ")}）。1日1本までです`);
  }
  return errors;
}

// 選出順の都合で、slot の無い（従来の）item だけを targetDate 順に返す。
export function legacyDueItems(items, todayKey) {
  return selectDueItems((items || []).filter((i) => !isSlotItem(i)), todayKey);
}
