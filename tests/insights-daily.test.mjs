// Daily insights collector (lib/insights-daily.mjs): mocked fetch only, no live API calls.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  previousJstDay,
  insightValue,
  parseIgFollows,
  collectInsightsDaily,
  mergeInsightsDaily,
  buildThemeLookup,
  buildPostInfoLookup,
  threadsMediaType,
  MAX_DAYS
} from "../lib/insights-daily.mjs";

// ---- per-repo settings ----
const BRAND = "lostball";
const WORKFLOW = new URL("../.github/workflows/insights-daily.yml", import.meta.url);
const CRON = "20 18 * * *";
const JST_TIME = "03:20";
const SECRETS = ["IG_ACCESS_TOKEN", "IG_USER_ID", "THREADS_ACCESS_TOKEN", "THREADS_USER_ID"];
// ---------------------------

const TOKEN = "TOKEN-must-never-appear-in-output";
const USER = "USERID-777";
const NOW = new Date("2026-10-14T18:30:00.000Z"); // 2026-10-15 03:30 JST

const reply = (status, body) => ({ ok: status === 200, status, text: async () => JSON.stringify(body) });

// Routes a Graph API URL to a canned answer. `opts` switches on failure modes.
function fakeFetch(opts = {}) {
  const calls = [];
  const fn = async (url) => {
    calls.push(url);
    const u = new URL(url);
    const path = u.pathname;
    const metric = u.searchParams.get("metric");
    const denied = () => reply(400, { error: { message: `denied ${url}` } }); // echoes the token like Meta can
    if (u.host === "graph.threads.net") {
      if (opts.threadsDown) return denied();
      if (path.endsWith("/me")) return reply(200, { id: USER, username: "harley_solo.jp" });
      if (path.endsWith("/threads_insights")) {
        if (metric === "followers_count") return reply(200, { data: [{ name: "followers_count", total_value: { value: 95 } }] });
        const names = metric.split(",");
        if (names.length > 1 && names.includes("clicks") && opts.noClicks) return denied();
        if (names.length === 1 && names[0] === "clicks" && opts.noClicks) return denied();
        return reply(200, {
          data: names.map((name) =>
            name === "views"
              ? { name, values: [{ value: 600, end_time: "x" }, { value: 634, end_time: "y" }] }
              : name === "clicks"
                ? { name, link_total_values: [{ value: 3, link_url: "a" }, { value: 1, link_url: "b" }] }
                : { name, total_value: { value: { likes: 10, replies: 2, reposts: 1, quotes: 0 }[name] } }
          )
        });
      }
      if (path.endsWith(`/${USER}/threads`)) {
        return reply(200, {
          data: [
            { id: "T2", timestamp: "2026-10-13T20:15:00+0000", permalink: "https://threads.net/p/T2", media_type: "TEXT_POST" },
            { id: "R1", timestamp: "2026-10-12T20:15:00+0000", media_type: "REPOST_FACADE" },
            { id: "T1", timestamp: "2026-10-01T00:00:00+0000", permalink: "https://threads.net/p/T1", media_type: "TEXT_POST" },
            { id: "OLD", timestamp: "2026-07-01T00:00:00+0000", media_type: "TEXT_POST" }
          ]
        });
      }
      if (path.endsWith("/insights")) {
        const names = metric.split(",");
        if (opts.noShares && names.includes("shares")) return denied();
        return reply(200, { data: names.map((name) => ({ name: name === "replies" ? "thread_replies" : name, values: [{ value: path.includes("T2") ? 50 : 7 }] })) });
      }
    }
    if (u.host === "graph.instagram.com") {
      if (opts.igDown) return denied();
      if (path.endsWith(`/${USER}`)) return reply(200, { username: "ig_handle", followers_count: 27, media_count: 12 });
      if (path.endsWith(`/${USER}/insights`)) {
        if (metric === "follows_and_unfollows") {
          return reply(200, { data: [{ name: metric, total_value: { value: 3, breakdowns: [{ results: [{ dimension_values: ["FOLLOWER"], value: 2 }, { dimension_values: ["NON_FOLLOWER"], value: 1 }] }] } }] });
        }
        const names = metric.split(",");
        if (opts.noProfileViews && names.includes("profile_views")) return denied();
        return reply(200, { data: names.map((name) => ({ name, total_value: { value: { reach: 300, views: 450, profile_views: 8 }[name] } })) });
      }
      if (path.endsWith(`/${USER}/media`)) {
        return reply(200, {
          data: [{ id: "M1", timestamp: "2026-10-12T22:00:00+0000", permalink: "https://instagram.com/p/M1", media_type: "IMAGE", like_count: 4, comments_count: 1 }],
          paging: {}
        });
      }
      if (path.endsWith("/M1/insights")) {
        const names = metric.split(",");
        if (names.includes("views") && opts.igMediaNoViews) return denied();
        return reply(200, { data: names.map((name) => ({ name, values: [{ value: { views: 90, reach: 70, likes: 5, comments: 2, saved: 3, shares: 1 }[name] }] })) });
      }
    }
    return reply(404, { error: { message: `unexpected ${url}` } });
  };
  fn.calls = calls;
  return fn;
}

