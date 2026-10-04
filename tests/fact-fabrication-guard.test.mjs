import { test } from "node:test";
import assert from "node:assert/strict";
import { checkFactFabricationSignals } from "../lib/fact-fabrication-guard.mjs";

test("特定ゴルフ場での回収活動の断定を検出する", () => {
  const result = checkFactFabricationSignals({ bodyJa: "今週、〇〇ゴルフ場で回収しました。", bodyEn: "" });
  assert.ok(result.warnings.some((w) => w.family === "unverified-collection-claim"));
});

test("回収数の具体的な数字の創作を検出する(日本語)", () => {
  const result = checkFactFabricationSignals({ bodyJa: "今週500球回収しました。", bodyEn: "" });
  assert.ok(result.warnings.some((w) => w.family === "fabricated-count-claim"));
});

test("回収数の具体的な数字の創作を検出する(英語)", () => {
  const result = checkFactFabricationSignals({ bodyJa: "", bodyEn: "We collected 500 balls this week." });
  assert.ok(result.warnings.some((w) => w.family === "fabricated-count-claim"));
});

test("寄付数・販売数の数字の創作も検出する", () => {
  const result = checkFactFabricationSignals({ bodyJa: "今月は1000個販売しました。", bodyEn: "" });
  assert.ok(result.warnings.some((w) => w.family === "fabricated-count-claim"));
});

test("存在確認できない取引先・協力企業の関係断定を検出する", () => {
  const result = checkFactFabricationSignals({ bodyJa: "〇〇ゴルフ場と提携しています。", bodyEn: "" });
  assert.ok(result.warnings.some((w) => w.family === "unverified-partner-claim"));
});

test("利用者の架空の発言・エピソードを検出する", () => {
  const result = checkFactFabricationSignals({ bodyJa: "利用者が「楽しい」と言った。", bodyEn: "" });
  assert.ok(result.warnings.some((w) => w.family === "fabricated-user-episode"));
});

test("利用者の障害・症状等の創作を検出する", () => {
  const result = checkFactFabricationSignals({ bodyJa: "利用者の障害について説明します。", bodyEn: "" });
  assert.ok(result.warnings.some((w) => w.family === "fabricated-health-info"));
});

test("CO2削減量等の環境効果の断定を検出する", () => {
  const result = checkFactFabricationSignals({ bodyJa: "CO2を大幅に削減しました。", bodyEn: "" });
  assert.ok(result.warnings.some((w) => w.family === "unverified-environmental-impact"));
});

test("寄付実績の具体的な金額の創作を検出する", () => {
  const result = checkFactFabricationSignals({ bodyJa: "今月は10万円寄付しました。", bodyEn: "" });
  assert.ok(result.warnings.some((w) => w.family === "fabricated-donation-achievement"));
});

test("一般的なテーマ・価値観の記述には反応しない(「回収する」という行為一般への言及は問題ない)", () => {
  const result = checkFactFabricationSignals({
    bodyJa: "ロストボールを再利用する意味。捨てずにもう一度使う。一球ずつ手作業で磨く。",
    bodyEn: "What it means to give a lost ball a second life. Reuse instead of throwing away."
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.warnings, []);
});

test("プレースホルダー本文(自動生成スケルトン)には反応しない", () => {
  const result = checkFactFabricationSignals({
    bodyJa: "[下書き未作成のプレースホルダーです。pillar: GOLF。候補テーマ: (未定)。]",
    bodyEn: "[DRAFT PLACEHOLDER - not written yet. Pillar: GOLF.]"
  });
  assert.equal(result.ok, true);
});
