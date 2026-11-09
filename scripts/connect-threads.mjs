// ロストボールの Threads の鍵を発行し直して GitHub に保存する。代表者がターミナルで自分で動かす。
// 使い方: node scripts/connect-threads.mjs [アプリの設定ファイル]
// 鍵は画面に出さない。違うアカウントの鍵は保存しない。
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const REPO = 'empowerartlab-art/threads-lostball-empowerartlab';
const USERNAME = 'lost_ball_empowerartlab';
const ENV_FILE = process.argv[2] ?? join(homedir(), 'projects/threads-lostball-empowerartlab/.env.local');
const SCOPES = 'threads_basic,threads_content_publish,threads_manage_insights,threads_read_replies,threads_manage_replies';

const env = Object.fromEntries(
  readFileSync(ENV_FILE, 'utf8').split('\n')
    .map((line) => line.replace(/^export\s+/, '').match(/^([A-Z_]+)=["']?(.*?)["']?\s*$/))
    .filter(Boolean).map((m) => [m[1], m[2]]),
);
const { THREADS_CLIENT_ID: clientId, THREADS_CLIENT_SECRET: secret, THREADS_REDIRECT_URI: redirect } = env;

function ask(label) {
  process.stdout.write(`${label}: `);
  const res = spawnSync('sh', ['-c', 'IFS= read -r v; printf %s "$v"'], { stdio: ['inherit', 'pipe', 'inherit'], encoding: 'utf8' });
  return res.stdout.trim();
}

function saveSecret(name, value) {
  const res = spawnSync('gh', ['secret', 'set', name, '-R', REPO], { input: value, encoding: 'utf8' });
  if (res.status !== 0) throw new Error(`${name} を保存できませんでした`);
}

// 通信が切れることがあるので、3回まで間をあけてやり直す。
async function json(url, init) {
  for (let i = 0; ; i += 1) {
    try {
      const res = await fetch(url, init);
      return { ok: res.ok, data: await res.json().catch(() => ({})) };
    } catch (err) {
      if (i === 2) return { ok: false, data: { error_message: '通信が切れました。もう一度試してください' } };
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}

const failed = (r) => `Threads: ${r.data.error?.code ?? r.data.error_code ?? r.data.code ?? ''} ${r.data.error_message ?? r.data.error?.type ?? ''}`.slice(0, 120);

const auth = new URL('https://threads.net/oauth/authorize');
Object.entries({ client_id: clientId, redirect_uri: redirect, scope: SCOPES, response_type: 'code' }).forEach(([k, v]) => auth.searchParams.set(k, v));
console.log('\n次のURLを Chrome で開いて、許可してください:\n');
console.log(auth.toString());
console.log('');

for (let i = 0; i < 3; i += 1) {
  const code = ask('画面に出たコード').replace(/#_?$/, '');
  const body = new URLSearchParams({ client_id: clientId, client_secret: secret, grant_type: 'authorization_code', redirect_uri: redirect, code });
  const short = await json('https://graph.threads.net/oauth/access_token', { method: 'POST', body });
  if (!short.ok) {
    console.log(`うまくいきませんでした（${failed(short)}）`);
    continue;
  }
  const long = await json(`https://graph.threads.net/access_token?${new URLSearchParams({ grant_type: 'th_exchange_token', client_secret: secret, access_token: short.data.access_token })}`);
  if (!long.ok) {
    console.log(`うまくいきませんでした（${failed(long)}）`);
    continue;
  }
  const me = await json(`https://graph.threads.net/v1.0/me?fields=id,username&access_token=${encodeURIComponent(long.data.access_token)}`);
  if (me.data.username !== USERNAME) {
    console.error(`違うアカウント（@${me.data.username}）です。保存しませんでした。@${USERNAME} でログインし直してください`);
    process.exit(1);
  }
  saveSecret('THREADS_ACCESS_TOKEN', long.data.access_token);
  console.log(`保存しました: @${me.data.username}`);
  process.exit(0);
}
console.error('3回とも通りませんでした。ここで終わります');
process.exit(1);
