# 客服收發台（LINE）

以 Cloudflare Workers 建置的 LINE 官方帳號客服訊息收發台。客服在網頁上即時收發一對一、群組與多人聊天室的訊息；所有資料存在自己的 Cloudflare 帳號。

- 技術棧：Cloudflare Workers + D1 + R2 + Durable Objects + Workflows + Queues + Analytics Engine，前端 React 19 + Vite + Tailwind 4。
- 架構、技術選型與設計原則：[docs/architecture.md](docs/architecture.md)
- 介面驗收清單（做什麼 → 應該看到什麼）：[docs/acceptance.md](docs/acceptance.md)
- 開發規則（給維護者與 Claude）：[CLAUDE.md](CLAUDE.md)

## 功能

**客服的日常**

- **即時收發**：使用者訊息 3 秒內出現在客服台；客服回覆以 LINE Push API 送出，同時廣播給其他在線客服。
- **送達狀態**：每則客服訊息都標示發送中／已發送／發送失敗；失敗可重新發送，網路中斷時由排程自動補送，不會重複送達。
- **引用、撤回、編輯、圖集**：與 LINE 手機端相同的呈現；取不到的資料（例如串接前的引用原文）明確標示。
- **已讀**：客服打開對話時通知 LINE 已讀（需官方帳號 Chat 開啟）。
- **逾時提醒**：超過 `REPLY_SLA_MINUTES` 未回覆的對話標記為需要處理，並推給所有在線客服。
- **多客服協作**：接手／交還、誰正在看同一個對話、回覆衝突提醒（別人接手中或在您之後已回覆）。
- **異常回報**：覺得某則訊息有問題，按泡泡旁的驚嘆號即可；上下文由系統自動收齊，交給工程端處理。
- **自動歡迎**：加好友時以 reply token 送出 `WELCOME_MESSAGE`。

**進階功能**

- **互動訊息編輯台**：以表單組合文字／確認／按鈕卡／輪播卡／資訊卡（Flex）與快速回覆，欄位內建 LINE 的字數與數量上限。使用者點選的結果即時顯示並可匯出 CSV。進階使用者可切到 JSON 模式。
- **歷史匯入**：LINE 官方帳號管理後台的聊天紀錄 CSV；自動偵測欄位、以名稱配對對話、重複匯入不會產生重複訊息，配不到的列人工指派。
- **通知型訊息（PNP）**：以電話號碼發送（需向 LINE 申請開通）；電話只存雜湊與遮罩。

**介面**：視窗寬度 1024px 以上是電腦模式（像 macOS「訊息」，鍵盤優先），以下是手機模式（像 LINE，一次一個畫面）。

## 正式部署（GitHub → Cloudflare Workers Builds）

不需要本機登入、不需要 API token，全部在 Cloudflare dashboard 完成。

1. **Workers & Pages → Create → Import a repository**，授權 GitHub 並選擇本 repo。
2. 設定：
   | 欄位 | 值 |
   | --- | --- |
   | Project name | `workflows-starter-template`（必須與 `wrangler.jsonc` 的 `name` 一致） |
   | Production branch | `main` |
   | Build command | `npm run build` |
   | Deploy command | `npm run deploy`（會呼叫 `scripts/bootstrap.sh`） |
3. 按 Save and Deploy。`scripts/bootstrap.sh` 會依序：
   - 建立 D1（`cs-console-db`）並把 `database_id` 寫入設定；
   - 建立 R2（`cs-console-media`）；
   - 建立 Queues（`cs-console-line-events`、`cs-console-line-events-dlq`）。需 Workers Paid，建不出來時自動改為 inline 模式部署；
   - 套用 `migrations/`；
   - `wrangler deploy`。帳號未啟用 Analytics Engine 時，自動改以不帶 `METRICS` 的設定重試。

   建置環境無權建立資源時，先在 dashboard 手動建好同名資源再重跑。`triggers.crons` 會註冊每 5 分鐘的排程維護。
4. 到 **該 Worker → Settings → Variables and Secrets** 新增三個 Secret（見下方「密鑰與設定」）。

之後每次 push 到 `main` 都會自動建置部署。替代方案：`npx wrangler login` 後在本機執行 `npm run deploy`。

### LINE Developers Console

1. **Messaging API → Webhook URL** 填 `https://<worker 網址>/webhook/line`，按 Verify，開啟 **Use webhook**。
2. 關閉 **Auto-reply messages**（否則官方帳號的自動回應會搶先回覆）。
3. 關閉 **Greeting message**（由 `WELCOME_MESSAGE` 取代；要用 LINE 內建的就把 `WELCOME_MESSAGE` 留空）。
4. 要讓使用者看到「已讀」，官方帳號管理後台的 **Chat（聊天）必須開啟**。目前的 `chatMode`／`markAsReadMode` 可由 `GET /api/integrity/health` 的 `botInfo` 確認（每 5 分鐘刷新）。
5. 通知型訊息（PNP）需另外向 LINE 申請；未開通時發送會失敗並顯示原因。

打開 worker 網址，輸入客服名稱與 `CONSOLE_TOKEN` 登入。

## 密鑰與設定

