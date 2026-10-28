# CLAUDE.md

## 專案定位

LINE 官方帳號客服訊息收發台（原本的 Cloudflare Workflows 範本程式碼已全部移除，只保留工具鏈與 Worker 名稱）。
技術棧：Cloudflare Workers + D1 + R2 + Durable Objects + Workflows + Queues + Analytics Engine，前端 React 19 + Vite + Tailwind 4。
Teams 渠道尚未實作，`conversations.channel` 與渠道層已預留。

文件分工：
- `docs/architecture.md`：架構、技術選型的理由、模組分層、資料流、設計原則。動到分層、資料流或新增 Cloudflare 資源時同步更新。
- `docs/acceptance.md`：介面驗收清單（見下方「介面設計原則」）。
- `README.md`：功能、部署、密鑰、API、指令、監控。新增路由或指標時同步更新。
- 本檔：改程式時必須遵守的規則與已知陷阱。

## 驗證方式（重要）

- 部署走 GitHub → Cloudflare Workers Builds：push 到 `main` 即自動建置（`npm run build`）並執行 `npm run deploy`（內含 `scripts/bootstrap.sh`）（建 D1/R2、寫入 database_id、套 schema、`wrangler deploy`）。
- Claude 的職責是改好程式、通過 `npm run check` 與 `npm test`、commit 並 push 到 `main`；部署與密鑰設定在 Cloudflare dashboard 完成，Claude 不需要也不應登入 Cloudflare。
- `wrangler.jsonc` 的 `database_id` 是 D1 資源識別碼（非密鑰），已寫入正式值；若換帳號或重建資料庫，bootstrap 會自動覆寫（含 dist 內已產生的 wrangler.json）。
- **一切功能都在正式環境部署後直接驗證**，不以本機開發伺服器為驗證依據。
- 改完程式碼的標準流程：`npm run check`（`tsc -b` + dry-run）→ `npm test` → commit 並 push 到 `main`（Workers Builds 自動部署）→ 由使用者以真實 LINE 帳號與客服台操作確認。
- 查正式環境狀況的指令（需使用者本機已 `wrangler login`，由使用者執行或明確授權後執行）：`npx wrangler tail`、`npx wrangler d1 execute DB --remote --command "..."`、`npm run reports`。
- 不要為了驗證而建立假資料的本機流程；本機 `npm run dev` 只用來看 UI 排版。

## 密鑰與設定

- 機密三個：`LINE_CHANNEL_SECRET`、`LINE_CHANNEL_ACCESS_TOKEN`、`CONSOLE_TOKEN`。
  **由使用者自行在 Cloudflare dashboard（Workers & Pages → 該 Worker → Settings → Variables and Secrets）輸入。**
- `wrangler.jsonc` 的 `name` 必須與 dashboard 的 Worker 專案名稱一致（目前 `workflows-starter-template`），否則 Workers Builds 部署會失敗。
  Claude 不執行 `wrangler secret put`、不建立 `.dev.vars`、不把任何密鑰或環境資訊寫進 `wrangler.jsonc` 或其他設定檔。
  `.dev.vars.example` 只是空白範本。
- 非機密設定放 `wrangler.jsonc` 的 `vars`（`REPLY_SLA_MINUTES`、`WELCOME_MESSAGE`、`WEBHOOK_MODE`）。
- 改過 `wrangler.jsonc` 的 binding 後要跑 `npm run cf-typegen` 重新產生 `worker-configuration.d.ts`。
- Secrets 的型別在 `worker/env.d.ts` 手動維護（擴充 `__BaseEnv_Env`）。

## 程式結構

