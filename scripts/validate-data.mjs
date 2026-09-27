#!/usr/bin/env node
// data/*.json の構造整合性チェック。Threads/Meta APIへは一切接続しない(ローカルファイルI/Oのみ)。

import fs from "node:fs/promises";
import { checkBilingualBody } from "../lib/bilingual-guard.mjs";
import { canUseCandidate } from "../lib/verified-fact-guard.mjs";
import { checkClaims } from "../lib/claim-guard.mjs";
import { checkMedia } from "../lib/media-guard.mjs";

const ALLOWED_PILLARS = new Set(["JAPAN", "ENVIRONMENT", "WELFARE", "SOCIAL_CONTRIBUTION", "GOLF"]);

async function readJson(path) {
  return JSON.parse(await fs.readFile(new URL(path, import.meta.url), "utf8"));
}

let errorCount = 0;
let warningCount = 0;

function fail(message) {
  errorCount += 1;
  console.error(`NG: ${message}`);
}

function warn(message) {
  warningCount += 1;
  console.warn(`warning: ${message}`);
}

const brand = await readJson("../data/brand-profile.json");
const factsFile = await readJson("../data/verified-facts.json");
const bankFile = await readJson("../data/draft-bank.json");
const candidatesFile = await readJson("../data/draft-bank-candidates.json");

const brandPillarIds = new Set((brand.pillars || []).map((p) => p.id));
for (const id of ALLOWED_PILLARS) {
  if (!brandPillarIds.has(id)) fail(`brand-profile.json に5軸のうち ${id} がありません`);
}

const factIds = new Set();
for (const fact of factsFile.facts || []) {
  if (!fact.id) fail("verified-facts.json に id の無い事実があります");
  if (factIds.has(fact.id)) fail(`verified-facts.json の id が重複しています: ${fact.id}`);
  factIds.add(fact.id);
  if (fact.verified !== true) warn(`未検証(verified:false)の事実が含まれています: ${fact.id}`);
}

function validateItems(items, label) {
  const seenIds = new Set();
  for (const item of items || []) {
    if (!item.id) {
      fail(`${label}: id の無いアイテムがあります`);
      continue;
    }
    if (seenIds.has(item.id)) fail(`${label}: id が重複しています: ${item.id}`);
    seenIds.add(item.id);

    if (item.pillar !== null && !ALLOWED_PILLARS.has(item.pillar)) {
      fail(`${label}[${item.id}]: pillar が5軸のいずれでもありません: ${item.pillar}`);
    }

    const bilingual = checkBilingualBody(item);
    if (!bilingual.ok) {
      fail(`${label}[${item.id}]: 併記フォーマットNG (${bilingual.errors.join(", ")})`);
    }

    const factCheck = canUseCandidate(item, factsFile.facts);
    if (!factCheck.ok) {
      fail(`${label}[${item.id}]: verified-facts.json との整合NG (${factCheck.reason})`);
    }

    for (const w of checkClaims(item)) {
      warn(`${label}[${item.id}]: 表現チェック警告 [${w.family}:${w.lang}] "${w.match}"`);
    }

    const mediaCheck = checkMedia(item);
    for (const e of mediaCheck.errors) {
      fail(`${label}[${item.id}]: メディアNG (${e})`);
    }
    for (const w of mediaCheck.warnings) {
      warn(`${label}[${item.id}]: メディア警告 (${w})`);
    }
  }
}

validateItems(bankFile.items, "draft-bank.json");
validateItems(candidatesFile.items, "draft-bank-candidates.json");

console.log(`検証完了: error=${errorCount} warning=${warningCount}`);
if (errorCount > 0) process.exit(1);
