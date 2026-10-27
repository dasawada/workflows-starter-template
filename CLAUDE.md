# CLAUDE.md

## 專案定位

LINE 官方帳號客服訊息收發台，從頭開始的新專案（原本的 Cloudflare Workflows 範本程式碼已全部移除，只保留工具鏈）。
技術棧：Cloudflare Workers + D1 + R2 + Durable Objects + Workflows，前端 React + Vite + Tailwind。
Teams 渠道尚未實作，`conversations.channel` 與渠道層已預留。

## 驗證方式（重要）

- 部署走 GitHub → Cloudflare Workers Builds：push 到 `main` 即自動建置（`npm run build`）並執行 `npm run deploy`（內含 `scripts/bootstrap.sh`）（建 D1/R2、寫入 database_id、套 schema、`wrangler deploy`）。
- Claude 的職責是改好程式、通過 `npm run check` 與 `npm test`、commit 並 push 到 `main`；部署與密鑰設定在 Cloudflare dashboard 完成，Claude 不需要也不應登入 Cloudflare。
- `wrangler.jsonc` 的 `database_id` 是 D1 資源識別碼（非密鑰），已寫入正式值；若換帳號或重建資料庫，bootstrap 會自動覆寫（含 dist 內已產生的 wrangler.json）。
- **一切功能都在正式環境部署後直接驗證**，不以本機開發伺服器為驗證依據。
- 改完程式碼的標準流程：`npm run check`（tsc + dry-run）→ `npm test` → `npm run deploy` → 用真實 LINE 帳號與客服台操作確認。
- 需要查正式環境狀況時用 `npx wrangler tail`、`npx wrangler d1 execute DB --remote --command "..."`。
- 不要為了驗證而建立假資料的本機流程；本機 `npm run dev` 只用來看 UI 排版。

## 密鑰與設定

- 機密三個：`LINE_CHANNEL_SECRET`、`LINE_CHANNEL_ACCESS_TOKEN`、`CONSOLE_TOKEN`。
  **由使用者自行在 Cloudflare dashboard（Workers & Pages → 該 Worker → Settings → Variables and Secrets）輸入。**
- `wrangler.jsonc` 的 `name` 必須與 dashboard 的 Worker 專案名稱一致（目前 `workflows-starter-template`），否則 Workers Builds 部署會失敗。
  Claude 不執行 `wrangler secret put`、不建立 `.dev.vars`、不把任何密鑰或環境資訊寫進 `wrangler.jsonc` 或其他設定檔。
  `.dev.vars.example` 只是空白範本。
- 非機密設定放 `wrangler.jsonc` 的 `vars`（`REPLY_SLA_MINUTES`、`WELCOME_MESSAGE`）。
- 改過 `wrangler.jsonc` 的 binding 後要跑 `npm run cf-typegen` 重新產生 `worker-configuration.d.ts`。
- Secrets 的型別在 `worker/env.d.ts` 手動維護（擴充 `__BaseEnv_Env`）。

## 程式結構

| 路徑 | 職責 |
| --- | --- |
| `worker/index.ts` | 路由；只做參數檢查與呼叫下層，不寫 SQL、不直接呼叫 LINE API |
| `worker/webhook-line.ts` | LINE webhook 事件處理 |
| `worker/line.ts` | LINE API client、簽章驗證、事件型別 |
| `worker/db.ts` | 所有 SQL 集中於此 |
| `worker/inbox-do.ts` | 單一實例 `InboxDO`（名稱固定 `"inbox"`），WebSocket 廣播 |
| `worker/workflow.ts` | `ReplyReminderWorkflow` 逾時提醒 |
| `src/templates.ts` | 可追蹤訊息範本；`{{變數}}` 自動變表單欄位，新增範本只要加一筆 |
| `migrations/` | D1 schema，新增欄位一律新開 migration 檔，不改舊檔 |
| `shared/types.ts` | 前後端共用型別，API 回傳格式改動要先改這裡 |
| `src/` | React 客服台；`src/api.ts` 是唯一打 API 的地方 |
| `test/` | Vitest 跑在 workerd 內；LINE API 用 `vi.stubGlobal("fetch")` 攔截（此版本沒有 `fetchMock`） |

## 慣例

- TypeScript 開了 `erasableSyntaxOnly`：不能用 constructor 參數屬性、enum、namespace。
- 縮排用 tab。回覆與註解用繁體中文，識別字用英文。
- 新增渠道（如 Teams）時：新增 `worker/<channel>.ts` 與 `worker/webhook-<channel>.ts`，資料寫入仍走 `db.ts`，`channel` 欄位填對應值，`handleReply` 依 `channel` 分派。
- 部署流程改動（新 binding、新資源）要同步更新 README 的「正式部署」段落。

## 已知事項

- `wrangler.jsonc` 的 `migrations`（Durable Object）只能追加新 tag，絕不能改寫或刪除已部署過的 tag，否則 Cloudflare 會略過它並在部署時報 10064。正式環境目前已套用到 `v2`。
- 正式環境的 Worker `workflows-starter-template` 曾部署過原始範本，舊的 Workflow `my-workflow` 可能殘留在 dashboard，不影響運作，可手動刪除。
- `test/reminder.test.ts` 會印一行 `WorkflowTimeoutError` 的 uncaught exception，來自測試工具 `forceEventTimeout` 內部，測試本身通過，可忽略。
- 客服台目前為單一共用 `CONSOLE_TOKEN`，無個別帳號。
- 一般回覆只能純文字，圖片／Flex Message 發送尚未做。
- 可追蹤訊息（prompts）：送出走 `POST /api/conversations/:id/prompt`，LINE 以 Confirm template 呈現，使用者點選後以 `postback` 事件回來（data 格式 `prompt=<id>&choice=<value>`），`worker/webhook-line.ts` 的 `handlePostback` 寫入 `prompts` / `prompt_responses`。按鈕最多兩顆。
