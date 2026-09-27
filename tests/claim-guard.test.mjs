import { test } from "node:test";
import assert from "node:assert/strict";
import { checkAbsoluteClaims, checkUnfoundedEnvironmentalStats, checkWelfarePityAppeal, checkClaims } from "../lib/claim-guard.mjs";

test("checkAbsoluteClaims: 日本語の未確認断定語を検知する", () => {
  const warnings = checkAbsoluteClaims({ bodyEn: "", bodyJa: "すべてのボールが新品同様です。" });
  assert.ok(warnings.some((w) => w.family === "absolute-claim" && w.match === "すべて"));
});

test("checkAbsoluteClaims: 英語のall/everyを検知する(警告のみ)", () => {
  const warnings = checkAbsoluteClaims({ bodyEn: "Every ball we sell carries their sticker.", bodyJa: "" });
  assert.ok(warnings.some((w) => w.family === "absolute-claim" && w.lang === "en"));
});

test("checkAbsoluteClaims: 断定語が無ければ警告0件", () => {
  const warnings = checkAbsoluteClaims({ bodyEn: "We give it another chance.", bodyJa: "もう一度活躍の場を与えます。" });
  assert.equal(warnings.length, 0);
});

test("checkUnfoundedEnvironmentalStats: 根拠のなさそうな数値表現を検知する", () => {
  const warnings = checkUnfoundedEnvironmentalStats({ bodyEn: "We reduced waste by 30%.", bodyJa: "" });
  assert.ok(warnings.length >= 1);
});

test("checkWelfarePityAppeal: 同情訴求になりやすい表現を検知する", () => {
  const warnings = checkWelfarePityAppeal({ bodyJa: "障害者だから、ぜひ買ってあげてください。" });
  assert.ok(warnings.length >= 1);
});

test("checkClaims: 3種のチェックをまとめて実行する", () => {
  const warnings = checkClaims({
    bodyEn: "Every ball helps reduce waste by 50%.",
    bodyJa: "障害者だからかわいそうなので買ってください。"
  });
  const families = new Set(warnings.map((w) => w.family));
  assert.ok(families.has("absolute-claim"));
  assert.ok(families.has("env-stat"));
  assert.ok(families.has("welfare-pity"));
});