| 路徑 | 職責 |
| --- | --- |
| `worker/index.ts` | 路由與請求編排（`handleReply`、`sendTracked`）、`fetch` / `queue` / `scheduled` 三個進入點；只做參數檢查與呼叫下層，不寫 SQL；LINE 呼叫經 `lineClientFor` 或 `outbox` |
| `worker/auth.ts` | `CONSOLE_TOKEN` 驗證（Bearer 或 WebSocket 的 `?token=`，常數時間比較） |
| `worker/webhook-line.ts` | LINE webhook 事件處理 |
| `worker/line.ts` | LINE API client、簽章驗證、事件型別 |
| `worker/db.ts` | 所有 SQL 集中於此 |
| `worker/inbox-do.ts` | 單一實例 `InboxDO`（名稱固定 `"inbox"`），WebSocket 廣播 |
| `worker/workflow.ts` | `ReplyReminderWorkflow` 逾時提醒 |
| `worker/metrics.ts` | Analytics Engine 指標 `recordMetric`，寫入失敗一律吞掉 |
| `worker/outbox.ts` | 客服發訊唯一入口 `sendOutbound`：先寫 D1（pending）再帶 `X-Line-Retry-Key` 推送；`detectConflict` 做接手／後到回覆的 409 |
| `worker/integrity.ts` | 缺口紀錄 `recordIntegrity`（dedupeKey 合併計數）、健康狀態、`runMaintenance`（cron 每 5 分鐘與 `POST /api/integrity/maintenance`）。**客服台不顯示這些**；工程端用 `npm run reports`（`scripts/reports.mjs`，直接讀正式 D1）每天讀取與結案；只有 token 時用 `/api/integrity/health`（健檢）、`/events`、`/resolve`、`/maintenance`（修復） |
| `worker/media.ts` | 附件下載 `storeMedia`：404/410 → expired 記缺口；其他失敗 → failed 由排程重試到 5 次 |
| `worker/import-csv.ts` | 官方後台 CSV：解析、欄位偵測、名稱配對、冪等寫入、未配對列指派 |
| `worker/pnp.ts` | 通知型訊息：電話號碼只存 SHA-256 與遮罩，`X-Line-Delivery-Tag` = notification id |
| `worker/line-env.ts` | `lineClientFor(env)`，避免 webhook / integrity / outbox 互相循環引用 |
| `src/builder/` | 傻瓜編輯台的核心：`limits.ts`（LINE 上限，所有欄位以此為準）、`types.ts`（草稿結構）、`toLine.ts`（草稿→LINE JSON，輸出必定合法；`validateDraft` 列出必填缺漏）、`presets.ts`（表單範本） |
| `src/components/builder/` | 編輯台 UI：`BuilderDialog`（主畫面）、`MessageForm`（各類型表單）、`ActionEditor`（按鈕）、`fields.tsx`（含字數計數的輸入框） |
| `src/presets.ts` | JSON 模式的範例（LINE 訊息陣列），給進階使用者 |
| `src/components/LinePreview.tsx` | 近似重現 LINE 呈現的預覽（template / flex / quick reply） |
| `migrations/` | D1 schema，新增欄位一律新開 migration 檔，不改舊檔 |
| `shared/types.ts` | 前後端共用型別，API 回傳格式改動要先改這裡 |
| `src/` | React 客服台；`src/api.ts` 是唯一打 API 的地方；`src/agent.ts` 存客服名稱（localStorage，以 `X-Agent-Name` 帶上） |
| `src/hooks/` | `useInboxSocket`（WebSocket、25 秒心跳、重連）、`useEscape`（浮層的 Escape 關閉） |
| `src/route.ts` | 畫面狀態（選取的對話、面板、互動訊息對話框）與網址的對應；App 以 `navigate()` 改網址、監聽 `popstate`，瀏覽器上一頁才有作用。新增頁面或對話框時要加進這裡，不要另外開 useState |
| `test/` | Vitest 跑在 workerd 內；LINE API 用 `vi.stubGlobal("fetch")` 攔截（此版本沒有 `fetchMock`） |
| `scripts/` | `bootstrap.sh`（部署前置，必須冪等）、`reports.mjs`（工程端讀取／結案缺口）、`loadtest.mjs`（webhook 壓測） |

## 慣例

