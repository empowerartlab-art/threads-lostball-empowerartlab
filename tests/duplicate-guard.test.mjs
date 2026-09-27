import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeBody, normalizeBilingualBody, buildPostedBodySet, isDuplicateBody } from "../lib/duplicate-guard.mjs";

test("normalizeBody: URLと余分な空白を除去する", () => {
  const result = normalizeBody("Link:  https://example.com/x  \nこちら  から");
  assert.equal(result, "Link: こちら から");
});

test("normalizeBilingualBody: bodyEn/bodyJaを1つのキーにまとめる", () => {
  const key = normalizeBilingualBody({ bodyEn: "Hello.", bodyJa: "こんにちは。" });
  assert.equal(key, "Hello.\nこんにちは。");
});

test("isDuplicateBody: 投稿済みと完全一致(正規化後)ならtrue", () => {
  const posted = buildPostedBodySet([{ bodyEn: "Hello.", bodyJa: "こんにちは。" }]);
  assert.equal(isDuplicateBody({ bodyEn: "Hello.", bodyJa: "こんにちは。" }, posted), true);
});

test("isDuplicateBody: 内容が違えばfalse", () => {
  const posted = buildPostedBodySet([{ bodyEn: "Hello.", bodyJa: "こんにちは。" }]);
  assert.equal(isDuplicateBody({ bodyEn: "Good bye.", bodyJa: "さようなら。" }, posted), false);
});
