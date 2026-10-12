// ロストボールの X アカウントを接続する(最初の1回と、鍵を作り直したとき)。
// アカウントの持ち主が自分のターミナルで実行する。Claude は実行しない・値を見ない。
//
// X 開発者画面で作った4つの鍵を、表示されない入力欄に1つずつ貼り付ける。
// 鍵が本物か・どのアカウントのものかを GET /2/users/me で確かめてから、
// gh 経由で GitHub Secrets(X_API_KEY / X_API_SECRET / X_ACCESS_TOKEN / X_ACCESS_TOKEN_SECRET)に直接保存する。
// 秘密値は画面にもファイルにも出さない。アカウント名だけ data/x-account.json に残す。
//
// 使い方: node scripts/connect-x.mjs
import { createInterface } from 'node:readline';
import { spawnSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { oauthHeader } from '../lib/x-api.mjs';
import { redactX } from '../lib/x-flow.mjs';

const REPO = 'empowerartlab-art/threads-lostball-empowerartlab';
const ACCOUNT_PATH = 'data/x-account.json';
const ME_URL = 'https://api.x.com/2/users/me';

function ask(question, { hidden = false } = {}) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) rl._writeToOutput = (s) => { if (s.startsWith(question)) process.stdout.write(question); };
    rl.question(question, (answer) => { rl.close(); if (hidden) process.stdout.write('\n'); resolve(answer.trim()); });
  });
}

function setSecret(name, value) {
  const r = spawnSync('gh', ['secret', 'set', name, '--repo', REPO], { input: value, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`gh secret set ${name} failed`);
}

let account = {};
try {
  account = JSON.parse(await readFile(ACCOUNT_PATH, 'utf8'));
} catch (err) {
  if (err.code !== 'ENOENT') throw err;
}

console.log('X 開発者画面の4つの鍵を、1つずつ貼り付けてください（入力は表示されません）。');
const creds = {
  apiKey: await ask('1/4 API Key（Consumer Key）: ', { hidden: true }),
  apiSecret: await ask('2/4 API Key Secret（Consumer Secret）: ', { hidden: true }),
  accessToken: await ask('3/4 Access Token: ', { hidden: true }),
  accessSecret: await ask('4/4 Access Token Secret: ', { hidden: true }),
};
const secrets = Object.values(creds);

try {
  if (secrets.some((s) => !s)) throw new Error('空の鍵があります。何も保存していません。');
  const { header } = oauthHeader({ method: 'GET', url: ME_URL, consumerKey: creds.apiKey, consumerSecret: creds.apiSecret, token: creds.accessToken, tokenSecret: creds.accessSecret });
  const res = await fetch(ME_URL, { headers: { Authorization: header } });
  const body = await res.text();
  if (!res.ok) throw new Error(`鍵の確認に失敗しました（HTTP ${res.status}）: ${body.slice(0, 300)}\n何も保存していません。`);
  const username = JSON.parse(body)?.data?.username;
  if (!username) throw new Error('アカウント名が取れませんでした。何も保存していません。');

  if (account.xUsername && username !== account.xUsername) {
    throw new Error(`別のアカウント（@${username}）の鍵です。@${account.xUsername} で作り直してください。何も保存していません。`);
  }
  if (!account.xUsername) {
    const ok = await ask(`@${username} を接続します。ロストボールの X アカウントで合っていますか？ (y/N): `);
    if (ok.toLowerCase() !== 'y') throw new Error('中止しました。何も保存していません。');
  }
  console.log('（注意）投稿の権限（Read and write）が無い鍵でも、ここでは確認できません。最初の投稿で分かります。');

  setSecret('X_API_KEY', creds.apiKey);
  setSecret('X_API_SECRET', creds.apiSecret);
  setSecret('X_ACCESS_TOKEN', creds.accessToken);
  setSecret('X_ACCESS_TOKEN_SECRET', creds.accessSecret);

  await writeFile(ACCOUNT_PATH, JSON.stringify({ ...account, xUsername: username, connectedAt: new Date().toISOString() }, null, 2) + '\n');
  console.log(`\n✅ X @${username} を接続しました。GitHub Secrets に4つの鍵を保存済み。`);
} catch (err) {
  console.error(`\n❌ ${redactX(err.message, secrets)}`);
  process.exit(1);
}
