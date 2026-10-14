// x-claim.mjs / x-publish.mjs 共通: 環境変数から「どの枠・どの日」を決める（読み取りのみ）。
//   X_RUN       … scripts/x-resolve-run.mjs が決めた run（legacy / morning / noon / night）。workflow は必ず渡す。
//   TARGET_DATE … 対象日（JST の YYYY-MM-DD）。
// X_RUN が無いとき（手元で試すとき）は、今の時刻（JST）までに来た最後の枠を使う。
import { jstToday } from './x-flow.mjs';
import { planXRun, resolveXRun } from './x-slots.mjs';

export function xRunFromEnv(env = process.env, now = new Date()) {
  const today = env.TARGET_DATE || jstToday(now);
  const run = env.X_RUN || resolveXRun({ input: 'auto', date: today, now }).run;
  return { today, run: run || null, plan: run ? planXRun(run, today) : { kind: 'none', reason: 'no-run-for-this-time' } };
}
