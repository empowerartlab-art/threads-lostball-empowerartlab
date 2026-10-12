// X アカウントを接続する(最初の1回と、鍵を作り直したとき)。持ち主が自分のターミナルで実行する。
// Claude は実行しない・値を見ない。
//
// 1つの X 開発者アプリで、複数のアカウント(ロストボール・ZERO RIDERS・ハーレー・エンパワー)に
// 投稿できるようにする。各アカウントの開発者登録は不要。流れ:
//   1. アプリの API Key / API Key Secret を貼る(表示されない)
//   2. 表示された URL を、接続したい X アカウントでログインしたブラウザで開き「許可」→ 7桁の PIN が出る
//   3. PIN を入力 → そのアカウント用の Access Token / Secret を受け取り、アカウント名を確認
//   4. 4つの鍵を、指定したリポジトリの GitHub Secrets に直接保存
//      (X_API_KEY / X_API_SECRET / X_ACCESS_TOKEN / X_ACCESS_TOKEN_SECRET)
// 秘密値は画面にもファイルにも出さない。
//
// 使い方: node scripts/connect-x.mjs                          (このリポジトリ=ロストボール)
//         node scripts/connect-x.mjs --repo empowerartlab-art/threads-zero-riders
//         node scripts/connect-x.mjs --all    (4アカウントを順番に。API Key の入力は1回だけ)
import { createInterface } from 'node:readline';
import { spawnSync } from 'node:child_process';
import { createHmac, randomBytes } from 'node:crypto';
import { redactX } from '../lib/x-flow.mjs';

// 接続先: --all なら下の4つを順番に、--repo なら1つ、何も無ければロストボール。
const ALL = [
  { repo: 'empowerartlab-art/threads-automation-empower', label: 'エンパワー' },
  { repo: 'empowerartlab-art/threads-harley-solo', label: 'ハーレー個人' },
  { repo: 'empowerartlab-art/threads-lostball-empowerartlab', label: 'ロストボール' },
  { repo: 'empowerartlab-art/threads-zero-riders', label: 'ZERO RIDERS' },
];
const argRepo = process.argv.indexOf('--repo');
const TARGETS = process.argv.includes('--all')
  ? ALL
  : [{ repo: argRepo === -1 ? 'empowerartlab-art/threads-lostball-empowerartlab' : process.argv[argRepo + 1], label: '' }];
const API = 'https://api.x.com';

function ask(question, { hidden = false } = {}) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) rl._writeToOutput = (s) => { if (s.startsWith(question)) process.stdout.write(question); };
    rl.question(question, (answer) => { rl.close(); if (hidden) process.stdout.write('\n'); resolve(answer.trim()); });
  });
}

function setSecret(repo, name, value) {
  const r = spawnSync('gh', ['secret', 'set', name, '--repo', repo], { input: value, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`gh secret set ${name} failed`);
}

const pe = (s) => encodeURIComponent(String(s)).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

// OAuth 1.0a の署名付きリクエスト(PIN 方式の request_token / access_token 用)。
async function signedPost(url, { consumerKey, consumerSecret, token = '', tokenSecret = '', oauthExtra = {}, form = {} }) {
  const oauth = {
    oauth_consumer_key: consumerKey,
    oauth_nonce: randomBytes(16).toString('hex'),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: String(Math.floor(Date.now() / 1000)),
    oauth_version: '1.0',
    ...(token ? { oauth_token: token } : {}),
    ...oauthExtra,
  };
  const all = { ...form, ...oauth };
  const params = Object.keys(all).sort().map((k) => `${pe(k)}=${pe(all[k])}`).join('&');
  const base = ['POST', pe(url), pe(params)].join('&');
  oauth.oauth_signature = createHmac('sha1', `${pe(consumerSecret)}&${pe(tokenSecret)}`).update(base).digest('base64');
  const header = 'OAuth ' + Object.entries(oauth).map(([k, v]) => `${pe(k)}="${pe(v)}"`).join(', ');
  const body = new URLSearchParams(form).toString();
  const res = await fetch(url, { method: 'POST', headers: { Authorization: header, 'Content-Type': 'application/x-www-form-urlencoded' }, body });
  const text = await res.text();
  if (!res.ok) throw new Error(`${url} failed (HTTP ${res.status}): ${text.slice(0, 300)}`);
  return Object.fromEntries(new URLSearchParams(text));
}


console.log(`接続するアカウント: ${TARGETS.map((t) => t.label || t.repo).join(' → ')}`);
const consumerKey = await ask('1/2 アプリの API Key（コンシューマーキー）: ', { hidden: true });
const consumerSecret = await ask('2/2 アプリの API Key Secret（コンシューマーシークレット）: ', { hidden: true });
const secrets = [consumerKey, consumerSecret];
if (!consumerKey || !consumerSecret) {
  console.error('❌ 空の鍵があります。何も保存していません。');
  process.exit(1);
}

let failed = 0;
for (const { repo, label } of TARGETS) {
  console.log(`\n===== ${label || repo} =====`);
  try {
    const req = await signedPost(`${API}/oauth/request_token`, { consumerKey, consumerSecret, oauthExtra: { oauth_callback: 'oob' } });
    secrets.push(req.oauth_token, req.oauth_token_secret);
    console.log(`ブラウザの X を「${label || '接続したいアカウント'}」に切り替えてから、次の URL を開き「アプリにアクセスを許可」を押してください。`);
    console.log(`  https://api.x.com/oauth/authorize?oauth_token=${req.oauth_token}\n`);
    const pin = await ask('表示された PIN（数字）。このアカウントを飛ばすなら空のまま Enter: ');
    if (!pin) {
      console.log('飛ばしました（何も保存していません）。');
      continue;
    }
    const acc = await signedPost(`${API}/oauth/access_token`, {
      consumerKey, consumerSecret, token: req.oauth_token, tokenSecret: req.oauth_token_secret, form: { oauth_verifier: pin },
    });
    secrets.push(acc.oauth_token, acc.oauth_token_secret);
    const username = acc.screen_name;
    if (!acc.oauth_token || !acc.oauth_token_secret || !username) throw new Error('鍵を受け取れませんでした。何も保存していません。');
    const ok = await ask(`@${username} を ${label || repo}（${repo}）に接続します。合っていますか？ (y/N): `);
    if (ok.toLowerCase() !== 'y') throw new Error('中止しました。このアカウントには何も保存していません。');

    setSecret(repo, 'X_API_KEY', consumerKey);
    setSecret(repo, 'X_API_SECRET', consumerSecret);
    setSecret(repo, 'X_ACCESS_TOKEN', acc.oauth_token);
    setSecret(repo, 'X_ACCESS_TOKEN_SECRET', acc.oauth_token_secret);
    console.log(`✅ @${username} を ${label || repo} に接続しました（GitHub Secrets に4つの鍵を保存済み）。`);
  } catch (err) {
    failed++;
    console.error(`❌ ${label || repo}: ${redactX(err.message, secrets)}`);
  }
}
console.log(failed ? `\n${failed}件うまくいきませんでした。上のメッセージを Claude に伝えてください（鍵の値は貼らないでください）。` : '\nすべて完了しました。');
process.exit(failed ? 1 : 0);
