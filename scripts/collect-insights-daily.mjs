#!/usr/bin/env node
// 毎日1回、Threads と Instagram のアカウント全体（前日JST分）と直近60日の投稿ごとのInsightsを取得し、
// data/insights-daily.json（sns-growth-dashboard data-contract v1）へマージする。
//
// 安全設計:
//   - GET(読み取り専用)のみ。投稿・削除・編集は一切行わない。
//   - 取得に失敗した指標はnull(0にはしない)。片方のSNSが失敗しても、もう片方は記録する。
//   - トークン・ユーザーID・エラー本文はファイルに書かない。ログに出すエラーはredact()済み。
//   - git add/commit/pushはここでは一切行わない(呼び出し側のworkflowの責務)。
//
// theme: Threadsは data/threads-posts.json の category(無ければpillar)。
//        Instagramは data/ig-posts.json(mediaId→id) と data/ig-queue.json(id→pillar) を突き合わせる。

import fs from "node:fs/promises";
import { loadLocalEnv, mergeWithProcessEnv } from "../lib/load-local-env.mjs";
import { createSecretRedactor } from "../lib/redact.mjs";
import { collectInsightsDaily, buildThemeLookup } from "../lib/insights-daily.mjs";

const data = (name) => new URL(`../data/${name}`, import.meta.url);
const OUTPUT_PATH = data("insights-daily.json");

async function readJson(url, fallback) {
  try {
    return JSON.parse(await fs.readFile(url, "utf8"));
  } catch {
    return fallback;
  }
}

const env = mergeWithProcessEnv(loadLocalEnv());
const redact = createSecretRedactor([env.THREADS_ACCESS_TOKEN, env.THREADS_USER_ID, env.IG_ACCESS_TOKEN, env.IG_USER_ID]);

for (const [a, b] of [["THREADS_ACCESS_TOKEN", "THREADS_USER_ID"], ["IG_ACCESS_TOKEN", "IG_USER_ID"]]) {
  if (!env[a] || !env[b]) console.error(`${a} または ${b} が見つかりません(キー名のみ表示)。この SNS は null で記録します。`);
}

const threadsPosts = (await readJson(data("threads-posts.json"), { posts: [] })).posts ?? [];
const igPosted = await readJson(data("ig-posts.json"), []);
const igQueue = await readJson(data("ig-queue.json"), []);
const pillarByQueueId = new Map((Array.isArray(igQueue) ? igQueue : []).map((q) => [q.id, q.pillar]));
const igRecords = (Array.isArray(igPosted) ? igPosted : []).map((p) => ({ mediaId: p.mediaId, pillar: pillarByQueueId.get(p.id) ?? null }));

const doc = await collectInsightsDaily({
  brand: "lostball",
  existing: await readJson(OUTPUT_PATH, null),
  credentials: {
    threads: { token: env.THREADS_ACCESS_TOKEN, userId: env.THREADS_USER_ID },
    instagram: { token: env.IG_ACCESS_TOKEN, userId: env.IG_USER_ID }
  },
  themeOf: {
    threads: buildThemeLookup(threadsPosts, { idKey: "threadsPostId", themeKeys: ["category", "pillar"] }),
    instagram: buildThemeLookup(igRecords, { idKey: "mediaId", themeKeys: ["pillar"] })
  },
  redact,
  log: (msg) => console.log(redact(msg))
});

await fs.writeFile(OUTPUT_PATH, `${JSON.stringify(doc, null, 2)}\n`);
console.log(`insights-daily: date=${doc.accounts.threads?.days.at(-1)?.date} posts=${doc.posts.length} を data/insights-daily.json に記録しました。`);
