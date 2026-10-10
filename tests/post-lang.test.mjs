import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPostBody } from "../lib/bilingual-guard.mjs";
import { buildPostedBodySet, isDuplicateBody, isPostedInLang } from "../lib/duplicate-guard.mjs";
import { buildPostRecord } from "../lib/threads-publish.mjs";
import { runLivePost, OUTCOME } from "../lib/live-post-runner.mjs";

const item = (id, targetDate) => ({
  id,
  day: 1,
  targetDate,
  pillar: "GOLF",
  category: "TEST",
  bodyEn: `English ${id}`,
  bodyJa: `日本語 ${id}`,
  requiresVerifiedFact: false,
  verifiedFactIds: [],
  media: { type: "TEXT_ONLY", required: false, aiVisualAllowed: false, path: null }
});

test("buildPostBody: ja/enはその言語だけ、bothは英語→日本語の併記", () => {
  assert.equal(buildPostBody("Hi", "やあ", "ja"), "やあ");
  assert.equal(buildPostBody("Hi", "やあ", "en"), "Hi");
  assert.equal(buildPostBody("Hi", "やあ", "both"), "Hi\n\nやあ");
  assert.equal(buildPostBody("Hi", "やあ"), "Hi\n\nやあ");
});

test("isPostedInLang: 言語別の記録は同じ言語だけ投稿済み。従来の併記記録は両言語とも投稿済み", () => {
  const a = item("a", "2026-10-13");
  assert.equal(isPostedInLang(a, [{ sourceItemId: "a", lang: "ja" }], "ja"), true);
  assert.equal(isPostedInLang(a, [{ sourceItemId: "a", lang: "ja" }], "en"), false);
  assert.equal(isPostedInLang(a, [{ sourceItemId: "a" }], "en"), true);
  assert.equal(isPostedInLang(a, [{ sourceItemId: "b", lang: "en" }], "en"), false);
});

test("言語別の記録は併記本文の重複セットに入らない(もう片方の言語が投稿済み扱いにならない)", () => {
  const a = item("a", "2026-10-13");
  const set = buildPostedBodySet([{ ...a, sourceItemId: "a", lang: "ja" }]);
  assert.equal(isDuplicateBody(a, set), false);
  const legacy = buildPostedBodySet([{ ...a, sourceItemId: "a" }]);
  assert.equal(isDuplicateBody(a, legacy), true);
});

test("buildPostRecord: 言語別ならlangを残し、bothなら従来の形のまま", () => {
  const base = { sourceItemId: "a", threadsPostId: "1", bodyEn: "A", bodyJa: "あ", postedAt: "x" };
  assert.equal(buildPostRecord({ ...base, lang: "en" }).lang, "en");
  assert.equal("lang" in buildPostRecord(base), false);
});

async function run(lang, postedPosts, publish) {
  return runLivePost({
    bankItems: [item("d13", "2026-10-13"), item("d14", "2026-10-14")],
    postedPosts,
    facts: [],
    todayKey: "2026-10-14",
    lang,
    live: true,
    env: { LIVE_POST: "true" },
    publish,
    saveState: async () => {}
  });
}

test("runLivePost: 日本語スロットは日本語本文だけを投稿し、記録にlang=jaが付く", async () => {
  const calls = [];
  const publish = async (args) => {
    calls.push(args);
    return { mode: "live", threadsPostId: "p1" };
  };
  const result = await run("ja", [{ sourceItemId: "d13", lang: "ja" }, { sourceItemId: "d13", lang: "en" }], publish);
  assert.equal(result.outcome, OUTCOME.POSTED_STATE_SAVED);
  assert.equal(result.selected.id, "d14");
  assert.equal(calls[0].lang, "ja");
  assert.equal(result.record.lang, "ja");
  assert.equal(result.report.body, "日本語 d14");
});

test("runLivePost: 同じ日の英語スロットは、日本語が投稿済みでも同じアイテムを英語で出す", async () => {
  const publish = async () => ({ mode: "live", threadsPostId: "p2" });
  const posted = [
    { sourceItemId: "d13", lang: "ja" },
    { sourceItemId: "d13", lang: "en" },
    { sourceItemId: "d14", lang: "ja" }
  ];
  const result = await run("en", posted, publish);
  assert.equal(result.selected.id, "d14");
  assert.equal(result.report.body, "English d14");
});

test("runLivePost: その言語で全件投稿済みならNO_CANDIDATEで、投稿しない", async () => {
  let called = false;
  const publish = async () => {
    called = true;
    return { mode: "live", threadsPostId: "x" };
  };
  const posted = [
    { sourceItemId: "d13", lang: "ja" },
    { sourceItemId: "d14", lang: "ja" }
  ];
  const result = await run("ja", posted, publish);
  assert.equal(result.outcome, OUTCOME.NO_CANDIDATE);
  assert.equal(called, false);
});