- TypeScript 開了 `erasableSyntaxOnly`：不能用 constructor 參數屬性、enum、namespace。
- 移除功能時以「呼叫端」為單位清乾淨：前端畫面、`src/api.ts`、後端路由、`shared/types.ts` 的型別與 WebSocket 事件、測試、README／CLAUDE.md／`docs/` 一起改；改完以 `grep` 確認沒有殘留引用。
- 縮排用 tab。回覆與註解用繁體中文，識別字用英文。
- 使用者看得到的文案（前端、後端回傳的錯誤與系統訊息、完整性事件標題）一律正式書面語：不用口語（拿、塞、搞、看看、～）、不用表情符號、量詞用「個」「張卡片」「則」、對使用者稱「您」、提示句以句號結尾。
- 新增渠道（如 Teams）時：新增 `worker/<channel>.ts` 與 `worker/webhook-<channel>.ts`，資料寫入仍走 `db.ts`，`channel` 欄位填對應值，`handleReply` 依 `channel` 分派。
- 部署流程改動（新 binding、新資源）要同步更新 README 的「正式部署」段落與 `docs/architecture.md` 的技術選型表。

## 介面設計原則（Apple Human Interface Guidelines 的精神，每個 session 都要遵守）

驗收以 `docs/acceptance.md` 為準（做什麼 → 應該看到什麼）；改介面前先讀它，改完對著它逐條確認，新行為要補進去。
兩種模式以視窗寬度 1024px（Tailwind `lg`）切換，不以裝置判斷：電腦模式像 macOS 的「訊息」（左清單右內容、鍵盤優先、滑過才出現次要控制項），手機模式像 LINE（一次一個畫面、底部分頁列只在清單出現、進對話後全站標題列讓位、Enter 換行按鈕送出、次要控制項一律顯示）。有沒有滑鼠以 CSS `@media (hover: hover) and (pointer: fine)` 判斷（`src/index.css` 的 `.bubble-actions`）。

使用者是客服人員，不是工程師；他們把這些當成基礎設施，一旦不符預期就是「壞掉」。簡單就是最好的。

- **清晰（Clarity）**：每個畫面只回答「現在怎麼了」「我要做什麼」。一個狀態一句話，一個問題一個動作。不把內部狀態（queue 模式、markAsReadMode、cron、retry key）做成介面。
- **退讓（Deference）**：介面退到內容後面。沒有裝飾性元素、沒有表情符號、沒有數字卡片牆；顏色只用來表達狀態（紅＝需要處理、琥珀＝注意、綠＝正常），不用來好看。
- **標準控制項、標準行為**：按鈕像按鈕、連結像連結；Enter 送出、Escape 關閉、點外面關閉浮層、瀏覽器上一頁有作用（`src/route.ts`）。任何暫時性的浮層（對話框、下拉清單、提示）都必須能用 Escape 與點擊外部關閉，否則不要做浮層——改成單擊完成的動作或行內元素。
- **直接操作、即時回饋**：動作發生在內容旁邊（泡泡旁的驚嘆號、訊息下方的狀態），按下去立刻有可見結果（已回報、已發送、發送失敗＋重新發送）。不要先問原因再做事；選填的說明永遠不該擋在主要動作前面。
- **一致性**：同類元素用同一個元件與同一套字級、間距、圓角（既有：標題列 `text-sm font-semibold`、說明 `text-xs text-neutral-500`、按鈕 `text-xs rounded-md px-3 py-1.5`）。新功能必須融入既有版面，不另起一套樣式。
- **漸進揭露**：預設只顯示必要資訊；細節放在 `title` 提示或可展開區塊，而不是一開始全部攤開。
- **可觸及**：可點的東西至少 24px（滑鼠）／44px（觸控）；hover 才出現的控制項要有 `focus-visible` 可見狀態。
- **改版面前先看基礎**：在既有元件外層包東西（例如為了放一個按鈕加 flex 容器）之前，先確認不會改變原本的對齊與寬度；用 `flex-row-reverse` 之類會反轉語意的工具時要特別小心（曾因此把客服訊息從靠右變成靠左）。改完一定開 `npm run dev` 看對話頁、清單、對話框三個畫面。
- **文案**：正式書面語（見上方慣例），短句，先說結論再說原因；錯誤訊息說「發生了什麼、接下來怎麼做」。
- **以 LINE 手機端的呈現為基準**：使用者在 LINE 看到的樣子就是客服的預期。webhook 的資料形狀（一張圖一個事件、貼圖只有 id、文字裡的 emoji 是佔位字元）不等於呈現；呈現層要還原成 LINE 的樣子（圖集收斂成一個格子泡泡、貼圖與 LINE emoji 顯示圖片、@提及加粗），資料拿不到的（對方是否已讀、組合貼圖內容）則明確標示，不假裝。這類差異一律在前端呈現層解決，不改資料模型。

