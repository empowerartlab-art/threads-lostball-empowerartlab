#!/usr/bin/env node
// daily-live-post.yml の最初に1回だけ「この実行はどの枠か・対象日はいつか」を決める（読み取りのみ・ネットワークなし）。
// 決めた値は GITHUB_OUTPUT（run / date / label / has_run）へ書き出し、後のstepはこの値だけを使う。
//
// 入力（環境変数）:
//   RUN_SCHEDULE   … github.event.schedule（cron で起動したときだけ値が入る）
//   RUN_INPUT      … 手動実行で選んだ枠（auto / legacy_ja / morning / noon / night / night_en）
//   RUN_DATE_INPUT … 手動の dry-run で確認したい日付（live では workflow 側で空にする）
//
// 使い方（手元で確認する場合）: RUN_INPUT=noon RUN_DATE_INPUT=2026-10-20 node scripts/resolve-run.mjs

import fs from "node:fs/promises";
import { resolveRun, runInfo } from "../lib/slots.mjs";

async function output(name, value) {
  if (process.env.GITHUB_OUTPUT) await fs.appendFile(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
}

try {
  const { run, date, source } = resolveRun({
    input: process.env.RUN_INPUT || "",
    schedule: process.env.RUN_SCHEDULE || "",
    date: process.env.RUN_DATE_INPUT || ""
  });
  const info = run ? runInfo(run) : null;
  const label = info ? `${info.label} ${info.time}` : "";
  await output("run", run ?? "");
  await output("date", date);
  await output("label", label);
  await output("has_run", run ? "true" : "false");
  console.log(run ? `枠: ${run}（${label} JST） 対象日: ${date}（決め方: ${source}）` : `対象日 ${date} の今の時刻に投稿する枠はありません（決め方: ${source}）`);
} catch (err) {
  // 合図(mode=tick)の slot が不正なときは、ここで失敗(赤)にせず「枠なし」として続け、
  // 次の run gate step が理由(unknown-slot 等)を付けて見送る(投稿しない・緑で終わる)。
  if (process.env.RUN_MODE === "tick") {
    await output("run", "");
    await output("date", "");
    await output("label", "");
    await output("has_run", "false");
    console.log(`合図(tick)の枠を決められません(${err.message})。投稿しません`);
    process.exit(0);
  }
  console.error(`枠を決められませんでした: ${err.message}`);
  process.exit(1);
}
