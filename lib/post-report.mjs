// 投稿処理の dry-run レポートを組み立てる純粋関数(テーマ非依存)。
// ネットワーク・Threads API・秘密情報は一切扱わない。既存ガード(lib/*.mjs)の結果を
// 人間が確認しやすい1つのレポートにまとめるだけで、判定ロジック自体は追加しない
// (選出条件を変えたい場合は scripts/select-daily-candidate.mjs 側の各ガードを直す)。

import { checkBilingualBody, buildBilingualBody, MAX_COMBINED_LENGTH } from "./bilingual-guard.mjs";
import { checkClaims } from "./claim-guard.mjs";
import { canUseCandidate } from "./verified-fact-guard.mjs";
import { isDuplicateBody } from "./duplicate-guard.mjs";
import { checkMedia, canSelectForProduction, isMediaApproved, defaultMedia } from "./media-guard.mjs";

export function buildDryRunReport(item, { postedBodySet, facts }) {
  const bilingual = checkBilingualBody(item);
  const claimWarnings = checkClaims(item);
  const verifiedFact = canUseCandidate(item, facts);
  const isDuplicate = isDuplicateBody(item, postedBodySet || new Set());
  const media = item?.media || defaultMedia();
  const mediaCheck = checkMedia(item);
  const mediaProductionGate = canSelectForProduction(item);
  const mediaApproved = isMediaApproved(media);
  const body = buildBilingualBody(item?.bodyEn, item?.bodyJa);

  const guardsOk =
    bilingual.ok &&
    verifiedFact.ok &&
    !isDuplicate &&
    mediaCheck.errors.length === 0 &&
    mediaProductionGate.ok;

  return {
    id: item?.id ?? null,
    day: item?.day ?? null,
    pillar: item?.pillar ?? null,
    category: item?.category ?? null,
    targetDate: item?.targetDate ?? null,
    hasCta: item?.hasCta === true,
    hasShopLink: item?.hasShopLink === true,
    combinedLength: bilingual.combinedLength,
    maxLength: MAX_COMBINED_LENGTH,
    body,
    media: {
      type: media.type,
      required: media.required === true,
      approved: mediaApproved,
      // 「画像あり」は、必須/任意を問わず人間が承認した実素材が揃っている場合のみtrue。
      // 未承認のまま画像ありとして扱うことはしない(AI画像の自動補完もしない)。
      hasImage: media.type !== "TEXT_ONLY" && mediaApproved
    },
    guards: {
      bilingual: { ok: bilingual.ok, errors: bilingual.errors },
      claimWarnings,
      verifiedFact,
      duplicate: { isDuplicate },
      media: { errors: mediaCheck.errors, warnings: mediaCheck.warnings, canSelectForProduction: mediaProductionGate }
    },
    guardsOk,
    // Phase 2はdry-run専用。この関数自体が実投稿を行うことは無く、常にDRY_RUNを返す。
    result: "DRY_RUN"
  };
}
