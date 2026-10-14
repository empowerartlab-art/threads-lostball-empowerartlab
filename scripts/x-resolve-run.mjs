#!/usr/bin/env node
// x-post.yml の最初に1回だけ「この実行はどの枠か・対象日はいつか」を決める（読み取りのみ・ネットワークなし）。
// 決めた値は GITHUB_OUTPUT（run / date / label / has_run）へ書き出し、後の step はこの値だけを使う。
// （Threads の scripts/resolve-run.mjs と同じ作り。X の枠は lib/x-slots.mjs）
//
// 入力（環境変数）:
//   RUN_SCHEDULE   … github.event.schedule（cron で起動したときだけ値が入る）
//   RUN_INPUT      … 手動実行で選んだ枠（auto / legacy / morning / noon / night）
//   RUN_DATE_INPUT … 手動実行（dry-run）で確認したい日付
//
// 手元で確認する場合: RUN_INPUT=noon RUN_DATE_INPUT=2026-10-20 node scripts/x-resolve-run.mjs

import fs from 'node:fs/promises';
import { resolveXRun, xRunInfo, planXRun } from '../lib/x-slots.mjs';

async function output(name, value) {
  if (process.env.GITHUB_OUTPUT) await fs.appendFile(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
}

try {
  const { run, date, source } = resolveXRun({
    input: process.env.RUN_INPUT || '',
    schedule: process.env.RUN_SCHEDULE || '',
    date: process.env.RUN_DATE_INPUT || '',
  });
  const plan = run ? planXRun(run, date) : { kind: 'none', reason: 'no-run-for-this-time' };
  const active = plan.kind !== 'none';
  const info = run ? xRunInfo(run) : null;
  const label = info ? `${info.label} ${info.time}` : '';
  await output('run', run ?? '');
  await output('date', date);
  await output('label', label);
  await output('has_run', active ? 'true' : 'false');
  if (active) console.log(`X の枠: ${run}（${label} JST） 対象日: ${date}（決め方: ${source}）`);
  else console.log(`対象日 ${date} に動く X の枠はありません（run=${run ?? 'なし'} 理由=${plan.reason} 決め方: ${source}）`);
} catch (err) {
  console.error(`X の枠を決められませんでした: ${err.message}`);
  process.exit(1);
}
