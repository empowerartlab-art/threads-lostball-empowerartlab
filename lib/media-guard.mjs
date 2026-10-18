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

  // ヘタ郎の画像(Threads の枠付き投稿だけ。2026-10-18〜)。本文の目印・NGの書き方は lib/slots.mjs の slotMediaProblem が見る。
  if (type === CHARACTER_HETARO) {
    if (!hetaroImageUrl(media.path)) errors.push(`hetaro-image-not-from-hetaro-media:${media.path}`);
    if (media.aiVisualAllowed) errors.push("hetaro-media-cannot-set-ai-visual-allowed");
    if (isMediaApproved(media) && (!media.altText || !media.altText.trim())) errors.push("approved-media-missing-alt-text");
    return { ok: errors.length === 0, errors, warnings };
  }

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

// ---------------------------------------------------------------------------
// 例外：ヘタ郎のキャラクター画像(2026-10-13 決定・2026-10-14 オーナー最終OK)
//
// AI画像は引き続き使わない。唯一の例外が「ヘタ郎(Lost Ball の見習いアンバサダー、
// 架空のキャラクター)」の画像。次の条件をすべて満たすときだけ通す:
//   - 画像はすべてヘタ郎の画像置き場(公開リポジトリ empowerartlab-art/hetaro-media の ig/、
//     GitHub Pages)から。それ以外の画像を1枚でも混ぜたら不可。
//   - 説明文に、キャラクターだと分かる目印「見習いアンバサダー」が毎回ある(2026-10-14 オーナー決定。
//     「#ヘタ郎」だけでは不可。「#ヘタ郎」は併記してよい)。
//   - 説明文で、商品写真・実在の人物・実際の出来事・お客様の結果であるかのように書かない。
// 使える場所: Instagram、Threads の日本語の枠(1日1本の画像として。2026-10-18〜)、X(image に hetaro-media/ig/ の画像。2026-10-18〜)。
// どれも本文に「見習いアンバサダー」が必須(checkHetaroCharacterPost)。
// ---------------------------------------------------------------------------

export const CHARACTER_HETARO = "CHARACTER_HETARO";
export const HETARO_MEDIA_BASE = "https://empowerartlab-art.github.io/hetaro-media/ig/";
const HETARO_REPO_PREFIX = "hetaro-media/ig/";
const HETARO_FILE = /^[A-Za-z0-9][\w-]*(?:\.[\w-]+)*\.jpe?g$/i;

// キャラクターだと分かる目印。「見習いアンバサダー」は毎回必須(「#ヘタ郎」だけでは不可。併記は可)。
export const HETARO_REQUIRED_MARKER = "見習いアンバサダー";

// ヘタ郎の画像で「実物・実在・実際の結果」を示す書き方は不可(ステマ・誤認防止)。
const HETARO_FORBIDDEN_CLAIMS = [
  { re: /商品写真|商品画像|実物(?:の)?写真|現物(?:の)?写真|実際の商品|実際のボール|実写|本物の写真|撮影した|写真のボール|この(?:ボール|球)を(?:販売|お届け|発送)/, family: "product-photo-claim" },
  { re: /お客様|購入者|ご購入いただ|利用者さん|本人の写真|スタッフの写真/, family: "real-person-claim" },
  { re: /お客様の声|レビュー|使ってみた結果|スコアが[\d０-９]|飛距離が[\d０-９]|ビフォー|アフター/, family: "customer-result-claim" },
  { re: /イベント(?:当日|の様子|レポート)|来場|開催しました|現地で撮/, family: "real-event-claim" },
];

// 画像の指定(GitHub Pages の URL、または "hetaro-media/ig/<ファイル名>")を公開 URL にする。
// ヘタ郎の置き場以外・不正な形なら null。
export function hetaroImageUrl(ref) {
  if (typeof ref !== "string") return null;
  let file = null;
  if (ref.startsWith(HETARO_MEDIA_BASE)) file = ref.slice(HETARO_MEDIA_BASE.length);
  else if (ref.startsWith(HETARO_REPO_PREFIX)) file = ref.slice(HETARO_REPO_PREFIX.length);
  if (!file || !HETARO_FILE.test(file)) return null; // "/" "?" "#" ".." 等はここで弾く
  return HETARO_MEDIA_BASE + file;
}

// mediaType=CHARACTER_HETARO の投稿(images[] と caption)の検査。errors は投稿を止める。
export function checkHetaroCharacterPost({ images, caption } = {}) {
  const errors = [];
  if (!Array.isArray(images) || images.length === 0) {
    errors.push("hetaro-no-images");
  } else {
    for (const ref of images) {
      if (!hetaroImageUrl(ref)) errors.push(`hetaro-image-not-from-hetaro-media:${ref}`);
    }
  }
  const text = typeof caption === "string" ? caption : "";
  if (!text.includes(HETARO_REQUIRED_MARKER)) {
    errors.push(`hetaro-caption-missing-marker(${HETARO_REQUIRED_MARKER})`);
  }
  for (const { re, family } of HETARO_FORBIDDEN_CLAIMS) {
    const m = text.match(re);
    if (m) errors.push(`hetaro-caption-${family}:「${m[0]}」`);
  }
  return { ok: errors.length === 0, errors };
}
