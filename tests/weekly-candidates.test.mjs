import { test } from "node:test";
import assert from "node:assert/strict";
import { checkBilingualBody } from "../lib/bilingual-guard.mjs";
import { canUseCandidate } from "../lib/verified-fact-guard.mjs";
import {
  nextTuesdayDateKey,
  nextSevenDates,
  assignPillarsForNextWeek,
  generateWeeklyCandidates,
  estimateNextWeekStart
} from "../lib/weekly-candidates.mjs";

test("nextTuesdayDateKey: 土曜日から見ると3日後の火曜日を返す", () => {
  assert.equal(nextTuesdayDateKey("2026-10-03"), "2026-10-06"); // 2026-10-03は土曜日
});

test("nextTuesdayDateKey: 今日が火曜日でも今日自身は返さず、1週間後の火曜日を返す", () => {
  assert.equal(nextTuesdayDateKey("2026-10-06"), "2026-10-13"); // 2026-10-06は火曜日
});

test("nextSevenDates: weekStartから7日分の連続した日付を返す", () => {
  const dates = nextSevenDates("2026-10-20");
  assert.deepEqual(dates, ["2026-10-20", "2026-10-21", "2026-10-22", "2026-10-23", "2026-10-24", "2026-10-25", "2026-10-26"]);
});

test("assignPillarsForNextWeek: 既存投稿で使われていないpillarを優先して割り当てる", () => {
  // JAPANが1件、他は0件 → 最初に選ばれるのはENVIRONMENT/WELFARE/SOCIAL_CONTRIBUTION/GOLFのいずれか(JAPANではない)
  const bankItems = [{ pillar: "JAPAN" }];
  const assigned = assignPillarsForNextWeek(bankItems, 4);
  assert.equal(assigned.includes("JAPAN"), false);
  assert.equal(assigned.length, 4);
});

test("assignPillarsForNextWeek: 7枠では5軸すべてが最低1回は含まれる(偏りを埋める方向に倒すため)", () => {
  const assigned = assignPillarsForNextWeek([], 7);
  const unique = new Set(assigned);
  assert.equal(unique.size, 5);
});

test("assignPillarsForNextWeek: 回帰テスト — 僅差で偏った実データに近い分布でも、2つのpillarだけが連続選出され続けて他の3つが丸ごと消える、ということは起きない", () => {
  // DAY1〜22相当の分布を模した入力(JAPAN:1, ENVIRONMENT:8, WELFARE:2, SOCIAL_CONTRIBUTION:6, GOLF:4)。
  // 単純な貪欲法(毎回最小値を選び直すだけ)だと、JAPANとWELFAREが交互に選ばれ続け、
  // ENVIRONMENT/SOCIAL_CONTRIBUTION/GOLFが1週間丸ごと出現しない、というバグが過去にあった。
  const bankItems = [
    ...Array(1).fill({ pillar: "JAPAN" }),
    ...Array(8).fill({ pillar: "ENVIRONMENT" }),
    ...Array(2).fill({ pillar: "WELFARE" }),
    ...Array(6).fill({ pillar: "SOCIAL_CONTRIBUTION" }),
    ...Array(4).fill({ pillar: "GOLF" })
  ];
  const assigned = assignPillarsForNextWeek(bankItems, 7);
  const unique = new Set(assigned);
  assert.equal(unique.size, 5, `5軸すべてが出現すべきだが、実際は: ${assigned.join(", ")}`);
  // 最も使われていない2つ(JAPAN, WELFARE)が、7枠中2回選ばれる側になることも確認する。
  const counts = {};
  for (const p of assigned) counts[p] = (counts[p] ?? 0) + 1;
  assert.equal(counts.JAPAN, 2);
  assert.equal(counts.WELFARE, 2);
  assert.equal(counts.ENVIRONMENT, 1);
  assert.equal(counts.SOCIAL_CONTRIBUTION, 1);
  assert.equal(counts.GOLF, 1);
});

