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

---

# X 自動投稿（2026-10-12 追加）

- 毎朝 05:53 JST に1本（`.github/workflows/x-post.yml`）。設計は Instagram と同じ（claim → publish、結果不明は人が確認するまで停止）。
- 中身：承認済みの Threads 投稿を、X 用（全角140字以内）に**書き直したもの**。Threads の文（日本語・英語）の丸写しは検査で止まる。新しい事実は足さない。
- タグは0〜1個（問いかけの日だけ `#ゴルフ` など）。ショップ誘導は週1回「プロフィールのリンクから」。
- **リンクは原則入れない**（X の投稿 API は従量課金で、リンク付きは約13倍の料金。目安：リンクなし約2.3円／本。公式の料金画面では未確認）。入れるときは `allowLink: true`、週2本まで。
- 画像付き投稿は未対応（必要になったら Instagram の画像を再利用する形で追加）。

| 操作 | コマンド |
|---|---|
| 一覧と検査 | `npm run x:validate` |
| 承認 | `node scripts/x-approve.mjs --from 2026-10-14 --to 2026-10-19 --by <名前> --yes` |
| 鍵の登録（本人がターミナルで。1つの開発者アプリ＋PIN方式で4アカウント共通） | `node scripts/connect-x.mjs --all`（4アカウント順番に）／`--repo empowerartlab-art/<repo>`（1つだけ） |
| 止まったとき | `node scripts/x-resolve.mjs --id <id> --outcome published|not-published [--x-id <id>] --by <名前> --yes` |

スイッチ：GitHub Secrets `X_LIVE_POST` が `true` のときだけ実投稿（Threads・Instagram とは別）。
鍵：`X_API_KEY` / `X_API_SECRET` / `X_ACCESS_TOKEN` / `X_ACCESS_TOKEN_SECRET`（connect-x.mjs が保存）。
