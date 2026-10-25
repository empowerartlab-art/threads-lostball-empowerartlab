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
//     唯一の例外は CHARACTER_HETARO(ヘタ郎のキャラクター画像。hetaro-media の GitHub Pages の
//     画像だけ・説明文に「見習いアンバサダー」が毎回必要(「#ヘタ郎」だけは不可)。lib/media-guard.mjs)。
//
// リール(2026-10-25 代表者決定。ZERO RIDERS の lib/ig-flow.mjs から移植):
//   - 承認データに `video: "<名前>.mp4"`(images は書かない)があるとリール(media_type=REELS)で出す。
//     `cover: "<名前>.jpg"`(表紙。省略可)、`shareToFeed`(省略時 true＝フィードにも出す)。
//   - 動画も assets/instagram/ に置く。ただし raw.githubusercontent.com は mp4 を
//     application/octet-stream で返す(2026-10-25 確認)ため、動画だけはこのリポジトリの
//     GitHub Pages(IG_VIDEO_BASE)の URL を渡す。表紙は画像と同じ raw の URL。
//   - 投稿前に動画が video/mp4(表紙は JPEG)で見られるか HEAD で確かめ、だめなら何も出さず止まる。
//   - リールの入れ物は処理に時間がかかるので、10秒ごとに最長5分待つ。
//   - 映像は AI 可(自然な見た目)。AI で作った映像は mediaType=AI_VIDEO(リール専用)。説明文に AI 注記は入れない。
//     AI_VIDEO でも画像(静止画)の AI は今までどおり不可。ヘタ郎のリールは未対応(検査で止める)。
//   - 予約(claim)・記録・dry run・自動でやり直さない決まりは画像と同じ。

import { createSecretRedactor } from './redact.mjs';
import { checkClaims } from './claim-guard.mjs';
import { checkProjectName, isProjectNameRuleDate } from './project-name-guard.mjs';
import { checkFactFabricationSignals } from './fact-fabrication-guard.mjs';
import * as J from './ig-journal.mjs';
import { remoteJournal, pushAndVerify } from './ig-persist.mjs';
import { CHARACTER_HETARO, checkHetaroCharacterPost, hetaroImageUrl } from './media-guard.mjs';

export const IG_QUEUE_PATH = 'data/ig-queue.json';
export const IG_POSTED_PATH = 'data/ig-posts.json';
export const IG_JOURNAL_PATH = 'data/ig-journal.json';
export const IG_MEDIA_DIR = 'assets/instagram/';
export const IG_MEDIA_BASE = `https://raw.githubusercontent.com/empowerartlab-art/threads-lostball-empowerartlab/main/${IG_MEDIA_DIR}`;
// 動画(mp4)用。GitHub Pages(main ブランチ・ルート)を有効にすると video/mp4 で配信される。
export const IG_VIDEO_BASE = `https://empowerartlab-art.github.io/threads-lostball-empowerartlab/${IG_MEDIA_DIR}`;
const GRAPH = 'https://graph.instagram.com/v23.0';
const MAX_CAPTION = 2200;
const MAX_HASHTAGS = 8; // ブランド方針: Instagram はタグ5〜8個まで
const POLL_MS = 5_000;
// リール: Meta は status_code を1分に1回・最長5分の確認を勧めている。10秒前後のリールは
// たいてい早く終わるので、10秒ごとに最長5分(30回)見る。
const REEL_POLL_MS = 10_000;
const REEL_POLL_TRIES = 30;

// AI で作った映像(リール専用。2026-10-25 代表者決定)。静止画(images)には使えない。
export const AI_VIDEO = 'AI_VIDEO';
export const IG_REEL_MEDIA_TYPES = ['BRAND_GRAPHIC', 'PRODUCT_PHOTO', 'REAL_PHOTO', 'REAL_WORK', AI_VIDEO];

export const isReel = (p) => typeof p?.video === 'string' && p.video !== '';

// AI_ASSISTED_VISUAL は Instagram では使わない(使うなら人が方針を決めてからここに足す)。
// CHARACTER_HETARO だけは AI 画像の例外(2026-10-14 オーナー最終OK)。条件は checkHetaroCharacterPost。
export const IG_ALLOWED_MEDIA_TYPES = ['BRAND_GRAPHIC', 'PRODUCT_PHOTO', 'REAL_PHOTO', 'REAL_WORK', CHARACTER_HETARO];

