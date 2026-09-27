import { test } from "node:test";
import assert from "node:assert/strict";
import { buildDryRunReport } from "../lib/post-report.mjs";

const facts = [{ id: "fact-a", verified: true }];

const baseItem = {
  id: "item-1",
  day: 1,
  pillar: "JAPAN",
  category: "BRAND_INTRO",
  bodyEn: "Hello there.",
  bodyJa: "こんにちは。",
  hasCta: false,
  hasShopLink: false,
  requiresVerifiedFact: true,
  verifiedFactIds: ["fact-a"],
  targetDate: null,
  media: { type: "TEXT_ONLY", required: false }
};

test("buildDryRunReport: 正常系はguardsOk=trueでresult=DRY_RUN", () => {
  const report = buildDryRunReport(baseItem, { postedBodySet: new Set(), facts });
  assert.equal(report.result, "DRY_RUN");
  assert.equal(report.guardsOk, true);
  assert.equal(report.media.hasImage, false);
  assert.match(report.body, /Hello there\.\n\nこんにちは。/);
});

test("buildDryRunReport: 未検証の事実を参照しているとverifiedFact.okがfalseになりguardsOkもfalse", () => {
  const item = { ...baseItem, verifiedFactIds: ["missing-fact"] };
  const report = buildDryRunReport(item, { postedBodySet: new Set(), facts });
  assert.equal(report.guards.verifiedFact.ok, false);
  assert.equal(report.guardsOk, false);
});

test("buildDryRunReport: 投稿済みと同一本文ならduplicate.isDuplicate=trueでguardsOk=false", () => {
  const postedBodySet = new Set(["Hello there.\nこんにちは。"]);
  const report = buildDryRunReport(baseItem, { postedBodySet, facts });
  assert.equal(report.guards.duplicate.isDuplicate, true);
  assert.equal(report.guardsOk, false);
});

test("buildDryRunReport: 画像必須かつ承認済みならhasImage=true", () => {
  const item = {
    ...baseItem,
    media: {
      type: "PRODUCT_PHOTO",
      required: true,
      aiVisualAllowed: false,
      altText: "photo",
      path: "assets/photo.jpg",
      approvedBy: "someone@example.com",
      approvedAt: "2026-09-27T00:00:00.000Z"
    }
  };
  const report = buildDryRunReport(item, { postedBodySet: new Set(), facts });
  assert.equal(report.media.hasImage, true);
  assert.equal(report.media.approved, true);
  assert.equal(report.guardsOk, true);
});

test("buildDryRunReport: 画像必須だが未承認ならhasImage=falseでguardsOk=false(自動生成しない)", () => {
  const item = { ...baseItem, media: { type: "PRODUCT_PHOTO", required: true, aiVisualAllowed: false } };
  const report = buildDryRunReport(item, { postedBodySet: new Set(), facts });
  assert.equal(report.media.hasImage, false);
  assert.equal(report.guards.media.canSelectForProduction.ok, false);
  assert.equal(report.guardsOk, false);
});

test("buildDryRunReport: 断定表現はclaimWarningsに載るがguardsOkはブロックしない", () => {
  const item = { ...baseItem, bodyEn: "This works for all golfers." };
  const report = buildDryRunReport(item, { postedBodySet: new Set(), facts });
  assert.ok(report.guards.claimWarnings.some((w) => w.family === "absolute-claim"));
  assert.equal(report.guardsOk, true);
});
