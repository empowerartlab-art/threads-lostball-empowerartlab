// 1日4本（2026-10-20〜）の枠: 定義・実行の枠の決め方・draft-bank.json の検査・選出と記録・従来との互換。
// ネットワークは一切使わない（publish はスタブ、または二重ゲートが揃わない dry-run のみ）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  RUNS,
  SLOTS_START,
  DAILY_SLOTS,
  planRun,
  resolveRun,
  runForCron,
  validateBankSlots,
  cycleWeekStart,
  RunResolutionError
} from "../lib/slots.mjs";
import { runLivePost, OUTCOME } from "../lib/live-post-runner.mjs";
import { buildPostRecord } from "../lib/threads-publish.mjs";
import { selectDailyCandidate } from "../scripts/select-daily-candidate.mjs";
import { promoteCandidate } from "../lib/approval-gate.mjs";

const TEXT_ONLY = { type: "TEXT_ONLY", required: false, aiVisualAllowed: false, path: null };

// 互いに似ていない本文（同じ日に並べても似すぎガードに掛からない）。
const JA = {
  morning: "おはようございます。\n林の中で見つかったボールが、もう一度コースへ戻っていきます。",
  noon: "昼休みの話題をひとつ。\n手で磨く作業は、一球ずつ表面の汚れを落としていく地道な仕事です。",
  night: "今日も一日おつかれさまでした。\n次のラウンドでは、どんな一打を打ちたいですか。"
};
const EN = {
  morning: "Good morning. Balls found in the woods head back to the course.",
  noon: "A lunch-break note: polishing by hand, one ball at a time.",
  night: "Thanks for today. What shot do you want to hit next round?"
};

function slotItem(date, slot, lang, extra = {}) {
  const base = lang === "en" ? "night" : slot;
  return {
    id: `lb-${date}-${slot}-${lang}`,
    pillar: "GOLF",
    category: `CAT_${slot.toUpperCase()}_${lang.toUpperCase()}`,
    bodyJa: lang === "en" ? `（英語の日本語訳）${JA.night}` : JA[base],
    bodyEn: lang === "en" ? EN.night : EN[base],
    hasCta: false,
    hasShopLink: false,
    requiresVerifiedFact: false,
    verifiedFactIds: [],
    media: { ...TEXT_ONLY },
    targetDate: date,
    slot,
    lang,
    approvedBy: "tester",
    approvedAt: "2026-10-17T00:00:00.000Z",
    ...extra
  };
}

function fullDay(date) {
  return DAILY_SLOTS.map((s) => slotItem(date, s.slot, s.lang));
}

function legacyItem(id, date) {
  return {
    id,
    pillar: "GOLF",
    category: "LEGACY",
    bodyEn: `Legacy English ${id}`,
    bodyJa: `従来の日本語 ${id}`,
    requiresVerifiedFact: false,
    verifiedFactIds: [],
    media: { ...TEXT_ONLY },
    targetDate: date
  };
}

// ---- 定義 ----

test("RUNS: cron は JST の時刻を UTC に直したもので、4本の枠は 7:35/12:35/20:35(日本語)と21:00(英語)", () => {
  for (const r of RUNS) {
    const [min, hour] = r.cron.split(" ").map(Number);
    const jst = new Date(Date.UTC(2026, 0, 1, hour, min) + 9 * 3600 * 1000).toISOString().slice(11, 16);
    assert.equal(jst, r.time, r.id);
  }
  assert.deepEqual(
    DAILY_SLOTS.map((s) => `${s.slot}/${s.lang}/${s.time}`),
    ["morning/ja/07:35", "noon/ja/12:35", "night/ja/20:35", "night/en/21:00"]
  );
  assert.equal(runForCron("0 12 * * *"), "night_en");
  assert.equal(runForCron("0 20 * * *"), "legacy_ja");
  assert.equal(runForCron("1 2 * * *"), null);
  assert.equal(SLOTS_START, "2026-10-20");
});

