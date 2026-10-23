// May this workflow run post? Decides once, right after the step that resolves
// the slot/date, and appends RUN_KIND / RUN_GO / SKIP_REASON to $GITHUB_ENV.
// The claim / publish / record / notify steps run only when RUN_GO=true.
// Reads repository files only: no network, no git.
//
//   schedule  when the repository variable SCHEDULE_LATE_SKIP is "true": posts
//             only inside SLOT_WINDOW of its slot time (lib/tick-gate.mjs); a run
//             GitHub starts too late (or too early) skips and ends green.
//             Unset / anything else (the default): not window-gated, exactly as
//             before (RUN_GO=true).
//   tick      workflow_dispatch with mode=tick (the external clock). Posts only
//             when run_attempt is 1, the slot is one of this workflow's real slots,
//             the date is today (JST), the clock is inside SLOT_WINDOW, and the
//             queue has an approved, unposted item with no open claim in that
//             medium's journal. The claim step stays the final gate (it re-reads
//             the remote journal before anything is posted).
//   manual    any other workflow_dispatch: unchanged (RUN_GO=true; the existing
//             mode=dry-run/live input, or X's confirm=POST LIVE, decides as before).
//             Never window-gated; a live manual run still goes through the claim.
//
// Usage: node scripts/run-gate.mjs --media threads|x|ig
// Env:   GITHUB_EVENT_NAME, GITHUB_RUN_ATTEMPT, RUN_MODE (inputs.mode),
//        SCHEDULE_LATE_SKIP (vars.SCHEDULE_LATE_SKIP; schedule runs only),
//        TICK_SLOT / TICK_DATE / TICK_ID (inputs.slot / date / tick_id),
//        RUN_SLOT / RUN_DATE (steps.resolve.outputs.run / date; Threads and X only)
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { decideRun, runKind, envLines, jstDateOf, RUN_KINDS, scheduleLateSkipOn } from '../lib/tick-gate.mjs';
import { RUNS, SLOTS_START, runInfo } from '../lib/slots.mjs';
import { X_SLOTS, X_SLOTS_START, xRunInfo, planXRun } from '../lib/x-slots.mjs';
import { selectXForRun, X_QUEUE_PATH, X_POSTED_PATH, X_JOURNAL_PATH } from '../lib/x-flow.mjs';
import { selectIgToday, IG_QUEUE_PATH, IG_POSTED_PATH, IG_JOURNAL_PATH } from '../lib/ig-flow.mjs';
import { selectThreadsForRun, THREADS_JOURNAL_PATH } from '../lib/threads-claim.mjs';
import * as J from '../lib/ig-journal.mjs';
import { fileIo } from '../lib/json-io.mjs';

export const IG_SLOT = 'daily'; // the one Instagram slot a tick may name
export const IG_TIME = '07:00'; // ig-post.yml cron "0 22 * * *" = 07:00 JST

const hasApproval = (item) => Boolean(item?.approvedBy && String(item.approvedBy).trim() && item?.approvedAt);

export const MEDIA = {
  threads: {
    journal: THREADS_JOURNAL_PATH,
    start: SLOTS_START,
    // The real slots only: no legacy_ja (05:00, ended 10/19) and no "auto".
    slotTimes: Object.fromEntries(RUNS.filter((r) => r.slot).map((r) => [r.id, r.time])),
    scheduleTime: (slot) => runInfo(slot)?.time,
    select: async (io, date, slot) => {
      const { selected, skipped, plan } = await selectThreadsForRun({ io, todayKey: date, run: slot });
      if (!selected) return { post: null, reason: plan?.kind === 'none' ? plan.reason : skipped?.[0]?.reason ?? 'no-post-scheduled' };
      if (!hasApproval(selected)) return { post: null, reason: 'not-approved' };
      return { post: selected, reason: null };
    },
  },
  x: {
    journal: X_JOURNAL_PATH,
    start: X_SLOTS_START,
    slotTimes: Object.fromEntries(X_SLOTS.map((s) => [s.slot, s.time])),
    scheduleTime: (slot) => xRunInfo(slot)?.time,
    select: async (io, date, slot) => selectXForRun(await io.readJson(X_QUEUE_PATH, []), await io.readJson(X_POSTED_PATH, []), date, planXRun(slot, date)),
  },
  ig: {
    journal: IG_JOURNAL_PATH,
    start: null,
    slotTimes: { [IG_SLOT]: IG_TIME },
    scheduleTime: () => IG_TIME,
    select: async (io, date) => selectIgToday(await io.readJson(IG_QUEUE_PATH, []), await io.readJson(IG_POSTED_PATH, []), date),
  },
};

