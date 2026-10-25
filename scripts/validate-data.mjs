#!/usr/bin/env node
// data/*.json の構造整合性チェック。Threads/Meta APIへは一切接続しない(ローカルファイルI/Oのみ)。

import fs from "node:fs/promises";
import { checkBilingualBody } from "../lib/bilingual-guard.mjs";
import { canUseCandidate } from "../lib/verified-fact-guard.mjs";
import { checkClaims } from "../lib/claim-guard.mjs";
import { checkMedia } from "../lib/media-guard.mjs";
import { checkProjectName, projectNameProblem, isProjectNameRuleDate } from "../lib/project-name-guard.mjs";
import { validateBankSlots, SLOTS_START, DAILY_SLOT_KEYS, itemSlotKey, isSlotItem, hasSlotImage } from "../lib/slots.mjs";

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

// プロジェクト名の書き方（2026-10-25 決定: 「ひとりじゃないよプロジェクト」。lib/project-name-guard.mjs）。
// 投稿済みの記録と 2026-10-25 以前の項目は対象外。日付の無いストックは警告だけ。
for (const item of bankFile.items || []) {
  const errs = checkProjectName(item);
  if (!errs.length) continue;
  if (isProjectNameRuleDate(item.targetDate)) for (const e of errs) fail(`draft-bank.json[${item.id}]: ${e}`);
  else if (item.targetDate == null) for (const e of errs) warn(`draft-bank.json[${item.id}]（日付なし）: ${e}`);
}
for (const item of candidatesFile.items || []) for (const e of checkProjectName(item)) fail(`draft-bank-candidates.json[${item.id}]: ${e}`);
for (const fact of factsFile.facts || []) {
  for (const k of ["statementJa", "statementEn"]) {
    const p = projectNameProblem(fact[k]);
    if (p) fail(`verified-facts.json[${fact.id}].${k}: ${p}`);
  }
}
for (const [file, data] of [
  ["brand-profile.json", brand],
  ["media-policy.json", await readJson("../data/media-policy.json")],
  ["reply-link-texts.json", await readJson("../data/reply-link-texts.json")]
]) {
  if (projectNameProblem(JSON.stringify(data))) fail(`${file}: ${projectNameProblem(JSON.stringify(data))}`);
}

// 1日4本（2026-10-20〜）: 承認済みの枠のルール（lib/slots.mjs の validateBankSlots）。
const slotCheck = validateBankSlots(bankFile.items);
for (const e of slotCheck.errors) fail(e);
for (const w of slotCheck.warnings) warn(w);

// 枠付き投稿の画像（2026-10-17〜）: 指定したファイルが本当にリポジトリにあるか（無いとThreadsが画像を取りに来て失敗する）。
for (const item of [...(bankFile.items || []), ...(candidatesFile.items || [])]) {
  if (!isSlotItem(item) || !hasSlotImage(item) || typeof item.media.path !== "string") continue;
  if (item.media.path.startsWith("hetaro-media/")) continue; // ヘタ郎の画像は別のリポジトリ（公開URLで配信）
  try {
    await fs.access(new URL(`../${item.media.path}`, import.meta.url));
  } catch {
    fail(`${item.id}: 画像ファイルがありません（${item.media.path}）`);
  }
}

// 候補は「枠の値が正しいか」だけを見る（4枠そろっているかは承認時に scripts/bulk-approve.mjs が確かめる）。
for (const c of candidatesFile.items || []) {
  const label = `draft-bank-candidates.json[${c.id ?? "?"}]`;
  if (isSlotItem(c)) {
    if (!DAILY_SLOT_KEYS.includes(itemSlotKey(c))) fail(`${label}: slot/lang が不正です（slot=${c.slot} lang=${c.lang ?? "(なし)"}）`);
    if (typeof c.targetDate !== "string" || c.targetDate < SLOTS_START) fail(`${label}: slot 付きの候補は ${SLOTS_START} 以降だけです`);
  } else if (typeof c.targetDate === "string" && c.targetDate >= SLOTS_START && c.status !== "needs_human_draft") {
    warn(`${label}: ${SLOTS_START} 以降の候補には slot と lang が必要です（このままでは承認できません）`);
  }
}

console.log(`検証完了: error=${errorCount} warning=${warningCount}`);
if (errorCount > 0) process.exit(1);