test("planRun: 10/19までは従来の05:00日本語・21:00英語だけ、10/20からは4つの枠だけ", () => {
  assert.deepEqual(planRun("legacy_ja", "2026-10-19"), { kind: "legacy", lang: "ja" });
  assert.deepEqual(planRun("night_en", "2026-10-19"), { kind: "legacy", lang: "en" });
  for (const id of ["morning", "noon", "night"]) assert.equal(planRun(id, "2026-10-19").kind, "none");
  assert.equal(planRun("legacy_ja", "2026-10-20").kind, "none");
  assert.deepEqual(planRun("morning", "2026-10-20"), { kind: "slot", slot: "morning", lang: "ja" });
  assert.deepEqual(planRun("noon", "2026-10-20"), { kind: "slot", slot: "noon", lang: "ja" });
  assert.deepEqual(planRun("night", "2026-10-20"), { kind: "slot", slot: "night", lang: "ja" });
  assert.deepEqual(planRun("night_en", "2026-10-20"), { kind: "slot", slot: "night", lang: "en" });
  assert.equal(planRun("bogus", "2026-10-20").kind, "none");
});

test("resolveRun: schedule は cron で枠が決まり、遅れて0時を過ぎても前日の分を出す", () => {
  // 10/20 07:40 JST に朝のcronが動いた
  assert.deepEqual(resolveRun({ schedule: "35 22 * * *", now: new Date("2026-10-19T22:40:00Z") }), { run: "morning", date: "2026-10-20", source: "schedule" });
  // 21:00 の英語が混雑で 10/21 00:10 JST に始まった → 10/20 の夜の分
  assert.equal(resolveRun({ schedule: "0 12 * * *", now: new Date("2026-10-20T15:10:00Z") }).date, "2026-10-20");
  // 昼のcronが少し遅れて 12:50 に始まっても昼のまま（時刻から推測しない）
  assert.equal(resolveRun({ schedule: "35 3 * * *", now: new Date("2026-10-20T03:50:00Z") }).run, "noon");
  assert.throws(() => resolveRun({ schedule: "5 5 * * *" }), RunResolutionError);
});

test("resolveRun: 手動実行は入力の枠、auto は今の時刻までに来た最後の枠", () => {
  assert.deepEqual(resolveRun({ input: "noon", date: "2026-10-22", now: new Date("2026-10-14T00:00:00Z") }), { run: "noon", date: "2026-10-22", source: "input" });
  assert.equal(resolveRun({ input: "auto", now: new Date("2026-10-20T04:00:00Z") }).run, "noon"); // 13:00 JST
  assert.equal(resolveRun({ input: "auto", now: new Date("2026-10-20T12:30:00Z") }).run, "night_en"); // 21:30 JST
  assert.equal(resolveRun({ input: "auto", now: new Date("2026-10-19T19:00:00Z") }).run, null); // 10/20 04:00 JST
  assert.equal(resolveRun({ input: "auto", now: new Date("2026-10-18T21:30:00Z") }).run, "legacy_ja"); // 10/19 06:30 JST
  assert.throws(() => resolveRun({ input: "lunch" }), RunResolutionError);
  assert.throws(() => resolveRun({ input: "noon", date: "10/20" }), RunResolutionError);
});

test("cycleWeekStart: 投稿の週は火曜はじまり", () => {
  assert.equal(cycleWeekStart("2026-10-20"), "2026-10-20");
  assert.equal(cycleWeekStart("2026-10-26"), "2026-10-20");
  assert.equal(cycleWeekStart("2026-10-27"), "2026-10-27");
});

// ---- draft-bank.json の検査 ----

test("validateBankSlots: 4枠そろった日はOK、今のdraft-bank.jsonもOK", () => {
  assert.deepEqual(validateBankSlots([...fullDay("2026-10-20"), legacyItem("old", "2026-10-19")]).errors, []);
  const bank = JSON.parse(readFileSync(new URL("../data/draft-bank.json", import.meta.url), "utf8"));
  assert.deepEqual(validateBankSlots(bank.items).errors, []);
});

