import { test } from "node:test";
import assert from "node:assert/strict";
import { parseEnvContent, mergeWithProcessEnv } from "../lib/load-local-env.mjs";

test("parseEnvContent: KEY=VALUE形式を解析する", () => {
  const result = parseEnvContent("THREADS_CLIENT_ID=abc123\nTHREADS_REDIRECT_URI=https://example.com/");
  assert.deepEqual(result, {
    THREADS_CLIENT_ID: "abc123",
    THREADS_REDIRECT_URI: "https://example.com/"
  });
});

test("parseEnvContent: 空行・コメント行を無視する", () => {
  const result = parseEnvContent("# comment\n\nKEY=value\n");
  assert.deepEqual(result, { KEY: "value" });
});

test("parseEnvContent: 値に=が含まれても最初の=だけで分割する", () => {
  const result = parseEnvContent("THREADS_REDIRECT_URI=https://example.com/?a=b");
  assert.equal(result.THREADS_REDIRECT_URI, "https://example.com/?a=b");
});

test("parseEnvContent: 前後の空白をtrimする", () => {
  const result = parseEnvContent("  KEY = value  ");
  assert.equal(result.KEY, "value");
});

test("mergeWithProcessEnv: processEnvがlocalEnvより優先される", () => {
  const merged = mergeWithProcessEnv({ A: "local", B: "local-only" }, { A: "process" });
  assert.equal(merged.A, "process");
  assert.equal(merged.B, "local-only");
});
