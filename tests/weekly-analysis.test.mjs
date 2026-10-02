import { test } from "node:test";
import assert from "node:assert/strict";
import { analyzeWeekly, buildPerPostView, findUnusedContentIdeas } from "../lib/weekly-analysis.mjs";

function samplePosts() {
  return [
    {
      sourceItemId: "lostball-day1-brand-intro",
      threadsPostId: "post-1",
      bodyEn: "Hello.",
      bodyJa: "こんにちは。",
      pillar: null,
      category: "BRAND_INTRO",
      postedAt: "2026-09-27T23:29:22.677Z"
    },
    {
      sourceItemId: "lostball-day2-japan-origin",
      threadsPostId: "post-2",
      bodyEn: "Japan.",
      bodyJa: "日本。",
      pillar: "JAPAN",
      category: "JAPAN_ORIGIN",
      postedAt: "2026-09-28T12:57:11.620Z"
    }
  ];
}

function sampleBankItems() {
  return [
    {
      id: "lostball-day1-brand-intro",
      day: 1,
      pillar: null,
      category: "BRAND_INTRO",
      bodyJa: "こんにちは。",
      hasCta: false,
      hasShopLink: false,
      media: { type: "BRAND_GRAPHIC", required: false, path: null }
    },
    {
      id: "lostball-day2-japan-origin",
      day: 2,
      pillar: "JAPAN",
      category: "JAPAN_ORIGIN",
      bodyJa: "日本。",
      hasCta: false,
      hasShopLink: false,
      media: { type: "AI_ASSISTED_VISUAL", required: false, path: null }
    },
    {
      id: "lostball-day7-product-shop",
      day: 7,
      pillar: "GOLF",
      category: "PRODUCT_SHOP",
      bodyJa: "ショップ誘導。",
      hasCta: true,
      hasShopLink: true,
      media: { type: "PRODUCT_PHOTO", required: true, path: "assets/lost-ball-product/day7-product-photo.png" }
    }
  ];
}

function sampleInsightsHistory() {
  return {
    snapshots: [
      { threadsPostId: "post-1", sourceItemId: "lostball-day1-brand-intro", fetchedAt: "2026-10-02T00:00:00.000Z", views: 4, likes: 0, replies: 0, reposts: 0, quotes: 0, shares: 0 },
      { threadsPostId: "post-2", sourceItemId: "lostball-day2-japan-origin", fetchedAt: "2026-10-02T00:00:00.000Z", views: 89, likes: 0, replies: 0, reposts: 0, quotes: 0, shares: 0 }
    ]
  };
}

test("buildPerPostView: threads-posts.json・draft-bank.json・insights historyを正しく1つのビューに結合する", () => {
  const view = buildPerPostView({ posts: samplePosts(), bankItems: sampleBankItems(), insightsHistory: sampleInsightsHistory() });
  assert.equal(view.length, 2);
  assert.equal(view[0].sourceItemId, "lostball-day1-brand-intro");
  assert.equal(view[0].hasCta, false);
  assert.equal(view[0].hasImage, false);
  assert.equal(view[0].insights.views, 4);
  assert.equal(view[1].pillar, "JAPAN");
  assert.equal(view[1].insights.views, 89);
});

test("buildPerPostView: media.pathがある投稿はhasImage=true", () => {
  const posts = [{ sourceItemId: "lostball-day7-product-shop", threadsPostId: "post-7", postedAt: "2026-10-04T11:00:00.000Z" }];
  const view = buildPerPostView({ posts, bankItems: sampleBankItems(), insightsHistory: { snapshots: [] } });
  assert.equal(view[0].hasImage, true);
  assert.equal(view[0].hasShopLink, true);
  assert.equal(view[0].hasCta, true);
  assert.equal(view[0].insights, null);
});

test("buildPerPostView: Insightsが無い投稿はinsights=null(データが無いことを隠さない)", () => {
  const posts = [{ sourceItemId: "lostball-day1-brand-intro", threadsPostId: "post-1", postedAt: "2026-09-27T23:29:22.677Z" }];
  const view = buildPerPostView({ posts, bankItems: sampleBankItems(), insightsHistory: { snapshots: [] } });
  assert.equal(view[0].insights, null);
});

test("findUnusedContentIdeas: draft-bank.jsonの本文に現れないworkingTitleだけを返す", () => {
  const contentIdeas = {
    themes: [
      {
        id: "environmental-conservation",
        title: "地球環境の保全",
        postIdeas: [
          { id: "environmental-conservation-01", workingTitle: "ロストボールにもう一度活躍する機会を" },
          { id: "environmental-conservation-05", workingTitle: "ゴルフ×サステナビリティ" }
        ]
      }
    ]
  };
  const bankItems = [{ id: "x", category: "OTHER", bodyJa: "ロストボールにもう一度活躍する機会を与えたいという想い" }];
  const unused = findUnusedContentIdeas({ contentIdeas, bankItems });
  assert.equal(unused.length, 1);
  assert.equal(unused[0].ideaId, "environmental-conservation-05");
});

test("analyzeWeekly: factsにはInsights取得状況の客観的な数字が入る", () => {
  const analysis = analyzeWeekly({
    posts: samplePosts(),
    bankItems: sampleBankItems(),
    insightsHistory: sampleInsightsHistory(),
    contentIdeas: { themes: [] }
  });
  assert.equal(analysis.postedCount, 2);
  assert.ok(analysis.facts.some((f) => f.includes("2件")));
  assert.ok(analysis.facts.some((f) => f.includes("Insightsを取得できた投稿: 2/2件")));
});

test("analyzeWeekly: 投稿数が少ない(10件未満)場合、tentativeTrendsを断定せずopenQuestionsに回す", () => {
  const analysis = analyzeWeekly({
    posts: samplePosts(),
    bankItems: sampleBankItems(),
    insightsHistory: sampleInsightsHistory(),
    contentIdeas: { themes: [] }
  });
  assert.ok(analysis.openQuestions.some((q) => q.includes("判断できません")));
  // pillar別の件数がMIN_SAMPLE_FOR_TREND(3)未満のため、tentativeTrendsにpillar別の断定は入らない。
  assert.equal(analysis.tentativeTrends.length, 0);
});

test("analyzeWeekly: 投稿が0件でも例外を投げない", () => {
  const analysis = analyzeWeekly({ posts: [], bankItems: [], insightsHistory: { snapshots: [] }, contentIdeas: { themes: [] } });
  assert.equal(analysis.postedCount, 0);
  assert.equal(analysis.perPost.length, 0);
});
