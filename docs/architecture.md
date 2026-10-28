# 架構與設計

本文說明客服收發台「為什麼長這樣」：系統邊界、技術選型的理由、模組分層，以及貫穿整個程式碼的設計原則。
「怎麼部署、API 有哪些」見 [README](../README.md)；「改程式時必須遵守的規則」見 [CLAUDE.md](../CLAUDE.md)；「介面做什麼應該看到什麼」見 [acceptance.md](acceptance.md)。

## 一、系統定位

- **使用者**：客服人員。他們把客服台當成基礎設施，不符預期就是「壞掉」。介面只回答「現在怎麼了、我要做什麼」。
- **另一端**：LINE 官方帳號的使用者（一對一聊天、群組、多人聊天室）。LINE 手機端看到的樣子，就是客服對畫面的預期。
- **工程端**：負責判讀缺口與客服回報（`npm run reports`），不透過客服台。
- **渠道**：目前只有 LINE。`conversations.channel` 與渠道層已為 Teams 預留，客服台與資料層不需要知道渠道細節。

## 二、整體架構

```
                        ┌──────────── 單一 Worker（workflows-starter-template）────────────┐
LINE 平台 ─POST /webhook/line─▶ 驗簽 ─┬─ queue 模式 ─▶ Queues ─▶ queue() ─┐                 │
                        │            └─ inline 模式 ──────────────────────┴▶ 事件處理        │
                        │                                         │   ├▶ D1（唯一真實來源）│
                        │                                         │   ├▶ R2（附件）        │
                        │                                         │   ├▶ Workflow（逾時提醒）
                        │                                         │   └▶ InboxDO.broadcast │
客服台（React）◀─WebSocket── InboxDO（全站一個，hibernation）◀──────┘                     │
客服台 ─/api/*─▶ 路由 ─▶ outbox ─▶ D1（pending）─▶ LINE Push（X-Line-Retry-Key）          │
cron 每 5 分鐘 ─▶ scheduled() ─▶ runMaintenance：補推、補抓附件、刷新官方帳號設定        │
DLQ ─▶ queue() ─▶ 缺口紀錄 event_dead_lettered                                         │
                        └──────────────────── 指標 ─▶ Analytics Engine ─────────────────┘
```

同一個 Worker 同時提供：靜態前端（assets，`run_worker_first` 只讓 `/api/*`、`/webhook/*`、`/ws` 進 Worker）、客服台 API、LINE webhook、Queues consumer、cron、Workflow 與 Durable Object 類別。一個部署單位、一份設定，沒有服務之間的版本相依。

## 三、技術選型

| 元件 | 用途 | 為什麼選它 | 代價／替代方案 |
| --- | --- | --- | --- |
| Workers | 全部的執行環境 | webhook 需要全年無休、冷啟動短；與下列儲存服務同一平台，免管主機 | 單次請求 CPU 時間有限，重工作要拆到 Queues／waitUntil |
| D1 | 對話、訊息、互動訊息結果、缺口、匯入、通知紀錄 | SQL 適合「清單＋分頁＋搜尋＋統計」；`batch` 可一次往返完成「寫＋回讀」 | 單一主庫，寫入吞吐有上限；以 Smart Placement 讓 Worker 靠近 D1 |
| R2 | 使用者傳來的圖片／影片／語音／檔案 | LINE 只保留內容一段時間，必須自己留存；無流出費用 | 下載失敗要自己重試與判定過期（`worker/media.ts`） |
| Durable Objects | `InboxDO`：WebSocket 廣播與「誰正在看」 | 需要一個能持有所有連線的單點；hibernation 讓閒置連線不計費，`setWebSocketAutoResponse` 讓心跳不喚醒 DO | 全站只有一個實例。客服人數是個位數到數十人，單點足夠；**不為每個對話建 DO** |
| Workflows | `ReplyReminderWorkflow`：逾時未回覆提醒 | 「等 N 分鐘，期間若收到事件就結束」正是 `step.waitForEvent` 的語意，不用自己做排程表 | 每個對話同時最多一個實例（`conversations` 存實例 id），實例數與訊息數無關 |
| Queues | webhook 削峰與重試；DLQ 收放棄的事件 | 驗簽後立即回 200，LINE 不會因逾時重送；失敗自動重試 3 次 | 只在 Workers Paid 提供。免費方案由 bootstrap 改為 inline，程式以 `env.LINE_EVENTS` 是否存在再保險一次 |
| Cron Triggers | `runMaintenance` 每 5 分鐘 | 補推、補抓、刷新設定都是「最終一致」的工作，不需要即時 | 最長 5 分鐘的修復延遲 |
| Analytics Engine | 耗時、錯誤率等指標 | 寫入不阻塞請求、可用 SQL 查 | 需在 dashboard 啟用一次；未啟用時 binding 缺席，`env.METRICS?.` 容忍 |
| Smart Placement | Worker 搬到 D1 附近執行 | 一次請求常做多次查詢，省掉跨區往返 | 無 |
| React 19 + Vite + Tailwind 4 | 客服台 | `@cloudflare/vite-plugin` 讓前端與 Worker 同一個建置流程 | 無 UI 套件，元件自寫以維持一致的字級與間距 |
| Vitest + `@cloudflare/vitest-pool-workers` | 測試 | 測試跑在 workerd 內，D1／DO／Workflow 都是真的 binding，migration 照套 | 此版本沒有 `fetchMock`，LINE API 以 `vi.stubGlobal("fetch")` 攔截 |
| GitHub → Workers Builds | 部署 | push 到 `main` 即部署；密鑰只存在 dashboard，不經過開發者或 Claude 的電腦 | `scripts/bootstrap.sh` 負責建資源與套 schema，必須冪等 |

