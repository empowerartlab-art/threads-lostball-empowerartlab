// X (Twitter) publishing, built on the same claim-then-publish design as the
// Threads and Instagram flows: the intent is pushed to the remote before the API
// is called, and a result that might have published is never retried.
//
// Policy that the code enforces (ロストボール版。~/Documents/threads-zero-riders/lib/x-flow.mjs から移植。方針は INSTAGRAM.md):
//   - only approved posts go out: one a day until 2026-10-19 (05:53 JST), then exactly
//     one per slot (morning 07:10 / noon 12:10 / night 20:10 JST) from 2026-10-20 (lib/x-slots.mjs)
//   - the text must be rewritten for X, never a copy or near-copy of a Threads post
//   - a link costs about 13x a plain post ($0.20 instead of $0.015), so a post with a
//     link needs allowLink: true, and every such post is warned about loudly
//   - shop promotion at most once a week
//   - images (2026-10-17 owner decision): at most one post a day may carry `image`,
//     a path to that day's Instagram image under assets/instagram/ (reused, never new).
//     It is uploaded to X just before the post call; an upload failure aborts cleanly.

import * as J from './ig-journal.mjs';
import { remoteJournal, pushAndVerify } from './ig-persist.mjs';
import { checkClaims } from './claim-guard.mjs';
import { checkFactFabricationSignals } from './fact-fabrication-guard.mjs';
import { textSimilarity, bigramContainment, checkScheduleSimilarity } from './similarity-guard.mjs';
import { postToX, uploadImageToX, xWeight, hasLink, X_MAX_WEIGHT } from './x-api.mjs';
import { isXSlotItem, validateXSlots, xSlotInfo } from './x-slots.mjs';

export const X_QUEUE_PATH = 'data/x-queue.json';
export const X_POSTED_PATH = 'data/x-posts.json';
export const X_JOURNAL_PATH = 'data/x-journal.json';
export const MAX_LINKS_PER_WEEK = 2;
export const MAX_SHOP_POSTS_PER_WEEK = 1;
// 記録(journal / x-posts.json)の push が他の workflow とぶつかったときの最大回数(Threads と同じ5回)。
export const X_PUSH_ATTEMPTS = 5;
// X の投稿 API の料金の目安(1本あたり。運用者の確認値。公式の料金画面は未確認)。
export const X_COST_PLAIN_USD = 0.015;
export const X_COST_LINK_USD = 0.2;
// Threads の丸写し・言い換え程度の写しを止めるしきい値(2026-10-14、承認済みの X 7本で実測:
// 書き直した X と元の Threads の類似度は 0.34〜0.52、X の2文字組が Threads に含まれる割合は 0.50〜0.81)。
export const NEAR_COPY_SIMILARITY = 0.7;
export const NEAR_COPY_CONTAINMENT = 0.9;
// ショップ誘導とみなす言い回し(週1回まで)。
const SHOP_RE = /プロフィールのリンク|販売中|ショップ|お買い求め|購入|\bshop\b/i;
const IMAGE_KEYS = ['images', 'media', 'mediaIds'];
// 使えない画像の項目名(無ければ空)。画像は `image` 1つだけ。media: { type: "TEXT_ONLY" } は文字のみなので可。
export function imageFieldsOf(p) {
  return IMAGE_KEYS.filter((k) => p?.[k] !== undefined && p?.[k] !== null && !(k === 'media' && (p.media?.type ?? 'TEXT_ONLY') === 'TEXT_ONLY'));
}

// 画像(2026-10-17〜): その日の Instagram 画像(assets/instagram/)を1日1本だけ使い回す。
export const X_IMAGE_RE = /^assets\/instagram\/[\w.-]+\.(jpe?g|png)$/i;
export const X_MAX_IMAGES_PER_DAY = 1;
const DEFAULT_REPOSITORY = 'empowerartlab-art/threads-lostball-empowerartlab';
// 公開リポジトリの raw URL(Threads の画像と同じ置き場。lib/media-url.mjs と同じ考え方)。
export const xMediaBase = (env = {}) => `https://raw.githubusercontent.com/${env.GITHUB_REPOSITORY || DEFAULT_REPOSITORY}/${env.GITHUB_REF_NAME || 'main'}/`;
export const hasXImage = (p) => p?.image !== undefined && p?.image !== null;
// `image` の問題を1つ返す(無ければ null)。
export function xImageProblem(p) {
  if (!hasXImage(p)) return null;
  if (!isXSlotItem(p)) return 'image は1日3本の枠(slot)付きの投稿だけ';
  if (typeof p.image !== 'string' || !X_IMAGE_RE.test(p.image) || p.image.includes('..')) return `image は assets/instagram/ の .jpg/.png だけ（${p.image}）`;
  return null;
}

