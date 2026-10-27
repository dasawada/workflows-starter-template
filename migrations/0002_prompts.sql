-- 可追蹤訊息：送出帶按鈕的訊息，記錄使用者的選擇
CREATE TABLE IF NOT EXISTS prompts (
	id TEXT PRIMARY KEY,
	conversation_id TEXT NOT NULL REFERENCES conversations (id),
	message_id TEXT,                     -- messages.id（客服台顯示用的那則）
	template_key TEXT,                   -- 使用的範本鍵（可為空）
	body TEXT,                           -- 送出的正文
	question TEXT NOT NULL,              -- 按鈕上方的問句
	options TEXT NOT NULL,               -- JSON [{ "label": "是", "value": "yes" }, ...]
	variables TEXT,                      -- JSON 範本變數，方便之後匯出報表
	status TEXT NOT NULL DEFAULT 'pending',  -- pending | answered
	choice TEXT,                         -- 最後一次選擇的 value
	choice_label TEXT,
	responded_at INTEGER,
	created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_prompts_conversation_created
	ON prompts (conversation_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_prompts_status_created
	ON prompts (status, created_at DESC);

-- 每一次點擊都留紀錄（使用者可能重複點）
CREATE TABLE IF NOT EXISTS prompt_responses (
	id TEXT PRIMARY KEY,
	prompt_id TEXT NOT NULL REFERENCES prompts (id),
	choice TEXT NOT NULL,
	choice_label TEXT,
	created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_prompt_responses_prompt
	ON prompt_responses (prompt_id, created_at);
