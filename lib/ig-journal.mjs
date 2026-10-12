// Append-only journal of publish attempts. Pure logic: no I/O, no network.
//
// The runner that publishes is thrown away when the job ends, so a local file
// records nothing. Every attempt is appended here and pushed to the remote
// BEFORE the publish API is called, so an interrupted run always leaves a trace
// a later run can see.
//
// (Instagram 用。~/Documents/threads-zero-riders/lib/journal.mjs から移植)

export const CLAIMED = 'claimed'; // intent is on the remote; publish not attempted yet
export const PUBLISHED = 'published'; // publish confirmed, mediaId known (stored in threadsId)
export const UNKNOWN = 'unknown'; // publish may or may not have happened
export const ABORTED = 'aborted'; // failed before anything could reach Instagram
export const RESOLVED = 'resolved'; // a human checked Instagram and closed the entry

// Stages that must stop every later run until a human resolves them.
const OPEN = new Set([CLAIMED, UNKNOWN]);

export function isOpen(entry) {
  return OPEN.has(entry.stage);
}

export function sameRun(a, b) {
  return a.runId === b.runId && a.runAttempt === b.runAttempt;
}

export function event({ postId, date, stage, runId, runAttempt, at, threadsId = null, note = null }) {
  return { postId, date, stage, runId, runAttempt, at, threadsId, note };
}

// Latest event per post id.
export function latest(journal) {
  const byId = new Map();
  for (const e of journal) byId.set(e.postId, e);
  return [...byId.values()];
}

export function openEntries(journal) {
  return latest(journal).filter(isOpen);
}

// Open entries that must stop a live run. `mine` is the claim the current run
// made itself, which is not a reason for that run to stop.
export function blockers(journal, mine = null) {
  return openEntries(journal).filter((e) => !(mine && e.postId === mine.postId && sameRun(e, mine)));
}

// Claims for `postId` that nothing has closed yet. More than one means two runs
// raced, and the caller must refuse to publish.
export function openClaimsFor(journal, postId) {
  let open = [];
  for (const e of journal) {
    if (e.postId !== postId) continue;
    if (e.stage === CLAIMED) open.push(e);
    else open = []; // any outcome closes the claims before it
  }
  return open;
}

export function describe(entry) {
  const bits = [`postId=${entry.postId}`, `date=${entry.date}`, `stage=${entry.stage}`, `run=${entry.runId}/${entry.runAttempt}`, `at=${entry.at}`];
  if (entry.threadsId) bits.push(`threadsId=${entry.threadsId}`);
  if (entry.note) bits.push(`note=${entry.note}`);
  return bits.join(' ');
}
