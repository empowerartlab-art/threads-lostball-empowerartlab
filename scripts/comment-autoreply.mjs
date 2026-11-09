// Threads のコメントへの自動返信（lib/comment-autoreply.mjs）。ログは件数だけ。
import { readFile, writeFile } from 'node:fs/promises';
import { fetchThreadsComments, NotConnected } from '../lib/comment-watch.mjs';
import { runAutoReply } from '../lib/comment-autoreply.mjs';

const ACCOUNT = 'ロストボール';
const TONE = 'lostball';
const PROFILE_URL = 'https://www.threads.com/@lost_ball_empowerartlab';
const FACTS_PATH = 'data/verified-facts.json'; // 確認済みの事実のファイル（ロストボールだけ）
const OWN_USERNAMES = ['hetarou.golf2026', 'Hetarougolf', 'zero.riders24', 'lost_ball_empowerartlab', 'harley_solo.jp', 'empowerartlab0310', 'empowerartlab', 'keita_desuyo', 'social.life2019'];
const STATE_PATH = 'data/comment-autoreply.json';
const INBOX_PATH = 'data/comment-inbox.enc.json';
const env = (name) => (process.env[name] ?? '').trim();

const readJson = async (path, fallback) => {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    throw err;
  }
};

const token = env('THREADS_ACCESS_TOKEN');
const userId = env('THREADS_USER_ID');
let comments;
try {
  comments = await fetchThreadsComments({ token, userId, ownUsernames: OWN_USERNAMES, profileUrl: PROFILE_URL });
} catch (err) {
  console.log(`comment-autoreply: コメントを読めませんでした（${err instanceof NotConnected ? '未接続' : err.message}）`);
  process.exit(err instanceof NotConnected ? 0 : 1);
}

let facts = [];
if (FACTS_PATH) {
  const j = await readJson(FACTS_PATH, null);
  facts = (Array.isArray(j) ? j : j?.facts ?? []).filter((f) => f?.verified === true).map((f) => f.statementJa).filter(Boolean);
}

const stateBefore = await readJson(STATE_PATH, null);
const inboxBefore = await readJson(INBOX_PATH, []);
const publicKeyPem = await readFile('config/inbox-public.pem', 'utf8');
const { state, inbox, stats } = await runAutoReply({
  comments, state: stateBefore, inbox: inboxBefore, account: ACCOUNT, tone: TONE, facts, publicKeyPem,
  token, userId, apiKey: env('GEMINI_API_KEY'), enabled: env('AUTO_REPLY') === 'on',
});
console.log(`comment-autoreply: ${JSON.stringify(stats)}`);

const write = async (path, before, after) => {
  if (JSON.stringify(before) === JSON.stringify(after)) return;
  await writeFile(path, JSON.stringify(after, null, 2) + '\n');
};
await write(STATE_PATH, stateBefore, state);
await write(INBOX_PATH, inboxBefore, inbox);
