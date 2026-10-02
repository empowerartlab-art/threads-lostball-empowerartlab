import { test } from "node:test";
import assert from "node:assert/strict";
import { checkBilingualBody } from "../lib/bilingual-guard.mjs";
import { canUseCandidate } from "../lib/verified-fact-guard.mjs";
import {
  nextTuesdayDateKey,
  nextSevenDates,
  assignPillarsForNextWeek,
  generateWeeklyCandidates
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
