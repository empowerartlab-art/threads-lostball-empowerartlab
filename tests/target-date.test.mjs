import { test } from "node:test";
import assert from "node:assert/strict";
import { maxDateKey, selectDueItems } from "../lib/target-date.mjs";

test("maxDateKey: 最大の日付キーを返す", () => {
  assert.equal(maxDateKey(["2026-09-01", "2026-09-27", "2026-09-10"]), "2026-09-27");
});

test("maxDateKey: 空/falsyのみならnull", () => {
  assert.equal(maxDateKey([]), null);
  assert.equal(maxDateKey([null, undefined, ""]), null);
});

test("selectDueItems: targetDate未指定はFIFO順で末尾に続く", () => {
  const items = [{ id: "a" }, { id: "b" }, { id: "c" }];
  const result = selectDueItems(items, "2026-09-27");
  assert.deepEqual(result.map((i) => i.id), ["a", "b", "c"]);
});

test("selectDueItems: 到来済みのtargetDateは早い順に先頭へ", () => {
  const items = [
    { id: "undated" },
    { id: "later", targetDate: "2026-10-01" },
    { id: "earlier", targetDate: "2026-09-20" }
  ];
  const result = selectDueItems(items, "2026-09-27");
  assert.deepEqual(result.map((i) => i.id), ["earlier", "undated"]);
});
