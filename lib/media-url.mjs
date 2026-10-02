// 承認済みmedia.pathから、Threads APIがcURLでアクセスできる公開URLを組み立てる。
// 新しい外部ストレージ・有料の画像ホスティングは一切導入しない。このリポジトリは既にpublicなので、
// GitHubのraw.githubusercontent.com経由でMeta Graph APIから直接cURLできることを利用するだけ
// (2026-10-02 調査: raw.githubusercontent.comはHTTP 200・content-type: image/png・
// access-control-allow-origin: * で配信されることを確認済み)。
//
// 対象外(nullを返す)の場合:
//   - media.pathが無い(TEXT_ONLY、または画像未設定)
//   - media.path はあるが承認済みでない(path/approvedBy/approvedAtが揃っていない)
// これにより、承認済みPRODUCT_PHOTO等が設定されている投稿のみ画像付き投稿を試み、
// それ以外は従来どおりテキストのみの投稿になる(lib/threads-publish.mjs側の分岐)。

import { isMediaApproved } from "./media-guard.mjs";

// GitHub Actions実行時はprocess.env.GITHUB_REPOSITORY/GITHUB_REF_NAMEが自動的に
// 設定される(owner/repo, ブランチ名)。ローカル実行等でこれらが無い場合は、
// このリポジトリ自身の値をデフォルトとして使う(このプロジェクトは単一リポジトリ専用のため)。
const DEFAULT_REPOSITORY = "empowerartlab-art/threads-lostball-empowerartlab";
const DEFAULT_REF = "main";

export function resolvePublicMediaUrl(media, env = {}) {
  if (!media?.path) return null;
  if (!isMediaApproved(media)) return null;

  const repository = env.GITHUB_REPOSITORY || DEFAULT_REPOSITORY;
  const ref = env.GITHUB_REF_NAME || DEFAULT_REF;
  return `https://raw.githubusercontent.com/${repository}/${ref}/${media.path}`;
}
