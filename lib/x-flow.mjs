// X (Twitter) publishing, built on the same claim-then-publish design as the
// Threads and Instagram flows: the intent is pushed to the remote before the API
// is called, and a result that might have published is never retried.
//
// Policy that the code enforces (ロストボール版。~/Documents/threads-zero-riders/lib/x-flow.mjs から移植。方針は INSTAGRAM.md / X.md):
//   - only approved posts go out, at most one a day
//   - the text must be rewritten for X, never a copy of a Threads post
//   - a link costs about 13x a plain post, so a post with a link needs allowLink: true

import * as J from './ig-journal.mjs';
import { remoteJournal, pushAndVerify } from './ig-persist.mjs';
import { checkClaims } from './claim-guard.mjs';
import { checkFactFabricationSignals } from './fact-fabrication-guard.mjs';
import { postToX, xWeight, hasLink, X_MAX_WEIGHT } from './x-api.mjs';

export const X_QUEUE_PATH = 'data/x-queue.json';
export const X_POSTED_PATH = 'data/x-posts.json';
export const X_JOURNAL_PATH = 'data/x-journal.json';
export const MAX_LINKS_PER_WEEK = 2;

const HALT = 'ACTION REQUIRED: a human must check the X profile and close the entry with scripts/x-resolve.mjs. X posting stays halted until then.';

// "YYYY-MM-DD" in Japan time (no DST, so +9h is always right).
export const jstToday = (now = new Date()) => new Date(now.getTime() + 9 * 3600 * 1000).toISOString().slice(0, 10);

const squash = (t) => String(t ?? '').replace(/\s+/g, '').toLowerCase();

export function redactX(message, secrets) {
  let out = String(message);
  for (const s of secrets) if (s) out = out.split(s).join('[REDACTED]');
  return out.replace(/oauth_(signature|token|consumer_key)="[^"]*"/g, 'oauth_$1="[REDACTED]"');
}

// `threadsTexts` are every Threads text this account has (queued or posted).
export function validateXQueue(queue, threadsTexts = []) {
  const errors = [];
  const seenDates = new Set();
  const seenIds = new Set();
  const seenTexts = new Set();
  const threads = new Set(threadsTexts.map(squash));
  const linksByWeek = new Map();
  for (const p of queue) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(p.date ?? '')) errors.push(`${p.id}: bad date`);
    if (seenDates.has(p.date)) errors.push(`${p.id}: duplicate date ${p.date}`);
    if (seenIds.has(p.id)) errors.push(`${p.id}: duplicate id`);
    if (typeof p.text !== 'string' || !p.text.trim()) errors.push(`${p.id}: empty text`);
    else {
      const w = xWeight(p.text);
      if (w > X_MAX_WEIGHT) errors.push(`${p.id}: ${w}/${X_MAX_WEIGHT} (Japanese counts 2 each, so about 140 characters)`);
      if (threads.has(squash(p.text))) errors.push(`${p.id}: same text as a Threads post; rewrite it for X`);
      if (seenTexts.has(squash(p.text))) errors.push(`${p.id}: duplicate text`);
      if (hasLink(p.text)) {
        if (p.allowLink !== true) errors.push(`${p.id}: has a link but allowLink is not true (a link costs about 13x a plain post)`);
        const week = isoWeek(p.date);
        linksByWeek.set(week, (linksByWeek.get(week) ?? 0) + 1);
      }
      seenTexts.add(squash(p.text));
    }
    if (p.approved === true && (!p.approvedBy || !p.approvedAt)) errors.push(`${p.id}: approved without approvedBy/approvedAt`);
    seenDates.add(p.date);
    seenIds.add(p.id);
  }
  for (const [week, n] of linksByWeek) if (n > MAX_LINKS_PER_WEEK) errors.push(`week of ${week}: ${n} posts with links (max ${MAX_LINKS_PER_WEEK})`);
  return errors;
}

// 人が承認時に目で確認する注意点(断定表現・作り話の兆候など。既存の Threads 用ガードを流用)。
export function xWarnings(queue) {
  const out = [];
  for (const p of queue) {
    for (const w of checkClaims({ bodyJa: p.text })) out.push(`${p.id}: ${w.family} 「${w.match}」`);
    for (const w of checkFactFabricationSignals({ bodyJa: p.text }).warnings) out.push(`${p.id}: ${w.family} 「${w.excerpt}」`);
  }
  return out;
}

// Monday of the date's week, as YYYY-MM-DD.
function isoWeek(date) {
  const d = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return 'invalid';
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}

