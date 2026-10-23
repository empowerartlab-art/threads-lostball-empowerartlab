// Run gate for the posting workflows: may this run post live, or must it skip?
// Pure logic: no I/O, no network, no clock (the caller passes `now`).
// The same file is copied into every posting repository; keep the copies equal.
//
// Three kinds of run:
//   schedule  A GitHub cron. GitHub often starts these 1.5-6 hours late. When
//             the repository variable SCHEDULE_LATE_SKIP is "true" it may post
//             only inside SLOT_WINDOW around its slot time (a late run skips,
//             exit 0, instead of posting the noon post in the evening). While
//             the variable is unset / anything else (the default) a schedule
//             run is NOT window-gated: it behaves exactly as before the tick
//             receiver, so late GitHub crons keep posting until the external
//             clock is live. Turn it on once the ticks are proven.
//   tick      workflow_dispatch with mode=tick, sent by the external clock
//             (Cloudflare Worker) with slot, date and tick_id. It is treated as a
//             scheduled live run ONLY when every gate holds:
//               1. run_attempt == 1 (a re-run never posts)
//               2. slot is one of this workflow's slots
//               3. date is a YYYY-MM-DD and equals today's JST date
//               4. now is inside SLOT_WINDOW around that slot's time
//               5. the repository's queue check passes: an approved item exists,
//                  it has no posted record, and no claim is open
//             The claim pushed before the API call (the workflow's claim step)
//             remains the final, authoritative gate.
//   manual    Any other workflow_dispatch. Not decided here: the workflow keeps
//             its existing manual behaviour (dry run, or the existing manual live
//             path where one exists).
// A run that fails a gate does not post and ends successfully with SKIP_REASON.

export const TICK_MODE = 'tick';

// The single tunable of this file: how far from a slot's time (JST) a schedule
// or tick run may still post. earlyMinutes before .. lateMinutes after.
export const SLOT_WINDOW = Object.freeze({ earlyMinutes: 3, lateMinutes: 60 });

export const RUN_KINDS = Object.freeze({ SCHEDULE: 'schedule', TICK: 'tick', MANUAL: 'manual' });

// Repository variable that turns the slot window on for schedule runs.
// Default (unset / not exactly "true", case-insensitive): off. Ticks always use the window.
export const SCHEDULE_LATE_SKIP_VAR = 'SCHEDULE_LATE_SKIP';
export function scheduleLateSkipOn(value) {
  return String(value ?? '').trim().toLowerCase() === 'true';
}

const JST_MS = 9 * 3600 * 1000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

export function runKind({ eventName = '', mode = '' } = {}) {
  if (eventName === 'schedule') return RUN_KINDS.SCHEDULE;
  if (eventName === 'workflow_dispatch' && String(mode).trim() === TICK_MODE) return RUN_KINDS.TICK;
  return RUN_KINDS.MANUAL;
}

export function jstDateOf(now) {
  return new Date(now.getTime() + JST_MS).toISOString().slice(0, 10);
}

// Minutes from the slot time (`date` + `time`, JST) to `now`. Negative = early.
export function minutesFromSlot({ date, time, now }) {
  if (!DATE_RE.test(String(date)) || !TIME_RE.test(String(time))) throw new Error(`bad slot date/time "${date} ${time}"`);
  const at = Date.parse(`${date}T${time}:00+09:00`);
  if (!Number.isFinite(at)) throw new Error(`bad slot date/time "${date} ${time}"`);
  return (now.getTime() - at) / 60000;
}

const no = (reason, detail) => ({ ok: false, reason, detail });

export function checkWindow({ date, time, now, window = SLOT_WINDOW }) {
  const offset = minutesFromSlot({ date, time, now });
  const span = `window ${window.earlyMinutes} min before .. ${window.lateMinutes} min after ${date} ${time} JST`;
  if (offset < -window.earlyMinutes) return no('too-early', `${Math.ceil(-offset)} min before the slot (${span})`);
  if (offset > window.lateMinutes) return no('too-late', `${Math.floor(offset)} min after the slot (${span})`);
  return { ok: true, reason: 'in-window', detail: `${Math.round(offset)} min from the slot (${span})` };
}