## 效能與成本原則

- 對話清單：後端游標分頁（`before` = 上一頁最後一筆的 `last_message_at`）+ `q` 搜尋；前端虛擬捲動（`ConversationList.tsx` 固定列高 68px）、記憶體上限 1000 筆、事件以「移除再插入正確位置」更新，不整個重排。新功能不得回到「一次載入全部對話」或「每個事件重排整個陣列」。
- 統計數字（未讀總數等）一律由 `/api/stats` 查 D1，不在前端加總已載入的列。
- 不要為每個對話建立 Durable Object；不要讓 Workflow 實例數跟訊息數成正比（每個對話同時最多一個提醒實例）。
- D1 操作以 `db.batch` 合併為單次往返；新增寫入路徑時維持「寫 + 回讀」同一個 batch，不要拆成多次 `run()` / `first()`。
- webhook：`WEBHOOK_MODE=queue` 時只驗簽與入列，處理邏輯在 `consumeLineEvents`；所有事件處理必須可重送（external_id / webhookEventId 去重），因為 Queues 會重試。
- 任何對外呼叫或關鍵路徑都用 `recordMetric` 記耗時與結果，指標名用小寫點分隔（`line.api`、`queue.consume`）。

## 已知事項

### 部署與工具鏈的陷阱

- `wrangler.jsonc` 的 `migrations`（Durable Object）只能追加新 tag，絕不能改寫或刪除已部署過的 tag，否則 Cloudflare 會略過它並在部署時報 10064。正式環境目前已套用到 `v2`。
- Analytics Engine 需在 dashboard 啟用一次；未啟用時 bootstrap 會改以不帶 `METRICS` binding 的設定重試部署，`metrics.ts` 以 `env.METRICS?.` 容忍缺少 binding。
- Queues 只在 Workers Paid 提供。`scripts/bootstrap.sh` 建不出 queue 時會改寫 dist 內的部署設定（移除 `queues`、`WEBHOOK_MODE=inline`），程式端以 `env.LINE_EVENTS` 是否存在再保險一次。`wrangler.jsonc` 本身保持 queue 設定。
- 正式環境的 Worker `workflows-starter-template` 曾部署過原始範本，舊的 Workflow `my-workflow` 可能殘留在 dashboard，不影響運作，可手動刪除。
- `test/reminder.test.ts` 會印一行 `WorkflowTimeoutError` 的 uncaught exception，來自測試工具 `forceEventTimeout` 內部，測試本身通過，可忽略。

### 領域規則（改相關程式前先讀）