export function selectXToday(queue, posted, today) {
  if (posted.some((p) => p.date === today)) return { post: null, reason: 'already-posted-today' };
  const items = queue.filter((p) => p.date === today);
  if (items.length === 0) return { post: null, reason: 'no-post-scheduled' };
  if (items.length > 1) return { post: null, reason: 'multiple-posts-same-day' };
  const post = items[0];
  if (post.approved !== true) return { post: null, reason: 'not-approved' };
  if (posted.some((p) => p.id === post.id)) return { post: null, reason: 'already-posted' };
  if (posted.some((p) => squash(p.text) === squash(post.text))) return { post: null, reason: 'duplicate-text' };
  if (xWeight(post.text) > X_MAX_WEIGHT) return { post: null, reason: 'too-long' };
  if (hasLink(post.text) && post.allowLink !== true) return { post: null, reason: 'link-not-allowed' };
  return { post, reason: null };
}

// A day without a post is allowed; an unapproved post is a reason to tell a human.
const QUIET = new Set(['no-post-scheduled', 'already-posted-today']);

async function readRemote({ git, branch, log, step }) {
  try {
    return await remoteJournal({ run: git, branch, path: X_JOURNAL_PATH });
  } catch (err) {
    log(`cannot read ${X_JOURNAL_PATH} on the remote (${err.message}); not publishing (step=${step})`);
    return null;
  }
}

function reportBlockers(log, blocked) {
  log(`halted: ${blocked.length} unresolved entr${blocked.length === 1 ? 'y' : 'ies'} in ${X_JOURNAL_PATH}`);
  for (const e of blocked) log(`  ${J.describe(e)}`);
  log(HALT);
}

export async function runXClaim({ io, git, branch, today, runId, runAttempt, now, log }) {
  const queue = await io.readJson(X_QUEUE_PATH, []);
  const posted = await io.readJson(X_POSTED_PATH, []);
  const { post, reason } = selectXToday(queue, posted, today);
  log(`date=${today} step=x-claim`);
  if (!post) {
    log(`nothing to claim: ${reason}`);
    return { code: QUIET.has(reason) ? 0 : 1, reason, skip: true };
  }

  const before = await readRemote({ git, branch, log, step: 'claim' });
  if (before === null) return { code: 1, reason: 'remote-unreadable' };
  const blocked = J.blockers(before);
  if (blocked.length) {
    reportBlockers(log, blocked);
    return { code: 1, halted: true };
  }

  const claim = J.event({ postId: post.id, date: today, stage: J.CLAIMED, runId, runAttempt, at: now() });
  await io.writeJson(X_JOURNAL_PATH, [...before, claim]);
  let landed;
  try {
    landed = await pushAndVerify({
      run: git,
      branch,
      files: [X_JOURNAL_PATH],
      path: X_JOURNAL_PATH,
      message: `chore(lostball): claim x ${post.id} (${today})`,
      guard: (remote) => {
        if (J.blockers(remote).length) throw new Error('another run holds an open claim');
      },
    });
  } catch (err) {
    log(`claim NOT persisted: ${err.message}; not publishing`);
    return { code: 1, reason: 'claim-not-persisted' };
  }
  const open = J.openClaimsFor(landed, post.id);
  if (open.length !== 1 || !J.sameRun(open[0], claim)) {
    log(`claim ambiguous on the remote (open claims=${open.length}); not publishing`);
    return { code: 1, reason: 'claim-ambiguous' };
  }
  log(`claimed: ${J.describe(claim)}`);
  return { code: 0, claim };
}

