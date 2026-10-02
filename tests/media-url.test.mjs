// ネットワーク・Secretsを一切扱わない純粋関数のテスト。
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolvePublicMediaUrl } from "../lib/media-url.mjs";

function approvedMedia(overrides = {}) {
  return {
    type: "PRODUCT_PHOTO",
    required: true,
    aiVisualAllowed: false,
    path: "assets/lost-ball-product/day7-product-photo.png",
    altText: "A hand holding a package of recycled lost golf balls.",
    approvedBy: "empower.artlab@gmail.com",
    approvedAt: "2026-10-02T00:00:00.000Z",
    ...overrides
  };
}

test("resolvePublicMediaUrl: media.pathが無ければnull(TEXT_ONLY等)", () => {
  assert.equal(resolvePublicMediaUrl({ type: "TEXT_ONLY", required: false, path: null }, {}), null);
  assert.equal(resolvePublicMediaUrl(null, {}), null);
  assert.equal(resolvePublicMediaUrl(undefined, {}), null);
});

test("resolvePublicMediaUrl: pathはあるが未承認(approvedBy/approvedAtが無い)ならnull", () => {
  const media = approvedMedia({ approvedBy: null, approvedAt: null });
  assert.equal(resolvePublicMediaUrl(media, {}), null);
});

test("resolvePublicMediaUrl: 承認済みなら、env.GITHUB_REPOSITORY/GITHUB_REF_NAMEを使ってraw.githubusercontent.comのURLを組み立てる", () => {
  const media = approvedMedia();
  const url = resolvePublicMediaUrl(media, { GITHUB_REPOSITORY: "owner/repo", GITHUB_REF_NAME: "feature-branch" });
  assert.equal(
    url,
    "https://raw.githubusercontent.com/owner/repo/feature-branch/assets/lost-ball-product/day7-product-photo.png"
  );
});

test("resolvePublicMediaUrl: GITHUB_REPOSITORY/GITHUB_REF_NAMEが無い場合(ローカル実行等)は、このリポジトリ自身のデフォルト値を使う", () => {
  const media = approvedMedia();
  const url = resolvePublicMediaUrl(media, {});
  assert.equal(
    url,
    "https://raw.githubusercontent.com/empowerartlab-art/threads-lostball-empowerartlab/main/assets/lost-ball-product/day7-product-photo.png"
  );
});

test("resolvePublicMediaUrl: aiVisualAllowed:trueの画像でも、path/承認情報が揃っていればURLを返す(AI可否の判断はmedia-guard.mjs側の責務)", () => {
  const media = approvedMedia({ aiVisualAllowed: true });
  const url = resolvePublicMediaUrl(media, {});
  assert.match(url, /^https:\/\/raw\.githubusercontent\.com\//);
});
