import { test } from "node:test";
import assert from "node:assert/strict";
import { selectDailyCandidate } from "../scripts/select-daily-candidate.mjs";

const facts = [{ id: "fact-a", verified: true }];

const bankItems = [
  { id: "item-1", day: 1, bodyEn: "First.", bodyJa: "1つ目。", requiresVerifiedFact: false, verifiedFactIds: [] },
  {
    id: "item-2",
    day: 2,
    bodyEn: "Second.",
    bodyJa: "2つ目。",
    requiresVerifiedFact: true,
    verifiedFactIds: ["fact-a"]
  }
];

test("投稿済みが無ければ配列順(FIFO)で先頭が選ばれる", async () => {
  const { selected, skipped } = await selectDailyCandidate({ bankItems, postedPosts: [], facts });
  assert.equal(selected.id, "item-1");
  assert.deepEqual(skipped, []);
});

test("先頭が投稿済み(重複)ならスキップして次が選ばれる", async () => {
  const postedPosts = [{ bodyEn: "First.", bodyJa: "1つ目。" }];
  const { selected, skipped } = await selectDailyCandidate({ bankItems, postedPosts, facts });
  assert.equal(selected.id, "item-2");
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0].reason, "duplicate-of-posted");
});

test("未検証の事実を要求する候補はスキップされる", async () => {
  const items = [
    { id: "unverified", day: 1, bodyEn: "X.", bodyJa: "X。", requiresVerifiedFact: true, verifiedFactIds: ["missing-fact"] }
  ];
  const { selected, skipped } = await selectDailyCandidate({ bankItems: items, postedPosts: [], facts });
  assert.equal(selected, null);
  assert.equal(skipped[0].reason, "unverified-fact:missing-fact");
});

test("全件投稿済みならselectedはnull", async () => {
  const postedPosts = bankItems.map((i) => ({ bodyEn: i.bodyEn, bodyJa: i.bodyJa }));
  const { selected } = await selectDailyCandidate({ bankItems, postedPosts, facts });
  assert.equal(selected, null);
});

test("media.required=trueで画像未承認の候補は選出されず、次の候補に進む(AI画像を自動生成して補うことはしない)", async () => {
  const items = [
    {
      id: "needs-photo",
      day: 1,
      bodyEn: "Photo needed.",
      bodyJa: "写真が必要。",
      requiresVerifiedFact: false,
      verifiedFactIds: [],
      media: { type: "PRODUCT_PHOTO", required: true, aiVisualAllowed: false }
    },
    {
      id: "text-only-ok",
      day: 2,
      bodyEn: "Text only is fine.",
      bodyJa: "テキストのみでOK。",
      requiresVerifiedFact: false,
      verifiedFactIds: [],
      media: { type: "TEXT_ONLY", required: false }
    }
  ];
  const { selected, skipped } = await selectDailyCandidate({ bankItems: items, postedPosts: [], facts });
  assert.equal(selected.id, "text-only-ok");
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0].item.id, "needs-photo");
  assert.equal(skipped[0].reason, "media-not-approved");
});

test("media.required=trueでも画像が承認済みなら選出される", async () => {
  const items = [
    {
      id: "photo-approved",
      day: 1,
      bodyEn: "Photo ready.",
      bodyJa: "写真準備済み。",
      requiresVerifiedFact: false,
      verifiedFactIds: [],
      media: {
        type: "PRODUCT_PHOTO",
        required: true,
        aiVisualAllowed: false,
        path: "assets/photo.jpg",
        approvedBy: "someone@example.com",
        approvedAt: "2026-09-27T00:00:00.000Z"
      }
    }
  ];
  const { selected, skipped } = await selectDailyCandidate({ bankItems: items, postedPosts: [], facts });
  assert.equal(selected.id, "photo-approved");
  assert.deepEqual(skipped, []);
});

test("requiresVerifiedFact:falseのまま具体的な未確認事実(回収数の数字)を書いた候補はスキップされる(verified-fact-guardの抜け道を塞ぐ)", async () => {
  const items = [
    {
      id: "fabricated-count",
      day: 1,
      bodyEn: "We collected 500 balls this week.",
      bodyJa: "今週500球回収しました。",
      requiresVerifiedFact: false,
      verifiedFactIds: []
    },
    {
      id: "safe-theme",
      day: 2,
      bodyEn: "Reusing a lost ball instead of throwing it away.",
      bodyJa: "捨てずにもう一度使うという選択。",
      requiresVerifiedFact: false,
      verifiedFactIds: []
    }
  ];
  const { selected, skipped } = await selectDailyCandidate({ bankItems: items, postedPosts: [], facts });
  assert.equal(selected.id, "safe-theme");
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0].item.id, "fabricated-count");
  assert.match(skipped[0].reason, /unverified-fact-fabrication/);
});

test("requiresVerifiedFact:trueかつ実在idの候補は、本文に未確認事実っぽい表現があってもこのガードでは追加スキップされない(verified-fact-guard側で既にid確認済みのため対象外)", async () => {
  const items = [
    {
      id: "verified-collection",
      day: 1,
      bodyEn: "Our lost balls are collected from golf courses in Japan.",
      bodyJa: "このロストボールは、日本国内のゴルフ場で回収したものです。",
      requiresVerifiedFact: true,
      verifiedFactIds: ["fact-a"]
    }
  ];
  const { selected, skipped } = await selectDailyCandidate({ bankItems: items, postedPosts: [], facts });
  assert.equal(selected.id, "verified-collection");
  assert.deepEqual(skipped, []);
});

test("すべての候補がmedia未承認で埋まっている場合はselectedがnullになる(何も自動生成しない)", async () => {
  const items = [
    {
      id: "only-needs-photo",
      day: 1,
      bodyEn: "Photo needed.",
      bodyJa: "写真が必要。",
      requiresVerifiedFact: false,
      verifiedFactIds: [],
      media: { type: "PRODUCT_PHOTO", required: true, aiVisualAllowed: false }
    }
  ];
  const { selected, skipped } = await selectDailyCandidate({ bankItems: items, postedPosts: [], facts });
  assert.equal(selected, null);
  assert.equal(skipped[0].reason, "media-not-approved");
});
