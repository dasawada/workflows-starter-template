-- 對話（每位 LINE 使用者 / 群組一筆）
CREATE TABLE IF NOT EXISTS conversations (
	id TEXT PRIMARY KEY,               -- 例如 line:U1234...、line:group:C1234...
	channel TEXT NOT NULL,             -- line | teams（預留）
	external_id TEXT NOT NULL,         -- 該渠道的 userId / groupId / roomId
	display_name TEXT,
	picture_url TEXT,
	status TEXT NOT NULL DEFAULT 'open',   -- open | closed
	last_message_text TEXT,
	last_message_at INTEGER,
	last_inbound_at INTEGER,
	last_outbound_at INTEGER,
	unread_count INTEGER NOT NULL DEFAULT 0,
	needs_attention INTEGER NOT NULL DEFAULT 0,  -- 逾時未回覆
	reminder_instance_id TEXT,         -- 進行中的 ReplyReminderWorkflow instance
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_conversations_status_last
	ON conversations (status, last_message_at DESC);

-- 訊息
CREATE TABLE IF NOT EXISTS messages (
	id TEXT PRIMARY KEY,
	conversation_id TEXT NOT NULL REFERENCES conversations (id),
	direction TEXT NOT NULL,           -- inbound | outbound
	sender TEXT NOT NULL,              -- user | agent | system
	type TEXT NOT NULL,                -- text | image | video | audio | file | sticker | location | unknown
	text TEXT,
	media_key TEXT,                    -- R2 物件 key
	media_content_type TEXT,
	metadata TEXT,                     -- JSON（sticker id、座標、檔名…）
	external_id TEXT,                  -- LINE 的 message id
	created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_messages_conversation_created
	ON messages (conversation_id, created_at);

CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_external
	ON messages (external_id) WHERE external_id IS NOT NULL;