test("validateBankSlots: 枠の不足・重複・英語の朝・言語なし・混在・日付の範囲・画像をエラーにする", () => {
  const day = fullDay("2026-10-20");
  const errs = (items) => validateBankSlots(items).errors.join("\n");

  assert.match(errs(day.filter((i) => i.lang !== "en")), /夜・英語\(21:00\)の投稿がありません/);
  assert.match(errs([...day, { ...day[0], id: "dup", bodyJa: "まったく別の話をします。グリーン周りの芝の手入れについて。", category: "X" }]), /朝・日本語\(07:35\)の投稿が2件あります/);
  assert.match(errs([...day.slice(1), { ...day[0], lang: "en" }]), /英語は夜の枠だけです/);
  assert.match(errs([...day.slice(1), { ...day[0], lang: undefined }]), /lang が必要です/);
  assert.match(errs([...day, legacyItem("old", "2026-10-20")]), /混ざっています/);
  assert.match(errs([...day, legacyItem("old", "2026-10-20")]), /slot と lang が必要です/);
  assert.match(errs(fullDay("2026-10-19")), /2026-10-20 以降だけです/);
  assert.match(errs([{ ...legacyItem("old", "2026-10-18"), lang: "ja" }]), /lang は slot と一緒に/);
  assert.match(errs([...day.slice(1), { ...day[0], media: { type: "REAL_PHOTO" } }]), /assets\/instagram\/ のInstagram画像だけです/);
});

test("validateBankSlots: 画像は日本語の枠だけ・1日1本まで・assets/instagram/ の承認済み画像だけ（2026-10-17〜）", () => {
  const day = fullDay("2026-10-20");
  const errs = (items) => validateBankSlots(items).errors.join("\n");
  const img = (path = "assets/instagram/2026-10-20-again.jpg", extra = {}) => ({
    type: "BRAND_GRAPHIC", required: false, aiVisualAllowed: false, altText: "説明", path,
    approvedBy: "山本", approvedAt: "2026-10-17T00:00:00.000Z", ...extra
  });
  const withImg = (pred, media) => day.map((i) => (pred(i) ? { ...i, media } : i));
  const isMorning = (i) => i.slot === "morning" && i.lang === "ja";

  assert.equal(errs(withImg(isMorning, img())), "");
  assert.match(errs(withImg((i) => i.lang === "en", img())), /英語の投稿は文字のみです/);
  assert.match(errs(withImg((i) => i.lang === "ja", img())), /画像付きの投稿が3件あります（画像は1日1本まで）/);
  assert.match(errs(withImg(isMorning, img("assets/other/x.jpg"))), /Instagram画像だけです/);
  assert.match(errs(withImg(isMorning, img("assets/instagram/../../secret.jpg"))), /Instagram画像だけです/);
  assert.match(errs(withImg(isMorning, img(undefined, { approvedAt: null }))), /画像が承認されていません/);
});

test("validateBankSlots: 同じ日の日本語どうしが似すぎ・同じカテゴリーならエラー（英語と日本語は比べない）", () => {
  const day = fullDay("2026-10-20");
  const similar = day.map((i) => (i.slot === "noon" ? { ...i, bodyJa: `${JA.morning}\nまた明日。` } : i));
  assert.match(validateBankSlots(similar).errors.join("\n"), /同じ日の日本語の本文が似ています/);
  const sameCat = day.map((i) => (i.slot === "noon" ? { ...i, category: day[0].category } : i));
  assert.match(validateBankSlots(sameCat).errors.join("\n"), /同じカテゴリー/);
  // 夜の英語の日本語訳が、夜の日本語と同じでも問題ない（比べるのは投稿される言語どうしだけ）
  const enIsTranslation = day.map((i) => (i.lang === "en" ? { ...i, bodyJa: JA.night } : i));
  assert.deepEqual(validateBankSlots(enIsTranslation).errors, []);
});

// ---- 選出・投稿・記録 ----

async function runSlot({ run, todayKey, bankItems, postedPosts = [], live = true }) {
  const calls = [];
  const saved = [];
  const result = await runLivePost({
    bankItems,
    postedPosts,
    facts: [],
    todayKey,
    run,
    live,
    env: live ? { LIVE_POST: "true" } : {},
    publish: async (args) => {
      calls.push(args);
      return { mode: "live", threadsPostId: `p-${calls.length}` };
    },
    saveState: async (r) => saved.push(r)
  });
  return { result, calls, saved };
}

test("朝の実行は、その日の朝・日本語の1件だけを日本語で投稿し、記録に slot / lang / targetDate が付く", async () => {
  const bank = [...fullDay("2026-10-20"), ...fullDay("2026-10-21")];
  const { result, calls, saved } = await runSlot({ run: "morning", todayKey: "2026-10-20", bankItems: bank });
  assert.equal(result.outcome, OUTCOME.POSTED_STATE_SAVED);
  assert.equal(result.selected.id, "lb-2026-10-20-morning-ja");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].lang, "ja");
  assert.equal(result.report.body, JA.morning);
  assert.equal(saved[0].slot, "morning");
  assert.equal(saved[0].lang, "ja");
  assert.equal(saved[0].targetDate, "2026-10-20");
});