## 四、模組分層

```
worker/index.ts            路由：參數檢查、呼叫下層、組 HTTP 回應（不寫 SQL）
   │
   ├─ webhook-line.ts      LINE 事件 → 領域操作（渠道層，入站）
   ├─ outbox.ts            客服發訊唯一入口（出站）
   ├─ integrity.ts         缺口紀錄、健康狀態、排程維護
   ├─ media.ts / import-csv.ts / pnp.ts   各自一件事
   ├─ workflow.ts / inbox-do.ts           Cloudflare 執行期類別
   │
   ├─ line.ts              LINE API client、簽章、事件型別、postback 改寫（渠道層，無狀態）
   ├─ line-env.ts          lineClientFor(env)：打破 webhook / outbox / integrity 的循環引用
   ├─ db.ts                所有 SQL
   └─ metrics.ts           指標；寫入失敗一律吞掉

shared/types.ts            前後端契約（API 回傳、WebSocket 事件）

src/api.ts                 前端唯一打 API 的地方
src/route.ts               畫面狀態 ⇄ 網址
src/builder/               互動訊息的草稿模型、LINE 上限、草稿→LINE JSON（純函式）
src/components/            呈現層
```

邊界規則：

- **SQL 只在 `db.ts`**。其他模組只呼叫具名函式（`insertMessage`、`markConversationRead`…）。寫入路徑維持「寫＋回讀」同一個 `db.batch`。
- **出站只有一條路**：所有客服訊息經 `sendOutbound`，不在別處呼叫 `client.push`。
- **渠道細節不外漏**：`line.ts` 只懂 LINE；資料層只看到 `channel` 欄位。新增渠道是新增 `worker/<channel>.ts` 與 `worker/webhook-<channel>.ts`，不是在既有檔案加分支。
- **契約先行**：API 或事件格式改動先改 `shared/types.ts`，前後端同時被型別檢查（`tsc -b` 涵蓋 worker 與 client 兩個專案）。
- **前端狀態歸位**：打 API 只在 `src/api.ts`；「現在在哪個畫面」只在 `src/route.ts`（網址），不另開 `useState`。

## 五、主要資料流

### 收訊

1. `POST /webhook/line` 驗 `X-Line-Signature`，失敗一律 401。
2. queue 模式丟進 Queues 立即回 200；inline 模式同步處理，單一事件失敗不影響其他事件。
3. 事件處理以 `external_id`（LINE message id，唯一索引）與 `webhookEventId` 去重；LINE 的重送（`isRedelivery`）記一筆以小時為桶的缺口。
4. 訊息、對話更新、回讀在同一個 `batch` 完成；重送不會重複累加未讀。
5. 附件交給 `waitUntil` 下載到 R2；使用者訊息啟動逾時提醒（同對話已有執行中的實例就不再建立）。
6. `InboxDO.broadcast` 推 `message.new` 給所有在線客服。

### 發訊（outbox）

```
寫 D1（pending, retry_key）──▶ 廣播 ──▶ 推 LINE（X-Line-Retry-Key）
                                         ├ 2xx ─▶ sent（存 sentMessages id，供之後引用）
                                         ├ 4xx ─▶ failed（客服可按重新發送）
                                         └ 5xx／429／網路 ─▶ 留 pending ─▶ cron 以同一把 key 重推
                                                                 ├ LINE 回 409 ─▶ 視為已送達
                                                                 └ 超過 24 小時 ─▶ unknown ＋ 缺口
```

- 前端每次發送產生 `clientKey`（UUID），即為 retry key；連點或逾時重送時直接回傳既有訊息，不會推第二次。
- `detectConflict` 在寫入前檢查：對話由別人接手中，或在客服最後看到的訊息之後已有其他客服回覆 → 409，客服確認後帶 `force` 重送。

### 互動訊息

- 編輯台（`src/builder/`）只產生五種受控版型：text、confirm、buttons、carousel、固定版面的 Flex 資訊卡。`limits.ts` 是 LINE 上限的唯一來源，`toLine.ts` 的輸出必定合法。JSON 模式留給進階使用者，最終由 LINE API 驗證。
- 送出時 `instrumentPostbacks` 把每個 postback 改寫成 `prompt=<id>&choice=<原值>`；有 postback 才建 `prompts` 紀錄。
- 使用者點選後回到 webhook 的 `handlePostback`：每次都寫 `prompt_responses`，但只有第一次（或 `allow_change = 1`）更新結果；LINE 的按鈕永遠可按，這是在資料層定義的規則。