const HALT = 'ACTION REQUIRED: a human must check the X profile and close the entry with scripts/x-resolve.mjs. X posting stays halted until then.';

// "YYYY-MM-DD" in Japan time (no DST, so +9h is always right).
export const jstToday = (now = new Date()) => new Date(now.getTime() + 9 * 3600 * 1000).toISOString().slice(0, 10);

const squash = (t) => String(t ?? '').replace(/\s+/g, '').toLowerCase();

export function redactX(message, secrets) {
  let out = String(message);
  for (const s of secrets) if (s) out = out.split(s).join('[REDACTED]');
  return out.replace(/oauth_(signature|token|consumer_key)="[^"]*"/g, 'oauth_$1="[REDACTED]"');
}

export const isShopPost = (p) => p?.shop === true || SHOP_RE.test(String(p?.text ?? ''));

// X の文が Threads の文(日本語・英語)の丸写し・ほぼ写しか。いちばん近いものを返す(無ければ null)。
export function nearCopyOf(text, threadsTexts = []) {
  let worst = null;
  for (const t of threadsTexts) {
    if (!t) continue;
    const sim = textSimilarity(text, t, 'ja');
    const contained = bigramContainment(text, t);
    if (sim >= NEAR_COPY_SIMILARITY || contained >= NEAR_COPY_CONTAINMENT) {
      if (!worst || sim + contained > worst.sim + worst.contained) worst = { sim, contained, source: t };
    }
  }
  return worst;
}

const round2 = (x) => Math.round(x * 100) / 100;

// `options` may be the old form (an array of every Threads text) or
// { threadsTexts, facts }. `facts` (data/verified-facts.json の facts) が渡されたら、
// verifiedFactIds がすべて verified:true の事実を指すかも確かめる。
export function validateXQueue(queue, options = []) {
  const { threadsTexts = [], facts = null } = Array.isArray(options) ? { threadsTexts: options } : options;
  const errors = [];
  const seenDates = new Set();
  const seenIds = new Set();
  const seenTexts = new Set();
  const threads = new Set(threadsTexts.map(squash));
  const linksByWeek = new Map();
  const shopByWeek = new Map();
  const imagesByDate = new Map();
  const factMap = facts ? new Map(facts.map((f) => [f.id, f])) : null;
  for (const p of queue) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(p.date ?? '')) errors.push(`${p.id}: bad date`);
    // 従来の形(slot なし)は1日1本。slot 付きの日は lib/x-slots.mjs の validateXSlots が見る。
    if (!isXSlotItem(p)) {
      if (seenDates.has(p.date)) errors.push(`${p.id}: duplicate date ${p.date}`);
      seenDates.add(p.date);
    }
    if (seenIds.has(p.id)) errors.push(`${p.id}: duplicate id`);
    if (typeof p.text !== 'string' || !p.text.trim()) errors.push(`${p.id}: empty text`);
    else {
      const w = xWeight(p.text);
      if (w > X_MAX_WEIGHT) errors.push(`${p.id}: ${w}/${X_MAX_WEIGHT} (Japanese counts 2 each, so about 140 characters)`);
      if (threads.has(squash(p.text))) errors.push(`${p.id}: same text as a Threads post; rewrite it for X`);
      else {
        const near = nearCopyOf(p.text, threadsTexts);
        if (near) errors.push(`${p.id}: almost a copy of a Threads post (similarity ${round2(near.sim)}, contained ${round2(near.contained)}); rewrite it for X`);
      }
      if (seenTexts.has(squash(p.text))) errors.push(`${p.id}: duplicate text`);
      if (hasLink(p.text)) {
        if (p.allowLink !== true) errors.push(`${p.id}: has a link but allowLink is not true (a link costs about 13x a plain post: $${X_COST_LINK_USD} instead of $${X_COST_PLAIN_USD})`);
        const week = isoWeek(p.date);
        linksByWeek.set(week, (linksByWeek.get(week) ?? 0) + 1);
      }
      if (isShopPost(p)) {
        const week = isoWeek(p.date);
        shopByWeek.set(week, [...(shopByWeek.get(week) ?? []), p.id]);
      }
      seenTexts.add(squash(p.text));
    }
    for (const k of imageFieldsOf(p)) {
      errors.push(`${p.id}: "${k}" is not supported: use "image" (one Instagram image under assets/instagram/)`);
    }
    const imageProblem = xImageProblem(p);
    if (imageProblem) errors.push(`${p.id}: ${imageProblem}`);
    if (hasXImage(p)) imagesByDate.set(p.date, (imagesByDate.get(p.date) ?? 0) + 1);
    if (factMap && p.verifiedFactIds !== undefined) {
      if (!Array.isArray(p.verifiedFactIds)) errors.push(`${p.id}: verifiedFactIds must be a list`);
      else for (const id of p.verifiedFactIds) if (factMap.get(id)?.verified !== true) errors.push(`${p.id}: unverified fact ${id} (only data/verified-facts.json の verified:true)`);
    }
    if (p.approved === true && (!p.approvedBy || !p.approvedAt)) errors.push(`${p.id}: approved without approvedBy/approvedAt`);
    seenIds.add(p.id);
  }
  for (const [week, n] of linksByWeek) if (n > MAX_LINKS_PER_WEEK) errors.push(`week of ${week}: ${n} posts with links (max ${MAX_LINKS_PER_WEEK})`);
  for (const [date, n] of imagesByDate) if (n > X_MAX_IMAGES_PER_DAY) errors.push(`${date}: ${n} X image posts (at most ${X_MAX_IMAGES_PER_DAY} a day)`);
  for (const [week, ids] of shopByWeek) if (ids.length > MAX_SHOP_POSTS_PER_WEEK) errors.push(`week of ${week}: ${ids.length} shop posts (max ${MAX_SHOP_POSTS_PER_WEEK} a week): ${ids.join(', ')}`);
  errors.push(...validateXSlots(queue));
  // 枠付きの X どうし(同じ日・7日以内)の似すぎ。Threads と同じしきい値・同じ書き出しの検査。
  const scheduled = queue.filter((p) => isXSlotItem(p) && typeof p.text === 'string').map((p) => ({ id: p.id, targetDate: p.date, lang: 'ja', text: p.text }));
  for (const pr of checkScheduleSimilarity(scheduled).problems) errors.push(`${pr.ids.join(' / ')}: ${pr.detail}`);
  return errors;
}

