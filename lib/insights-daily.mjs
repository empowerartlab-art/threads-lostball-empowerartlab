// Daily SNS insights collector (data contract v1: sns-growth-dashboard/data-contract.md).
// Read-only: every network call here is a GET. Nothing posts, edits or deletes.
//
// - fetchImpl / redact / now are injected so tests never touch the real APIs.
// - A metric that fails or is not offered becomes null. A failure is never recorded as 0.
// - Tokens, user IDs and raw error bodies are never written to the output document;
//   error messages only go to the log, after redaction.

export const SCHEMA_VERSION = 1;
export const THREADS_GRAPH = "https://graph.threads.net/v1.0";
export const IG_GRAPH = "https://graph.instagram.com/v23.0";
export const MAX_DAYS = 400;
export const POST_WINDOW_DAYS = 60;

export const THREADS_ACCOUNT_METRICS = ["views", "likes", "replies", "reposts", "quotes", "clicks"];
export const THREADS_POST_METRICS = ["views", "likes", "replies", "reposts", "quotes", "shares"];
export const IG_ACCOUNT_METRICS = ["reach", "views", "profile_views"];
export const IG_MEDIA_METRICS = ["views", "reach", "likes", "comments", "saved", "shares"];

const DAY_MS = 24 * 60 * 60 * 1000;
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
const MAX_PAGES = 10;

// Threads sometimes names post metrics differently (see lostball lib/insights-metrics.mjs).
const METRIC_ALIASES = { thread_replies: "replies", thread_shares: "shares" };

export function jstDateKey(value = new Date()) {
  const d = value instanceof Date ? value : new Date(value);
  return new Date(d.getTime() + JST_OFFSET_MS).toISOString().slice(0, 10);
}

// The previous full JST day: [00:00 JST yesterday, 00:00 JST today), as unix seconds.
export function previousJstDay(now = new Date()) {
  const todayKey = jstDateKey(now);
  const todayStartMs = Date.parse(`${todayKey}T00:00:00+09:00`);
  const sinceMs = todayStartMs - DAY_MS;
  return { date: jstDateKey(new Date(sinceMs)), since: sinceMs / 1000, until: todayStartMs / 1000 };
}

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

