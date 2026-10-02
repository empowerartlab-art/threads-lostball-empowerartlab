import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { checkBilingualBody } from "../lib/bilingual-guard.mjs";
import { canUseCandidate } from "../lib/verified-fact-guard.mjs";
import { checkMedia, canSelectForProduction, MEDIA_TYPES } from "../lib/media-guard.mjs";

const ALLOWED_PILLARS = new Set(["JAPAN", "ENVIRONMENT", "WELFARE", "SOCIAL_CONTRIBUTION", "GOLF"]);

async function readJson(path) {
  return JSON.parse(await fs.readFile(new URL(path, import.meta.url), "utf8"));
}

const bankFile = await readJson("../data/draft-bank.json");
const factsFile = await readJson("../data/verified-facts.json");
const brandFile = await readJson("../data/brand-profile.json");
const categoryFile = await readJson("../data/category-profile.json");

test("draft-bank.json には初期7投稿(DAY1〜7)に加え、DAY8〜DAY12のうちDAY11を除く4件、およびDAY13〜DAY15が登録されている(DAY11はverified-facts確認待ちのため保留)", () => {
  assert.equal(bankFile.items.length, 14);
  const days = bankFile.items.map((i) => i.day).sort((a, b) => a - b);
  assert.deepEqual(days, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 13, 14, 15]);
});

test("初期7投稿(DAY1〜7)の本文(bodyEn/bodyJa)は今回の追加(DAY8以降)で一切変更されていない", () => {
  const originalBodies = {
    "lostball-day1-brand-intro": {
      bodyEn:
        "New account, quick intro 👋\nWe give lost golf balls from Japan a second life — cleaned, checked, and hand-polished.\nJapan, the environment, welfare work, and giving back, all tied together. More on each, soon.",
      bodyJa:
        "はじめまして👋\n日本のロストボールを、洗浄・チェック・手磨きを経てもう一度使えるようにしています。\n日本らしさ、環境、福祉の仕事、社会貢献。それぞれを少しずつ紹介していきます。"
    },
    "lostball-day2-japan-origin": {
      bodyEn:
        "Our lost balls are collected from golf courses in Japan.\nEach ball is then checked and given a second life, one by one, by hand.",
      bodyJa:
        "このロストボールは、日本国内のゴルフ場で回収したものです。\n回収したボールを1球ずつ手作業で確認し、もう一度活躍できる状態へと整えています。"
    },
    "lostball-day6-hitori-janai-yo-project": {
      bodyEn:
        "A portion of our sales supports 一人じゃないよプロジェクト ('Hitori Janai yo') — born from a wish to see fewer children feel alone. They've even made a picture book about it.\nThe balls we sell come with a peel-and-stick sticker.",
      bodyJa:
        "ロストボールの売上の一部は、『一人じゃないよプロジェクト』への寄付にあてています。『ひとりで寂しい思いをする子を減らしたい』という想いから生まれ、その想いを伝える絵本もつくられました。\n販売するボールには、剥がして貼れるステッカーが付いています。"
    }
  };
  for (const [id, body] of Object.entries(originalBodies)) {
    const item = bankFile.items.find((i) => i.id === id);
    assert.ok(item, `${id}がdraft-bank.jsonに見つからない`);
    assert.equal(item.bodyEn, body.bodyEn, `${id}: bodyEnが変更されている`);
    assert.equal(item.bodyJa, body.bodyJa, `${id}: bodyJaが変更されている`);
  }
});

test("初期7投稿はすべて人間による明示承認(approvedBy/approvedAt)を持つ", () => {
  for (const item of bankFile.items) {
    assert.ok(item.approvedBy && item.approvedBy.trim(), `${item.id}: approvedByが無い`);
    assert.ok(item.approvedAt, `${item.id}: approvedAtが無い`);
  }
});

test("初期7投稿はすべて英語→日本語の併記フォーマット(合計500文字以内・生URLなし)を満たす", () => {
  for (const item of bankFile.items) {
    const result = checkBilingualBody(item);
    assert.equal(result.ok, true, `${item.id}: ${result.errors.join(", ")}`);
  }
});

test("初期7投稿のpillarはnull、または5軸のいずれかである", () => {
  for (const item of bankFile.items) {
    if (item.pillar !== null) {
      assert.ok(ALLOWED_PILLARS.has(item.pillar), `${item.id}: 不明なpillar ${item.pillar}`);
    }
  }
});

test("初期7投稿が参照するverifiedFactIdsはすべてverified-facts.json上でverified:trueである", () => {
  for (const item of bankFile.items) {
    const result = canUseCandidate(item, factsFile.facts);
    assert.equal(result.ok, true, `${item.id}: ${result.reason}`);
  }
});

test("ショップ誘導(hasShopLink)が立っているのはDAY7のみ", () => {
  const shopLinkDays = bankFile.items.filter((i) => i.hasShopLink).map((i) => i.day);
  assert.deepEqual(shopLinkDays, [7]);
});

