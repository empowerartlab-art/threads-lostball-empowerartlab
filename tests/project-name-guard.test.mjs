import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { checkProjectName, projectNameProblem, isProjectNameRuleDate, PROJECT_NAME } from "../lib/project-name-guard.mjs";
import { validateXQueue } from "../lib/x-flow.mjs";
import { validateIgQueue } from "../lib/ig-flow.mjs";
import { validateTexts } from "../lib/reply-link.mjs";

const read = (p) => JSON.parse(fs.readFileSync(new URL(`../data/${p}`, import.meta.url), "utf8"));

test("正式な書き方は「ひとりじゃないよプロジェクト」。漢字の「一人じゃないよ」は止める", () => {
  assert.equal(PROJECT_NAME, "ひとりじゃないよプロジェクト");
  assert.equal(projectNameProblem("売上の一部は「ひとりじゃないよプロジェクト」へ。"), null);
  assert.ok(projectNameProblem("売上の一部は「一人じゃないよプロジェクト」へ。"));
  assert.equal(checkProjectName({ bodyJa: "「一人じゃないよプロジェクト」", media: { altText: "一人じゃないよ" } }).length, 2);
  assert.deepEqual(checkProjectName({ text: "ひとりじゃないよプロジェクト" }), []);
});

test("検査は 2026-10-26 以降の項目だけ（10/25 以前・投稿済みの過去分は対象外）", () => {
  assert.equal(isProjectNameRuleDate("2026-10-25"), false);
  assert.equal(isProjectNameRuleDate("2026-10-26"), true);
  assert.equal(isProjectNameRuleDate(null), false);
});

test("X・IG の予定と返信リンクの文で「一人じゃないよ」が入ると止まる", () => {
  const xErrors = validateXQueue([{ id: "x-test", date: "2026-10-30", pillar: "SOCIAL_CONTRIBUTION", text: "「一人じゃないよプロジェクト」へ。" }]);
  assert.ok(xErrors.some((e) => e.includes("x-test") && e.includes("一人じゃないよ")));
  const ig = validateIgQueue([{ id: "ig-test", date: "2026-10-30", mediaType: "real_photo", images: ["a.jpg"], caption: "「一人じゃないよプロジェクト」へ。" }]);
  assert.ok(ig.errors.some((e) => e.includes("ig-test") && e.includes("一人じゃないよ")));
  const rl = validateTexts([{ id: "t", text: "「一人じゃないよプロジェクト」\nhttps://empower.base.shop/", approved: false }]);
  assert.ok(rl.some((e) => e.includes("一人じゃないよ")));
});

test("事実・ブランド・返信リンクの文・10/26 以降の下書きは「ひとりじゃないよ」にそろっている", () => {
  for (const f of ["verified-facts.json", "brand-profile.json", "media-policy.json", "reply-link-texts.json"]) {
    assert.equal(JSON.stringify(read(f)).includes("一人じゃないよ"), false, `${f} に「一人じゃないよ」が残っている`);
  }
  for (const item of read("draft-bank.json").items) {
    if (isProjectNameRuleDate(item.targetDate)) assert.deepEqual(checkProjectName(item), [], item.id);
  }
  for (const p of read("x-queue.json")) if (isProjectNameRuleDate(p.date)) assert.deepEqual(checkProjectName(p), [], p.id);
  for (const p of read("ig-queue.json")) if (isProjectNameRuleDate(p.date)) assert.deepEqual(checkProjectName(p), [], p.id);
});