| 名稱 | 用途 | 取得方式 |
| --- | --- | --- |
| `LINE_CHANNEL_SECRET` | 驗證 webhook 簽章 | LINE Developers Console → Messaging API channel → **Basic settings → Channel secret** |
| `LINE_CHANNEL_ACCESS_TOKEN` | 呼叫 LINE API | 同上 → **Messaging API → Channel access token (long-lived)** → Issue |
| `CONSOLE_TOKEN` | 客服台登入密鑰（所有客服共用） | 自行產生，例如 `openssl rand -hex 24` |

密鑰只在 Cloudflare dashboard 輸入，不寫進任何設定檔。非機密設定在 `wrangler.jsonc` 的 `vars`：

| 名稱 | 預設 | 說明 |
| --- | --- | --- |
| `REPLY_SLA_MINUTES` | `10` | 多久未回覆視為逾時 |
| `WELCOME_MESSAGE` | 一段歡迎詞 | 加好友時自動送出；留空則不送 |
| `WEBHOOK_MODE` | `queue` | `queue`＝驗簽後入列立即回 200；`inline`＝同步處理。免費方案由 bootstrap 自動改為 `inline` |

## 指令

```bash
npm run check     # tsc -b（worker 與前端）+ wrangler deploy --dry-run
npm test          # Vitest，跑在 workerd 內（含 D1 migration）
npm run lint
npm run dev       # 本機只看 UI 排版：http://localhost:5173
npm run deploy    # build + scripts/bootstrap.sh（Workers Builds 會自動執行）
npm run reports   # 工程端：讀取／結案客服回報與缺口紀錄（直接讀正式 D1，需 wrangler login）
npm run loadtest  # 對正式環境 webhook 壓測（見下方）
npm run cf-typegen  # 改過 wrangler.jsonc 的 binding 後重新產生 worker-configuration.d.ts
```

功能一律在正式環境以真實 LINE 帳號驗證。本機 `npm run dev` 前需 `npm run db:migrate:local`；若真要在本機跑 LINE 流程，需自行建立 `.dev.vars`（參考 `.dev.vars.example`）並以 `cloudflared tunnel` 取得公開網址。

## 工程端：回報與缺口

客服按驚嘆號的回報，以及系統自己偵測到的缺口（引用找不到原文、附件逾期、發送失敗或結果不明、LINE 重送、事件處理中止、Chat 設定）都記在 D1 的 `integrity_events`，同一件事以 `dedupe_key` 合併計數。客服台不顯示這些。

```bash
npm run reports                          # 未處理的回報與缺口（含上下文）
npm run reports -- --all                 # 含已處理
npm run reports -- --kind agent_report   # 只看某一類
npm run reports -- --resolve <id> "處理說明"
```

不想登入 Cloudflare 時，同樣的健檢與修復可用 `CONSOLE_TOKEN` 呼叫 `/api/integrity/*`（見下方 API）。

## API

所有 `/api/*` 與 `/ws` 需要 `Authorization: Bearer <CONSOLE_TOKEN>`（WebSocket 用 `?token=`）。前端另以 `X-Agent-Name`（URI 編碼）帶客服名稱，只用於協作顯示，不是身分驗證。完整型別見 `shared/types.ts`。

**收發與對話**

| 方法 | 路徑 | 說明 |
| --- | --- | --- |
| POST | `/webhook/line` | LINE 平台呼叫（`X-Line-Signature` 驗證） |
| GET | `/ws` | 即時事件：`message.new`、`conversation.updated`、`prompt.updated`、`presence.updated`、`notification.updated`；客服台送 `{ type: "view" }` 回報正在看的對話 |
| GET | `/api/me` | 驗證 token |
| GET | `/api/conversations?status=open\|closed\|all&before=<ts>&q=&limit=50` | 對話清單（游標分頁、搜尋名稱或 ID） |
| GET | `/api/stats` | 未讀總數、進行中數、逾時數 |
| GET | `/api/conversations/:id/messages?before=&limit=` | 訊息（舊→新） |
| POST | `/api/conversations/:id/reply` | `{ text, clientKey?, lastSeenMessageId?, force?, quoteMessageId? }`；衝突回 409、LINE 拒絕回 502 |
| POST | `/api/conversations/:id/send` | `{ messages: [LINE 訊息…], templateKey?, allowChange?, clientKey?, … }` 最多 5 則，postback 自動追蹤 |
| POST | `/api/conversations/:id/read` | 清除未讀並通知 LINE 已讀 |
| POST | `/api/conversations/:id/status` | `{ status: "open" \| "closed" }` |
| POST | `/api/conversations/:id/assign`、`/release` | 接手（`{ agent? }`）／交還 |
| GET | `/api/conversations/:id/presence` | 正在看此對話的客服 |
| POST | `/api/messages/:id/retry` | 重新發送失敗或結果不明的客服訊息 |
| POST | `/api/messages/:id/report` | 回報異常（`{ note? }` 選填），伺服器自動收齊上下文 |
| GET | `/api/prompts?status=all\|pending\|answered&conversationId=` | 互動訊息與使用者的選擇 |
| GET | `/api/media/:key` | R2 附件 |

