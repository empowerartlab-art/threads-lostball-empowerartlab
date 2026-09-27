import { test } from "node:test";
import assert from "node:assert/strict";
import { promoteCandidate, ApprovalError } from "../lib/approval-gate.mjs";

const candidate = {
  id: "cand-1",
  day: 8,
  pillar: "GOLF",
  category: "PRODUCT_SHOP",
  bodyEn: "Hello.",
  bodyJa: "こんにちは。",
  requiresVerifiedFact: false,
  verifiedFactIds: []
};

test("approval.approvedがtrueでなければApprovalError", () => {
  assert.throws(() => promoteCandidate(candidate, { approved: false }), ApprovalError);
});

test("approvedByが無ければApprovalError", () => {
  assert.throws(() => promoteCandidate(candidate, { approved: true, approvedAt: "2026-01-01T00:00:00.000Z" }), ApprovalError);
});

test("approvedAtが無ければApprovalError", () => {
  assert.throws(() => promoteCandidate(candidate, { approved: true, approvedBy: "someone@example.com" }), ApprovalError);
});

test("bodyEn/bodyJaが無ければApprovalError", () => {
  assert.throws(
    () => promoteCandidate({ ...candidate, bodyEn: "" }, { approved: true, approvedBy: "x", approvedAt: "2026-01-01T00:00:00.000Z" }),
    ApprovalError
  );
});

test("すべて揃っていれば昇格結果を返す", () => {
  const result = promoteCandidate(candidate, {
    approved: true,
    approvedBy: "empower.artlab@gmail.com",
    approvedAt: "2026-01-01T00:00:00.000Z"
  });
  assert.equal(result.bodyEn, "Hello.");
  assert.equal(result.approvedBy, "empower.artlab@gmail.com");
  assert.equal(result.sourceCandidateId, "cand-1");
});

test("candidate.mediaを指定した場合はそのまま昇格結果に引き継がれる(画像の自動承認はしない)", () => {
  const withMedia = {
    ...candidate,
    media: { type: "PRODUCT_PHOTO", required: true, aiVisualAllowed: false }
  };
  const result = promoteCandidate(withMedia, {
    approved: true,
    approvedBy: "empower.artlab@gmail.com",
    approvedAt: "2026-01-01T00:00:00.000Z"
  });
  assert.deepEqual(result.media, { type: "PRODUCT_PHOTO", required: true, aiVisualAllowed: false });
  assert.equal(result.media.approvedBy ?? null, null, "テキスト承認だけでmediaが自動承認されてはいけない");
});

test("candidate.mediaを指定しなければTEXT_ONLYがデフォルトになる", () => {
  const result = promoteCandidate(candidate, {
    approved: true,
    approvedBy: "empower.artlab@gmail.com",
    approvedAt: "2026-01-01T00:00:00.000Z"
  });
  assert.deepEqual(result.media, { type: "TEXT_ONLY", required: false });
});