// 投稿の画像指定 → Instagram に渡す公開 URL。
// CHARACTER_HETARO はヘタ郎の置き場(GitHub Pages)、それ以外はこのリポジトリの assets/instagram/。
export function igImageUrls(post, mediaBase = IG_MEDIA_BASE) {
  if (post.mediaType === CHARACTER_HETARO) {
    return post.images.map((f) => {
      const url = hetaroImageUrl(f);
      if (!url) throw new Error(`${post.id}: not a ヘタ郎 image: ${f}`);
      return url;
    });
  }
  return post.images.map((f) => mediaBase + f);
}

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
    if (p.video !== undefined) {
      // リール(動画)。ファイルは assets/instagram/ に置く(名前だけ。"/" は不可)。
      if (typeof p.video !== 'string' || !/^[\w.-]+\.mp4$/i.test(p.video)) errors.push(`${p.id}: video must be an .mp4 file name`);
      if (Array.isArray(p.images) ? p.images.length > 0 : p.images !== undefined) errors.push(`${p.id}: a reel (video) cannot also have images`);
      if (p.cover !== undefined && (typeof p.cover !== 'string' || !/^[\w.-]+\.jpe?g$/i.test(p.cover))) errors.push(`${p.id}: cover must be a .jpg file name`);
      if (p.shareToFeed !== undefined && typeof p.shareToFeed !== 'boolean') errors.push(`${p.id}: shareToFeed must be true or false`);
      if (!IG_REEL_MEDIA_TYPES.includes(p.mediaType)) errors.push(`${p.id}: a reel's mediaType must be one of ${IG_REEL_MEDIA_TYPES.join('/')} (ヘタ郎のリールは未対応)`);
      if (p.mediaType === AI_VIDEO) warnings.push(`${p.id}: AI の映像。実際の商品・お客様・出来事の証拠のように見せていないか確認(説明文に AI 注記は入れない)`);
    } else if (p.cover !== undefined || p.shareToFeed !== undefined) errors.push(`${p.id}: cover / shareToFeed are only for reels (video)`);
    else if (p.mediaType === AI_VIDEO) errors.push(`${p.id}: ${AI_VIDEO} is only for reels (video). AI の静止画は使わない`);
    else if (!Array.isArray(p.images) || p.images.length < 1 || p.images.length > 10) errors.push(`${p.id}: needs 1-10 images`);
    else if (p.mediaType === CHARACTER_HETARO) {
      // ヘタ郎の画像は hetaro-media の URL / パスのみ(このリポジトリの画像や他サイトの画像は混ぜない)
      for (const e of checkHetaroCharacterPost({ images: p.images, caption: p.caption }).errors) errors.push(`${p.id}: ${e}`);
    } else if (p.images.some((f) => !/^[\w.-]+\.jpe?g$/i.test(f))) errors.push(`${p.id}: images must be .jpg file names`);
    else if (p.images.some((f) => /hetaro/i.test(f))) errors.push(`${p.id}: ヘタ郎の画像は mediaType ${CHARACTER_HETARO}（hetaro-media の画像）でしか使えない`);
    if (p.mediaType !== CHARACTER_HETARO && typeof p.caption === 'string' && p.caption.includes('ヘタ郎')) {
      warnings.push(`${p.id}: 説明文にヘタ郎が出てくるが mediaType=${p.mediaType}。ヘタ郎の画像なら ${CHARACTER_HETARO} にする`);
    }
    if (p.video === undefined && p.mediaType !== AI_VIDEO && !IG_ALLOWED_MEDIA_TYPES.includes(p.mediaType)) errors.push(`${p.id}: mediaType must be one of ${IG_ALLOWED_MEDIA_TYPES.join('/')} (AI画像は使わない。例外は ${CHARACTER_HETARO} のみ)`);
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
    // プロジェクト名の書き方（2026-10-26 以降の項目だけ。投稿済みの過去分は対象外）。
    if (isProjectNameRuleDate(p.date)) for (const e of checkProjectName(p)) errors.push(`${p.id}: ${e}`);
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
  mediaBase = IG_MEDIA_BASE, videoBase = IG_VIDEO_BASE, pollTries = 20, reelPollTries = REEL_POLL_TRIES,
}) {
  const queue = await io.readJson(IG_QUEUE_PATH, []);
  const posted = await io.readJson(IG_POSTED_PATH, []);
  const { post, reason } = selectIgToday(queue, posted, today);
  log(`date=${today} mode=${live ? 'LIVE' : 'dry-run'} (instagram)`);
  if (!post) {
    log(`nothing to post: ${reason}`);
    return { code: QUIET.has(reason) ? 0 : 1, reason };
  }
  const reel = isReel(post);
  const videoUrl = reel ? videoBase + post.video : null;
  const coverUrl = reel && post.cover ? mediaBase + post.cover : null;
  const shareToFeed = post.shareToFeed !== false;
  let urls = [];
  if (!reel) {
    try {
      urls = igImageUrls(post, mediaBase);
    } catch (err) {
      log(`not publishing: ${err.message}`);
      return { code: 1, reason: 'bad-image-source', postId: post.id };
    }
  }
  if (reel) log(`post=${post.id} type=REELS share_to_feed=${shareToFeed}\nvideo: ${videoUrl}\ncover: ${coverUrl ?? '(first frame)'}\n---\n${post.caption}\n---`);
  else log(`post=${post.id} images=${urls.length}\n${urls.join('\n')}\n---\n${post.caption}\n---`);

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
  const checkType = async (url, re, what) => {
    const head = await fetchImpl(url, { method: 'HEAD' });
    const type = head.headers?.get?.('content-type') ?? '';
    if (!head.ok || !re.test(type)) throw new Error(`${what} not reachable: ${url} (${head.status} ${type})`);
  };
  try {
    if (reel) {
      await checkType(videoUrl, /^video\/mp4\b/i, 'video as MP4');
      if (coverUrl) await checkType(coverUrl, /image\/jpe?g/i, 'cover as JPEG');
    }
    for (const url of urls) await checkType(url, /image\/jpe?g/i, 'image as JPEG');
    if (reel) {
      const params = { media_type: 'REELS', video_url: videoUrl, caption: post.caption, share_to_feed: String(shareToFeed) };
      if (coverUrl) params.cover_url = coverUrl;
      creationId = (await api('POST', `${userId}/media`, params)).id;
    } else if (urls.length === 1) {
      creationId = (await api('POST', `${userId}/media`, { image_url: urls[0], caption: post.caption })).id;
    } else {
      const children = [];
      for (const url of urls) children.push((await api('POST', `${userId}/media`, { image_url: url, is_carousel_item: 'true' })).id);
      creationId = (await api('POST', `${userId}/media`, { media_type: 'CAROUSEL', children: children.join(','), caption: post.caption })).id;
    }
    let status = '';
    const tries = reel ? reelPollTries : pollTries;
    for (let i = 0; i < tries; i++) {
      status = (await api('GET', creationId, { fields: 'status_code' })).status_code;
      if (status === 'FINISHED') break;
      if (status === 'ERROR' || status === 'EXPIRED') throw new Error(`container ${creationId} status ${status}`);
      await sleep(reel ? REEL_POLL_MS : POLL_MS);
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
  const record = reel
    ? { id: post.id, date: today, mediaId: published.id, publishedAt: now(), type: 'REELS', video: post.video, cover: post.cover ?? null, caption: post.caption }
    : { id: post.id, date: today, mediaId: published.id, publishedAt: now(), images: post.images, caption: post.caption };
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
      const media = isReel(post) ? { type: 'REELS', video: post.video, cover: post.cover ?? null } : { images: post?.images ?? [] };
      posted.push({ id, date: target.date, mediaId: mediaId ?? null, publishedAt: now(), ...media, caption: post?.caption ?? '', recoveredBy: by });
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
    const kind = isReel(p) ? `リール（動画${p.cover ? '・表紙あり' : ''}）` : `画像${p.images?.length ?? 0}枚`;
    out.push(`- ${p.date} ${p.approved ? '✅承認済み' : '⏳未承認'} ${p.id}（${kind}）「${(p.caption.split('\n').find((l) => l.trim()) ?? '').slice(0, 30)}」`);
  }
  out.push('');
  return out.join('\n');
}
