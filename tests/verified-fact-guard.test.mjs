import { test } from "node:test";
import assert from "node:assert/strict";
import { canUseCandidate } from "../lib/verified-fact-guard.mjs";

const facts = [
  { id: "fact-a", verified: true },
  { id: "fact-b", verified: false }
];

test("requiresVerifiedFactがfalseなら常にOK", () => {
  const result = canUseCandidate({ requiresVerifiedFact: false }, facts);
  assert.equal(result.ok, true);
});

test("requiresVerifiedFactがtrueでもverifiedFactIdsが空ならNG", () => {
  const result = canUseCandidate({ requiresVerifiedFact: true, verifiedFactIds: [] }, facts);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "requires-verified-fact-but-no-fact-id");
});

test("verified:trueの事実のみを参照していればOK", () => {
  const result = canUseCandidate({ requiresVerifiedFact: true, verifiedFactIds: ["fact-a"] }, facts);
  assert.equal(result.ok, true);
});

test("verified:falseの事実を参照しているとNG", () => {
  const result = canUseCandidate({ requiresVerifiedFact: true, verifiedFactIds: ["fact-b"] }, facts);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "unverified-fact:fact-b");
});

test("存在しないfactIdを参照しているとNG", () => {
  const result = canUseCandidate({ requiresVerifiedFact: true, verifiedFactIds: ["fact-does-not-exist"] }, facts);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "unverified-fact:fact-does-not-exist");
});
