# 客服收發台（LINE）

以 Cloudflare Workers 建置的 LINE 官方帳號客服訊息收發台：

- **收訊**：LINE Messaging API webhook → 驗簽章 → 存入 D1 → 透過 Durable Object 以 WebSocket 即時推到客服台
- **發訊**：客服在網頁上回覆 → LINE Push API → 存入 D1 → 廣播給其他在線客服
- **媒體**：使用者傳的圖片／影片／語音／檔案背景下載到 R2，客服台直接顯示
- **逾時提醒**：Cloudflare Workflows 監看每個對話，客服超過 `REPLY_SLA_MINUTES` 未回覆就標記「逾時」並推播
- **互動訊息編輯台**：不用懂 JSON，用表單組合「文字／是否確認／按鈕卡／輪播卡／資訊卡（Flex）」與快速回覆小圓鈕，每個欄位都內建 LINE 的字數與數量上限，送出前自動檢查；範本在 `src/builder/presets.ts`。進階使用者可切到 JSON 模式直接改（範例在 `src/presets.ts`）。所有 postback 按鈕送出時會自動加上追蹤 id，使用者點選後以 postback 回到 webhook，結果寫入 D1 的 `prompts` 與 `prompt_responses`，客服台即時顯示並可匯出 CSV
- **自動歡迎**：使用者加好友時用 reply token 送 `WELCOME_MESSAGE`
- **群組／多人聊天室**：以群組為對話單位，訊息會標示發言者（名稱拿不到時保留 userId）
- **對話完整性**：引用訊息（`quotedMessageId`）快照與「原文無法取得」標示、撤回（`unsend`）、群組編輯（`messageEdited`）、圖集（`imageSet`）、LINE 重送標記；客服打開對話時呼叫 `markAsRead`（需官方帳號 Chat 開啟）
- **發訊 outbox**：客服訊息先寫 D1 再帶 `X-Line-Retry-Key` 推送；送出中／失敗／結果不明都看得到，排程自動補推，失敗可重試；同一把 `clientKey` 重送不會重複推給 LINE
- **完整性中心**：缺口紀錄（引用找不到原文、附件過期、發送失敗、LINE 重送、事件處理放棄、Chat 模式、客服回報、匯入）、同步健康狀態、「回報缺失」；排程（cron 每 5 分鐘）補推、補抓附件、刷新官方帳號設定
- **歷史匯入**：LINE 官方帳號管理後台的聊天紀錄 CSV，自動偵測欄位、以名稱配對對話、重複匯入冪等、配不到的列人工指派；匯入的訊息標示「匯入紀錄」
- **通知型訊息（PNP）**：以電話號碼發送（需向 LINE 申請開通），中央發送紀錄 + `X-Line-Delivery-Tag` 對應 `delivery` 事件
- **多客服協作**：客服名稱、接手／交還、誰正在看同一個對話、回覆衝突偵測（別人接手中或在你之後已回覆 → 409，可確認後強制送出）

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
| `worker/outbox.ts` | 客服發訊 outbox：retry key、送達狀態、衝突偵測 |
| `worker/integrity.ts` | 缺口紀錄、健康狀態、排程維護 |
| `worker/media.ts` | 附件下載與重試、過期判定 |
| `worker/import-csv.ts` | 官方後台 CSV 匯入 |
| `worker/pnp.ts` | 通知型訊息發送紀錄與送達事件 |
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
   | Project name | `workflows-starter-template`（必須與 `wrangler.jsonc` 的 `name` 一致） |
   | Production branch | `main` |
   | Build command | `npm run build` |
   | Deploy command | `npm run deploy`（預設值即可，會呼叫 `scripts/bootstrap.sh`） |
3. 按 Save and Deploy。`scripts/bootstrap.sh` 會自動建立 D1（`cs-console-db`）、R2（`cs-console-media`）與 Queues（`cs-console-line-events`、`cs-console-line-events-dlq`，需 Workers Paid；建不出來會自動改 inline 模式）、套用 schema、部署；若建置環境無權建立資源，先在 dashboard 手動建好同名資源再重跑。`wrangler.jsonc` 的 `triggers.crons` 會註冊每 5 分鐘的排程維護，DLQ 也有 consumer（失敗事件記成缺口）。
4. 部署完成後到 **該 Worker → Settings → Variables and Secrets**，新增三個 Secret：`LINE_CHANNEL_SECRET`、`LINE_CHANNEL_ACCESS_TOKEN`、`CONSOLE_TOKEN`。

之後每次 push 到 `main` 都會自動建置部署。

手動部署（替代方案）：`npx wrangler login` 後執行 `npm run deploy`。

接著到 LINE Developers Console：

1. **Messaging API → Webhook URL** 填 `https://<你的 worker 網址>/webhook/line`，按 Verify，開啟 **Use webhook**
2. 關閉 **Auto-reply messages**（否則 LINE 會用官方帳號的罐頭訊息搶先回覆）
3. 要讓使用者看到「已讀」，官方帳號管理後台的 **Chat（聊天）必須開啟**；客服台「完整性」頁會顯示目前的 `chatMode` / `markAsReadMode`
4. 通知型訊息（PNP）需另外向 LINE 申請；未開通時發送會失敗並顯示原因
3. 關閉 **Greeting message**（由本系統的 `WELCOME_MESSAGE` 取代；想用 LINE 內建的就把 `WELCOME_MESSAGE` 留空）

打開 worker 網址，用 `CONSOLE_TOKEN` 登入即可。

## API

