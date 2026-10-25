# Instagram リール（2026-10-25 代表者決定）

画像の投稿と同じ仕組み（毎朝 7:00・承認したものだけ・二重投稿防止・dry run）で、リール（縦の短い動画）を出せる。
仕組みは ZERO RIDERS（`~/projects/threads-zero-riders`）のリールと同じ。

## 1. 動画を用意する
- 縦 1080×1920（9:16）・MP4（H.264／音声 AAC）・7〜15秒くらい
- **映像は AI で作ってもよい**（2026-10-25 代表者決定）。ただし自然な見た目にする。説明文に AI 注記は入れない
- AI の映像を、実際の商品・お客様・実際の出来事の証拠のように見せない（MEDIA_POLICY.md の絶対ルールは同じ）
- 音楽は入れない（著作権のある曲を使わない）。BGM を付けたいときは、権利のはっきりした音源だけ
- 表紙（任意）：JPEG。省略すると動画の最初の画面が表紙になる

## 2. 置き場所
画像と同じ `assets/instagram/` に置いて push する。
- 動画：`assets/instagram/<日付>-<名前>.mp4`（例 `2026-10-28-polish.mp4`）
- 表紙：`assets/instagram/<日付>-<名前>-cover.jpg`
- Instagram に渡す URL
  - 動画：`https://empowerartlab-art.github.io/threads-lostball-empowerartlab/assets/instagram/<ファイル名>.mp4`（GitHub Pages）
  - 表紙：`https://raw.githubusercontent.com/empowerartlab-art/threads-lostball-empowerartlab/main/assets/instagram/<ファイル名>.jpg`（画像と同じ）
- 動画だけ GitHub Pages なのは、raw.githubusercontent.com が mp4 を `application/octet-stream` で返し、`video/mp4` にならないため（2026-10-25 確認）。
  **このリポジトリの GitHub Pages（main ブランチ・ルート）を有効にするまで、リールは投稿前の確認で止まる（何も出ない）。**

## 3. 承認データ（`data/ig-queue.json`）の書き方
```json
{
  "id": "ig-2026-10-28-polish",
  "date": "2026-10-28",
  "pillar": "ENVIRONMENT",
  "mediaType": "AI_VIDEO",
  "video": "2026-10-28-polish.mp4",
  "cover": "2026-10-28-polish-cover.jpg",
  "shareToFeed": true,
  "caption": "本文…\n\n#ロストボール #ゴルフ …",
  "verifiedFactIds": [],
  "threadsDate": "2026-10-28",
  "approved": false
}
```
- `video` があるとリールになる（`images` は書かない。両方あるとエラー）。ファイル名だけ書く（`/` は不可）
- `cover`（表紙・JPEG）は省略可
- `shareToFeed`：`true`（省略時）＝フィードとリールの両方に出す／`false`＝リールのタブだけ
- `mediaType`：AI で作った映像は `AI_VIDEO`（リール専用。静止画には使えない）。実写の動画は `REAL_PHOTO`／`PRODUCT_PHOTO`／`REAL_WORK`、文字デザインを動かしたものは `BRAND_GRAPHIC`
- ヘタ郎のリールは未対応（`CHARACTER_HETARO` に `video` を付けるとエラー）
- 本文の決まりは画像と同じ（2,200字・タグ8個まで・URL 直書き禁止）
- その日の Threads・X に付ける画像を使い回す日は、表紙の JPEG（`assets/instagram/〜-cover.jpg`）を使う

## 4. 承認・確認
- 確認：`npm run ig:validate`（動画・表紙のファイルが `assets/instagram/` にあるかも見る。AI_VIDEO は注意が出る）
- 承認：`node scripts/ig-approve.mjs --id ig-2026-10-28-polish --by KEITA --yes`
- 試し（投稿しない）：`TARGET_DATE=2026-10-28 node scripts/ig-publish.mjs` → `type=REELS` と動画の URL が出る

## 5. 投稿のときに自動でしていること
1. 動画の URL が `video/mp4` で見られるか確かめる（表紙があれば JPEG か）。だめならその日は止める（何も出ない）
2. `media_type=REELS` で入れ物を作り、10秒ごとに最長5分、処理が終わるのを待つ（終わらなければ止める。何も出ない）
3. 公開。結果が分からないときは画像と同じく自動でやり直さず止まる → INSTAGRAM.md の「止まったとき」
4. 記録（`data/ig-posts.json`）には `type: "REELS"`・`video`・`cover` が残る

公式の条件（ZERO RIDERS で 2026-10-24 確認）：MP4/MOV、H.264、AAC 48kHz まで、23〜60fps、横 1920px まで、9:16 推奨、3秒〜15分、300MB まで、表紙は JPEG 8MB まで。
