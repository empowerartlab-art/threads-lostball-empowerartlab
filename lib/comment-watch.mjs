// コメントの見回り: 直近の Threads / Instagram の投稿についた新しいコメントを探し、
// 暗号化して置いておく。sns-daily-digest がそれを読み、返信案をつけて LINE に送る。
// 両 API とも読むだけ。投稿・返信・非表示・削除は一切しない。
//
// ファイル(どちらも commit する。読めるコメント本文は入らない):
//   data/comment-seen.json      { seeded: ['threads', ...], ids: ['threads:123', ...] } 見た印(IDだけ)
//   data/comment-inbox.enc.json [{ id, fetchedAt, enc }] enc = AES-256-GCM で暗号化した中身。
//                               その鍵を RSA-OAEP-SHA256(config/inbox-public.pem)で包む。
// 秘密鍵は sns-daily-digest の Secret(INBOX_PRIVATE_KEY)にだけある。
//
// 同じファイルを各アカウントのリポジトリに置いている(threads-hetaro, threads-zero-riders,
// threads-harley-solo, threads-lostball-empowerartlab, threads-automation-empower)。

import { publicEncrypt, randomBytes, createCipheriv, constants } from 'node:crypto';

export const THREADS_GRAPH = 'https://graph.threads.net/v1.0';
export const IG_GRAPH = 'https://graph.instagram.com/v23.0';
export const SEEN_CAP = 2000;
export const KEEP_DAYS = 7; // 見る投稿の期間、inbox に残す期間
export const POST_LIMIT = 10;
export const MAX_PAGES = 3; // 1投稿あたりに読むコメントのページ数(Instagram は1ページ50件)
const DAY = 86400 * 1000;

// 鍵が無い・許可が無い: 静かに飛ばす(状態は変えない)。
export class NotConnected extends Error {}

// 401/403、OAuth エラー(190)、許可エラー(10, 200-299)。応答の中身は出さない。
export function isPermissionError(status, body) {
  const code = body?.error?.code;
  return status === 401 || status === 403 || code === 10 || code === 190 || (code >= 200 && code <= 299);
}

async function getJson(fetchImpl, url) {
  let res;
  try {
    res = await fetchImpl(url);
  } catch {
    throw new Error('network error'); // URL は出さない(鍵が入っているため)
  }
  const text = await res.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    // null のまま
  }
  if (res.ok) return body ?? {};
  if (isPermissionError(res.status, body)) throw new NotConnected(`HTTP ${res.status}`);
  throw new Error(`HTTP ${res.status}${body?.error?.code ? ` code ${body.error.code}` : ''}`);
}

async function getPages(fetchImpl, url) {
  const out = [];
  let next = url;
  for (let i = 0; next && i < MAX_PAGES; i++) {
    const page = await getJson(fetchImpl, next);
    out.push(...(page.data ?? []));
    next = page.paging?.next ?? null;
  }
  return out;
}

const recent = (items, now) => items.filter((m) => m.timestamp && Date.parse(m.timestamp) >= now - KEEP_DAYS * DAY).slice(0, POST_LIMIT);
const lower = (s) => String(s ?? '').toLowerCase();

// 直近7日の Threads の投稿への返信(1段目だけ。GET /{media-id}/replies)。
export async function fetchThreadsComments({ fetchImpl = fetch, token, userId, now = Date.now(), ownUsernames = [], profileUrl = '' }) {
  if (!token || !userId) throw new NotConnected('no token');
  const t = encodeURIComponent(token);
  const own = new Set(ownUsernames.map(lower));
  const posts = recent((await getJson(fetchImpl, `${THREADS_GRAPH}/${userId}/threads?fields=id,text,permalink,timestamp&limit=${POST_LIMIT}&access_token=${t}`)).data ?? [], now);
  const out = [];
  for (const p of posts) {
    const replies = await getPages(fetchImpl, `${THREADS_GRAPH}/${p.id}/replies?fields=id,text,username,timestamp,is_reply_owned_by_me,hide_status&reverse=true&access_token=${t}`);
    for (const r of replies) {
      if (!r.id || r.is_reply_owned_by_me || own.has(lower(r.username))) continue;
      if (r.hide_status && !['NOT_HUSHED', 'UNHUSHED'].includes(r.hide_status)) continue;
      out.push({ id: `threads:${r.id}`, media: 'Threads', postUrl: p.permalink || profileUrl, postText: String(p.text ?? '').slice(0, 80), commentText: String(r.text ?? ''), username: r.username ?? '', commentedAt: r.timestamp ?? '' });
    }
  }
  return out;
}