test("21:00の英語は、10/20からは夜・英語の枠の1件を英語で投稿する", async () => {
  const { result, calls, saved } = await runSlot({ run: "night_en", todayKey: "2026-10-20", bankItems: fullDay("2026-10-20") });
  assert.equal(result.selected.id, "lb-2026-10-20-night-en");
  assert.equal(calls[0].lang, "en");
  assert.equal(result.report.body, EN.night);
  assert.deepEqual([saved[0].slot, saved[0].lang], ["night", "en"]);
});

test("前の枠の取り残しを後の枠で出さない（昼の実行は昼の1件だけ。投稿済みならNO_CANDIDATE）", async () => {
  const bank = fullDay("2026-10-20");
  const noon = await runSlot({ run: "noon", todayKey: "2026-10-20", bankItems: bank });
  assert.equal(noon.result.selected.id, "lb-2026-10-20-noon-ja");
  const again = await runSlot({ run: "noon", todayKey: "2026-10-20", bankItems: bank, postedPosts: [{ sourceItemId: "lb-2026-10-20-noon-ja", lang: "ja", slot: "noon" }] });
  assert.equal(again.result.outcome, OUTCOME.NO_CANDIDATE);
  assert.equal(again.calls.length, 0);
  // 前日の枠は出さない
  const nextDay = await runSlot({ run: "morning", todayKey: "2026-10-21", bankItems: bank });
  assert.equal(nextDay.result.outcome, OUTCOME.NO_CANDIDATE);
});

test("同じ言語で投稿済みの本文とまったく同じ枠の投稿は出さない", async () => {
  const bank = fullDay("2026-10-20");
  const posted = [{ sourceItemId: "older", lang: "ja", bodyJa: JA.morning, bodyEn: "x" }];
  const { result, calls } = await runSlot({ run: "morning", todayKey: "2026-10-20", bankItems: bank, postedPosts: posted });
  assert.equal(result.outcome, OUTCOME.NO_CANDIDATE);
  assert.equal(result.skipped[0].reason, "duplicate-of-posted");
  assert.equal(calls.length, 0);
});

test("同じ枠に2件ある（検査をすり抜けた）場合は、どちらも出さない", async () => {
  const day = fullDay("2026-10-20");
  const { result, calls } = await runSlot({ run: "morning", todayKey: "2026-10-20", bankItems: [...day, { ...day[0], id: "other" }] });
  assert.equal(result.outcome, OUTCOME.NO_CANDIDATE);
  assert.equal(calls.length, 0);
});

test("05:00の従来の実行は10/20以降は何もしない（publishを呼ばない）", async () => {
  const { result, calls } = await runSlot({ run: "legacy_ja", todayKey: "2026-10-20", bankItems: [...fullDay("2026-10-20"), legacyItem("old", "2026-10-19")] });
  assert.equal(result.outcome, OUTCOME.NO_CANDIDATE);
  assert.equal(result.plan.kind, "none");
  assert.equal(calls.length, 0);
});

test("従来との互換: 10/19までは slot の無い同じ投稿を05:00に日本語・21:00に英語で出し、新しい枠は動かない", async () => {
  const bank = [legacyItem("d19", "2026-10-19"), ...fullDay("2026-10-20")];
  const ja = await runSlot({ run: "legacy_ja", todayKey: "2026-10-19", bankItems: bank });
  assert.equal(ja.result.selected.id, "d19");
  assert.equal(ja.calls[0].lang, "ja");
  assert.equal("slot" in ja.saved[0], false, "従来の記録の形は変えない");
  assert.equal(ja.saved[0].lang, "ja");
  const en = await runSlot({ run: "night_en", todayKey: "2026-10-19", bankItems: bank, postedPosts: [{ sourceItemId: "d19", lang: "ja" }] });
  assert.equal(en.result.selected.id, "d19");
  assert.equal(en.calls[0].lang, "en");
  for (const id of ["morning", "noon", "night"]) {
    const r = await runSlot({ run: id, todayKey: "2026-10-19", bankItems: bank });
    assert.equal(r.result.outcome, OUTCOME.NO_CANDIDATE, id);
    assert.equal(r.calls.length, 0);
  }
});

