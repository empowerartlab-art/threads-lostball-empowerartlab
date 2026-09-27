import { test } from "node:test";
import assert from "node:assert/strict";
import { buildBilingualBody, checkBilingualBody, MAX_COMBINED_LENGTH } from "../lib/bilingual-guard.mjs";

test("buildBilingualBody: 英語→空行→日本語の順で結合する", () => {
  const body = buildBilingualBody("Hello", "こんにちは");
  assert.equal(body, "Hello\n\nこんにちは");
});

test("checkBilingualBody: 正常な併記本文はOK", () => {
  const result = checkBilingualBody({ bodyEn: "Hello there.", bodyJa: "こんにちは。" });
  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
});

test("checkBilingualBody: bodyEnが空ならNG", () => {
  const result = checkBilingualBody({ bodyEn: "", bodyJa: "こんにちは。" });
  assert.equal(result.ok, false);
  assert.ok(result.errors.includes("bodyEn-empty"));
});

test("checkBilingualBody: bodyJaが空ならNG", () => {
  const result = checkBilingualBody({ bodyEn: "Hello.", bodyJa: "" });
  assert.equal(result.ok, false);
  assert.ok(result.errors.includes("bodyJa-empty"));
});

test(`checkBilingualBody: 合計${MAX_COMBINED_LENGTH}文字を超えるとNG`, () => {
  const result = checkBilingualBody({ bodyEn: "a".repeat(300), bodyJa: "あ".repeat(300) });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.startsWith("combined-length-exceeds")));
});

test("checkBilingualBody: 本文に生URLが含まれるとNG", () => {
  const result = checkBilingualBody({ bodyEn: "Shop here: https://empower.base.shop/", bodyJa: "こちらから。" });
  assert.equal(result.ok, false);
  assert.ok(result.errors.includes("raw-url-in-body"));
});

test("checkBilingualBody: 生URLが無ければ「link in bio」等の表現はOK", () => {
  const result = checkBilingualBody({ bodyEn: "Link in bio.", bodyJa: "プロフィールのリンクから。" });
  assert.equal(result.ok, true);
});
