// Put today's Instagram publish intent on the remote before anything is published.
// Writes GITHUB_OUTPUT skip=true when nothing is scheduled today, so the workflow
// can stop quietly.
import { appendFileSync } from 'node:fs';
import { runIgClaim } from '../lib/ig-flow.mjs';
import { fileIo } from '../lib/json-io.mjs';
import { gitRunner } from '../lib/ig-persist.mjs';
import { jstDateKey } from '../lib/target-date.mjs';

const result = await runIgClaim({
  io: fileIo,
  git: gitRunner(),
  branch: process.env.GITHUB_REF_NAME || 'main',
  today: process.env.TARGET_DATE || jstDateKey(),
  runId: process.env.GITHUB_RUN_ID || 'local',
  runAttempt: process.env.GITHUB_RUN_ATTEMPT || '1',
  now: () => new Date().toISOString(),
  log: console.log,
});
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `skip=${result.skip ? 'true' : 'false'}\n`);
process.exit(result.code);