// Gates 1-4 of a tick. `slotTimes` maps every slot a tick may name to "HH:MM".
export function checkTick({ runAttempt, slot, date, slotTimes, start = null, now, window = SLOT_WINDOW }) {
  if (String(runAttempt ?? '').trim() !== '1') return no('not-first-attempt', `run_attempt=${runAttempt}; a re-run never posts`);
  if (!slot || !Object.prototype.hasOwnProperty.call(slotTimes, slot)) {
    return no('unknown-slot', `slot "${slot ?? ''}" is not one of: ${Object.keys(slotTimes).join(', ')}`);
  }
  if (!DATE_RE.test(String(date ?? ''))) return no('bad-date', `date "${date ?? ''}" is not YYYY-MM-DD`);
  const today = jstDateOf(now);
  if (date !== today) return no('not-today', `date ${date} is not today (${today} JST)`);
  if (start && date < start) return no('before-start', `date ${date} is before the slot start ${start}`);
  return checkWindow({ date, time: slotTimes[slot], now, window });
}

/**
 * Decide one run.
 *   kind        runKind(...)
 *   slot, date  the slot and JST date this run acts on (tick: the tick's inputs;
 *               schedule: what the workflow resolved from the cron)
 *   time        schedule only: "HH:MM" JST of that slot
 *   scheduleLateSkip  schedule only: true = apply SLOT_WINDOW (SCHEDULE_LATE_SKIP
 *               is "true"); false (default) = schedule runs go as before
 *   slotTimes   tick only: { slot: "HH:MM" } of the slots a tick may name
 *   queueCheck  tick only: async ({ slot, date }) => { ok, reason, detail }
 * Returns { kind, go, reason, detail }. go=false means: do not claim, do not post.
 */
export async function decideRun({ kind, runAttempt, slot, date, time, slotTimes = {}, start = null, now, window = SLOT_WINDOW, queueCheck = null, scheduleLateSkip = false }) {
  if (kind === RUN_KINDS.MANUAL) return { kind, go: true, reason: 'manual', detail: 'manual run: existing behaviour' };

  if (kind === RUN_KINDS.SCHEDULE && !scheduleLateSkip) {
    let where = '';
    try { if (time && date) where = `; ${checkWindow({ date, time, now, window }).detail}`; } catch { /* informational only */ }
    return { kind, go: true, reason: 'schedule-window-off', detail: `${SCHEDULE_LATE_SKIP_VAR} is not "true": schedule runs are not window-gated${where}` };
  }

  if (kind === RUN_KINDS.SCHEDULE) {
    if (!time) return { kind, go: false, reason: 'unknown-slot', detail: `no time for slot "${slot}"` };
    const w = checkWindow({ date, time, now, window });
    return { kind, go: w.ok, reason: w.reason, detail: w.detail };
  }

  if (kind !== RUN_KINDS.TICK) throw new Error(`unknown run kind "${kind}"`);
  const t = checkTick({ runAttempt, slot, date, slotTimes, start, now, window });
  if (!t.ok) return { kind, go: false, reason: t.reason, detail: t.detail };
  if (typeof queueCheck !== 'function') return { kind, go: false, reason: 'no-queue-check', detail: 'internal: no queue check given' };
  const q = await queueCheck({ slot, date });
  if (!q?.ok) return { kind, go: false, reason: q?.reason || 'queue-check-failed', detail: q?.detail || '' };
  return { kind, go: true, reason: 'tick-ok', detail: `${t.detail}; ${q.detail || 'queue ok'}` };
}

// One-line, injection-safe value for $GITHUB_ENV / log annotations.
export function oneLine(value) {
  return String(value ?? '').replace(/[\r\n]+/g, ' ').replace(/[^\x20-\x7e　-鿿＀-￯]/g, '?').slice(0, 400);
}

// KEY=value lines the workflow appends to $GITHUB_ENV.
//   RUN_KIND    schedule | tick | manual
//   RUN_GO      true | false   (claim / publish steps run only when true)
//   SKIP_REASON short reason (empty when RUN_GO=true)
export function envLines(decision) {
  return [
    `RUN_KIND=${decision.kind}`,
    `RUN_GO=${decision.go ? 'true' : 'false'}`,
    `SKIP_REASON=${decision.go ? '' : oneLine(`${decision.reason}: ${decision.detail}`)}`,
  ];
}
