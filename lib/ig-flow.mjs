// Instagram 自動投稿(@lost_ball_empowerartlab の Instagram 版)。
// ~/Documents/threads-zero-riders/lib/ig-flow.mjs と同じ「先に予約(claim)を GitHub に
// 書き込み、読み戻して確認してから投稿する」設計を移植したもの。投稿されたか分からない
// 失敗は自動で再試行せず、人が確認するまで止まる(二重投稿の防止)。
//
// Threads との違い:
//   - 投稿は画像(1枚=単体、2〜10枚=カルーセル)。画像はこのリポジトリ(公開)の
//     assets/instagram/ に置き、raw.githubusercontent.com の URL を Instagram に渡す。
//   - JPEG のみ。
//   - 毎日ではない(週3〜4回)。「今日は予定なし」は正常。
//   - AI で作った画像は使わない(MEDIA_POLICY.md)。mediaType は文字デザイン or 実写のみ許可。

import { createSecretRedactor } from './redact.mjs';
import { checkClaims } from './claim-guard.mjs';
import { checkFactFabricationSignals } from './fact-fabrication-guard.mjs';
import * as J from './ig-journal.mjs';
import { remoteJournal, pushAndVerify } from './ig-persist.mjs';

export const IG_QUEUE_PATH = 'data/ig-queue.json';
export const IG_POSTED_PATH = 'data/ig-posts.json';
export const IG_JOURNAL_PATH = 'data/ig-journal.json';
export const IG_MEDIA_DIR = 'assets/instagram/';
export const IG_MEDIA_BASE = `https://raw.githubusercontent.com/empowerartlab-art/threads-lostball-empowerartlab/main/${IG_MEDIA_DIR}`;
const GRAPH = 'https://graph.instagram.com/v23.0';
const MAX_CAPTION = 2200;
const MAX_HASHTAGS = 8; // ブランド方針: Instagram はタグ5〜8個まで

// AI_ASSISTED_VISUAL は Instagram では使わない(使うなら人が方針を決めてからここに足す)。
export const IG_ALLOWED_MEDIA_TYPES = ['BRAND_GRAPHIC', 'PRODUCT_PHOTO', 'REAL_PHOTO', 'REAL_WORK'];

const HALT = 'ACTION REQUIRED: a human must check Instagram and close the entry with scripts/ig-resolve.mjs. Instagram posting stays halted until then.';

const redactWith = (text, secrets) => createSecretRedactor(secrets)(text);

