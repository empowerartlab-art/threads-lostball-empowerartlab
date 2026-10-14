// 直近7日の Threads / Instagram の投稿についた新しいコメントを探し、暗号化して
// data/comment-inbox.enc.json に置く(lib/comment-watch.mjs)。
// API は読むだけ。返信は一切しない。ログは件数だけ(コメントの中身は出さない)。
// 鍵が無い・許可が無い媒体は「許可なし（未接続）」と1行出して飛ばす(失敗にしない)。
import { readFile, writeFile } from 'node:fs/promises';
import { watchComments, fetchThreadsComments, fetchInstagramComments, normalizeSeen } from '../lib/comment-watch.mjs';

const ACCOUNT = 'ロストボール';
// 自分たちのアカウント。ここにあるユーザーのコメントは「新しいコメント」として送らない。
const OWN_USERNAMES = ['hetarou.golf2026', 'Hetarougolf', 'zero.riders24', 'lost_ball_empowerartlab', 'harley_solo.jp', 'empowerartlab0310', 'empowerartlab', 'keita_desuyo'];
const SEEN_PATH = 'data/comment-seen.json';
const INBOX_PATH = 'data/comment-inbox.enc.json';
// Secret の前後に空白・改行が入っていても使えるように trim する。
const env = (name) => (process.env[name] ?? '').trim();

const readJson = async (path, fallback) => {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    throw err;
  }
};

const channels = [
  { key: 'threads', label: 'Threads', fetch: (o) => fetchThreadsComments({ ...o, token: env('THREADS_ACCESS_TOKEN'), userId: env('THREADS_USER_ID'), ownUsernames: OWN_USERNAMES, profileUrl: 'https://www.threads.com/@lost_ball_empowerartlab' }) },
  { key: 'instagram', label: 'Instagram', fetch: (o) => fetchInstagramComments({ ...o, token: env('IG_ACCESS_TOKEN'), userId: env('IG_USER_ID'), ownUsernames: OWN_USERNAMES, profileUrl: 'https://www.instagram.com/lost_ball_empowerartlab/' }) },
];

const seenBefore = await readJson(SEEN_PATH, null);
const inboxBefore = await readJson(INBOX_PATH, []);
const publicKeyPem = await readFile('config/inbox-public.pem', 'utf8');
const { seen, inbox, log } = await watchComments({ channels, seen: seenBefore, inbox: inboxBefore, account: ACCOUNT, publicKeyPem });
for (const line of log) console.log(`comment-watch ${line}`);

// 変わったときだけ書く(変化が無ければ commit も起きない)。
const write = async (path, before, after) => {
  if (JSON.stringify(before) === JSON.stringify(after)) return false;
  await writeFile(path, JSON.stringify(after, null, 2) + '\n');
  return true;
};
const changed = [await write(SEEN_PATH, normalizeSeen(seenBefore), seen), await write(INBOX_PATH, inboxBefore, inbox)].some(Boolean);
console.log(`comment-watch inbox ${inbox.length} envelopes${changed ? '' : ' (no change)'}`);