test("generateWeeklyCandidates: 7件生成され、targetDateが火曜〜月曜の連続7日になる", () => {
  const candidates = generateWeeklyCandidates({
    bankItems: [],
    categoryProfile: { week2PlusCandidateCategories: [] },
    unusedContentIdeas: [],
    weekStartDateKey: "2026-10-20",
    startDay: 23
  });
  assert.equal(candidates.length, 7);
  assert.deepEqual(
    candidates.map((c) => c.targetDate),
    ["2026-10-20", "2026-10-21", "2026-10-22", "2026-10-23", "2026-10-24", "2026-10-25", "2026-10-26"]
  );
  assert.deepEqual(
    candidates.map((c) => c.day),
    [23, 24, 25, 26, 27, 28, 29]
  );
});

test("generateWeeklyCandidates: approvedBy/approvedAtは常にnull(AI側で承認済み扱いにしない)", () => {
  const candidates = generateWeeklyCandidates({
    bankItems: [],
    categoryProfile: { week2PlusCandidateCategories: [] },
    unusedContentIdeas: [],
    weekStartDateKey: "2026-10-20",
    startDay: 23
  });
  for (const c of candidates) {
    assert.equal(c.approvedBy, null);
    assert.equal(c.approvedAt, null);
    assert.equal(c.media.approvedBy, null);
    assert.equal(c.status, "needs_human_draft");
  }
});

test("generateWeeklyCandidates: requiresVerifiedFact=falseでverifiedFactIds=[](人間が本文確定後に設定する前提)", () => {
  const candidates = generateWeeklyCandidates({
    bankItems: [],
    categoryProfile: { week2PlusCandidateCategories: [] },
    unusedContentIdeas: [],
    weekStartDateKey: "2026-10-20",
    startDay: 23
  });
  for (const c of candidates) {
    assert.equal(c.requiresVerifiedFact, false);
    assert.deepEqual(c.verifiedFactIds, []);
  }
});

test("generateWeeklyCandidates: 画像必須にしない(media.required=falseで統一)", () => {
  const candidates = generateWeeklyCandidates({
    bankItems: [],
    categoryProfile: { week2PlusCandidateCategories: [] },
    unusedContentIdeas: [],
    weekStartDateKey: "2026-10-20",
    startDay: 23
  });
  for (const c of candidates) {
    assert.equal(c.media.required, false);
  }
});

test("generateWeeklyCandidates: すべてのプレースホルダー本文が併記フォーマット(500文字以内・空でない・生URLなし)を満たす", () => {
  const categoryProfile = {
    week2PlusCandidateCategories: [
      { id: "hand-polishing-detail", labelJa: "1球ずつ磨く作業(詳細)", pillar: "GOLF" },
      { id: "japan-golf", labelJa: "日本のゴルフ", pillar: "JAPAN" }
    ]
  };
  const candidates = generateWeeklyCandidates({
    bankItems: [],
    categoryProfile,
    unusedContentIdeas: [
      { themeId: "environmental-conservation", ideaId: "environmental-conservation-05", workingTitle: "ゴルフ×サステナビリティ" }
    ],
    weekStartDateKey: "2026-10-20",
    startDay: 23
  });
  for (const c of candidates) {
    const result = checkBilingualBody(c);
    assert.equal(result.ok, true, `${c.id}: ${result.errors.join(", ")}`);
  }
});

test("generateWeeklyCandidates: requiresVerifiedFact=falseのため、verified-fact-guardのチェックも通る(未承認のまま選出されても事実捏造にはならない)", () => {
  const candidates = generateWeeklyCandidates({
    bankItems: [],
    categoryProfile: { week2PlusCandidateCategories: [] },
    unusedContentIdeas: [],
    weekStartDateKey: "2026-10-20",
    startDay: 23
  });
  for (const c of candidates) {
    const result = canUseCandidate(c, []);
    assert.equal(result.ok, true);
  }
});

test("generateWeeklyCandidates: 同じバッチ内で同じトピックを2回使わない", () => {
  const categoryProfile = {
    week2PlusCandidateCategories: [{ id: "hand-polishing-detail", labelJa: "1球ずつ磨く作業(詳細)", pillar: "GOLF" }]
  };
  const bankItems = Array.from({ length: 6 }, () => ({ pillar: "JAPAN" })); // GOLFが7枠中、複数回選ばれるよう偏らせる
  const candidates = generateWeeklyCandidates({
    bankItems,
    categoryProfile,
    unusedContentIdeas: [],
    weekStartDateKey: "2026-10-20",
    startDay: 23
  });
  const golfCandidatesWithTopic = candidates.filter((c) => c.pillar === "GOLF" && c.suggestedTopic?.id === "hand-polishing-detail");
  assert.ok(golfCandidatesWithTopic.length <= 1, "同じトピックが複数の候補で重複している");
});