test("CTA(hasCta)が立っているのはDAY7のみ", () => {
  const ctaDays = bankFile.items.filter((i) => i.hasCta).map((i) => i.day);
  assert.deepEqual(ctaDays, [7]);
});

test("brand-profile.json の5軸とcategory-profile.json の5軸が一致する", () => {
  const brandPillars = (brandFile.pillars || []).map((p) => p.id).sort();
  const categoryPillars = [...categoryFile.pillars].sort();
  assert.deepEqual(brandPillars, categoryPillars);
  assert.deepEqual(categoryPillars, [...ALLOWED_PILLARS].sort());
});

test("category-profile.json の initialSevenDayPlan がdraft-bank.jsonのカテゴリー・pillarと一致する", () => {
  for (const plan of categoryFile.initialSevenDayPlan) {
    const item = bankFile.items.find((i) => i.day === plan.day);
    assert.ok(item, `day=${plan.day} がdraft-bank.jsonに無い`);
    assert.equal(item.category, plan.category);
    assert.equal(item.pillar, plan.pillar);
  }
});

test("verified-facts.json の16件の事実がすべてverified:trueで登録されている", () => {
  assert.equal(factsFile.facts.length, 16);
  for (const fact of factsFile.facts) {
    assert.equal(fact.verified, true, `${fact.id} が未検証`);
  }
});

test("draft-bank-candidates.json は現時点で空である(週2以降の提案は未生成)", async () => {
  const candidatesFile = await readJson("../data/draft-bank-candidates.json");
  assert.deepEqual(candidatesFile.items, []);
});

test("threads-posts.json の構造が正しい(Phase 3の実投稿開始後は0件以上になり得る)", async () => {
  const postsFile = await readJson("../data/threads-posts.json");
  assert.ok(Array.isArray(postsFile.posts));
  assert.equal(postsFile.count, postsFile.posts.length);
  if (postsFile.posts.length > 0) {
    assert.equal(typeof postsFile.updatedAt, "string");
    assert.ok(!Number.isNaN(Date.parse(postsFile.updatedAt)), "updatedAtが有効な日時文字列でない");
  }
  for (const post of postsFile.posts) {
    assert.ok(post.sourceItemId, "sourceItemIdが無い投稿記録がある");
    assert.ok(post.threadsPostId, `${post.sourceItemId}: threadsPostIdが無い`);
    assert.ok(post.bodyEn && post.bodyJa, `${post.sourceItemId}: bodyEn/bodyJaが無い`);
    assert.ok(
      bankFile.items.some((i) => i.id === post.sourceItemId),
      `${post.sourceItemId}: draft-bank.jsonに存在しないsourceItemIdが記録されている`
    );
  }
});

test("初期7投稿はすべて有効なmediaTypeを持ち、構造チェックにパスする", () => {
  for (const item of bankFile.items) {
    assert.ok(item.media, `${item.id}: mediaが無い`);
    assert.ok(MEDIA_TYPES.includes(item.media.type), `${item.id}: 不明なmediaType ${item.media.type}`);
    const result = checkMedia(item);
    assert.equal(result.ok, true, `${item.id}: ${result.errors.join(", ")}`);
  }
});

test("DAY7のみmedia.required=trueで、画像必須の想定になっている", () => {
  const requiredDays = bankFile.items.filter((i) => i.media.required).map((i) => i.day);
  assert.deepEqual(requiredDays, [7]);
});

test("DAY7は画像が未承認のため、現時点では本番選出できない(canSelectForProduction=false)", () => {
  const day7 = bankFile.items.find((i) => i.day === 7);
  const result = canSelectForProduction(day7);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "media-not-approved");
});

test("DAY1〜6はmedia.required=falseのため、画像未承認でも現時点で本番選出できる(canSelectForProduction=true)", () => {
  for (const item of bankFile.items.filter((i) => i.day !== 7)) {
    const result = canSelectForProduction(item);
    assert.equal(result.ok, true, `${item.id}: ${result.reason}`);
  }
});

test("実写系(REAL_PHOTO/REAL_WORK/PRODUCT_PHOTO)のうち、まだ承認されていないものはaiVisualAllowedが方針として妥当な値になっている", () => {
  // DAY3/DAY5(REAL_WORK)・DAY6(PRODUCT_PHOTO)は実在の人物・商品の証拠用途のためAI代替を許容しない。
  // DAY4(REAL_PHOTO)のみ、実写が無い場合の環境イメージAI代替を許容する方針。
  const strict = bankFile.items.filter((i) => ["lostball-day3-hand-polishing-process", "lostball-day5-welfare-jobs", "lostball-day6-hitori-janai-yo-project"].includes(i.id));
  for (const item of strict) {
    assert.equal(item.media.aiVisualAllowed, false, `${item.id}: AI代替を許容すべきではない`);
  }
  const day4 = bankFile.items.find((i) => i.id === "lostball-day4-reuse");
  assert.equal(day4.media.aiVisualAllowed, true);
});