test("従来の選び方(selectDailyCandidate)は枠付きの投稿を選ばない（手動のboth投稿等で繰り上がらない）", async () => {
  const { selected } = await selectDailyCandidate({ bankItems: fullDay("2026-10-20"), postedPosts: [], facts: [], todayKey: "2026-10-25", lang: "both" });
  assert.equal(selected, null);
});

test("二重ゲートが揃わなければ枠の実行もdry-run（本物のpublishPostでもネットワークに出ない）", async () => {
  const result = await runLivePost({ bankItems: fullDay("2026-10-20"), postedPosts: [], facts: [], todayKey: "2026-10-20", run: "night_en", live: true, env: {} });
  assert.equal(result.outcome, OUTCOME.DRY_RUN);
  assert.equal(result.publishResult.body, EN.night);
});

test("buildPostRecord: slot を渡したときだけ slot / targetDate を残す", () => {
  const base = { sourceItemId: "a", threadsPostId: "1", bodyEn: "A", bodyJa: "あ", postedAt: "x" };
  const rec = buildPostRecord({ ...base, lang: "en", slot: "night", targetDate: "2026-10-20" });
  assert.deepEqual([rec.lang, rec.slot, rec.targetDate], ["en", "night", "2026-10-20"]);
  assert.equal("slot" in buildPostRecord({ ...base, lang: "ja" }), false);
});

test("promoteCandidate: slot / lang を引き継ぐ（slot の無い候補は従来の形のまま）", () => {
  const approval = { approved: true, approvedBy: "t", approvedAt: "2026-10-17T00:00:00Z" };
  const promoted = promoteCandidate(slotItem("2026-10-20", "night", "en"), approval);
  assert.deepEqual([promoted.slot, promoted.lang], ["night", "en"]);
  const legacy = promoteCandidate(legacyItem("old", "2026-10-19"), approval);
  assert.equal("slot" in legacy, false);
  assert.equal("lang" in legacy, false);
});

// ---- CLI（--live を渡さないので常にdry-run。ネットワークに出ない） ----

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SCRIPT = fileURLToPath(new URL("../scripts/post-to-threads.mjs", import.meta.url));
const cli = (args) => spawnSync(process.execPath, [SCRIPT, ...args], { cwd: ROOT, env: { ...process.env, LIVE_POST: "", GITHUB_OUTPUT: "" }, encoding: "utf8" });

test("post-to-threads.mjs --run / --date: 枠と日付を表示してdry-runで終わる。不正な値は止まる", () => {
  const ok = cli(["--run=morning", "--date=2026-10-20"]);
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /実行の枠: morning/);
  assert.match(ok.stdout, /枠付き\(slot=morning lang=ja\)/);
  assert.match(ok.stdout, /最終結果: DRY_RUN/);
  const legacyEnded = cli(["--run=legacy_ja", "--date=2026-10-21"]);
  assert.equal(legacyEnded.status, 0);
  assert.match(legacyEnded.stdout, /この枠はこの日には投稿しません/);
  assert.equal(cli(["--run=lunch"]).status, 1);
  assert.equal(cli(["--run=noon", "--date=2026/10/20"]).status, 1);
});

test("validateBankSlots: ヘタ郎の画像は hetaro-media の画像で、本文に「見習いアンバサダー」があるときだけ（2026-10-18〜）", () => {
  const day = fullDay("2026-10-20");
  const errs = (items) => validateBankSlots(items).errors.join("\n");
  const media = (path = "hetaro-media/ig/2026-10-26-ig-1.jpg") => ({
    type: "CHARACTER_HETARO", required: false, aiVisualAllowed: false, altText: "ヘタ郎", path,
    approvedBy: "山本", approvedAt: "2026-10-18T00:00:00.000Z"
  });
  const set = (m, extra = {}) => day.map((i) => (i.slot === "morning" && i.lang === "ja" ? { ...i, media: m, ...extra } : i));
  const marked = (i) => `${i.bodyJa}\nうちの見習いアンバサダー、ヘタ郎です。`;
  const morning = day.find((i) => i.slot === "morning" && i.lang === "ja");
  assert.equal(errs(set(media(), { bodyJa: marked(morning) })), "");
  assert.match(errs(set(media())), /見習いアンバサダー/);
  assert.match(errs(set(media("assets/instagram/a.jpg"), { bodyJa: marked(morning) })), /hetaro-image-not-from-hetaro-media/);
});