// errors は投稿を止める問題、warnings は人が承認時に目で確認する注意点。
export function validateIgQueue(queue, { factIds = null } = {}) {
  const errors = [];
  const warnings = [];
  const seenDates = new Set();
  const seenIds = new Set();
  const known = factIds ? new Set(factIds) : null;
  for (const p of queue) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(p.date ?? '')) errors.push(`${p.id}: bad date`);
    if (seenDates.has(p.date)) errors.push(`${p.id}: duplicate date ${p.date}`);
    if (seenIds.has(p.id)) errors.push(`${p.id}: duplicate id`);
    if (!Array.isArray(p.images) || p.images.length < 1 || p.images.length > 10) errors.push(`${p.id}: needs 1-10 images`);
    else if (p.images.some((f) => !/^[\w.-]+\.jpe?g$/i.test(f))) errors.push(`${p.id}: images must be .jpg file names`);
    if (!IG_ALLOWED_MEDIA_TYPES.includes(p.mediaType)) errors.push(`${p.id}: mediaType must be one of ${IG_ALLOWED_MEDIA_TYPES.join('/')} (AI画像は使わない)`);
    if (typeof p.caption !== 'string' || !p.caption.trim()) errors.push(`${p.id}: empty caption`);
    else {
      if ([...p.caption].length > MAX_CAPTION) errors.push(`${p.id}: caption over ${MAX_CAPTION} chars`);
      if ((p.caption.match(/#/g) || []).length > MAX_HASHTAGS) errors.push(`${p.id}: over ${MAX_HASHTAGS} hashtags`);
      if (/https?:\/\//i.test(p.caption)) errors.push(`${p.id}: caption must not contain a raw URL (use 「プロフィールのリンクから」)`);
      for (const w of checkClaims({ bodyJa: p.caption })) warnings.push(`${p.id}: ${w.family} 「${w.match}」`);
      for (const w of checkFactFabricationSignals({ bodyJa: p.caption }).warnings) warnings.push(`${p.id}: ${w.family} 「${w.excerpt}」`);
    }
    if (known) {
      for (const f of p.verifiedFactIds ?? []) if (!known.has(f)) errors.push(`${p.id}: unknown verifiedFactId ${f}`);
    }
    if (p.approved === true && (!p.approvedBy || !p.approvedAt)) errors.push(`${p.id}: approved without approvedBy/approvedAt`);
    seenDates.add(p.date);
    seenIds.add(p.id);
  }
  return { errors, warnings };
}

export function selectIgToday(queue, posted, today) {
  if (posted.some((p) => p.date === today)) return { post: null, reason: 'already-posted-today' };
  const items = queue.filter((p) => p.date === today);
  if (items.length === 0) return { post: null, reason: 'no-post-scheduled' };
  if (items.length > 1) return { post: null, reason: 'multiple-posts-same-day' };
  const post = items[0];
  if (post.approved !== true) return { post: null, reason: 'not-approved' };
  if (posted.some((p) => p.id === post.id)) return { post: null, reason: 'already-posted' };
  return { post, reason: null };
}

// 予定なし・投稿済みは正常な日。未承認は「承認忘れ」なので失敗扱いにして気づけるようにする。
const QUIET = new Set(['no-post-scheduled', 'already-posted-today']);

async function readRemote({ git, branch, log, step }) {
  try {
    return await remoteJournal({ run: git, branch, path: IG_JOURNAL_PATH });
  } catch (err) {
    log(`cannot read ${IG_JOURNAL_PATH} on the remote (${err.message}); not publishing (step=${step})`);
    return null;
  }
}

function reportBlockers(log, blocked) {
  log(`halted: ${blocked.length} unresolved entr${blocked.length === 1 ? 'y' : 'ies'} in ${IG_JOURNAL_PATH}`);
  for (const e of blocked) log(`  ${J.describe(e)}`);
  log(HALT);
}

export async function runIgClaim({ io, git, branch, today, runId, runAttempt, now, log }) {
  const queue = await io.readJson(IG_QUEUE_PATH, []);
  const posted = await io.readJson(IG_POSTED_PATH, []);
  const { post, reason } = selectIgToday(queue, posted, today);
  log(`date=${today} step=ig-claim`);
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
  await io.writeJson(IG_JOURNAL_PATH, [...before, claim]);
  let landed;
  try {
    landed = await pushAndVerify({
      run: git,
      branch,
      files: [IG_JOURNAL_PATH],
      path: IG_JOURNAL_PATH,
      message: `chore(lostball): claim instagram ${post.id} (${today})`,
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

export async function runIgPublish({
  io, git, branch, today, live, token, userId, runId, runAttempt, now, sleep, fetchImpl, log, errLog,
  mediaBase = IG_MEDIA_BASE, pollTries = 20,
}) {
  const queue = await io.readJson(IG_QUEUE_PATH, []);
  const posted = await io.readJson(IG_POSTED_PATH, []);
  const { post, reason } = selectIgToday(queue, posted, today);
  log(`date=${today} mode=${live ? 'LIVE' : 'dry-run'} (instagram)`);
  if (!post) {
    log(`nothing to post: ${reason}`);
    return { code: QUIET.has(reason) ? 0 : 1, reason };
  }
  const urls = post.images.map((f) => mediaBase + f);
  log(`post=${post.id} images=${urls.length}\n${urls.join('\n')}\n---\n${post.caption}\n---`);

  if (!live) {
    log('dry-run: not published');
    return { code: 0, stage: 'dry-run', postId: post.id };
  }
  if (!token || !userId) {
    errLog('IG_ACCESS_TOKEN / IG_USER_ID are not set');
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

  const secrets = [token, userId];
  const api = async (method, path, params = {}) => {
    const url = new URL(`${GRAPH}/${path}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    url.searchParams.set('access_token', token);
    const res = await fetchImpl(url, { method });
    const body = await res.text();
    if (!res.ok) throw new Error(`${method} ${path} failed (${res.status}): ${redactWith(body, secrets)}`);
    return JSON.parse(body);
  };
  const close = async (stage, extra = {}) => {
    const entry = J.event({ postId: post.id, date: today, stage, runId, runAttempt, at: now(), ...extra });
    try {
      const journal = await remoteJournal({ run: git, branch, path: IG_JOURNAL_PATH });
      await io.writeJson(IG_JOURNAL_PATH, [...journal, entry]);
      await pushAndVerify({ run: git, branch, files: [IG_JOURNAL_PATH], path: IG_JOURNAL_PATH, message: `chore(lostball): instagram ${stage} ${post.id} (${today})` });
      log(`journal: ${J.describe(entry)}`);
    } catch (err) {
      errLog(`journal NOT updated (${err.message}); the open claim keeps Instagram posting halted: ${J.describe(entry)}`);
    }
  };

  // media_publish の手前までは「下書き(コンテナ)」を作るだけで、プロフィールには出ない。
  // ここでの失敗は「何も投稿されていない」ので安全に中止できる。
  let creationId;
  try {
    for (const url of urls) {
      const head = await fetchImpl(url, { method: 'HEAD' });
      const type = head.headers?.get?.('content-type') ?? '';
      if (!head.ok || !/image\/jpe?g/i.test(type)) throw new Error(`image not reachable as JPEG: ${url} (${head.status} ${type})`);
    }
    if (urls.length === 1) {
      creationId = (await api('POST', `${userId}/media`, { image_url: urls[0], caption: post.caption })).id;
    } else {
      const children = [];
      for (const url of urls) children.push((await api('POST', `${userId}/media`, { image_url: url, is_carousel_item: 'true' })).id);
      creationId = (await api('POST', `${userId}/media`, { media_type: 'CAROUSEL', children: children.join(','), caption: post.caption })).id;
    }
    let status = '';
    for (let i = 0; i < pollTries; i++) {
      status = (await api('GET', creationId, { fields: 'status_code' })).status_code;
      if (status === 'FINISHED') break;
      if (status === 'ERROR' || status === 'EXPIRED') throw new Error(`container ${creationId} status ${status}`);
      await sleep(5_000);
    }
    if (status !== 'FINISHED') throw new Error(`container ${creationId} not ready (last status ${status || 'none'})`);
  } catch (err) {
    errLog(`step=container-failed postId=${post.id} date=${today}: ${redactWith(err.message, secrets)}`);
    await close(J.ABORTED, { note: 'container step failed; nothing was published' });
    return { code: 1, stage: J.ABORTED, postId: post.id };
  }
  log(`step=container-ready postId=${post.id} creationId=${creationId}`);

  let published;
  try {
    published = await api('POST', `${userId}/media_publish`, { creation_id: creationId });
  } catch (err) {
    errLog(`step=publish-unknown postId=${post.id} date=${today} creationId=${creationId}: ${redactWith(err.message, secrets)}`);
    await close(J.UNKNOWN, { note: `publish result unknown (creationId=${creationId})` });
    errLog(HALT);
    return { code: 1, stage: J.UNKNOWN, creationId, postId: post.id };
  }

  log(`published: postId=${post.id} date=${today} mediaId=${published.id}`);
  const record = { id: post.id, date: today, mediaId: published.id, publishedAt: now(), images: post.images, caption: post.caption };
  const entry = J.event({ postId: post.id, date: today, stage: J.PUBLISHED, runId, runAttempt, at: now(), threadsId: published.id, note: 'instagram mediaId stored in threadsId' });
  try {
    const journal = await remoteJournal({ run: git, branch, path: IG_JOURNAL_PATH });
    await io.writeJson(IG_POSTED_PATH, [...posted, record]);
    await io.writeJson(IG_JOURNAL_PATH, [...journal, entry]);
    await pushAndVerify({ run: git, branch, files: [IG_JOURNAL_PATH, IG_POSTED_PATH], path: IG_JOURNAL_PATH, message: `chore(lostball): record instagram ${post.id} (${today})` });
  } catch (err) {
    errLog(`RECORD NOT PERSISTED (${err.message})`);
    errLog(`recover: node scripts/ig-resolve.mjs --id ${post.id} --outcome published --media-id ${published.id} --by <name> --yes`);
    errLog(HALT);
    return { code: 1, stage: 'record-not-persisted', mediaId: published.id, postId: post.id };
  }
  return { code: 0, stage: J.PUBLISHED, mediaId: published.id, postId: post.id };
}

export async function runIgResolve({ io, id, outcome, mediaId, by, now, log }) {
  const journal = await io.readJson(IG_JOURNAL_PATH, []);
  const target = J.openEntries(journal).find((e) => e.postId === id);
  if (!target) {
    log(`nothing open for ${id}`);
    return { code: 1 };
  }
  const published = outcome === 'published';
  const entry = J.event({
    postId: id, date: target.date, stage: published ? J.PUBLISHED : J.RESOLVED,
    runId: `resolved-by:${by}`, runAttempt: '1', at: now(),
    threadsId: published ? (mediaId ?? null) : null,
    note: published ? 'confirmed live on Instagram by a human' : 'confirmed not published by a human',
  });
  await io.writeJson(IG_JOURNAL_PATH, [...journal, entry]);
  if (published) {
    const posted = await io.readJson(IG_POSTED_PATH, []);
    if (!posted.some((p) => p.id === id)) {
      const queue = await io.readJson(IG_QUEUE_PATH, []);
      const post = queue.find((p) => p.id === id);
      posted.push({ id, date: target.date, mediaId: mediaId ?? null, publishedAt: now(), images: post?.images ?? [], caption: post?.caption ?? '', recoveredBy: by });
      await io.writeJson(IG_POSTED_PATH, posted);
    }
  }
  log(`resolved: ${J.describe(entry)}; commit and push ${IG_JOURNAL_PATH} and ${IG_POSTED_PATH}.`);
  return { code: 0 };
}

// 土曜の確認用: 次の火曜〜月曜(today が土曜なら3日後〜9日後)の予定を並べる。
export function nextReviewWeek(today) {
  const d = new Date(`${today}T00:00:00Z`);
  const daysToTue = ((2 - d.getUTCDay()) + 7) % 7 || 7;
  const start = new Date(d.getTime() + daysToTue * 86400000);
  const end = new Date(start.getTime() + 6 * 86400000);
  return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
}

export function igWeekMarkdown(queue, { start, end }) {
  const items = queue.filter((p) => p.date >= start && p.date <= end).sort((a, b) => a.date.localeCompare(b.date));
  const out = [`## Instagram 来週の予定（${start}〜${end}）`, ''];
  if (!items.length) return [...out, '- まだ1本もありません → Claude に「来週のインスタを作って」と依頼', ''].join('\n');
  for (const p of items) {
    out.push(`- ${p.date} ${p.approved ? '✅承認済み' : '⏳未承認'} ${p.id}（画像${p.images.length}枚）「${(p.caption.split('\n').find((l) => l.trim()) ?? '').slice(0, 30)}」`);
  }
  out.push('');
  return out.join('\n');
}
