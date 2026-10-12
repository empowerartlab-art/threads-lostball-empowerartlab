# Instagram 自動投稿（2026-10-12 追加）

Threads と同じリポジトリで、承認済みの Instagram 投稿を毎朝 07:00 JST に出す仕組み。
設計は ZERO RIDERS（`~/Documents/threads-zero-riders`）の Instagram 投稿と同じ。

## 媒体ごとの役割
| | Threads | Instagram | X（予定） |
|---|---|---|---|
| 役割 | 話す（会話・小話） | 見せる（ブランドの顔） | 広げる（ゴルファーとの接点） |
| 頻度 | 毎日（JA 05:00／EN 21:00） | 週3〜4回 07:00 | 毎日1〜2回 |
| 形 | 文字のみ | 画像1枚 or 2〜10枚＋説明文 | 短文＋IG画像の再利用 |
| タグ | 0〜2 | 5〜8 | 0〜2 |
| ショップ誘導 | 週1回まで | 週1回まで（プロフィールのリンクから） | 週1回まで |

Instagram は、同じ日の Threads のネタを画像で深掘りする（例：Threads「推定5億〜10億球」→ IG 数字カード）。

## 画像のルール
- **AI 画像は使わない**（MEDIA_POLICY.md）。`mediaType` は BRAND_GRAPHIC / PRODUCT_PHOTO / REAL_PHOTO / REAL_WORK のみ（検査で強制）。
- 文字デザイン（`instagram/templates/*.html`）＋実写・ステッカー原画で作る。1080×1350（縦4:5）JPEG。
- ステッカー原画は QR コード部分を写さない。チラシ原本（顔・住所・QR入り）は使わない。
- 作り方: `instagram/templates/<日付>-<名前>.html` を作る → `npm run ig:render` → `assets/instagram/` に JPEG。

## 1週間のサイクル（他のアカウントと同じ）
1. **土曜 07:07 頃**: 週次レビューが Discord に届く。Threads の候補に加えて、Instagram の反応と「来週（火〜月）の予定・承認状況」が載る。
2. **土曜**: Claude と一緒に来週の Threads を確定 → 同じネタから Instagram（画像＋説明文）を作る → `data/ig-queue.json` に追加。
3. **人が承認**: `node scripts/ig-approve.mjs --id <id> --by <名前> --yes`（AI の自動承認はしない）→ commit / push。
4. **火〜月 07:00**: 承認済みの分だけ自動投稿。予定がない日は何もしない。

## 投稿データ（data/ig-queue.json）
`id, date, pillar, mediaType, images[], caption, verifiedFactIds[], threadsDate, note, approved, approvedBy, approvedAt`
- caption は 2200 字以内・タグ8個まで・URL 直書き禁止。`verifiedFactIds` は `data/verified-facts.json` にあるものだけ。
- 断定表現などは `npm run ig:validate` で警告が出る（人が承認時に判断）。

## スイッチと鍵（GitHub Secrets）
| 名前 | 用途 |
|---|---|
| `IG_ACCESS_TOKEN` / `IG_USER_ID` | `node scripts/connect-instagram.mjs` で本人が登録（約60日ごとに更新。期限14日前から週次レビューで警告） |
| `IG_LIVE_POST` | `true` のときだけ実際に投稿。無ければ試運転（ログのみ）。Threads の `LIVE_POST` とは別 |

## 止まったとき
- Discord に「⚠️ 失敗」が来たら **再実行しない**。Instagram のプロフィールを目で見て、
  `node scripts/ig-resolve.mjs --id <id> --outcome published|not-published --by <名前> --yes` → commit / push。
- それまで Instagram の投稿は止まったまま（二重投稿防止）。Threads には影響しない。
