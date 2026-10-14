# Instagram 自動投稿（2026-10-12 追加）

Threads と同じリポジトリで、承認済みの Instagram 投稿を毎朝 07:00 JST に出す仕組み。
設計は ZERO RIDERS（`~/Documents/threads-zero-riders`）の Instagram 投稿と同じ。

## 媒体ごとの役割
| | Threads | Instagram | X |
|---|---|---|---|
| 役割 | 話す（会話・小話） | 見せる（ブランドの顔） | 広げる（ゴルファーとの接点） |
| 頻度 | 1日4本（2026-10-20〜：日本語 7:35・12:35・20:35／英語 21:00。10/19までは JA 05:00／EN 21:00） | **毎日** 07:00（2026-10-20〜。それまでは週3〜4回） | 1日3本（2026-10-20〜：7:10・12:10・20:10。10/19までは 05:53 に1本） |
| 形 | 文字のみ | 画像1枚 or 2〜10枚＋説明文 | 短文・文字のみ（画像は未対応。使うときも IG 画像の再利用だけ） |
| タグ | 0〜2 | 5〜8 | 0〜2 |
| ショップ誘導 | 週1回まで | 週1回まで（プロフィールのリンクから） | 週1回まで |

Instagram は、同じ日の Threads のネタを画像で深掘りする（例：Threads「推定5億〜10億球」→ IG 数字カード）。

## 画像のルール
- **AI 画像は使わない**（MEDIA_POLICY.md）。`mediaType` は BRAND_GRAPHIC / PRODUCT_PHOTO / REAL_PHOTO / REAL_WORK のみ（検査で強制）。
- **例外はヘタ郎だけ**（2026-10-14 オーナーOK）：`mediaType` を `CHARACTER_HETARO` にすると、ヘタ郎（Lost Ball の見習いアンバサダー）のキャラクター画像を使える。
  - 画像は hetaro-media の公開URL（`https://empowerartlab-art.github.io/hetaro-media/ig/<ファイル名>`）だけ。このリポジトリの画像や他の画像と混ぜない。
  - 説明文に「見習いアンバサダー」を毎回必ず入れる（「#ヘタ郎」だけでは不可。「#ヘタ郎」は併記してよい）。
  - 商品写真・実在の人・お客様の結果・実際のイベントのように書かない（「商品写真」「お客様」「イベント当日」などがあると検査で止まる）。
  - 詳しくは MEDIA_POLICY.md の「例外：ヘタ郎のキャラクター画像」。
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

# X 自動投稿（2026-10-12 追加・2026-10-20 から1日3本）

## いつ出るか
| 枠 | 時刻（日本時間） | cron（UTC） | data/x-queue.json の書き方 |
|---|---|---|---|
| 朝 | 07:10 | `10 22 * * *`（前日） | `"slot": "morning"` |
| 昼 | 12:10 | `10 3 * * *` | `"slot": "noon"` |
| 夜 | 20:10 | `10 11 * * *` | `"slot": "night"` |
| （従来） | 05:53 | `53 20 * * *`（前日） | slot なし（**10/19 まで**） |

- **10/19 まで**は今までとまったく同じ：毎朝 05:53 に、slot の無い承認済みの1本だけ。
- **10/20 から**は朝・昼・夜の3本。05:53 の実行は何もせずに終わる（消しても害はない）。
- どの枠かは「どの時刻の予約（cron）で動いたか」で決まる（`lib/x-slots.mjs`・`scripts/x-resolve-run.mjs`）。GitHub が混んで遅れて動いても、枠を取り違えない。
- 1回で出すのは「その日・その枠」の承認済み1本だけ。朝に出せなかった分を昼に出すことはしない。
- 10/20 以降の日付は、朝・昼・夜がちょうど1本ずつ。足りない・多い・従来の形と混ざっている日は、検査（`npm run x:validate`）でエラーになり、投稿の前に止まる。
- 投稿記録（`data/x-posts.json`）と予約記録（`data/x-journal.json`）には `slot` が残る。