### 逾時提醒

使用者傳訊 → 建立 Workflow（每個對話最多一個）→ `waitForEvent("agent-replied", REPLY_SLA_MINUTES)`。客服回覆時送事件結束；逾時則把對話標成需要處理並廣播。

### 排程維護（cron 每 5 分鐘）

補推 pending 超過 1 分鐘的客服訊息、補抓未完成的附件（重試到 5 次，404/410 判定過期）、刷新官方帳號設定（`chatMode`／`markAsReadMode`）。也可用 `POST /api/integrity/maintenance` 立即執行。

## 六、設計原則

1. **資料忠實，呈現還原。** D1 存 LINE 給的原始形狀（一張圖一個事件、貼圖只有 id、emoji 是佔位字元、引用與撤回存在 `metadata`）。還原成 LINE 手機端的樣子（圖集收斂成格子泡泡、貼圖顯示圖片）是前端呈現層的工作，不改資料模型。資料拿不到的（對方是否已讀、組合貼圖內容、串接前的引用原文）明確標示，不假裝。
2. **沒有證據就不宣稱完整，但缺口是工程端的事。** 已知的缺口（引用找不到原文、附件過期、發送結果不明、LINE 重送、事件放棄、Chat 設定）都寫進 `integrity_events`，以 `dedupe_key` 合併計數。客服台不顯示這些；客服唯一的入口是泡泡旁的驚嘆號，按一下即可，上下文由伺服器收齊。
3. **每一步都可以重做。** webhook 事件、Queues 重試、客服連點、cron 重推、CSV 重複匯入，全部以識別碼去重（`external_id`、`webhookEventId`、`retry_key`、`csv:<hash>`、`delivery_tag`）。先寫再送：任何時刻中斷，狀態都能從 D1 判讀並由排程補完。
4. **單一入口。** 同一件事只有一個地方做：SQL 在 `db.ts`、發訊在 `outbox.ts`、打 API 在 `src/api.ts`、畫面狀態在 `src/route.ts`、LINE 上限在 `src/builder/limits.ts`。找得到、改一處就全部生效。
5. **受控勝過自由。** 互動訊息不開放自由 Flex，只給五種一定合法的版型；新版型要同時補型別、轉換、表單與測試。客服不必懂 LINE 的規格。
6. **成本只與訊息數線性相關。** 一個 DO、每個對話最多一個 Workflow、對話清單游標分頁加虛擬捲動、統計由 `/api/stats` 查 D1。對話開多久、客服台開多久都不額外計費。
7. **容忍缺席的基礎設施。** Queues、Analytics Engine 不一定存在：bootstrap 會降級部署，程式以 binding 是否存在判斷。指標寫入失敗一律吞掉，不影響主流程。
8. **協作資訊不是身分。** 單一共用 `CONSOLE_TOKEN`；客服名稱由前端以 `X-Agent-Name` 自報，只用於接手、在看、衝突偵測與署名。
9. **不把內部狀態做成介面。** queue 模式、`markAsReadMode`、cron、retry key 都不出現在客服台。顏色只表達狀態（紅＝需要處理、琥珀＝注意、綠＝正常）。完整的介面原則見 CLAUDE.md「介面設計原則」。

## 七、資料模型

| 資料表 | 內容 | 重點欄位 |
| --- | --- | --- |
| `conversations` | 一個 LINE 使用者／群組／聊天室一列 | `channel`、`status`、`unread_count`、`needs_attention`、`assigned_to`、`mark_as_read_token`、`reminder_instance_id` |
| `messages` | 雙向訊息 | `external_id`（唯一）、`source`、`delivery_status`、`retry_key`（唯一）、`media_status`、`edited_at`、`unsent_at`、`metadata`（引用、圖集、payload） |
| `prompts` / `prompt_responses` | 含 postback 的互動訊息與每一次點選 | `allow_change`、`payload` |
| `integrity_events` | 缺口與客服回報 | `kind`、`dedupe_key`（唯一）、`status`、`details`（重複發生時累加 `$.count`） |
| `system_state` | 系統狀態鍵值（最後收到 webhook 的時間、官方帳號資訊快取、上次維護時間） | `key`、`value` |
| `import_batches` / `import_rows` | 官方後台 CSV 匯入批次與未配對列 | `status` |
| `notifications` | 通知型訊息（PNP） | 電話只存 SHA-256 與遮罩、`delivery_tag`（唯一） |

Schema 變更一律新開 `migrations/000N_*.sql`，不改舊檔。

## 八、尚未在正式環境驗證的假設

- `messageEdited` 的事件結構與 `markAsReadToken` 的位置依文件實作，第一次收到時以 `npx wrangler tail` 核對。
- PNP 的 `to` 雜湊是否含 `+`、回應格式。
- 官方後台 CSV 的實際欄位名稱（目前以關鍵字偵測，偵測不到時由前端指定）。