export async function runXPublish({ io, git, branch, today, live, creds, runId, runAttempt, now, fetchImpl, log, errLog }) {
  const queue = await io.readJson(X_QUEUE_PATH, []);
  const posted = await io.readJson(X_POSTED_PATH, []);
  const { post, reason } = selectXToday(queue, posted, today);
  log(`date=${today} mode=${live ? 'LIVE' : 'dry-run'} (x)`);
  if (!post) {
    log(`nothing to post: ${reason}`);
    return { code: QUIET.has(reason) ? 0 : 1, reason };
  }
  log(`post=${post.id} weight=${xWeight(post.text)}/${X_MAX_WEIGHT}\n---\n${post.text}\n---`);

  if (!live) {
    log('dry-run: not published');
    return { code: 0, stage: 'dry-run', postId: post.id };
  }
  const secrets = [creds?.apiKey, creds?.apiSecret, creds?.accessToken, creds?.accessSecret];
  if (secrets.some((s) => !s)) {
    errLog('X_API_KEY / X_API_SECRET / X_ACCESS_TOKEN / X_ACCESS_TOKEN_SECRET are not all set');
    return { code: 1, reason: 'missing-credentials' };
  }

  const remote = await readRemote({ git, branch, log, step: 'publish' });
  if (remote === null) return { code: 1, reason: 'remote-unreadable' };
  const open = J.openClaimsFor(remote, post.id);
  const mine = open.length === 1 && open[0].runId === runId && open[0].runAttempt === runAttempt ? open[0] : null;
  const blocked = J.blockers(remote, mine);
  if (blocked.length) {
    reportBlockers(log, blocked);
    return { code: 1, halted: true };
  }
  if (!mine) {
    log(`no durable claim for this run on the remote (open claims=${open.length}); refusing to publish`);
    return { code: 1, reason: 'no-claim' };
  }

  const close = async (stage, note) => {
    const entry = J.event({ postId: post.id, date: today, stage, runId, runAttempt, at: now(), note });
    try {
      const journal = await remoteJournal({ run: git, branch, path: X_JOURNAL_PATH });
      await io.writeJson(X_JOURNAL_PATH, [...journal, entry]);
      await pushAndVerify({ run: git, branch, files: [X_JOURNAL_PATH], path: X_JOURNAL_PATH, message: `chore(lostball): x ${stage} ${post.id} (${today})` });
      log(`journal: ${J.describe(entry)}`);
    } catch (err) {
      errLog(`journal NOT updated (${err.message}); the open claim keeps X posting halted: ${J.describe(entry)}`);
    }
  };

  const result = await postToX({ text: post.text, creds, fetchImpl });
  if (result.outcome === 'rejected') {
    errLog(`step=rejected postId=${post.id} date=${today}: ${redactX(result.detail, secrets)}`);
    await close(J.ABORTED, 'X refused the post (4xx); nothing was published');
    return { code: 1, stage: J.ABORTED, postId: post.id };
  }
  if (result.outcome === 'unknown') {
    errLog(`step=publish-unknown postId=${post.id} date=${today}: ${redactX(result.detail, secrets)}`);
    await close(J.UNKNOWN, 'publish result unknown');
    errLog(HALT);
    return { code: 1, stage: J.UNKNOWN, postId: post.id };
  }

  log(`published: postId=${post.id} date=${today} xId=${result.id}`);
  const record = { id: post.id, date: today, xId: result.id, publishedAt: now(), text: post.text };
  const entry = J.event({ postId: post.id, date: today, stage: J.PUBLISHED, runId, runAttempt, at: now(), threadsId: result.id, note: 'x post id stored in threadsId' });
  try {
    const journal = await remoteJournal({ run: git, branch, path: X_JOURNAL_PATH });
    await io.writeJson(X_POSTED_PATH, [...posted, record]);
    await io.writeJson(X_JOURNAL_PATH, [...journal, entry]);
    await pushAndVerify({ run: git, branch, files: [X_JOURNAL_PATH, X_POSTED_PATH], path: X_JOURNAL_PATH, message: `chore(lostball): record x ${post.id} (${today})` });
  } catch (err) {
    errLog(`RECORD NOT PERSISTED (${err.message})`);
    errLog(`recover: node scripts/x-resolve.mjs --id ${post.id} --outcome published --x-id ${result.id} --by <name> --yes`);
    errLog(HALT);
    return { code: 1, stage: 'record-not-persisted', xId: result.id };
  }
  return { code: 0, stage: J.PUBLISHED, xId: result.id, postId: post.id };
}

export async function runXResolve({ io, id, outcome, xId, by, now, log }) {
  const journal = await io.readJson(X_JOURNAL_PATH, []);
  const target = J.openEntries(journal).find((e) => e.postId === id);
  if (!target) {
    log(`nothing open for ${id}`);
    return { code: 1 };
  }
  const published = outcome === 'published';
  const entry = J.event({
    postId: id, date: target.date, stage: published ? J.PUBLISHED : J.RESOLVED,
    runId: `resolved-by:${by}`, runAttempt: '1', at: now(),
    threadsId: published ? (xId ?? null) : null,
    note: published ? 'confirmed live on X by a human' : 'confirmed not published by a human',
  });
  await io.writeJson(X_JOURNAL_PATH, [...journal, entry]);
  if (published) {
    const posted = await io.readJson(X_POSTED_PATH, []);
    if (!posted.some((p) => p.id === id)) {
      const queue = await io.readJson(X_QUEUE_PATH, []);
      const post = queue.find((p) => p.id === id);
      posted.push({ id, date: target.date, xId: xId ?? null, publishedAt: now(), text: post?.text ?? '', recoveredBy: by });
      await io.writeJson(X_POSTED_PATH, posted);
    }
  }
  log(`resolved: ${J.describe(entry)}; commit and push ${X_JOURNAL_PATH} and ${X_POSTED_PATH}.`);
  return { code: 0 };
}