const both = { threads: { token: TOKEN, userId: USER }, instagram: { token: TOKEN, userId: USER } };

test("previousJstDay is the full JST day before the run", () => {
  const d = previousJstDay(NOW);
  assert.equal(d.date, "2026-10-14");
  assert.equal(new Date(d.since * 1000).toISOString(), "2026-10-13T15:00:00.000Z");
  assert.equal(d.until - d.since, 86400);
});

test("insightValue reads total_value, sums a daily series and Threads link clicks, else null", () => {
  assert.equal(insightValue({ total_value: { value: 5 } }), 5);
  assert.equal(insightValue({ values: [{ value: 1 }, { value: 2 }] }), 3);
  assert.equal(insightValue({ link_total_values: [{ value: 3 }, { value: 4 }] }), 7);
  assert.equal(insightValue({ values: [{ value: "x" }] }), null);
  assert.equal(insightValue(undefined), null);
});

test("parseIgFollows takes the FOLLOWER bucket and never guesses on unknown shapes", () => {
  assert.equal(parseIgFollows({ data: [{ name: "follows_and_unfollows", total_value: { value: 3, breakdowns: [{ results: [{ dimension_values: ["FOLLOWER"], value: 2 }] }] } }] }), 2);
  assert.equal(parseIgFollows({ data: [{ name: "follows_and_unfollows", total_value: { value: 0, breakdowns: [{ results: [] }] } }] }), 0);
  assert.equal(parseIgFollows({ data: [{ name: "follows_and_unfollows", total_value: { value: 4 } }] }), null);
  assert.equal(parseIgFollows({ data: [] }), null);
});

test("collects Threads + Instagram into the contract shape", async () => {
  const fetchImpl = fakeFetch();
  const doc = await collectInsightsDaily({ brand: BRAND, existing: null, credentials: both, fetchImpl, now: NOW });
  assert.equal(doc.schemaVersion, 1);
  assert.equal(doc.brand, BRAND);
  assert.equal(doc.updatedAt, NOW.toISOString());
  assert.deepEqual(doc.accounts.threads.days, [
    { date: "2026-10-14", capturedAt: NOW.toISOString(), followers: 95, views: 1234, likes: 10, replies: 2, reposts: 1, quotes: 0, clicks: 4 }
  ]);
  assert.equal(doc.accounts.threads.handle, "harley_solo.jp");
  assert.deepEqual(doc.accounts.instagram.days, [
    { date: "2026-10-14", capturedAt: NOW.toISOString(), followers: 27, mediaCount: 12, reach: 300, views: 450, profileViews: 8, follows: 2 }
  ]);
  // newest first, repost facade and posts older than 60 days excluded
  assert.deepEqual(doc.posts.map((p) => `${p.platform}:${p.postId}`), ["threads:T2", "instagram:M1", "threads:T1"]);
  const t2 = doc.posts[0];
  assert.deepEqual(
    { views: t2.views, replies: t2.replies, shares: t2.shares, reach: t2.reach, saves: t2.saves, permalink: t2.permalink },
    { views: 50, replies: 50, shares: 50, reach: null, saves: null, permalink: "https://threads.net/p/T2" }
  );
  const m1 = doc.posts[1];
  assert.deepEqual(
    { views: m1.views, reach: m1.reach, likes: m1.likes, replies: m1.replies, saves: m1.saves, shares: m1.shares, reposts: m1.reposts, quotes: m1.quotes },
    { views: 90, reach: 70, likes: 5, replies: 2, saves: 3, shares: 1, reposts: null, quotes: null }
  );
  // the account day request is bounded to the previous JST day
  const dayCall = fetchImpl.calls.find((c) => c.includes("threads_insights") && c.includes("since="));
  assert.match(dayCall, /since=1791903600/);
  assert.match(dayCall, /until=1791990000/);
});

test("every call is a GET to a Graph API host", async () => {
  const seen = [];
  const fetchImpl = fakeFetch();
  const spy = async (url, init) => {
    seen.push({ host: new URL(url).host, method: init?.method });
    return fetchImpl(url, init);
  };
  await collectInsightsDaily({ brand: BRAND, existing: null, credentials: both, fetchImpl: spy, now: NOW });
  assert.ok(seen.length > 0);
  for (const s of seen) {
    assert.equal(s.method, "GET");
    assert.ok(["graph.threads.net", "graph.instagram.com"].includes(s.host));
  }
});

