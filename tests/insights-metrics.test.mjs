import { test } from "node:test";
import assert from "node:assert/strict";
import { parseMediaInsightsResponse, MEDIA_INSIGHTS_METRICS } from "../lib/insights-metrics.mjs";

test("parseMediaInsightsResponse: 正常なレスポンスを平坦なオブジェクトへ変換する", () => {
  const response = {
    data: [
      { name: "views", values: [{ value: 42 }] },
      { name: "likes", values: [{ value: 3 }] },
      { name: "thread_replies", values: [{ value: 1 }] },
      { name: "reposts", values: [{ value: 0 }] },
      { name: "quotes", values: [{ value: 0 }] },
      { name: "thread_shares", values: [{ value: 0 }] }
    ]
  };
  const result = parseMediaInsightsResponse(response);
  assert.deepEqual(result, { views: 42, likes: 3, replies: 1, reposts: 0, quotes: 0, shares: 0 });
});

test("parseMediaInsightsResponse: 一部metricが欠けていればnullのまま", () => {
  const response = { data: [{ name: "views", values: [{ value: 10 }] }] };
  const result = parseMediaInsightsResponse(response);
  assert.equal(result.views, 10);
  assert.equal(result.likes, null);
  assert.equal(result.shares, null);
});

test("parseMediaInsightsResponse: dataが空/未定義でも全metricがnullのオブジェクトを返す(例外にしない)", () => {
  assert.deepEqual(parseMediaInsightsResponse({ data: [] }), Object.fromEntries(MEDIA_INSIGHTS_METRICS.map((m) => [m, null])));
  assert.deepEqual(parseMediaInsightsResponse({}), Object.fromEntries(MEDIA_INSIGHTS_METRICS.map((m) => [m, null])));
  assert.deepEqual(parseMediaInsightsResponse(undefined), Object.fromEntries(MEDIA_INSIGHTS_METRICS.map((m) => [m, null])));
});

test("parseMediaInsightsResponse: 未知のmetric名は無視する", () => {
  const response = { data: [{ name: "some_future_metric", values: [{ value: 999 }] }] };
  const result = parseMediaInsightsResponse(response);
  assert.equal(Object.values(result).every((v) => v === null), true);
});
