// candidate(draft-bank-candidates.json) → 承認済み(draft-bank.json) への昇格は、
// この関数を通らない限り成立しない。approvedBy/approvedAtが明示されていない限り例外を投げる。
// AIが自動的に承認済み扱いで書き込むことは想定していない。
//
// 注: ここでの承認(approval.approvedBy/approvedAt)は本文(テキスト)の承認であり、
// メディア(画像)の承認とは独立している。candidate.media はそのまま引き継ぐだけで、
// media.approvedBy/media.approvedAt を自動的に埋めることはしない
// (画像の承認は別途、人間が data/draft-bank.json の media を直接更新する形で行う)。

import { defaultMedia } from "./media-guard.mjs";

export class ApprovalError extends Error {}

export function promoteCandidate(candidate, approval) {
  if (!approval || approval.approved !== true) {
    throw new ApprovalError("candidateは明示的に承認(approval.approved === true)されていません");
  }
  if (!approval.approvedBy || !String(approval.approvedBy).trim()) {
    throw new ApprovalError("approval.approvedBy(承認者)が必要です");
  }
  if (!approval.approvedAt) {
    throw new ApprovalError("approval.approvedAt(承認日時)が必要です");
  }
  if (!candidate?.bodyEn || !String(candidate.bodyEn).trim()) {
    throw new ApprovalError("candidate.bodyEn が空です");
  }
  if (!candidate?.bodyJa || !String(candidate.bodyJa).trim()) {
    throw new ApprovalError("candidate.bodyJa が空です");
  }

  return {
    id: candidate.id,
    day: candidate.day ?? null,
    pillar: candidate.pillar ?? null,
    category: candidate.category ?? null,
    bodyEn: candidate.bodyEn,
    bodyJa: candidate.bodyJa,
    hasCta: candidate.hasCta === true,
    hasShopLink: candidate.hasShopLink === true,
    requiresVerifiedFact: candidate.requiresVerifiedFact === true,
    verifiedFactIds: Array.isArray(candidate.verifiedFactIds) ? candidate.verifiedFactIds : [],
    media: candidate.media ?? defaultMedia(),
    targetDate: candidate.targetDate ?? null,
    approvedBy: approval.approvedBy,
    approvedAt: approval.approvedAt,
    sourceCandidateId: candidate.id ?? null
  };
}
