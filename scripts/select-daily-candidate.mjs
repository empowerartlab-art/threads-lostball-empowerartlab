// ローカル選出のみ。Threads/Meta APIへは一切接続せず、投稿も行わない。
// draft-bank.json から「今日投稿してよい候補」を選び、標準出力に表示するだけ。

import fs from "node:fs/promises";
import { jstDateKey, selectDueItems } from "../lib/target-date.mjs";
import { buildPostedBodySet, isDuplicateBody, isPostedInLang } from "../lib/duplicate-guard.mjs";
import { canUseCandidate } from "../lib/verified-fact-guard.mjs";
import { checkBilingualBody, buildBilingualBody } from "../lib/bilingual-guard.mjs";
import { checkClaims } from "../lib/claim-guard.mjs";
import { checkFactFabricationSignals } from "../lib/fact-fabrication-guard.mjs";
import { canSelectForProduction, isMediaApproved, defaultMedia } from "../lib/media-guard.mjs";

const BANK_PATH = new URL("../data/draft-bank.json", import.meta.url);
const POSTS_PATH = new URL("../data/threads-posts.json", import.meta.url);
const FACTS_PATH = new URL("../data/verified-facts.json", import.meta.url);

async function readJson(url, fallback) {
  try {
    return JSON.parse(await fs.readFile(url, "utf8"));
  } catch {
    return fallback;
  }
}

export async function selectDailyCandidate({ bankItems, postedPosts, facts, todayKey = jstDateKey(), lang = "both" }) {
  const postedBodies = buildPostedBodySet(postedPosts);
  const ordered = selectDueItems(bankItems, todayKey);
  const skipped = [];

  for (const item of ordered) {
    if (isDuplicateBody(item, postedBodies)) {
      skipped.push({ item, reason: "duplicate-of-posted" });
      continue;
    }
    if (lang !== "both" && isPostedInLang(item, postedPosts, lang)) {
      skipped.push({ item, reason: `already-posted-in-${lang}` });
      continue;
    }
    const check = canUseCandidate(item, facts);
    if (!check.ok) {
      skipped.push({ item, reason: check.reason });
      continue;
    }
    // verified-fact-guard(canUseCandidate)はrequiresVerifiedFact:trueの項目しか検証しない。
    // draft-bank.jsonが直接手編集される等でこのフラグを立てずに具体的な未確認事実を含む
    // 本文が入り込んだ場合に備えた、選出時点での最終防衛線(scripts/promote-candidates.mjsの
    // 昇格時チェックと同じガードを、ここでも独立に適用する)。
    if (item.requiresVerifiedFact !== true) {
      const fabrication = checkFactFabricationSignals(item);
      if (!fabrication.ok) {
        skipped.push({
          item,
          reason: `unverified-fact-fabrication:${fabrication.warnings.map((w) => w.family).join(",")}`
        });
        continue;
      }
    }
    // 画像が必須(media.required===true)の投稿は、人間が承認した実際の素材が無い限り選出しない。
    // 代わりにAI画像を自動生成する処理はここには一切無い(lib/media-guard.mjs参照)。
    const mediaCheck = canSelectForProduction(item);
    if (!mediaCheck.ok) {
      skipped.push({ item, reason: mediaCheck.reason });
      continue;
    }
    return { selected: item, skipped };
  }
  return { selected: null, skipped };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const bank = await readJson(BANK_PATH, { items: [] });
  const postsFile = await readJson(POSTS_PATH, { posts: [] });
  const factsFile = await readJson(FACTS_PATH, { facts: [] });

  const { selected, skipped } = await selectDailyCandidate({
    bankItems: bank.items,
    postedPosts: postsFile.posts,
    facts: factsFile.facts
  });

  for (const { item, reason } of skipped) {
    console.warn(`SKIP: day=${item.day ?? "?"} category=${item.category || "?"} reason=${reason}`);
  }

  if (!selected) {
    console.log("本日投稿できる候補はありません(全件投稿済み、または未検証の事実を含む可能性があります)。");
  } else {
    console.log("=== 本日の投稿候補(ローカル選出のみ・投稿は行いません) ===");
    console.log(JSON.stringify(selected, null, 2));

    const bilingualCheck = checkBilingualBody(selected);
    const claimWarnings = checkClaims(selected);

    console.log("");
    console.log("--- 併記フォーマットチェック ---");
    console.log(bilingualCheck.ok ? "OK" : `NG: ${bilingualCheck.errors.join(", ")}`);
    console.log(`合計文字数: ${bilingualCheck.combinedLength}/500`);

    if (claimWarnings.length) {
      console.log("--- 表現チェック警告(投稿前に人間が確認する材料です。投稿はブロックしません) ---");
      for (const w of claimWarnings) {
        console.log(`  [${w.family}:${w.lang}] "${w.match}"`);
      }
    }

    const media = selected.media || defaultMedia();
    console.log("");
    console.log("--- メディア ---");
    console.log(
      `type=${media.type} required=${media.required} 承認済み=${isMediaApproved(media)}${
        media.description ? ` note="${media.description}"` : ""
      }`
    );

    console.log("");
    console.log("--- 投稿本文プレビュー ---");
    console.log(buildBilingualBody(selected.bodyEn, selected.bodyJa));
  }
}
