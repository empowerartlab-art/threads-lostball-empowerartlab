#!/usr/bin/env node
// 通行証（アクセストークン）を期限が切れる前に新しくする（週1回・GitHub Actions）。2026-11-20 代表の指示で追加。
// - Threads（THREADS_ACCESS_TOKEN）と Instagram（IG_ACCESS_TOKEN、あれば）を refresh して 60日延ばす
// - 新しい通行証は GitHub Secrets に上書き（SECRETS_WRITE_TOKEN = Secrets の書き込みだけできる鍵）
// - 新しい期限を data/token-meta.json に書く（sns-daily-digest が読み、14日を切ると朝のまとめで知らせる）
// - 通行証の中身はログに出さない。失敗したら終了コード 1（朝のまとめの「失敗」に出る）
// DRY_RUN=true：延ばさず、今の通行証で接続できるかと、書き込み用の鍵が使えるかだけ確かめる
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const KINDS = [
  { name: 'Threads', secret: 'THREADS_ACCESS_TOKEN', field: 'tokenExpiresAt',
    refresh: (t) => `https://graph.threads.net/refresh_access_token?grant_type=th_refresh_token&access_token=${encodeURIComponent(t)}`,
    me: (t) => `https://graph.threads.net/v1.0/me?fields=id,username&access_token=${encodeURIComponent(t)}` },
  { name: 'Instagram', secret: 'IG_ACCESS_TOKEN', field: 'igTokenExpiresAt',
    refresh: (t) => `https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=${encodeURIComponent(t)}`,
    me: (t) => `https://graph.instagram.com/v21.0/me?fields=user_id,username&access_token=${encodeURIComponent(t)}` },
];
const META = 'data/token-meta.json';

export function hide(text, secrets) {
  let s = String(text ?? '');
  for (const x of secrets) if (x) s = s.split(x).join('[REDACTED]');
  return s;
}

async function getJson(url, secrets, fetchImpl) {
  const r = await fetchImpl(url);
  let j = null;
  try { j = await r.json(); } catch { /* not json */ }
  if (!r.ok || !j || j.error) throw new Error(hide(`HTTP ${r.status} ${j?.error?.message ?? ''}`.trim(), secrets).slice(0, 200));
  return j;
}

function setSecret(name, value, repo, run = spawnSync) {
  const p = run('gh', ['secret', 'set', name, '-R', repo], { input: value, encoding: 'utf8', env: process.env });
  if (p.status !== 0) throw new Error(`GitHub Secrets に ${name} を保存できませんでした（${String(p.stderr || '').trim().slice(0, 160)}）`);
}

export async function main({ env = process.env, fetchImpl = fetch, run = spawnSync, now = new Date(), log = console.log } = {}) {
  const dry = String(env.DRY_RUN || '').toLowerCase() === 'true';
  const repo = env.REPO;
  if (!repo) throw new Error('REPO がありません');
  if (!env.GH_TOKEN) throw new Error('SECRETS_WRITE_TOKEN（GitHub Secrets に書き込む鍵）が登録されていません');
  const meta = existsSync(META) ? JSON.parse(readFileSync(META, 'utf8')) : {};
  const errors = [];
  let changed = false;
  for (const k of KINDS) {
    const old = String(env[k.secret] || '').trim();
    if (!old) continue;
    const secrets = [old];
    try {
      if (dry) {
        const me = await getJson(k.me(old), secrets, fetchImpl);
        const p = run('gh', ['secret', 'list', '-R', repo], { encoding: 'utf8', env: process.env });
        if (p.status !== 0) throw new Error('書き込み用の鍵で Secrets を見られません');
        log(`${k.name}: 試し OK（@${me.username ?? '?'}・延ばしていません）`);
        continue;
      }
      const j = await getJson(k.refresh(old), secrets, fetchImpl);
      const fresh = String(j.access_token || '');
      if (!fresh || !j.expires_in) throw new Error('新しい通行証が返ってきませんでした');
      secrets.push(fresh);
      if (env.GITHUB_ACTIONS) log(`::add-mask::${fresh}`);
      const me = await getJson(k.me(fresh), secrets, fetchImpl); // 新しい通行証で本当につながるか
      setSecret(k.secret, fresh, repo, run);
      const exp = new Date(now.getTime() + Number(j.expires_in) * 1000).toISOString();
      meta[k.field] = exp;
      meta[`${k.field.replace(/ExpiresAt$/, '')}RefreshedAt`] = now.toISOString();
      changed = true;
      log(`${k.name}: 延ばしました（@${me.username ?? '?'}・新しい期限 ${exp.slice(0, 10)}）`);
    } catch (e) {
      errors.push(`${k.name}: ${hide(e.message, secrets)}`);
    }
  }
  if (changed) writeFileSync(META, JSON.stringify(meta, null, 2) + '\n');
  for (const e of errors) log(`失敗 ${e}`);
  return { changed, errors };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then((r) => { process.exitCode = r.errors.length ? 1 : 0; })
    .catch((e) => { console.log(`失敗 ${e.message}`); process.exitCode = 1; });
}
