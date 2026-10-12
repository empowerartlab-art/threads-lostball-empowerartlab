#!/bin/zsh
# instagram/templates/*.html を 1080x1350（Instagram 縦4:5）の JPEG にして assets/instagram/ に書き出す。
# Mac の Google Chrome を使う（画像生成AIは使わない。文字デザイン＋実写のみ）。
# 使い方: instagram/render.sh                    → 全部
#         instagram/render.sh 2026-10-15-number  → 1枚だけ
set -e
HERE="${0:A:h}"
OUT="${HERE:h}/assets/instagram"
cd "$HERE"
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
TMP=$(mktemp -d)
mkdir -p "$OUT"
for f in templates/${1:-*}.html; do
  name=${f:t:r}
  "$CHROME" --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=1 \
    --allow-file-access-from-files --window-size=1080,1350 --virtual-time-budget=8000 \
    --screenshot="$TMP/$name.png" "file://$PWD/$f" >/dev/null 2>&1
  sips -s format jpeg -s formatOptions 90 "$TMP/$name.png" --out "$OUT/$name.jpg" >/dev/null
  echo "assets/instagram/$name.jpg"
done
rm -rf "$TMP"
