import { test } from "node:test";
import assert from "node:assert/strict";
import { checkMedia, canSelectForProduction, isMediaApproved, defaultMedia } from "../lib/media-guard.mjs";

test("defaultMedia: TEXT_ONLY・required:falseを返す", () => {
  assert.deepEqual(defaultMedia(), { type: "TEXT_ONLY", required: false });
});

test("media未指定のアイテムはTEXT_ONLY扱いでOK", () => {
  const result = checkMedia({});
  assert.equal(result.ok, true);
});

test("TEXT_ONLYはrequired:trueにできない", () => {
  const result = checkMedia({ media: { type: "TEXT_ONLY", required: true } });
  assert.equal(result.ok, false);
  assert.ok(result.errors.includes("text-only-cannot-be-required"));
});

test("不明なmediaTypeはNG", () => {
  const result = checkMedia({ media: { type: "PHOTOSHOP", required: false } });
  assert.equal(result.ok, false);
  assert.ok(result.errors[0].startsWith("invalid-media-type"));
});

test("required:trueだが未承認(path等なし)なら警告のみでエラーにはしない(準備中の正常な状態)", () => {
  const result = checkMedia({ media: { type: "PRODUCT_PHOTO", required: true, aiVisualAllowed: false } });
  assert.equal(result.ok, true);
  assert.ok(result.warnings.includes("required-media-not-yet-approved"));
});

test("承認済みなのにaltTextが無ければNG", () => {
  const result = checkMedia({
    media: {
      type: "PRODUCT_PHOTO",
      required: true,
      aiVisualAllowed: false,
      path: "assets/day7.jpg",
      approvedBy: "someone@example.com",
      approvedAt: "2026-09-27T00:00:00.000Z"
    }
  });
  assert.equal(result.ok, false);
  assert.ok(result.errors.includes("approved-media-missing-alt-text"));
});

test("承認済みの実写系(REAL_PHOTO等)はaiVisualAllowed:trueにできない(AI画像を実写と偽ることを防ぐ)", () => {
  const result = checkMedia({
    media: {
      type: "PRODUCT_PHOTO",
      required: true,
      aiVisualAllowed: true,
      altText: "ロストボール商品写真",
      path: "assets/day7.jpg",
      approvedBy: "someone@example.com",
      approvedAt: "2026-09-27T00:00:00.000Z"
    }
  });
  assert.equal(result.ok, false);
  assert.ok(result.errors.includes("approved-real-media-cannot-be-ai-visual"));
});

test("未承認(計画段階)の実写系はaiVisualAllowed:trueでもOK(将来AI代替を許容する方針表明のため)", () => {
  const result = checkMedia({ media: { type: "REAL_PHOTO", required: false, aiVisualAllowed: true } });
  assert.equal(result.ok, true);
});

test("承認済みAI_ASSISTED_VISUALはaiReferenceNoteが無いとNG(「とりあえずAI画像」を防ぐ)", () => {
  const result = checkMedia({
    media: {
      type: "AI_ASSISTED_VISUAL",
      required: false,
      aiVisualAllowed: true,
      altText: "日本の風景イメージ",
      path: "assets/day2.jpg",
      approvedBy: "someone@example.com",
      approvedAt: "2026-09-27T00:00:00.000Z"
    }
  });
  assert.equal(result.ok, false);
  assert.ok(result.errors.includes("ai-visual-missing-reference-note"));
});

test("承認済みAI_ASSISTED_VISUALでaiReferenceNoteがあればOK", () => {
  const result = checkMedia({
    media: {
      type: "AI_ASSISTED_VISUAL",
      required: false,
      aiVisualAllowed: true,
      altText: "日本の風景イメージ",
      aiReferenceNote: "日本の海沿いゴルフ場複数の写真を参考に構図を検討",
      path: "assets/day2.jpg",
      approvedBy: "someone@example.com",
      approvedAt: "2026-09-27T00:00:00.000Z"
    }
  });
  assert.equal(result.ok, true);
});

test("isMediaApproved: path/approvedBy/approvedAtが全て揃って初めてtrue", () => {
  assert.equal(isMediaApproved({ path: "x", approvedBy: "y" }), false);
  assert.equal(isMediaApproved({ path: "x", approvedBy: "y", approvedAt: "z" }), true);
});

test("canSelectForProduction: TEXT_ONLYは常に選出可能", () => {
  assert.equal(canSelectForProduction({ media: { type: "TEXT_ONLY", required: false } }).ok, true);
});

test("canSelectForProduction: required:falseは未承認でも選出可能(画像は無くてもテキストのみで投稿)", () => {
  assert.equal(canSelectForProduction({ media: { type: "REAL_PHOTO", required: false } }).ok, true);
});

test("canSelectForProduction: required:trueかつ未承認なら選出不可(AIによる自動生成もしない)", () => {
  const result = canSelectForProduction({ media: { type: "PRODUCT_PHOTO", required: true } });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "media-not-approved");
});

test("canSelectForProduction: required:trueでも承認済みなら選出可能", () => {
  const result = canSelectForProduction({
    media: {
      type: "PRODUCT_PHOTO",
      required: true,
      path: "assets/day7.jpg",
      approvedBy: "someone@example.com",
      approvedAt: "2026-09-27T00:00:00.000Z"
    }
  });
  assert.equal(result.ok, true);
});
