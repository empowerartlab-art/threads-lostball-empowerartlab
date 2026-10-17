// Instagram reactions for the Saturday review. Read-only: nothing here posts,
// edits or deletes. It reads the account's recent media (manual posts included)
// and each post's insights, and turns them into a Markdown section.
//
// Needs the instagram_business_manage_insights permission on IG_ACCESS_TOKEN.
// Without it the per-post insights fail; likes/comments still come from /media.

import { createSecretRedactor } from './redact.mjs';
import { under24h } from './analysis-window.mjs';

const GRAPH = 'https://graph.instagram.com/v23.0';
export const INSIGHT_METRICS = ['views', 'reach', 'saved', 'shares', 'total_interactions'];

async function getJson(fetchImpl, url) {
  const res = await fetchImpl(url);
  const body = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${body.slice(0, 300)}`);
  return JSON.parse(body);
}

// All metrics in one call; if Instagram rejects the set (a metric not offered
// for this media type), fall back to one call per metric and keep what works.
async function mediaInsights(fetchImpl, id, token) {
  const q = (m) => `${GRAPH}/${id}/insights?metric=${m}&access_token=${encodeURIComponent(token)}`;
  const toMap = (data) => Object.fromEntries((data ?? []).map((d) => [d.name, d.values?.[0]?.value ?? d.total_value?.value ?? null]));
  try {
    return { values: toMap((await getJson(fetchImpl, q(INSIGHT_METRICS.join(',')))).data), error: null };
  } catch (err) {
    const values = {};
    let lastErr = err;
    for (const m of INSIGHT_METRICS) {
      try {
        Object.assign(values, toMap((await getJson(fetchImpl, q(m))).data));
      } catch (e) {
        lastErr = e;
      }
    }
    return { values, error: Object.keys(values).length ? null : lastErr.message };
  }
}

export async function collectIgStats({ fetchImpl = fetch, token, userId, since, until }) {
  const t = encodeURIComponent(token);
  const account = await getJson(fetchImpl, `${GRAPH}/${userId}?fields=username,followers_count,media_count&access_token=${t}`);
  const list = await getJson(fetchImpl, `${GRAPH}/${userId}/media?fields=id,caption,media_type,timestamp,permalink,like_count,comments_count&limit=50&access_token=${t}`);
  const media = (list.data ?? []).filter((m) => (!since || m.timestamp >= since) && (!until || m.timestamp < until));
  const posts = [];
  for (const m of media) {
    const { values, error } = await mediaInsights(fetchImpl, m.id, token);
    posts.push({
      date: jstDay(m.timestamp),
      ts: m.timestamp,
      title: firstLine(m.caption),
      type: m.media_type,
      permalink: m.permalink,
      likes: m.like_count ?? null,
      comments: m.comments_count ?? null,
      ...values,
      insightsError: error,
    });
  }
  posts.sort((a, b) => a.date.localeCompare(b.date));
  return { username: account.username, followers: account.followers_count ?? null, mediaCount: account.media_count ?? null, posts };
}

const jstDay = (ts) => new Date(new Date(ts).getTime() + 9 * 3600 * 1000).toISOString().slice(0, 10);
const firstLine = (c) => (c ?? '').split('\n').find((l) => l.trim())?.trim().slice(0, 30) ?? '（本文なし）';
const n = (v) => (v === null || v === undefined ? '-' : String(v));

// Saves and shares are the strongest "this spoke to me" signals on Instagram,
// so the highlights call those out alongside reach.
export function igStatsMarkdown(stats, { prevFollowers = null, period = null, now = new Date() } = {}) {
  const out = [`## Instagramの反応（${period ? `${period}の投稿` : '直近の投稿'}）`, ''];
  const diff = prevFollowers === null || stats.followers === null ? '' : `（前回から ${stats.followers - prevFollowers >= 0 ? '+' : ''}${stats.followers - prevFollowers}）`;
  out.push(`- フォロワー：${n(stats.followers)}人${diff}／投稿数：${n(stats.mediaCount)}`, '');
  if (!stats.posts.length) return [...out, '（対象期間の投稿なし）', ''].join('\n');
  out.push('| 日付 | 投稿 | 閲覧 | リーチ | いいね | コメント | 保存 | シェア |', '|---|---|---|---|---|---|---|---|');
  const anyYoung = stats.posts.some((p) => p.ts && under24h(p.ts, now));
  for (const p of stats.posts) {
    const young = p.ts && under24h(p.ts, now) ? '※' : '';
    out.push(`| ${p.date}${young} | [${p.title.replace(/\|/g, '／')}](${p.permalink}) | ${n(p.views)} | ${n(p.reach)} | ${n(p.likes)} | ${n(p.comments)} | ${n(p.saved)} | ${n(p.shares)} |`);
  }
  if (anyYoung) out.push('', '※ 投稿から24時間たっていない（数字がまだ伸びる途中）。ほかの投稿と比べるときは注意');
  out.push('');
  const best = (key) => stats.posts.filter((p) => typeof p[key] === 'number').sort((a, b) => b[key] - a[key])[0];
  const hi = [['reach', 'いちばん届いた'], ['saved', 'いちばん保存された'], ['comments', 'いちばんコメントが来た']]
    .map(([k, label]) => [best(k), k, label])
    .filter(([p, k]) => p && p[k] > 0)
    .map(([p, k, label]) => `- ${label}：${p.date}「${p.title}」（${p[k]}）`);
  if (hi.length) out.push(...hi, '');
  if (stats.posts.some((p) => p.insightsError)) {
    out.push('- ⚠️ 一部の数字（閲覧・リーチ・保存・シェア）が取れませんでした。Instagramの接続に「インサイトの許可」が足りない可能性があります → Claude に相談', '');
  }
  return out.join('\n');
}

export function igStatsFailureMarkdown(err, secrets) {
  return ['## Instagramの反応', '', `- ⚠️ 取得できませんでした：${createSecretRedactor(secrets)(String(err?.message ?? err))}`, ''].join('\n');
}