// 直近7日の Instagram の投稿へのコメント(1段目だけ。GET /{media-id}/comments)。
export async function fetchInstagramComments({ fetchImpl = fetch, token, userId, now = Date.now(), ownUsernames = [], profileUrl = '' }) {
  if (!token || !userId) throw new NotConnected('no token');
  const t = encodeURIComponent(token);
  const own = new Set(ownUsernames.map(lower));
  const posts = recent((await getJson(fetchImpl, `${IG_GRAPH}/${userId}/media?fields=id,caption,permalink,timestamp&limit=${POST_LIMIT}&access_token=${t}`)).data ?? [], now);
  const out = [];
  for (const p of posts) {
    const comments = await getPages(fetchImpl, `${IG_GRAPH}/${p.id}/comments?fields=id,text,username,from,timestamp,hidden&limit=50&access_token=${t}`);
    for (const c of comments) {
      const username = c.username ?? c.from?.username ?? '';
      if (!c.id || c.hidden || own.has(lower(username))) continue;
      out.push({ id: `instagram:${c.id}`, media: 'Instagram', postUrl: p.permalink || profileUrl, postText: String(p.caption ?? '').slice(0, 80), commentText: String(c.text ?? ''), username, commentedAt: c.timestamp ?? '' });
    }
  }
  return out;
}

// 暗号化: 1件ごとに新しい AES-256-GCM の鍵を作り、その鍵を RSA-OAEP-SHA256 で包む。
export function encryptPayload(publicKeyPem, payload) {
  const key = randomBytes(32);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
  const wrapped = publicEncrypt({ key: publicKeyPem, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, key);
  return { v: 1, alg: 'RSA-OAEP-256+A256GCM', key: wrapped.toString('base64'), iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') };
}

export function normalizeSeen(seen) {
  return { seeded: Array.isArray(seen?.seeded) ? [...seen.seeded] : [], ids: Array.isArray(seen?.ids) ? [...seen.ids] : [] };
}

// 純粋な関数: 1つの媒体のコメントを seen / inbox に反映する。
// その媒体の初回は、いまあるコメントを「見た」にするだけ(昔のコメントを大量に送らない)。
// 2回目からは、まだ見ていないコメント1件ごとに暗号化した1通を足す。
export function applyComments({ seen, inbox, channel, comments, account, publicKeyPem, fetchedAt, encrypt = encryptPayload }) {
  const s = normalizeSeen(seen);
  const known = new Set(s.ids);
  const fresh = comments.filter((c) => !known.has(c.id));
  let next = Array.isArray(inbox) ? [...inbox] : [];
  let added = 0;
  if (!s.seeded.includes(channel)) {
    s.seeded.push(channel);
  } else {
    const sorted = [...fresh].sort((a, b) => String(a.commentedAt).localeCompare(String(b.commentedAt)));
    for (const c of sorted) {
      const payload = { account, media: c.media, postUrl: c.postUrl, postText: c.postText, commentText: c.commentText, username: c.username, commentedAt: c.commentedAt };
      next.push({ id: c.id, fetchedAt, enc: encrypt(publicKeyPem, payload) });
      added++;
    }
  }
  for (const c of fresh) s.ids.push(c.id);
  s.ids = s.ids.slice(-SEEN_CAP);
  return { seen: s, inbox: next, added, seeded: fresh.length - added };
}

// KEEP_DAYS より古いものは消す。
export function pruneInbox(inbox, now = Date.now()) {
  return (Array.isArray(inbox) ? inbox : []).filter((e) => Date.parse(e.fetchedAt) >= now - KEEP_DAYS * DAY);
}

// 全媒体を1回見回る。新しい状態と、中身を含まないログ(件数だけ)を返す。
export async function watchComments({ channels, seen, inbox, account, publicKeyPem, fetchImpl = fetch, now = () => Date.now(), encrypt = encryptPayload }) {
  let state = { seen: normalizeSeen(seen), inbox: Array.isArray(inbox) ? inbox : [] };
  const log = [];
  for (const ch of channels) {
    let comments;
    try {
      comments = await ch.fetch({ fetchImpl, now: now() });
    } catch (err) {
      if (err instanceof NotConnected) log.push(`${ch.label}: 許可なし（未接続）`);
      else log.push(`${ch.label}: 読めませんでした（${err.message}）`);
      continue;
    }
    const r = applyComments({ ...state, channel: ch.key, comments, account, publicKeyPem, fetchedAt: new Date(now()).toISOString(), encrypt });
    state = { seen: r.seen, inbox: r.inbox };
    log.push(`${ch.label}: ${comments.length} comments, ${r.added} new${r.seeded ? `, ${r.seeded} marked seen (first run)` : ''}`);
  }
  state.inbox = pruneInbox(state.inbox, now());
  return { ...state, log };
}
