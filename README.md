# 客服收發台（LINE）

以 Cloudflare Workers 建置的 LINE 官方帳號客服訊息收發台：

- **收訊**：LINE Messaging API webhook → 驗簽章 → 存入 D1 → 透過 Durable Object 以 WebSocket 即時推到客服台
- **發訊**：客服在網頁上回覆 → LINE Push API → 存入 D1 → 廣播給其他在線客服
- **媒體**：使用者傳的圖片／影片／語音／檔案背景下載到 R2，客服台直接顯示
- **逾時提醒**：Cloudflare Workflows 監看每個對話，客服超過 `REPLY_SLA_MINUTES` 未回覆就標記「逾時」並推播
- **自動歡迎**：使用者加好友時用 reply token 送 `WELCOME_MESSAGE`
- **群組／多人聊天室**：以群組為對話單位，訊息會標示發言者

渠道層（`worker/line.ts`、`worker/webhook-line.ts`）與資料層（`worker/db.ts`）分離，`conversations.channel` 已預留 `teams`，之後可用同一套客服台接 Microsoft Teams。

## 架構

```
LINE 平台 ──POST /webhook/line──▶ Worker ──▶ D1 (conversations, messages)
                                   │  └──▶ R2 (媒體)
                                   │  └──▶ Workflow (逾時提醒)
                                   └──▶ InboxDO ──WebSocket──▶ 客服台 (React)
客服台 ──POST /api/conversations/:id/reply──▶ Worker ──▶ LINE Push API
```

| 路徑 | 說明 |
| --- | --- |
| `worker/index.ts` | 路由與客服台 API |
| `worker/webhook-line.ts` | LINE webhook 事件處理 |
| `worker/line.ts` | LINE API client、簽章驗證 |
| `worker/db.ts` | D1 存取層 |
| `worker/inbox-do.ts` | WebSocket 廣播用 Durable Object |
| `worker/workflow.ts` | 逾時未回覆提醒 Workflow |
| `migrations/` | D1 schema |
| `shared/types.ts` | 前後端共用型別 |
| `src/` | React 客服台 |
| `test/` | Vitest（跑在 workerd 裡，含 D1 migration） |

## 密鑰與設定

| 名稱 | 用途 | 哪裡取得 |
| --- | --- | --- |
| `LINE_CHANNEL_SECRET` | 驗證 webhook 簽章 | LINE Developers Console → Messaging API channel → **Basic settings → Channel secret** |
| `LINE_CHANNEL_ACCESS_TOKEN` | 呼叫 LINE API | 同上 → **Messaging API → Channel access token (long-lived)** → Issue |
| `CONSOLE_TOKEN` | 客服台登入密鑰 | 自行產生：`openssl rand -hex 24` |

非機密設定在 `wrangler.jsonc` 的 `vars`：`REPLY_SLA_MINUTES`（預設 10 分鐘）、`WELCOME_MESSAGE`（留空則不送）。

### 本機開發（選用，功能驗證以正式環境為準）

```bash
npm install
npm run db:migrate:local         # 建立本機 D1 schema
npm run dev                      # http://localhost:5173，只看 UI 排版
```

若要在本機完整測 LINE 流程，需自行建立 `.dev.vars`（參考 `.dev.vars.example`，已在 .gitignore）並用 `cloudflared tunnel` 取得公開網址。

### 正式部署（GitHub → Cloudflare Workers Builds）

不需要本機登入、不需要 API token，全部在 Cloudflare dashboard 完成：

1. **Workers & Pages → Create → Import a repository**，授權 GitHub 並選擇本 repo。
2. 設定：
   | 欄位 | 值 |
   | --- | --- |
   | Project name | `cs-console` |
   | Production branch | `main` |
   | Build command | `npm run build` |
   | Deploy command | `bash scripts/bootstrap.sh` |
3. 按 Save and Deploy。`scripts/bootstrap.sh` 會自動建立 D1（`cs-console-db`）與 R2（`cs-console-media`）、套用 schema、部署；若建置環境無權建立資源，先在 dashboard 手動建好同名資源再重跑。
4. 部署完成後到 **cs-console → Settings → Variables and Secrets**，新增三個 Secret：`LINE_CHANNEL_SECRET`、`LINE_CHANNEL_ACCESS_TOKEN`、`CONSOLE_TOKEN`。

之後每次 push 到 `main` 都會自動建置部署。

手動部署（替代方案）：`npx wrangler login` 後執行 `npm run build && bash scripts/bootstrap.sh`。

接著到 LINE Developers Console：

1. **Messaging API → Webhook URL** 填 `https://<你的 worker 網址>/webhook/line`，按 Verify，開啟 **Use webhook**
2. 關閉 **Auto-reply messages**（否則 LINE 會用官方帳號的罐頭訊息搶先回覆）
3. 關閉 **Greeting message**（由本系統的 `WELCOME_MESSAGE` 取代；想用 LINE 內建的就把 `WELCOME_MESSAGE` 留空）

打開 worker 網址，用 `CONSOLE_TOKEN` 登入即可。

## API

所有 `/api/*` 與 `/ws` 需要 `Authorization: Bearer <CONSOLE_TOKEN>`（WebSocket 用 `?token=`）。

| 方法 | 路徑 | 說明 |
| --- | --- | --- |
| POST | `/webhook/line` | LINE 平台呼叫（X-Line-Signature 驗證） |
| GET | `/ws` | 即時事件：`message.new`、`conversation.updated` |
| GET | `/api/me` | 驗證 token |
| GET | `/api/conversations?status=open\|closed\|all` | 對話清單 |
| GET | `/api/conversations/:id/messages?before=&limit=` | 訊息（舊→新） |
| POST | `/api/conversations/:id/reply` | `{ "text": "..." }` |
| POST | `/api/conversations/:id/read` | 清除未讀 |
| POST | `/api/conversations/:id/status` | `{ "status": "open" \| "closed" }` |
| GET | `/api/media/:key` | R2 媒體 |

## 指令

```bash
npm run dev       # 本機開發
npm test          # Vitest
npm run check     # tsc + wrangler deploy --dry-run
npm run lint
npm run deploy
```

## 已知限制

- 客服台目前是單一共用密鑰，沒有個別帳號與權限；多人使用建議改接 Cloudflare Access 或自建帳號。
- 目前只能回覆純文字；LINE 的圖片／貼圖／Flex Message 發送可在 `worker/line.ts` 的 `push()` 擴充。
- Teams 尚未實作（schema 與渠道層已預留）。
