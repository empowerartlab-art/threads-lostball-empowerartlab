// 1日4本（2026-10-20〜）のまとめて承認（lib/bulk-approve.mjs）と似すぎガード（lib/similarity-guard.mjs）。
// ファイルI/O・ネットワークなし。
import { test } from "node:test";
import assert from "node:assert/strict";
import { datesFor, planBulkApproval, formatBulkList, isDraftSkeleton } from "../lib/bulk-approve.mjs";
import { textSimilarity, checkAgainstPosted, checkScheduleSimilarity, THRESHOLDS } from "../lib/similarity-guard.mjs";

const TEXT_ONLY = { type: "TEXT_ONLY", required: false, aiVisualAllowed: false, path: null };

// 日付ごとに中身が違う、互いに似ていない本文。
const TOPICS = [
  ["林の奥で見つかったボールが、もう一度コースへ戻っていきます。", "Balls found deep in the woods go back to the course."],
  ["一球ずつ手で磨く作業は、表面の汚れを落とす地道な仕事です。", "Polishing by hand is quiet, patient work."],
  ["次のラウンドでは、どんな一打を打ちたいですか。", "What shot do you want to hit next round?"],
  ["池に入ったボールの行き先を、考えたことはありますか。", "Ever wondered where pond balls end up?"],
  ["練習場の帰り道、空がきれいな夕方でした。", "Driving home from the range under an orange sky."],
  ["新品でなくても、ちゃんと使えるボールがあります。", "Not brand new, still good to play."],
  ["雨の日のゴルフ、みなさんは行きますか。", "Rainy-day golf: in or out?"]
];

function cand(date, slot, lang, n, extra = {}) {
  const [ja, en] = TOPICS[n % TOPICS.length];
  const tag = `${date.slice(5)}${slot}${lang}`;
  return {
    id: `c-${date}-${slot}-${lang}`,
    pillar: "GOLF",
    category: `CAT_${n}_${slot}_${lang}`,
    bodyJa: lang === "en" ? `（訳）${ja}【${tag}】` : `${ja}【${tag}】`,
    bodyEn: `${en} [${tag}]`,
    hasCta: false,
    hasShopLink: false,
    requiresVerifiedFact: false,
    verifiedFactIds: [],
    media: { ...TEXT_ONLY },
    targetDate: date,
    slot,
    lang,
    ...extra
  };
}

// 1日分の4件。日付ごと・枠ごとに別の話題を割り当てる。
function day(date, offset) {
  return [
    cand(date, "morning", "ja", offset),
    cand(date, "noon", "ja", offset + 2),
    cand(date, "night", "ja", offset + 4),
    cand(date, "night", "en", offset + 1)
  ];
}

const base = { bankItems: [], postedPosts: [], facts: [], approvedBy: "承認者", approvedAt: "2026-10-17T01:00:00.000Z", todayKey: "2026-10-17", now: new Date("2026-10-17T01:00:00Z") };

test("datesFor: --date は1日、--week はその日を含む火〜月、--from/--to は最大31日", () => {
  assert.deepEqual(datesFor({ date: "2026-10-21" }), ["2026-10-21"]);
  const week = datesFor({ week: "2026-10-23" });
  assert.equal(week[0], "2026-10-20");
  assert.equal(week.at(-1), "2026-10-26");
  assert.equal(week.length, 7);
  assert.equal(datesFor({ from: "2026-10-20", to: "2026-10-22" }).length, 3);
  assert.throws(() => datesFor({ from: "2026-10-01", to: "2026-12-01" }), /31日/);
  assert.throws(() => datesFor({}), /--date/);
  assert.throws(() => datesFor({ date: "10/20" }), /形式/);
});

test("1日分の4件がそろっていれば承認でき、slot / lang / 承認者が付く", () => {
  const plan = planBulkApproval({ ...base, candidates: day("2026-10-20", 0), dates: ["2026-10-20"] });
  assert.equal(plan.ok, true, JSON.stringify(plan.problems));
  assert.equal(plan.toApprove.length, 4);
  for (const p of plan.toApprove) {
    assert.equal(p.approvedBy, "承認者");
    assert.ok(p.slot && p.lang);
  }
  assert.deepEqual(plan.toApprove.map((p) => `${p.slot}:${p.lang}`).sort(), ["morning:ja", "night:en", "night:ja", "noon:ja"]);
});