- 客服台目前為單一共用 `CONSOLE_TOKEN`，無個別帳號。客服名稱由前端以 `X-Agent-Name`（URI 編碼）自報，只用於接手／在看／衝突偵測／署名，不是身分驗證。
- 客服發訊一律走 `worker/outbox.ts`，不要在別處直接呼叫 `client.push`。`delivery_status`：pending（排程會重推，LINE 回 409 視為已送達）／sent／failed（4xx，客服可重試）／unknown（超過 24 小時，記 `send_unknown` 缺口）。
- 缺口紀錄 `integrity_events` 用 `dedupe_key` 合併（`ON CONFLICT(dedupe_key) WHERE dedupe_key IS NOT NULL`），重送以小時為桶。DLQ consumer 把放棄的事件連原始 payload 記成 `event_dead_lettered`。
- 客服回報只有一種入口：泡泡旁的驚嘆號 → `POST /api/messages/:id/report`，伺服器自動收齊該訊息、前後各 5 則、送達／附件狀態、相關缺口進 `details.context`，同一則重複按只累加 count。客服台沒有完整性頁面、橫幅或數字卡；判讀與修正是工程端的事，不要再把內部狀態（queue 模式、markAsReadMode、cron）做成給客服看的介面。
- CSV 匯入的訊息 `source = manager_csv`、`external_id = csv:<hash>`，不動未讀與逾時；與 webhook 已收到的訊息以「同一分鐘 + 同文字」視為重複。官方 CSV 的實際欄位名稱尚未以真實檔案驗證，欄位偵測靠關鍵字，偵測不到時前端要求指定。
- PNP 的 `to` 是 E.164（含 `+`）的 SHA-256 hex，端點 `POST https://api.line.me/bot/pnp/push`；是否含 `+` 與實際回應格式尚未在正式環境驗證。
- 一般回覆（`/reply`）只能純文字（可帶引用）；Flex 等互動訊息走 `/send`；客服上傳圖片尚未做。
- LINE 按鈕可反覆按：`recordPromptResponse` 每次都寫 `prompt_responses`，但只有第一次（或 `allow_change = 1`）會更新 `prompts` 的結果；重複按會回覆「以第一次回覆為準」。
- 對話完整性（migration 0005）：`quotedMessageId` 在收訊時以 `findMessageByExternalId` 做快照存進 `metadata.quote`，找不到原文時 `messageId: null`，前端明示「無法取得」；`unsend` 清掉 text／media／R2 物件並設 `unsent_at`；`messageEdited`（目前僅群組文字訊息）以同一個 LINE message id 更新 text、第一版留在 `metadata.originalText`，只接受 timestamp 較新的版本；`imageSet`、`senderUserId`、`isRedelivery` 原樣存 metadata。
- 已讀：使用者訊息的 `markAsReadToken` 存在 `conversations.mark_as_read_token`，客服 `POST /read` 時呼叫 `POST /v2/bot/chat/markAsRead`，成功才清掉 token。只有官方帳號 Chat 開啟（`GET /api/integrity/health` 的 `botInfo.markAsReadMode = manual`）才有效，Chat 關閉時 LINE 回 400、客服台照常。`messageEdited` 的事件結構與 `markAsReadToken` 的位置是依文件寫的，正式環境第一次收到時用 `npx wrangler tail` 核對。
- 互動訊息編輯台只產生五種受控版型（text / confirm / buttons / carousel / 固定版面的 Flex 資訊卡），不開放自由 Flex；新版型要先在 `types.ts` 加草稿型別、`toLine.ts` 加轉換與檢查、`MessageForm.tsx` 加表單，並在 `test/builder.test.ts` 加測試。
- 互動訊息：`POST /api/conversations/:id/send` 接任意 LINE 訊息陣列；`worker/line.ts` 的 `instrumentPostbacks` 會把所有 postback 的 data 改寫成 `prompt=<id>&choice=<原 data 或 label>` 並萃取選項，改寫後任何一個 data 超過 LINE 的 300 字元上限（`POSTBACK_DATA_MAX`；中文經網址編碼後一字占 9 字元）就回 400「字數超出上限」，不寫入也不推送。有 postback 才建立 `prompts` 紀錄（message type `prompt`），否則 type `rich`。使用者點選後 `worker/webhook-line.ts` 的 `handlePostback` 寫入 `prompts` / `prompt_responses`。舊的 `/prompt` 介面已移除，一律走 `/send`。