**匯入、通知、工程端健檢與修復**

| 方法 | 路徑 | 說明 |
| --- | --- | --- |
| POST | `/api/imports/preview` | CSV 欄位偵測與配對預覽 `{ csv, mapping? }` |
| POST／GET | `/api/imports` | 執行匯入／歷史批次 |
| GET | `/api/imports/:id/rows` | 未配對的列（依名稱分組） |
| POST | `/api/imports/:id/assign`、`/skip` | 指派到對話／略過 |
| GET／POST | `/api/notifications` | 通知型訊息紀錄／發送 |
| POST | `/api/notifications/:id/retry` | 重新發送 |
| GET | `/api/integrity/health` | 同步健康狀態快照：webhook 模式與最後收到時間、待送／失敗訊息數、附件狀態、未處理缺口數、官方帳號 Chat 設定 |
| GET | `/api/integrity/events?status=&kind=` | 缺口與回報紀錄 |
| POST | `/api/integrity/events/:id/resolve` | 結案 |
| POST | `/api/integrity/maintenance` | 立即執行排程維護（補推、補抓附件、刷新官方帳號設定） |

## 規模與效能

- **webhook 削峰**：queue 模式驗完簽章即入列回 200，由同一個 Worker 的 `queue()` 消費；失敗重試 3 次後進 DLQ，DLQ consumer 把原始事件記成缺口。
- **D1 單次往返**：寫訊息、更新對話、回讀結果合併成一次 `batch`；LINE 重送時以 SQL 條件避免重複累加未讀。
- **Smart Placement**：Worker 搬到 D1 所在地區執行。
- **WebSocket**：單一 Durable Object 採 hibernation，`setWebSocketAutoResponse` 讓心跳不喚醒 DO。
- **對話清單**：後端游標分頁（每頁 50 筆）＋前端虛擬捲動（記憶體最多 1000 筆）；統計數字由 `/api/stats` 查 D1。
- **成本**只與訊息數線性相關：每則訊息約 3 次 D1 寫入；逾時提醒 Workflow 每個對話同時最多一個實例。對話開多久都不額外計費。

### 壓測

`scripts/loadtest.mjs` 對正式環境的 webhook 發出 N 則合法簽章的測試事件，量測回應時間、吞吐、入庫完成時間與 `cf-placement` 標頭：

```bash
LINE_CHANNEL_SECRET=<channel secret> CONSOLE_TOKEN=<token> \
  npm run loadtest -- --url https://<worker 網址> --count 200 --concurrency 20
```

密鑰只從環境變數讀取。結束時會印出清理這次測試資料的 `wrangler d1 execute` 指令。

## 監控

指標寫進 Analytics Engine 資料集 `cs_console_metrics`（dashboard → Analytics & Logs → Analytics Engine，或以 SQL API 接 Grafana）。欄位：`blob1` 指標名、`blob2…` 標籤、`double1…` 數值。

| 指標 | 標籤 | 數值 |
| --- | --- | --- |
| `http.request` | 路由、方法、狀態碼 | 耗時 ms |
| `webhook.received` | queue 或 inline | 事件數 |
| `webhook.redelivery` | 事件類型 | 1 |
| `line.event` | 事件類型、ok 或 error | 處理耗時 ms |
| `line.api` | endpoint（profile、push、reply、content…）、HTTP 狀態 | 耗時 ms |
| `queue.consume` | ok 或 retry | 耗時 ms、第幾次嘗試、排隊等待 ms |
| `queue.dead_letter` | 事件類型 | 1 |
| `integrity.event` | 缺口類型、嚴重度 | 1 |
| `maintenance.run` | ok | 耗時 ms、補推則數、補抓附件數 |

範例：過去一天各 LINE API 的錯誤率與平均耗時

```sql
SELECT blob2 AS endpoint, blob3 AS status, count() AS calls, avg(double1) AS avg_ms
FROM cs_console_metrics
WHERE blob1 = 'line.api' AND timestamp > NOW() - INTERVAL '1' DAY
GROUP BY endpoint, status ORDER BY calls DESC
```

日誌：`npx wrangler tail`；查資料：`npx wrangler d1 execute DB --remote --command "..."`。

## 已知限制

- 客服台為單一共用密鑰，沒有個別帳號與權限；需要時建議改接 Cloudflare Access。
- 一般回覆只能純文字（可帶引用）；Flex 等互動訊息走編輯台，圖片只能在 JSON 模式以公開網址送出，客服上傳圖片尚未實作。
- LINE 的按鈕永遠留在聊天室且可反覆按。預設以第一次回覆為準，之後再按只留紀錄並回覆提示；送出時勾「允許使用者更改回覆」則取最後一次。
- 客服台的預覽是近似呈現；JSON 模式的訊息由 LINE API 做最終驗證，錯誤以 502 回到客服台。精確版面請用 LINE Flex Message Simulator。
- 與 LINE 手機端的呈現差異逐項追蹤於 [docs/acceptance.md](docs/acceptance.md) 第四節（LINE emoji、@提及、位置縮圖等尚未完成）。
- Teams 尚未實作（schema 與渠道層已預留）。
