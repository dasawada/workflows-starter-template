#!/usr/bin/env bash
# 部署前置 + 部署。本機與 Cloudflare Workers Builds 皆可用：
#   1. D1 不存在就建立，並把 database_id 寫進 wrangler.jsonc（資源識別碼，非密鑰）
#   2. R2 bucket 不存在就建立
#   3. 套用 D1 migrations（remote）
#   4. wrangler deploy
# 不會碰任何密鑰；密鑰請在 Cloudflare dashboard 輸入。
# 需先 `npm run build`（Workers Builds 的 Build command 會做）。
set -euo pipefail
cd "$(dirname "$0")/.."

DB_NAME="cs-console-db"
BUCKET_NAME="cs-console-media"

json_field() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const v=JSON.parse(s);const r=Array.isArray(v)?v.find(x=>x.name===process.argv[2]):v;process.stdout.write(r?String(r[process.argv[1]]??""):"")})' "$@"; }

echo "== D1: $DB_NAME"
DB_ID=$(npx wrangler d1 list --json | json_field uuid "$DB_NAME")
if [ -z "$DB_ID" ]; then
  DB_ID=$(npx wrangler d1 create "$DB_NAME" --json | json_field uuid) || {
    echo "!! 無法建立 D1，請在 dashboard（Storage & Databases → D1）手動建立名為 $DB_NAME 的資料庫後重試"; exit 1; }
  echo "   已建立 $DB_ID"
else
  echo "   已存在 $DB_ID"
fi

echo "== 寫入 database_id 到 wrangler.jsonc"
node -e '
  const fs=require("fs");const p="wrangler.jsonc";
  const s=fs.readFileSync(p,"utf8").replace(/"database_id":\s*"[^"]*"/,`"database_id": "${process.argv[1]}"`);
  fs.writeFileSync(p,s);' "$DB_ID"

echo "== R2: $BUCKET_NAME"
if npx wrangler r2 bucket list 2>/dev/null | grep -Eq "^name: *$BUCKET_NAME\$|^$BUCKET_NAME\$"; then
  echo "   已存在"
else
  npx wrangler r2 bucket create "$BUCKET_NAME" || {
    echo "!! 無法建立 R2，請在 dashboard（R2 Object Storage）手動建立名為 $BUCKET_NAME 的 bucket 後重試"; exit 1; }
fi

if [ ! -d dist/client ]; then
  echo "== dist 不存在，先建置"
  npm run build
fi

echo "== 套用 D1 schema（remote）"
npx wrangler d1 migrations apply DB --remote

echo "== 部署"
npx wrangler deploy

cat <<MSG

完成。若尚未設定密鑰，請到 Cloudflare dashboard：
  Workers & Pages → cs-console → Settings → Variables and Secrets
  新增三個 Secret：LINE_CHANNEL_SECRET、LINE_CHANNEL_ACCESS_TOKEN、CONSOLE_TOKEN
再到 LINE Developers Console 設定 Webhook URL：https://<worker 網址>/webhook/line
MSG