// 2026-10-03に実際に発生した不具合の再発防止用テスト群:
// nextTuesdayDateKey(todayKey)だけを使うと、既存の承認済み予定・既存の未承認候補・
// targetDateを持たないFIFOキューの残り件数のいずれも考慮せず、重複する週の候補を
// 生成してしまう(実際に2026-10-20〜10-26向けの既存候補と重複する形で
// 2026-10-06〜10-12向けの候補が追加され、テストの期待値と不整合になった)。
test("estimateNextWeekStart: 予定が何も無い場合は、従来どおり今日から見て次の火曜日を返す", () => {
  const result = estimateNextWeekStart("2026-10-03", { bankItems: [], existingCandidates: [], postedPosts: [] });
  assert.equal(result, "2026-10-06");
});

test("estimateNextWeekStart: targetDateを持たないFIFOキューの残り件数から完了予定日を推定し、それより後の火曜日を返す", () => {
  // day6〜22(17件)が未投稿のまま残っている想定。今日(10/4)から1日1本消化すると
  // 完了は10/4+16日=10/20。10/20より後の次の火曜日は10/27。
  const bankItems = Array.from({ length: 17 }, (_, i) => ({ id: `day${i + 6}`, day: i + 6, targetDate: null, bodyJa: `本文${i}`, bodyEn: `body${i}` }));
  const result = estimateNextWeekStart("2026-10-04", { bankItems, existingCandidates: [], postedPosts: [] });
  assert.equal(result, "2026-10-27");
});

test("estimateNextWeekStart: 投稿済みのFIFOアイテムは残り件数から除外される(重複カウントしない)", () => {
  const bankItems = [
    { id: "day1", day: 1, targetDate: null, bodyJa: "投稿済み1", bodyEn: "posted1" },
    { id: "day2", day: 2, targetDate: null, bodyJa: "未投稿2", bodyEn: "notposted2" }
  ];
  const postedPosts = [{ bodyJa: "投稿済み1", bodyEn: "posted1" }];
  // 残り1件(day2)のみ → 完了予定日は今日(10/4)そのもの → 10/4より後の次の火曜日は10/6。
  const result = estimateNextWeekStart("2026-10-04", { bankItems, existingCandidates: [], postedPosts });
  assert.equal(result, "2026-10-06");
});

test("estimateNextWeekStart: 既存の未承認候補(draft-bank-candidates.json)の最終日が最も遅い場合、それより後の火曜日を返す(実際に発生した不具合の再現)", () => {
  const existingCandidates = Array.from({ length: 7 }, (_, i) => ({
    targetDate: `2026-10-${20 + i}`
  }));
  // 2026-10-26(月)より後の次の火曜日は2026-10-27。
  const result = estimateNextWeekStart("2026-10-03", { bankItems: [], existingCandidates, postedPosts: [] });
  assert.equal(result, "2026-10-27");
});

test("estimateNextWeekStart: draft-bank.jsonのtargetDate付きアイテムの最終日が最も遅い場合、それより後の火曜日を返す", () => {
  const bankItems = [{ id: "future1", targetDate: "2026-11-02", bodyJa: "x", bodyEn: "x" }];
  const result = estimateNextWeekStart("2026-10-03", { bankItems, existingCandidates: [], postedPosts: [] });
  assert.equal(result, "2026-11-03");
});

test("generateWeeklyCandidates: マッチするトピックが無いpillarは suggestedTopic=null, category='TOPIC_TBD' になる(捏造しない)", () => {
  const candidates = generateWeeklyCandidates({
    bankItems: [],
    categoryProfile: { week2PlusCandidateCategories: [] },
    unusedContentIdeas: [],
    weekStartDateKey: "2026-10-20",
    startDay: 23
  });
  for (const c of candidates) {
    assert.equal(c.suggestedTopic, null);
    assert.equal(c.category, "TOPIC_TBD");
  }
});