test("a rejected metric set falls back per metric: only the failing metric becomes null", async () => {
  const doc = await collectInsightsDaily({
    brand: BRAND,
    existing: null,
    credentials: both,
    fetchImpl: fakeFetch({ noClicks: true, noShares: true, noProfileViews: true, igMediaNoViews: true }),
    now: NOW
  });
  const th = doc.accounts.threads.days[0];
  assert.equal(th.clicks, null);
  assert.equal(th.likes, 10);
  assert.equal(doc.posts[0].shares, null);
  assert.equal(doc.posts[0].views, 50);
  assert.equal(doc.accounts.instagram.days[0].profileViews, null);
  assert.equal(doc.accounts.instagram.days[0].reach, 300);
  const m1 = doc.posts.find((p) => p.postId === "M1");
  assert.equal(m1.views, null);
  assert.equal(m1.reach, 70);
});

test("API failures become null (never 0) and the token never reaches the file or the log", async () => {
  const logs = [];
  const redact = (s) => String(s).split(TOKEN).join("[REDACTED]").split(USER).join("[REDACTED]");
  const doc = await collectInsightsDaily({
    brand: BRAND,
    existing: null,
    credentials: both,
    fetchImpl: fakeFetch({ threadsDown: true, igDown: true }),
    now: NOW,
    redact,
    log: (m) => logs.push(m)
  });
  const th = doc.accounts.threads.days[0];
  for (const k of ["followers", "views", "likes", "replies", "reposts", "quotes", "clicks"]) assert.equal(th[k], null, k);
  const ig = doc.accounts.instagram.days[0];
  for (const k of ["followers", "mediaCount", "reach", "views", "profileViews", "follows"]) assert.equal(ig[k], null, k);
  assert.deepEqual(doc.posts, []);
  const text = JSON.stringify(doc) + logs.join("\n");
  assert.ok(logs.length > 0);
  assert.doesNotMatch(text, new RegExp(TOKEN));
  assert.doesNotMatch(text, new RegExp(USER));
});

test("missing credentials: no API call, the platform is kept with a null row", async () => {
  const fetchImpl = fakeFetch();
  const doc = await collectInsightsDaily({ brand: BRAND, existing: null, credentials: { threads: { token: "", userId: "" }, instagram: null }, fetchImpl, now: NOW });
  assert.equal(fetchImpl.calls.length, 0);
  assert.equal(doc.accounts.threads.days[0].followers, null);
  assert.equal(doc.accounts.instagram.days[0].reach, null);
});

test("only platforms named in credentials are written", async () => {
  const doc = await collectInsightsDaily({ brand: BRAND, existing: null, credentials: { threads: { token: TOKEN, userId: USER } }, fetchImpl: fakeFetch(), now: NOW });
  assert.deepEqual(Object.keys(doc.accounts), ["threads"]);
  assert.ok(doc.posts.every((p) => p.platform === "threads"));
});

test("merge is idempotent: same date overwritten, a later null does not erase a number", async () => {
  const first = await collectInsightsDaily({ brand: BRAND, existing: null, credentials: both, fetchImpl: fakeFetch(), now: NOW });
  const again = await collectInsightsDaily({ brand: BRAND, existing: first, credentials: both, fetchImpl: fakeFetch(), now: NOW });
  assert.deepEqual(again, first);
  const failed = await collectInsightsDaily({ brand: BRAND, existing: first, credentials: both, fetchImpl: fakeFetch({ threadsDown: true }), now: NOW });
  assert.equal(failed.accounts.threads.days.length, 1);
  assert.equal(failed.accounts.threads.days[0].views, 1234);
  assert.equal(failed.posts.find((p) => p.postId === "T2").views, 50);
});

test("days stay ascending and capped; posts older than 60 days drop out", () => {
  const days = Array.from({ length: MAX_DAYS + 5 }, (_, i) => ({ date: new Date(Date.UTC(2025, 0, 1) + i * 86400000).toISOString().slice(0, 10), followers: i }));
  const existing = {
    schemaVersion: 1,
    accounts: { threads: { handle: "h", days: [...days].reverse() } },
    posts: [{ platform: "threads", postId: "OLD", postedAt: "2026-08-01T00:00:00.000Z" }]
  };
  const day = { date: "2026-10-14", capturedAt: NOW.toISOString(), followers: 1 };
  const doc = mergeInsightsDaily(existing, { brand: BRAND, now: NOW, platforms: { threads: { handle: null, day, posts: [] } } });
  const out = doc.accounts.threads.days;
  assert.equal(out.length, MAX_DAYS);
  assert.equal(out.at(-1).date, "2026-10-14");
  assert.ok(out.every((d, i) => i === 0 || out[i - 1].date < d.date));
  assert.equal(doc.accounts.threads.handle, "h");
  assert.deepEqual(doc.posts, []);
});

