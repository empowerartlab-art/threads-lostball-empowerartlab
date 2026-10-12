// ロストボールの Instagram プロアカウントを接続する(初回と、約60日ごとの更新)。
// アカウントの持ち主が自分のターミナルで実行する。Claude は実行しない・値を見ない。
//
// Meta の開発者画面(Instagram API with Instagram Login → アクセストークンを生成)で
// コピーしたトークンを、表示されない入力欄に貼り付ける。トークンを確認・延長して、
// gh 経由で GitHub Secrets(IG_ACCESS_TOKEN / IG_USER_ID)に直接保存する。
// 秘密値は画面にもファイルにも出さない。有効期限の目安だけ data/ig-account.json に残す。
//
// 使い方: node scripts/connect-instagram.mjs
// (~/Documents/threads-zero-riders/scripts/connect-instagram.mjs から移植)
import { createInterface } from 'node:readline';
import { spawnSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { createSecretRedactor } from '../lib/redact.mjs';

const REPO = 'empowerartlab-art/threads-lostball-empowerartlab';
const ACCOUNT_PATH = 'data/ig-account.json';
const GRAPH = 'https://graph.instagram.com';

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

let token = await ask('Instagramのアクセストークン（Metaの画面でコピーしたもの。入力は表示されません）: ', { hidden: true });
const secrets = [token];
const redact = (s) => createSecretRedactor(secrets)(s);

try {
  const meRes = await fetch(`${GRAPH}/v23.0/me?fields=user_id,username&access_token=${encodeURIComponent(token)}`);
  const meBody = await meRes.text();
  if (!meRes.ok) throw new Error(`GET /me failed (${meRes.status}): ${meBody}`);
  const me = JSON.parse(meBody);
  secrets.push(String(me.user_id));

  // 2回目以降は前回のアカウント名と一致するかで取り違えを防ぐ。初回は本人に確認してもらう。
  if (account.igUsername && me.username !== account.igUsername) {
    throw new Error(`別のアカウント（@${me.username}）のトークンです。@${account.igUsername} で作り直してください。何も保存していません。`);
  }
  if (!account.igUsername) {
    const ok = await ask(`@${me.username} を接続します。ロストボールのアカウントで合っていますか？ (y/N): `);
    if (ok.toLowerCase() !== 'y') throw new Error('中止しました。何も保存していません。');
  }

  // 投稿の許可(instagram_business_content_publish)が入っているトークンでだけ答えが返る。
  const limRes = await fetch(`${GRAPH}/v23.0/${me.user_id}/content_publishing_limit?access_token=${encodeURIComponent(token)}`);
  if (!limRes.ok) {
    throw new Error('このトークンには「投稿の許可（instagram_business_content_publish）」が入っていません。Metaの「アクセス許可と機能」で追加してから、トークンを作り直してください。何も保存していません。');
  }
  console.log('✔ 投稿の許可を確認しました');

  // 有効期限を延ばす。作ったばかり(24時間未満)のトークンは延長できないので、その場合はそのまま使う。
  let expiresIn = 60 * 24 * 3600;
  const refRes = await fetch(`${GRAPH}/refresh_access_token?grant_type=ig_refresh_token&access_token=${encodeURIComponent(token)}`);
  if (refRes.ok) {
    const ref = await refRes.json();
    if (ref.access_token) {
      token = ref.access_token;
      secrets.push(token);
      expiresIn = ref.expires_in ?? expiresIn;
    }
  } else {
    console.log('（トークンの延長は今回はスキップしました。作ったばかりのトークンは延長できないためで、問題ありません）');
  }

  setSecret('IG_ACCESS_TOKEN', token);
  setSecret('IG_USER_ID', String(me.user_id));

  const expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();
  await writeFile(ACCOUNT_PATH, JSON.stringify({ ...account, igUsername: me.username, igTokenExpiresAt: expiresAt }, null, 2) + '\n');
  console.log(`\n✅ Instagram @${me.username} を接続しました。GitHub Secrets に保存済み（有効期限の目安: ${expiresAt.slice(0, 10)}）`);
  console.log(`   ${ACCOUNT_PATH} を commit / push してください（秘密値は入っていません）。`);
} catch (err) {
  console.error(`\n❌ ${redact(err.message)}`);
  process.exit(1);
}
