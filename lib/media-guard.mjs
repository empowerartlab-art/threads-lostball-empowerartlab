// メディア(画像)運用ガード(テーマ非依存)。ネットワーク・画像生成は一切行わない、純粋なデータ検査のみ。
//
// 目的:
//   「画像が無いから、とりあえずAI画像を作る」を構造的に禁止する。
//   - required:true の投稿は、人間が承認した実際の素材(path+approvedBy+approvedAt)が
//     揃っていない限り本番選出できない。システムが自動でAI画像を生成・添付することは無い
//     (canSelectForProductionはfalseを返すだけで、代わりに何かを生成する処理を一切持たない)。
//   - REAL_PHOTO/REAL_WORK/PRODUCT_PHOTO(実写系)は、承認された時点でAI生成であってはならない
//     (「AI生成したロストボールを実際の商品写真として使用しない」等を構造的に強制する)。
//   - AI_ASSISTED_VISUALとして承認する場合は、何を参考にしたか(aiReferenceNote)の記録を必須にし、
//     実在の出来事・人物・商品の証拠として使われることを防ぐ最低限の記録を残す。
//
// 詳細な運用方針(スタイルガードレール等、テキストでは検査できない部分)は
// data/media-policy.json / MEDIA_POLICY.md を参照。

export const MEDIA_TYPES = Object.freeze([
  "TEXT_ONLY",
  "REAL_PHOTO",
  "PRODUCT_PHOTO",
  "REAL_WORK",
  "AI_ASSISTED_VISUAL",
  "BRAND_GRAPHIC"
]);

// 実写系: 承認後にAI生成であってはならない(実在の証拠として使うため)。
const REAL_MEDIA_TYPES = new Set(["REAL_PHOTO", "REAL_WORK", "PRODUCT_PHOTO"]);

export function defaultMedia() {
  return { type: "TEXT_ONLY", required: false };
}

export function isMediaApproved(media) {
  return Boolean(media?.path && media?.approvedBy && media?.approvedAt);
}

// data/*.jsonの構造整合性チェック用。投稿を止める(errors)ものと、
// 「まだ準備中なだけ」の情報(warnings)を分ける。
export function checkMedia(item) {
  const errors = [];
  const warnings = [];
  const media = item?.media || defaultMedia();
  const type = media.type;

  if (!MEDIA_TYPES.includes(type)) {
    errors.push(`invalid-media-type:${type}`);
    return { ok: false, errors, warnings };
  }

  if (type === "TEXT_ONLY") {
    if (media.required) errors.push("text-only-cannot-be-required");
    return { ok: errors.length === 0, errors, warnings };
  }

  const approved = isMediaApproved(media);

  if (approved) {
    if (!media.altText || !media.altText.trim()) {
      errors.push("approved-media-missing-alt-text");
    }
    if (REAL_MEDIA_TYPES.has(type) && media.aiVisualAllowed) {
      errors.push("approved-real-media-cannot-be-ai-visual");
    }
    if (type === "AI_ASSISTED_VISUAL") {
      if (!media.aiVisualAllowed) {
        errors.push("ai-visual-not-allowed-for-this-item");
      }
      if (!media.aiReferenceNote || !media.aiReferenceNote.trim()) {
        errors.push("ai-visual-missing-reference-note");
      }
    }
  } else if (media.required) {
    warnings.push("required-media-not-yet-approved");
  }

  return { ok: errors.length === 0, errors, warnings };
}

// 本番選出時のゲート。required:trueの投稿は、承認済み素材が無い限り選出しない。
// TEXT_ONLY、またはrequired:falseの投稿は素材の有無に関わらず選出可能
// (承認済み素材があればそれを使い、無ければテキストのみで投稿する。何かを自動生成することは無い)。
export function canSelectForProduction(item) {
  const media = item?.media || defaultMedia();
  if (media.type === "TEXT_ONLY" || !media.required) return { ok: true };
  if (!isMediaApproved(media)) {
    return { ok: false, reason: "media-not-approved" };
  }
  return { ok: true };
}