// URL 入りの投稿を大きく警告する(1本 $0.20。通常の約13倍)。表示用の文字列を返す。
export function linkCostWarnings(queue) {
  return queue
    .filter((p) => typeof p.text === 'string' && hasLink(p.text))
    .map((p) => `⚠️⚠️ URL入り(料金 約13倍): ${p.id} ${p.date}${p.slot ? ` ${p.slot}` : ''} は1本 $${X_COST_LINK_USD}(URLなしは $${X_COST_PLAIN_USD})。本当に必要か確認してください`);
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
  return selectXForRun(queue, posted, today, { kind: 'legacy' });
}

// その実行(plan: lib/x-slots.mjs の planXRun)で出す1本を選ぶ。前の枠の取り残しを後の枠で出すことはしない。
export function selectXForRun(queue, posted, today, plan) {
  if (!plan || plan.kind === 'none') return { post: null, reason: 'no-run-for-this-time' };
  const slot = plan.kind === 'slot' ? plan.slot : null;
  const mine = (p) => p.date === today && (slot ? p.slot === slot : !isXSlotItem(p));
  if (posted.some(mine)) return { post: null, reason: 'already-posted-today' };
  const items = queue.filter(mine);
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
const QUIET = new Set(['no-post-scheduled', 'already-posted-today', 'no-run-for-this-time']);

async function readRemote({ git, branch, log, step }) {
  try {
    return await remoteJournal({ run: git, branch, path: X_JOURNAL_PATH });
  } catch (err) {
    log(`cannot read ${X_JOURNAL_PATH} on the remote (${err.message}); not publishing (step=${step})`);
    return null;
  }
}

// journal の1行。枠付きの投稿は slot も残す(同じ投稿を2回出していないかを人が追えるように)。
const xEvent = (post, fields) => ({ ...J.event({ postId: post.id, ...fields }), ...(post.slot ? { slot: post.slot } : {}) });
const runLabel = (plan) => (plan?.kind === 'slot' ? ` slot=${plan.slot}(${xSlotInfo(plan.slot)?.time ?? '?'} JST)` : '');
const alreadyPublished = (journal, postId) => journal.some((e) => e.postId === postId && e.stage === J.PUBLISHED);

function reportBlockers(log, blocked) {
  log(`halted: ${blocked.length} unresolved entr${blocked.length === 1 ? 'y' : 'ies'} in ${X_JOURNAL_PATH}`);
  for (const e of blocked) log(`  ${J.describe(e)}`);
  log(HALT);
}

export async function runXClaim({ io, git, branch, today, plan = { kind: 'legacy' }, runId, runAttempt, now, log, sleep }) {
  const queue = await io.readJson(X_QUEUE_PATH, []);
  const posted = await io.readJson(X_POSTED_PATH, []);
  const { post, reason } = selectXForRun(queue, posted, today, plan);
  log(`date=${today}${runLabel(plan)} step=x-claim`);
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
  if (alreadyPublished(before, post.id)) {
    log(`${post.id} is already recorded as published in ${X_JOURNAL_PATH} but not in ${X_POSTED_PATH}; not posting it again. A human must check.`);
    return { code: 1, reason: 'already-published-in-journal', skip: true };
  }

  const claim = xEvent(post, { date: today, stage: J.CLAIMED, runId, runAttempt, at: now() });
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
        if (alreadyPublished(remote, post.id)) throw new Error('another run already published this post');
      },
      attempts: X_PUSH_ATTEMPTS,
      sleep,
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

export async function runXPublish({ io, git, branch, today, plan = { kind: 'legacy' }, live, creds, runId, runAttempt, now, fetchImpl, log, errLog, sleep, mediaBase = xMediaBase(process.env) }) {
  const queue = await io.readJson(X_QUEUE_PATH, []);
  const posted = await io.readJson(X_POSTED_PATH, []);
  const { post, reason } = selectXForRun(queue, posted, today, plan);
  log(`date=${today}${runLabel(plan)} mode=${live ? 'LIVE' : 'dry-run'} (x)`);
  if (!post) {
    log(`nothing to post: ${reason}`);
    return { code: QUIET.has(reason) ? 0 : 1, reason };
  }
  const imageUrl = hasXImage(post) ? mediaBase + post.image : null;
  log(`post=${post.id} weight=${xWeight(post.text)}/${X_MAX_WEIGHT}${imageUrl ? `\nimage=${imageUrl}` : ' text-only'}\n---\n${post.text}\n---`);
  if (hasLink(post.text)) {
    // GitHub Actions の画面に黄色い警告として出る。
    log(`::warning::X post ${post.id} contains a URL: about $${X_COST_LINK_USD} instead of $${X_COST_PLAIN_USD} (about 13x)`);
  }

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
    const entry = xEvent(post, { date: today, stage, runId, runAttempt, at: now(), note });
    try {
      const journal = await remoteJournal({ run: git, branch, path: X_JOURNAL_PATH });
      await io.writeJson(X_JOURNAL_PATH, [...journal, entry]);
      await pushAndVerify({ run: git, branch, files: [X_JOURNAL_PATH], path: X_JOURNAL_PATH, message: `chore(lostball): x ${stage} ${post.id} (${today})`, attempts: X_PUSH_ATTEMPTS, sleep });
      log(`journal: ${J.describe(entry)}`);
    } catch (err) {
      errLog(`journal NOT updated (${err.message}); the open claim keeps X posting halted: ${J.describe(entry)}`);
    }
  };

  const mediaIds = [];
  if (imageUrl) {
    try {
      mediaIds.push(await uploadImageToX({ imageUrl, creds, fetchImpl }));
    } catch (err) {
      // The post call has not been made, so nothing can be on the timeline.
      errLog(`step=media-failed postId=${post.id} date=${today}: ${redactX(err.message, secrets)}`);
      await close(J.ABORTED, 'image upload failed before the post call; nothing was published');
      return { code: 1, stage: J.ABORTED, postId: post.id };
    }
    log(`step=media-uploaded postId=${post.id} mediaId=${mediaIds[0]}`);
  }

  const result = await postToX({ text: post.text, mediaIds, creds, fetchImpl });
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
  const record = { id: post.id, date: today, ...(post.slot ? { slot: post.slot } : {}), xId: result.id, publishedAt: now(), text: post.text, ...(hasXImage(post) ? { image: post.image } : {}) };
  const entry = xEvent(post, { date: today, stage: J.PUBLISHED, runId, runAttempt, at: now(), threadsId: result.id, note: 'x post id stored in threadsId' });
  try {
    const journal = await remoteJournal({ run: git, branch, path: X_JOURNAL_PATH });
    await io.writeJson(X_POSTED_PATH, [...posted, record]);
    await io.writeJson(X_JOURNAL_PATH, [...journal, entry]);
    await pushAndVerify({ run: git, branch, files: [X_JOURNAL_PATH, X_POSTED_PATH], path: X_JOURNAL_PATH, message: `chore(lostball): record x ${post.id} (${today})`, attempts: X_PUSH_ATTEMPTS, sleep });
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
      posted.push({ id, date: target.date, ...(post?.slot ? { slot: post.slot } : {}), xId: xId ?? null, publishedAt: now(), text: post?.text ?? '', recoveredBy: by });
      await io.writeJson(X_POSTED_PATH, posted);
    }
  }
  log(`resolved: ${J.describe(entry)}; commit and push ${X_JOURNAL_PATH} and ${X_POSTED_PATH}.`);
  return { code: 0 };
}