test("1週間ぶんをまとめて承認でき、週次レビューの下書き前スケルトンは対象外として飛ばす", () => {
  const dates = datesFor({ week: "2026-10-20" });
  // 28件すべて別の話題になるよう、件ごとに重ならない文字・単語で本文を作る。
  let k = 0;
  const unique = (c) => {
    k += 1;
    const ja = Array.from({ length: 24 }, (_, i) => String.fromCharCode(0x4e00 + k * 50 + i)).join("");
    const en = Array.from({ length: 10 }, (_, i) => `w${k}x${i}`).join(" ");
    return { ...c, bodyJa: `${ja}。`, bodyEn: `${en}.` };
  };
  const candidates = dates.flatMap((d, i) => day(d, i)).map(unique);
  const skeleton = { id: "lostball-candidate-20261020", targetDate: "2026-10-20", status: "needs_human_draft", bodyEn: "[DRAFT PLACEHOLDER]", bodyJa: "[下書き未作成]" };
  assert.equal(isDraftSkeleton(skeleton), true);
  const plan = planBulkApproval({ ...base, candidates: [...candidates, skeleton], dates });
  assert.equal(plan.ok, true, JSON.stringify(plan.problems, null, 1));
  assert.equal(plan.toApprove.length, 28);
  assert.equal(plan.rows.find((r) => r.id === skeleton.id).status, "draft");
  assert.ok(!plan.approvedIds.includes(skeleton.id));
});

test("全部OKのときだけ: 1件でも問題があれば何も承認しない（toApprove は空）", () => {
  const candidates = day("2026-10-20", 0).map((c) => (c.slot === "noon" ? { ...c, bodyJa: `${c.bodyJa} https://example.com` } : c));
  const plan = planBulkApproval({ ...base, candidates, dates: ["2026-10-20"] });
  assert.equal(plan.ok, false);
  assert.deepEqual(plan.toApprove, []);
  assert.deepEqual(plan.approvedIds, []);
  assert.ok(plan.problems.some((p) => p.id === "c-2026-10-20-noon-ja" && p.reasons.some((r) => /raw-url/.test(r))));
});

test("1日の途中まで（英語が無い等）では承認できない（承認後のdraft-bank.jsonが4枠そろわない）", () => {
  const candidates = day("2026-10-20", 0).filter((c) => c.lang === "ja");
  const plan = planBulkApproval({ ...base, candidates, dates: ["2026-10-20"] });
  assert.equal(plan.ok, false);
  assert.match(JSON.stringify(plan.problems), /夜・英語\(21:00\)の投稿がありません/);
});

test("--exclude: 1日分4件を外せばその日は投稿なしで残りを承認できる。存在しないidはエラー", () => {
  const candidates = [...day("2026-10-20", 0), ...day("2026-10-21", 1)];
  const dates = ["2026-10-20", "2026-10-21"];
  const ex = day("2026-10-21", 1).map((c) => c.id);
  const plan = planBulkApproval({ ...base, candidates, dates, exclude: ex });
  assert.equal(plan.ok, true, JSON.stringify(plan.problems));
  assert.equal(plan.toApprove.length, 4);
  assert.ok(plan.notices.some((n) => n.startsWith("2026-10-21")));
  const typo = planBulkApproval({ ...base, candidates, dates, exclude: ["c-typo"] });
  assert.equal(typo.ok, false);
  assert.match(JSON.stringify(typo.problems), /対象日の候補に無いid/);
  // 1件だけ外すと、その日が4枠そろわないので承認しない
  const one = planBulkApproval({ ...base, candidates, dates, exclude: [ex[0]] });
  assert.equal(one.ok, false);
});

test("枠のルール: 英語の朝・slotなし・10/19以前・過去日・同じ枠に2件・承認済みと同じ枠はエラー", () => {
  const d = day("2026-10-20", 0);
  const reasonsOf = (candidates, dates = ["2026-10-20"], extra = {}) =>
    JSON.stringify(planBulkApproval({ ...base, candidates, dates, ...extra }).problems);
  assert.match(reasonsOf([{ ...d[0], lang: "en" }, ...d.slice(1)]), /枠\(slot\)と言語\(lang\)が不正/);
  assert.match(reasonsOf([{ ...d[0], slot: undefined }, ...d.slice(1)]), /枠\(slot\)と言語\(lang\)が不正/);
  assert.match(reasonsOf(day("2026-10-19", 0), ["2026-10-19"]), /2026-10-20 以降だけ/);
  assert.match(reasonsOf(d, ["2026-10-20"], { todayKey: "2026-10-21" }), /過去の日付/);
  assert.match(reasonsOf([...d, { ...d[0], id: "c-other", bodyJa: "まったく別の話。芝の手入れ。", category: "Z" }]), /候補が2件以上/);
  assert.match(reasonsOf(d, ["2026-10-20"], { bankItems: [{ ...d[0], id: "already" }] }), /承認済みの別の投稿で埋まっています/);
  assert.match(reasonsOf([{ ...d[0], media: { type: "REAL_PHOTO", required: false } }, ...d.slice(1)]), /文字のみ/);
});