// The queue part of a tick: an approved, unposted item and no open claim.
async function queueCheck({ m, io, slot, date, env }) {
  if (env.RUN_SLOT !== undefined && (env.RUN_SLOT !== slot || env.RUN_DATE !== date)) {
    return { ok: false, reason: 'decide-mismatch', detail: `resolved "${env.RUN_SLOT}" ${env.RUN_DATE} but the tick is for ${slot} ${date}` };
  }
  const journal = await io.readJson(m.journal, []);
  const open = J.openEntries(journal);
  if (open.length) return { ok: false, reason: 'open-claim', detail: `${open.length} unresolved entr${open.length === 1 ? 'y' : 'ies'} in ${m.journal}: ${open.map(J.describe).join(' | ')}` };
  const { post, reason } = await m.select(io, date, slot);
  if (!post) return { ok: false, reason: reason || 'no-post', detail: `no postable item for ${date} ${slot}` };
  if (journal.some((e) => e.postId === post.id && e.stage === J.PUBLISHED)) {
    return { ok: false, reason: 'already-posted', detail: `${post.id} is recorded as published in ${m.journal}` };
  }
  return { ok: true, detail: `post ${post.id}` };
}

export async function planGate({ media, env = {}, now = new Date(), io = fileIo }) {
  const m = MEDIA[media];
  if (!m) throw new Error(`unknown --media "${media}" (threads|x|ig)`);
  const kind = runKind({ eventName: env.GITHUB_EVENT_NAME, mode: env.RUN_MODE });

  if (kind === RUN_KINDS.SCHEDULE) {
    // The slot and date the workflow already resolved from the cron that fired.
    const slot = media === 'ig' ? IG_SLOT : env.RUN_SLOT;
    const date = media === 'ig' ? jstDateOf(now) : env.RUN_DATE;
    if (!slot || !date) throw new Error('RUN_SLOT / RUN_DATE are not set (the resolve step must run first)');
    return { ...(await decideRun({ kind, slot, date, time: m.scheduleTime(slot), now, scheduleLateSkip: scheduleLateSkipOn(env.SCHEDULE_LATE_SKIP) })), slot, date };
  }

  const slot = String(env.TICK_SLOT ?? '').trim();
  const date = String(env.TICK_DATE ?? '').trim();
  const d = await decideRun({
    kind, runAttempt: env.GITHUB_RUN_ATTEMPT, slot, date, slotTimes: m.slotTimes, start: m.start, now,
    queueCheck: (a) => queueCheck({ m, io, env, ...a }),
  });
  return { ...d, slot: kind === RUN_KINDS.TICK ? slot : env.RUN_SLOT ?? null, date: kind === RUN_KINDS.TICK ? date : env.RUN_DATE ?? null };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const i = process.argv.indexOf('--media');
  const media = i >= 0 ? process.argv[i + 1] : '';
  let d;
  try {
    // The resolve step leaves RUN_SLOT empty when it found no run (e.g. a tick
    // naming an unknown slot); keep "set but empty" distinguishable from unset.
    d = await planGate({ media, env: process.env });
  } catch (err) {
    console.error(`run gate failed, not posting: ${err.message}`);
    process.exit(1);
  }
  const lines = envLines(d);
  if (process.env.GITHUB_ENV) appendFileSync(process.env.GITHUB_ENV, lines.join('\n') + '\n');
  else for (const l of lines) console.log(l);
  const tick = d.kind === RUN_KINDS.TICK ? ` tick_id=${process.env.TICK_ID || '-'}` : '';
  console.log(`gate: media=${media} kind=${d.kind} slot=${d.slot ?? '-'} date=${d.date ?? '-'}${tick} -> ${d.go ? 'GO' : 'SKIP'} (${d.reason}: ${d.detail})`);
  if (!d.go) console.log(`::notice title=Not posting (skipped)::${lines[2].slice('SKIP_REASON='.length)}`);
}
