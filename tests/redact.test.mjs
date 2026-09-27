import { test } from "node:test";
import assert from "node:assert/strict";
import { createSecretRedactor } from "../lib/redact.mjs";

test("createSecretRedactor: 指定した秘密値を[REDACTED]に置き換える", () => {
  const redact = createSecretRedactor(["super-secret-token"]);
  assert.equal(redact("error: super-secret-token is invalid"), "error: [REDACTED] is invalid");
});

test("createSecretRedactor: 複数の秘密値をすべて置き換える", () => {
  const redact = createSecretRedactor(["secret-a", "secret-b"]);
  assert.equal(redact("secret-a and secret-b"), "[REDACTED] and [REDACTED]");
});

test("createSecretRedactor: null/undefinedはそのまま返す", () => {
  const redact = createSecretRedactor(["x"]);
  assert.equal(redact(null), null);
  assert.equal(redact(undefined), undefined);
});

test("createSecretRedactor: 空/falsyな秘密値はリストから除外される", () => {
  const redact = createSecretRedactor([null, "", undefined, "real-secret"]);
  assert.equal(redact("real-secret here"), "[REDACTED] here");
});

test("createSecretRedactor: 秘密値が含まれなければそのまま返す", () => {
  const redact = createSecretRedactor(["secret"]);
  assert.equal(redact("nothing sensitive here"), "nothing sensitive here");
});