test("theme comes from the repo's own records, else null", async () => {
  const themeOf = { threads: buildThemeLookup([{ threadsPostId: "T2", pillar: "HARLEY" }], { idKey: "threadsPostId", themeKeys: ["pillar"] }) };
  const doc = await collectInsightsDaily({ brand: BRAND, existing: null, credentials: { threads: { token: TOKEN, userId: USER } }, fetchImpl: fakeFetch(), now: NOW, themeOf });
  assert.equal(doc.posts.find((p) => p.postId === "T2").theme, "HARLEY");
  assert.equal(doc.posts.find((p) => p.postId === "T1").theme, null);
});

test("v1 additions: Threads posts carry slot, lang (from threads-posts.json) and mediaType (from media_type)", async () => {
  const records = [
    { threadsPostId: "T2", slot: "night", lang: "en" },
    { threadsPostId: "T1", lang: "ja" }, // legacy single-language post: no slot
    { threadsPostId: "X9", slot: "weird", lang: "both" }
  ];
  const postInfoOf = { threads: buildPostInfoLookup(records, { idKey: "threadsPostId" }) };
  const doc = await collectInsightsDaily({ brand: BRAND, existing: null, credentials: { threads: { token: TOKEN, userId: USER } }, fetchImpl: fakeFetch(), now: NOW, postInfoOf });
  const t2 = doc.posts.find((p) => p.postId === "T2");
  const t1 = doc.posts.find((p) => p.postId === "T1");
  assert.equal(t2.slot, "night");
  assert.equal(t2.lang, "en");
  assert.equal(t2.mediaType, "TEXT");
  assert.equal(t1.slot, null);
  assert.equal(t1.lang, "ja");
  const lookup = postInfoOf.threads;
  assert.deepEqual(lookup("X9"), { slot: null, lang: null });
  assert.equal(lookup("nope"), null);
  assert.equal(threadsMediaType("IMAGE"), "IMAGE");
  assert.equal(threadsMediaType("CAROUSEL_ALBUM"), "CAROUSEL");
  assert.equal(threadsMediaType("SOMETHING"), null);
});

test("without post records, slot and lang are null (consumers treat them as optional)", async () => {
  const doc = await collectInsightsDaily({ brand: BRAND, existing: null, credentials: { threads: { token: TOKEN, userId: USER } }, fetchImpl: fakeFetch(), now: NOW });
  for (const p of doc.posts.filter((x) => x.platform === "threads")) {
    assert.equal(p.slot, null);
    assert.equal(p.lang, null);
  }
});

// ---- workflow ----
const wf = fs.readFileSync(WORKFLOW, "utf8");

test(`insights-daily.yml runs daily at ${JST_TIME} JST and on demand`, () => {
  assert.match(wf, /workflow_dispatch:/);
  assert.ok(wf.includes(`cron: "${CRON}"`));
  const [min, hour] = CRON.split(" ").map(Number);
  const jst = new Date(Date.UTC(2026, 0, 1, hour, min) + 9 * 3600 * 1000);
  assert.equal(jst.toISOString().slice(11, 16), JST_TIME);
});

test("insights-daily.yml uses only the repo's existing secrets and runs no posting script", () => {
  const used = [...new Set([...wf.matchAll(/secrets\.([A-Z0-9_]+)/g)].map((m) => m[1]))].sort();
  assert.deepEqual(used, [...SECRETS].sort());
  assert.match(wf, /node scripts\/collect-insights-daily\.mjs/);
  assert.doesNotMatch(wf, /publish|--live|LIVE_POST|DISCORD/);
});

test("insights-daily.yml commits only data/insights-daily.json, only when changed, after pull --rebase", () => {
  assert.match(wf, /contents: write/);
  assert.match(wf, /concurrency:/);
  const adds = [...wf.matchAll(/git add ([^\n]+)/g)].map((m) => m[1].trim());
  assert.deepEqual(adds, ["data/insights-daily.json"]);
  assert.match(wf, /git diff --cached --quiet/);
  assert.ok(wf.indexOf("git pull --rebase") < wf.indexOf("git push"));
  if (wf.includes(".env.local")) assert.match(wf, /if: always\(\)\s*\n\s*run: rm -f \.env\.local/);
});