所有 `/api/*` 與 `/ws` 需要 `Authorization: Bearer <CONSOLE_TOKEN>`（WebSocket 用 `?token=`）。

| 方法 | 路徑 | 說明 |
| --- | --- | --- |
| POST | `/webhook/line` | LINE 平台呼叫（X-Line-Signature 驗證） |
| GET | `/ws` | 即時事件：`message.new`、`conversation.updated` |
| GET | `/api/me` | 驗證 token |
| GET | `/api/conversations?status=open\|closed\|all&before=<ts>&q=<關鍵字>&limit=50` | 對話清單（游標分頁、搜尋名稱或 ID） |
| GET | `/api/stats` | 未讀總數、進行中數、逾時數 |
| GET | `/api/conversations/:id/messages?before=&limit=` | 訊息（舊→新） |
| POST | `/api/conversations/:id/reply` | `{ "text": "..." }` |
| POST | `/api/conversations/:id/send` | `{ "messages": [LINE 訊息…], "templateKey"?, "allowChange"? }` 直接送訊息陣列（最多 5 則），postback 自動追蹤；`allowChange` 預設 false，使用者重複按只留紀錄不改結果 |
| POST | `/api/conversations/:id/prompt` | `{ "body"?, "question", "options": [{label,value}] }` 舊介面：正文 + Confirm 是／否 |
| GET | `/api/prompts?status=all\|pending\|answered&conversationId=` | 可追蹤訊息與使用者的選擇 |
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

## 規模與效能

- **webhook 削峰**：預設 `WEBHOOK_MODE=queue`，驗完簽章就把事件丟進 Cloudflare Queues 立即回 200，由同一個 Worker 的 `queue()` 消費，失敗自動重試 3 次後進 dead letter queue。Queues 需要 Workers Paid；免費方案下 `scripts/bootstrap.sh` 建不出 queue 時會自動從部署設定移除並改走 `inline`（同步處理），功能不變。
- **Smart Placement**：`wrangler.jsonc` 開了 `placement.mode = smart`，Worker 會搬到 D1 所在地區執行，一次請求做多次查詢時省掉跨區往返。
- **D1 單次往返**：寫訊息、更新對話、回讀結果合併成一次 `batch`，LINE 重送時以 SQL 條件避免重複累加未讀。
- **WebSocket ping**：Durable Object 用 `setWebSocketAutoResponse` 讓平台直接回 pong，前端心跳不會喚醒 DO。

- 對話清單用虛擬捲動，只渲染畫面上看得到的列，捲到底才向後端要下一頁（每頁 50 筆，記憶體最多保留 1000 筆）。對話總數再多也不影響畫面流暢度。
- 未讀總數與逾時數由後端 `/api/stats` 一次算出，不靠前端加總。
- 成本只與訊息數線性相關：每則訊息約 3 次 D1 寫入；Durable Object 只有一個且閒置休眠；逾時提醒 Workflow 每個對話同時最多一個實例，客服回覆或逾時即結束。對話開著多久都不會額外計費。

## 壓測與驗證

`scripts/loadtest.mjs` 對正式環境的 webhook 發出 N 則合法簽章的假事件，量測回應時間、吞吐、入庫完成時間與 `cf-placement` 標頭：

```bash
LINE_CHANNEL_SECRET=<channel secret> CONSOLE_TOKEN=<token> \
  npm run loadtest -- --url https://<worker 網址> --count 200 --concurrency 20
```

密鑰只從環境變數讀取。結束時會印出清理這次測試資料的 `wrangler d1 execute` 指令。

## 監控

所有指標寫進 Analytics Engine 資料集 `cs_console_metrics`（dashboard → Analytics & Logs → Analytics Engine，或用 SQL API 接 Grafana）。欄位：`blob1` 指標名、`blob2…` 標籤、`double1…` 數值。

| 指標 | 標籤 | 數值 |
| --- | --- | --- |
| `http.request` | 路由、方法、狀態碼 | 耗時 ms |
| `webhook.received` | queue 或 inline | 事件數 |
| `line.event` | 事件類型、ok 或 error | 處理耗時 ms |
| `line.api` | endpoint（profile、push、reply、content…）、HTTP 狀態 | 耗時 ms |
| `queue.consume` | ok 或 retry | 耗時 ms、第幾次嘗試、排隊等待 ms |

範例：過去一天各 LINE API 的錯誤率與平均耗時

```sql
SELECT blob2 AS endpoint, blob3 AS status, count() AS calls, avg(double1) AS avg_ms
FROM cs_console_metrics
WHERE blob1 = 'line.api' AND timestamp > NOW() - INTERVAL '1' DAY
GROUP BY endpoint, status ORDER BY calls DESC
```

## 已知限制

- 客服台目前是單一共用密鑰，沒有個別帳號與權限；多人使用建議改接 Cloudflare Access 或自建帳號。
- 一般回覆只能純文字；LINE 的圖片／貼圖／Flex Message 發送可在 `worker/line.ts` 的 `push()` 擴充。
- LINE 的按鈕訊息會永遠留在聊天室且可反覆按，LINE 沒有「按過即失效」的機制；本系統預設第一次回覆為準，之後再按只寫入 `prompt_responses` 並回覆提示。送出時勾「允許使用者更改回覆」則改為取最後一次。
- 互動訊息的 JSON 由 LINE API 做最終驗證，格式錯誤會以 502 把 LINE 的錯誤訊息回到客服台；客服台的預覽是近似呈現，精確版面請用 LINE Flex Message Simulator。
- Teams 尚未實作（schema 與渠道層已預留）。