## 中身のルール
- 日本語・文字のみ。全角140字以内（X は日本語1文字を2と数える）。
- 承認済みの Threads 投稿を、X 用に**書き直したもの**。基本は「同じ日・同じ枠の日本語 Threads」から作り、`threadsItemId` にその Threads の id を書く。
- Threads の文（日本語・英語）の**丸写し・ほぼ写し・抜き書きは検査で止まる**（似ている度合い0.7以上、または X の文の9割以上が Threads の文に含まれる場合）。
- 同じ日の3本・7日以内の X どうしが似すぎていても止まる（Threads と同じ基準）。
- 新しい事実は足さない。事実を書くときは `requiresVerifiedFact: true` と `verifiedFactIds`（`data/verified-facts.json` の確認済みのものだけ）。
- タグは0〜1個。ショップ誘導（「販売中」「プロフィールのリンクから」など）は**週1回まで**（検査で止まる）。
- 画像付きは未対応（使うようになっても、Instagram で承認済みの画像の再利用だけ。AI画像は使わない。例外はヘタ郎のキャラクター画像だけで、MEDIA_POLICY.md のルールに従う）。

## 料金とリンク（大事）
- X の投稿は1本ごとにお金がかかる。目安：**URLなし 1本 $0.015、URL入り 1本 $0.20（約13倍）**。1日3本・URLなしなら月およそ $1.4。
- **URL は原則入れない**。入れるときは `allowLink: true`（週2本まで）。URL入りの投稿は、検査・まとめて承認・投稿のたびに「⚠️⚠️ URL入り」と大きく警告が出る。

## 1週間の流れ（土曜）
1. 土曜の週次レビュー（Discord）に「X 来週の予定」が載る。1週間で **21本（3本×7日）**、作成数と承認数、足りない枠には「元にする日本語 Threads」が並ぶ。
2. Threads の1日4本を決めたら、Claude に「来週のXを作って」と頼む。同じ日・同じ枠の日本語 Threads を X 用に書き直して、`data/x-queue.json` に21本（`approved: false`）入れる。
3. 人がまとめて確認・承認する（AI の自動承認はしない）：

```bash
# 見るだけ（何も書き換えない）。日付ごとに 枠・時刻・本文・画像・文字数・元の Threads が並ぶ
node scripts/x-bulk-approve.mjs --week 2026-10-20

# 承認する（--by 名前 と --yes の両方が必要）
node scripts/x-bulk-approve.mjs --week 2026-10-20 --by 承認者 --yes
# 一部の日を外して承認する（外すときは、その日の3本をまとめて外す）
node scripts/x-bulk-approve.mjs --week 2026-10-20 --exclude id1,id2,id3 --by 承認者 --yes
```

- 1件でも問題があれば何も書き換えない（全部OKのときだけ承認）。問題の id と理由が表示される。
- 1日の途中まで（例：夜だけ未承認）では承認できない。3本そろえるか、3本とも外す。
- 承認したら `npm run x:validate` → `data/x-queue.json` を commit / push。

## 安全のしくみ
- 出す前に「この枠の分を出します」という予約（claim）を GitHub に書き込んでから投稿する。
- 結果が分からない（通信が切れた等）ときは、**自動で投稿し直さない**。人が X を目で確認して `x-resolve.mjs` で閉じるまで、朝・昼・夜すべての X 投稿が止まる（二重投稿を防ぐため）。
- 記録の push が他の自動実行とぶつかったら、最大5回やり直す（やり直すのは記録だけ。X への投稿はやり直さない）。
- X 専用の順番待ち（concurrency group `lostball-x-post`、`cancel-in-progress: false`）。Threads・Instagram・週次レビューとは別。
- 手動実行（Actions の Run workflow）は**必ず試運転（dry-run）**で、X には投稿しない。`run`（auto / morning / noon / night / legacy）と `date` で、どの枠・どの日の投稿が出る予定かを確認できる。

## コマンド
| 操作 | コマンド |
|---|---|
| 一覧と検査 | `npm run x:validate` |
| まとめて承認（10/20〜） | `node scripts/x-bulk-approve.mjs --week 2026-10-20 --by <名前> --yes` |
| 1件ずつ承認（従来の形） | `node scripts/x-approve.mjs --id <postId> --by <名前> --yes` |
| 来週の予定 | `npm run x:week` |
| 鍵の登録（本人がターミナルで。1つの開発者アプリ＋PIN方式で4アカウント共通） | `node scripts/connect-x.mjs --all`（4アカウント順番に）／`--repo empowerartlab-art/<repo>`（1つだけ） |
| 止まったとき | `node scripts/x-resolve.mjs --id <id> --outcome published|not-published [--x-id <id>] --by <名前> --yes` |

スイッチ：GitHub Secrets `X_LIVE_POST` が `true` のときだけ実投稿（Threads・Instagram とは別）。
鍵：`X_API_KEY` / `X_API_SECRET` / `X_ACCESS_TOKEN` / `X_ACCESS_TOKEN_SECRET`（connect-x.mjs が保存）。