// Removes access tokens from any text that may echo a request URL.
function scrub(text) {
  return String(text).replace(/access_token=[^&\s"']+/g, "access_token=[REDACTED]");
}

export async function getJson(fetchImpl, url) {
  const res = await fetchImpl(url, { method: "GET" });
  const body = await res.text();
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status}: ${scrub(body.slice(0, 300))}`);
    err.status = res.status;
    throw err;
  }
  return JSON.parse(body);
}

function buildUrl(base, path, params) {
  const url = new URL(`${base}/${path}`);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  return url.toString();
}

// One insights entry -> number|null. Handles the shapes Meta returns:
// total_value.value, values[] (a daily series: summed), link_total_values[] (Threads clicks: summed).
export function insightValue(entry) {
  if (!entry) return null;
  const total = num(entry.total_value?.value);
  if (total !== null) return total;
  if (Array.isArray(entry.values) && entry.values.length > 0) {
    const nums = entry.values.map((v) => num(v?.value));
    return nums.every((v) => v !== null) ? nums.reduce((a, b) => a + b, 0) : null;
  }
  if (Array.isArray(entry.link_total_values)) {
    const nums = entry.link_total_values.map((v) => num(v?.value));
    return nums.every((v) => v !== null) ? nums.reduce((a, b) => a + b, 0) : null;
  }
  return null;
}

function toMetricMap(data, wanted) {
  const out = Object.fromEntries(wanted.map((m) => [m, null]));
  for (const entry of data ?? []) {
    const key = METRIC_ALIASES[entry?.name] ?? entry?.name;
    if (wanted.includes(key)) out[key] = insightValue(entry);
  }
  return out;
}

// All metrics in one call; if the set is rejected, one call per metric and keep what works.
// Returns { values, errors } where errors are redacted messages (log only, never stored).
export async function fetchMetricSet({ fetchImpl, makeUrl, metrics, redact = (x) => x }) {
  try {
    const json = await getJson(fetchImpl, makeUrl(metrics.join(",")));
    return { values: toMetricMap(json.data, metrics), errors: [] };
  } catch (setErr) {
    const values = Object.fromEntries(metrics.map((m) => [m, null]));
    const errors = [];
    for (const m of metrics) {
      try {
        const json = await getJson(fetchImpl, makeUrl(m));
        values[m] = toMetricMap(json.data, [m])[m];
      } catch (err) {
        errors.push(`${m}: ${redact(err.message)}`);
      }
    }
    if (errors.length === metrics.length) errors.unshift(`set: ${redact(setErr.message)}`);
    return { values, errors };
  }
}

async function listPaged({ fetchImpl, firstUrl, stopBefore }) {
  const items = [];
  let url = firstUrl;
  for (let page = 0; url && page < MAX_PAGES; page++) {
    const json = await getJson(fetchImpl, url);
    const data = json.data ?? [];
    items.push(...data);
    const oldest = data.at(-1)?.timestamp;
    if (!data.length || (oldest && stopBefore && Date.parse(oldest) < stopBefore)) break;
    url = json.paging?.next ?? null;
  }
  return items;
}

// ---------------- Threads ----------------

// data-contract v1 additions (2026-10-14): Threads media_type -> mediaType.
const THREADS_MEDIA_TYPES = { TEXT_POST: "TEXT", IMAGE: "IMAGE", CAROUSEL_ALBUM: "CAROUSEL", VIDEO: "VIDEO" };
export function threadsMediaType(mediaType) {
  return THREADS_MEDIA_TYPES[mediaType] ?? null;
}

// postInfoOf: postId -> { slot, lang } from this repo's own post records (buildPostInfoLookup).
export async function collectThreads({ fetchImpl, token, userId, now, themeOf = () => null, postInfoOf = () => null, redact = (x) => x, log = () => {} }) {
  const capturedAt = now.toISOString();
  const day = previousJstDay(now);
  const tq = { access_token: token };
  const warn = (msg) => log(`threads: ${redact(msg)}`);

  let handle = null;
  try {
    handle = (await getJson(fetchImpl, buildUrl(THREADS_GRAPH, "me", { fields: "username", ...tq }))).username ?? null;
  } catch (err) {
    warn(`handle unavailable (${err.message})`);
  }

  // followers_count does not accept since/until: it is the point-in-time count.
  let followers = null;
  try {
    const json = await getJson(fetchImpl, buildUrl(THREADS_GRAPH, `${userId}/threads_insights`, { metric: "followers_count", ...tq }));
    followers = toMetricMap(json.data, ["followers_count"]).followers_count;
  } catch (err) {
    warn(`followers_count unavailable (${err.message})`);
  }

  const account = await fetchMetricSet({
    fetchImpl,
    redact,
    metrics: THREADS_ACCOUNT_METRICS,
    makeUrl: (metric) => buildUrl(THREADS_GRAPH, `${userId}/threads_insights`, { metric, since: day.since, until: day.until, ...tq })
  });
  account.errors.forEach((e) => warn(`account metric failed: ${e}`));

  const dayEntry = { date: day.date, capturedAt, followers, ...account.values };

  const posts = [];
  const cutoffMs = now.getTime() - POST_WINDOW_DAYS * DAY_MS;
  let items = [];
  try {
    items = await listPaged({
      fetchImpl,
      stopBefore: cutoffMs,
      firstUrl: buildUrl(THREADS_GRAPH, `${userId}/threads`, {
        fields: "id,timestamp,permalink,media_type",
        since: Math.floor(cutoffMs / 1000),
        limit: 100,
        ...tq
      })
    });
  } catch (err) {
    warn(`post list unavailable (${err.message})`);
  }
  for (const item of items) {
    if (!item?.id || !item.timestamp || Date.parse(item.timestamp) < cutoffMs) continue;
    if (item.media_type === "REPOST_FACADE") continue; // someone else's post reposted: no insights of ours
    const res = await fetchMetricSet({
      fetchImpl,
      redact,
      metrics: THREADS_POST_METRICS,
      makeUrl: (metric) => buildUrl(THREADS_GRAPH, `${item.id}/insights`, { metric, ...tq })
    });
    if (res.errors.length) warn(`post ${item.id}: ${res.errors.length} metric(s) failed`);
    posts.push({
      platform: "threads",
      postId: String(item.id),
      postedAt: new Date(item.timestamp).toISOString(),
      permalink: item.permalink ?? null,
      theme: themeOf(String(item.id)) ?? null,
      // v1 additions: slot (morning/noon/night) and lang (ja/en) from data/threads-posts.json,
      // null for legacy posts without a slot / bilingual posts / unknown; mediaType from media_type.
      slot: postInfoOf(String(item.id))?.slot ?? null,
      mediaType: threadsMediaType(item.media_type),
      lang: postInfoOf(String(item.id))?.lang ?? null,
      capturedAt,
      views: res.values.views,
      reach: null,
      likes: res.values.likes,
      replies: res.values.replies,
      reposts: res.values.reposts,
      quotes: res.values.quotes,
      shares: res.values.shares,
      saves: null
    });
  }
  return { handle, day: dayEntry, posts };
}

// ---------------- Instagram ----------------

// follows_and_unfollows with breakdown=follow_type: the FOLLOWER bucket is "new follows".
export function parseIgFollows(json) {
  const entry = (json?.data ?? []).find((d) => d?.name === "follows_and_unfollows");
  if (!entry?.total_value) return null;
  const breakdowns = entry.total_value.breakdowns;
  if (Array.isArray(breakdowns) && breakdowns.length > 0) {
    const results = breakdowns[0]?.results ?? [];
    const hit = results.find((r) => (r?.dimension_values ?? []).includes("FOLLOWER"));
    return hit ? num(hit.value) : 0; // breakdown answered, no FOLLOWER bucket = nobody followed
  }
  return num(entry.total_value.value) === 0 ? 0 : null; // a non-zero total mixes follows and unfollows
}

export async function collectInstagram({ fetchImpl, token, userId, now, themeOf = () => null, redact = (x) => x, log = () => {} }) {
  const capturedAt = now.toISOString();
  const day = previousJstDay(now);
  const tq = { access_token: token };
  const warn = (msg) => log(`instagram: ${redact(msg)}`);

  let handle = null;
  let followers = null;
  let mediaCount = null;
  try {
    const acc = await getJson(fetchImpl, buildUrl(IG_GRAPH, userId, { fields: "username,followers_count,media_count", ...tq }));
    handle = acc.username ?? null;
    followers = num(acc.followers_count);
    mediaCount = num(acc.media_count);
  } catch (err) {
    warn(`account fields unavailable (${err.message})`);
  }

  const account = await fetchMetricSet({
    fetchImpl,
    redact,
    metrics: IG_ACCOUNT_METRICS,
    makeUrl: (metric) =>
      buildUrl(IG_GRAPH, `${userId}/insights`, { metric, period: "day", metric_type: "total_value", since: day.since, until: day.until, ...tq })
  });
  account.errors.forEach((e) => warn(`account metric failed: ${e}`));

  let follows = null;
  try {
    const json = await getJson(
      fetchImpl,
      buildUrl(IG_GRAPH, `${userId}/insights`, {
        metric: "follows_and_unfollows",
        period: "day",
        metric_type: "total_value",
        breakdown: "follow_type",
        since: day.since,
        until: day.until,
        ...tq
      })
    );
    follows = parseIgFollows(json);
  } catch (err) {
    warn(`follows unavailable (${err.message})`);
  }

  const dayEntry = {
    date: day.date,
    capturedAt,
    followers,
    mediaCount,
    reach: account.values.reach,
    views: account.values.views,
    profileViews: account.values.profile_views,
    follows
  };

  const posts = [];
  const cutoffMs = now.getTime() - POST_WINDOW_DAYS * DAY_MS;
  let items = [];
  try {
    items = await listPaged({
      fetchImpl,
      stopBefore: cutoffMs,
      firstUrl: buildUrl(IG_GRAPH, `${userId}/media`, {
        fields: "id,timestamp,permalink,media_type,like_count,comments_count",
        limit: 50,
        ...tq
      })
    });
  } catch (err) {
    warn(`media list unavailable (${err.message})`);
  }
  for (const item of items) {
    if (!item?.id || !item.timestamp || Date.parse(item.timestamp) < cutoffMs) continue;
    const res = await fetchMetricSet({
      fetchImpl,
      redact,
      metrics: IG_MEDIA_METRICS,
      makeUrl: (metric) => buildUrl(IG_GRAPH, `${item.id}/insights`, { metric, ...tq })
    });
    if (res.errors.length) warn(`media ${item.id}: ${res.errors.length} metric(s) failed`);
    posts.push({
      platform: "instagram",
      postId: String(item.id),
      postedAt: new Date(item.timestamp).toISOString(),
      permalink: item.permalink ?? null,
      theme: themeOf(String(item.id)) ?? null,
      capturedAt,
      views: res.values.views,
      reach: res.values.reach,
      likes: res.values.likes ?? num(item.like_count),
      replies: res.values.comments ?? num(item.comments_count),
      reposts: null,
      quotes: null,
      shares: res.values.shares,
      saves: res.values.saved
    });
  }
  return { handle, day: dayEntry, posts };
}

// ---------------- merge (pure) ----------------

// Same key: the newer record wins field by field, but a null (failure) never erases a number
// recorded earlier for the same date / post. Re-running the job is therefore idempotent.
function overlay(prev, next) {
  if (!prev) return { ...next };
  const out = { ...prev };
  for (const [k, v] of Object.entries(next)) if (v !== null && v !== undefined) out[k] = v;
  return out;
}

export function mergeInsightsDaily(existing, { brand, now, platforms }) {
  const prev = existing && existing.schemaVersion === SCHEMA_VERSION ? existing : { accounts: {}, posts: [] };
  const accounts = { ...(prev.accounts ?? {}) };

  for (const [platform, result] of Object.entries(platforms)) {
    const old = accounts[platform] ?? { handle: null, days: [] };
    const byDate = new Map((old.days ?? []).map((d) => [d.date, d]));
    byDate.set(result.day.date, overlay(byDate.get(result.day.date), result.day));
    const days = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date)).slice(-MAX_DAYS);
    accounts[platform] = { handle: result.handle ?? old.handle ?? null, days };
  }

  const cutoffMs = now.getTime() - POST_WINDOW_DAYS * DAY_MS;
  const byPost = new Map();
  for (const p of prev.posts ?? []) byPost.set(`${p.platform}:${p.postId}`, p);
  for (const result of Object.values(platforms)) {
    for (const p of result.posts) {
      const key = `${p.platform}:${p.postId}`;
      byPost.set(key, overlay(byPost.get(key), p));
    }
  }
  const posts = [...byPost.values()]
    .filter((p) => Date.parse(p.postedAt) >= cutoffMs)
    .sort((a, b) => Date.parse(b.postedAt) - Date.parse(a.postedAt));

  return { schemaVersion: SCHEMA_VERSION, brand, updatedAt: now.toISOString(), accounts, posts };
}

// A platform whose credentials are missing still gets a day row of nulls (not 0),
// so the dashboard can tell "connected but no data" from "no change".
export function emptyPlatformResult(platform, now) {
  const base = { date: previousJstDay(now).date, capturedAt: now.toISOString(), followers: null };
  const day =
    platform === "instagram"
      ? { ...base, mediaCount: null, reach: null, views: null, profileViews: null, follows: null }
      : { ...base, views: null, likes: null, replies: null, reposts: null, quotes: null, clicks: null };
  return { handle: null, day, posts: [] };
}

// Orchestrates one run. credentials: { threads?: {token,userId}|null, instagram?: {token,userId}|null }.
// Only the platform keys present in `credentials` are written (a missing key = not on that platform).
// postInfoOf: { threads: postId -> { slot, lang } } (buildPostInfoLookup).
export async function collectInsightsDaily({ brand, existing, credentials, fetchImpl = fetch, now = new Date(), themeOf = {}, postInfoOf = {}, redact = (x) => x, log = () => {} }) {
  const platforms = {};
  if ("threads" in credentials) {
    const c = credentials.threads;
    if (c?.token && c?.userId) {
      platforms.threads = await collectThreads({ fetchImpl, token: c.token, userId: c.userId, now, themeOf: themeOf.threads, postInfoOf: postInfoOf.threads, redact, log });
    } else {
      log("threads: credentials not set; recording nulls");
      platforms.threads = emptyPlatformResult("threads", now);
    }
  }
  if ("instagram" in credentials) {
    const c = credentials.instagram;
    if (c?.token && c?.userId) {
      platforms.instagram = await collectInstagram({ fetchImpl, token: c.token, userId: c.userId, now, themeOf: themeOf.instagram, redact, log });
    } else {
      log("instagram: credentials not set; recording nulls");
      platforms.instagram = emptyPlatformResult("instagram", now);
    }
  }
  return mergeInsightsDaily(existing, { brand, now, platforms });
}

// Builds a postId -> theme lookup from a repo's own records. Returns null when nothing matches.
export function buildThemeLookup(records, { idKey, themeKeys }) {
  const map = new Map();
  for (const r of Array.isArray(records) ? records : []) {
    const id = r?.[idKey];
    if (!id) continue;
    const theme = themeKeys.map((k) => r?.[k]).find((v) => typeof v === "string" && v.trim());
    if (theme) map.set(String(id), theme);
  }
  return (postId) => map.get(String(postId)) ?? null;
}

// postId -> { slot, lang } from this repo's own Threads post records (data/threads-posts.json).
//   slot: "morning" | "noon" | "night" (slot posts from 2026-10-20), otherwise null.
//   lang: "ja" | "en" for single-language posts, null for the old bilingual posts (no lang / "both").
const CONTRACT_SLOTS = new Set(["morning", "noon", "night"]);
const CONTRACT_LANGS = new Set(["ja", "en"]);
export function buildPostInfoLookup(records, { idKey }) {
  const map = new Map();
  for (const r of Array.isArray(records) ? records : []) {
    const id = r?.[idKey];
    if (!id) continue;
    map.set(String(id), {
      slot: CONTRACT_SLOTS.has(r?.slot) ? r.slot : null,
      lang: CONTRACT_LANGS.has(r?.lang) ? r.lang : null
    });
  }
  return (postId) => map.get(String(postId)) ?? null;
}