test("事実のガード: 裏付けの無い具体的な数字・未登録のverifiedFactIdsは承認できない", () => {
  const d = day("2026-10-20", 0);
  const fabricated = { ...d[0], bodyJa: "先月は3000球を回収しました。", bodyEn: "We collected 3,000 balls last month." };
  const plan = planBulkApproval({ ...base, candidates: [fabricated, ...d.slice(1)], dates: ["2026-10-20"] });
  assert.equal(plan.ok, false);
  assert.match(JSON.stringify(plan.problems), /裏付けの無い具体的な事実/);
  const unknownFact = { ...d[0], requiresVerifiedFact: true, verifiedFactIds: ["no-such-fact"] };
  assert.equal(planBulkApproval({ ...base, candidates: [unknownFact, ...d.slice(1)], dates: ["2026-10-20"] }).ok, false);
});

test("似すぎ: 同じ日の日本語の言い換え・同じ週の言い換え・投稿済みの言い換えは承認できない", () => {
  const d = day("2026-10-20", 0);
  const sameDay = d.map((c) => (c.slot === "noon" ? { ...c, bodyJa: d[0].bodyJa.replace("。", "！") } : c));
  assert.match(JSON.stringify(planBulkApproval({ ...base, candidates: sameDay, dates: ["2026-10-20"] }).problems), /同じ日の日本語の本文が似ています/);

  const bank = day("2026-10-20", 0).map((c) => ({ ...c, id: `b-${c.id}`, approvedBy: "x", approvedAt: "y" }));
  const next = day("2026-10-23", 3).map((c) => (c.slot === "morning" ? { ...c, bodyJa: bank[0].bodyJa.replace("【10-20morningja】", "") } : c));
  assert.match(JSON.stringify(planBulkApproval({ ...base, bankItems: bank, candidates: next, dates: ["2026-10-23"] }).problems), /7日以内の日本語の本文が似ています/);

  const posted = [{ sourceItemId: "old", lang: "en", bodyEn: d[3].bodyEn.replace(/ \[.*\]$/, ""), bodyJa: "x", postedAt: "2026-10-10T12:00:00Z" }];
  assert.match(JSON.stringify(planBulkApproval({ ...base, postedPosts: posted, candidates: d, dates: ["2026-10-20"] }).problems), /投稿済み.*英語の本文が似ています/);
});

test("formatBulkList: 日付ごとに4枠・時刻・状態を並べ、英語の枠には日本語訳も出す", () => {
  const plan = planBulkApproval({ ...base, candidates: day("2026-10-20", 0).filter((c) => c.slot !== "noon"), dates: ["2026-10-20"] });
  const text = formatBulkList({ dates: ["2026-10-20"], rows: plan.rows, bankItems: [] });
  assert.match(text, /==== 2026-10-20（火）====/);
  assert.match(text, /\[朝・日本語 07:35\]/);
  assert.match(text, /\[昼・日本語 12:35\] ❌ まだありません/);
  assert.match(text, /\[夜・英語 21:00\]/);
  assert.match(text, /（日本語訳）/);
});

test("似すぎガード: 日本語は文字、英語は単語の組で比べ、言語が違うものは比べない", () => {
  assert.equal(textSimilarity("同じ文章です。", "同じ文章です", "ja"), 1);
  assert.ok(textSimilarity("Polishing by hand is quiet work.", "Polishing by hand is quiet, patient work.", "en") >= THRESHOLDS.en.sameWeek);
  assert.ok(textSimilarity("Rainy-day golf: in or out?", "Balls found deep in the woods go back.", "en") < 0.1);
  const items = [
    { id: "a", targetDate: "2026-10-20", lang: "ja", text: "同じ話題の文章です。" },
    { id: "b", targetDate: "2026-10-20", lang: "en", text: "同じ話題の文章です。" }
  ];
  assert.equal(checkScheduleSimilarity(items).ok, true);
  // 自分自身の投稿記録とは比べない
  const self = checkAgainstPosted({ id: "a", lang: "ja", text: "同じ話題の文章です。" }, [{ sourceItemId: "a", lang: "ja", bodyJa: "同じ話題の文章です。" }]);
  assert.equal(self.ok, true);
});
