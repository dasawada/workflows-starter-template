-- 對話完整性中心：訊息來源與送達狀態、客服接手、缺口紀錄、歷史匯入、通知型訊息

-- 訊息來源與狀態
ALTER TABLE messages ADD COLUMN source TEXT NOT NULL DEFAULT 'line_webhook'; -- line_webhook | console | system | manager_csv
ALTER TABLE messages ADD COLUMN delivery_status TEXT;  -- 客服送出的訊息：pending | sent | failed | unknown
ALTER TABLE messages ADD COLUMN retry_key TEXT;        -- 送 LINE 時用的 X-Line-Retry-Key（UUID），重推同一把 key 不會重複送達
ALTER TABLE messages ADD COLUMN media_status TEXT;     -- 使用者附件：pending | stored | failed | expired
ALTER TABLE messages ADD COLUMN agent_name TEXT;       -- 送出這則訊息的客服
UPDATE messages SET source = 'console' WHERE direction = 'outbound' AND sender = 'agent';
UPDATE messages SET source = 'system' WHERE sender = 'system';
UPDATE messages SET delivery_status = 'sent' WHERE direction = 'outbound';
UPDATE messages SET media_status = 'stored' WHERE media_key IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_retry_key
	ON messages (retry_key) WHERE retry_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_messages_delivery_pending
	ON messages (delivery_status, created_at) WHERE delivery_status IN ('pending', 'failed');
CREATE INDEX IF NOT EXISTS idx_messages_media_pending
	ON messages (media_status, created_at) WHERE media_status IN ('pending', 'failed');

-- 客服接手
ALTER TABLE conversations ADD COLUMN assigned_to TEXT;
ALTER TABLE conversations ADD COLUMN assigned_at INTEGER;

-- 資料缺口與完整性事件
CREATE TABLE IF NOT EXISTS integrity_events (
	id TEXT PRIMARY KEY,
	kind TEXT NOT NULL,                     -- quote_missing | media_failed | media_expired | send_failed | send_unknown | webhook_redelivery | event_dead_lettered | chat_mode | agent_report | import
	severity TEXT NOT NULL,                 -- info | warning | error
	status TEXT NOT NULL DEFAULT 'open',    -- open | resolved
	conversation_id TEXT,
	message_id TEXT,
	dedupe_key TEXT,                        -- 同一件事只建一筆
	title TEXT NOT NULL,
	details TEXT,                           -- JSON
	started_at INTEGER,
	ended_at INTEGER,
	resolved_at INTEGER,
	resolution TEXT,
	created_by TEXT,
	created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_integrity_dedupe
	ON integrity_events (dedupe_key) WHERE dedupe_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_integrity_status_created
	ON integrity_events (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_integrity_conversation
	ON integrity_events (conversation_id, status);

-- 系統狀態（最後收到 webhook 的時間、bot info 快取、上次維護時間）
CREATE TABLE IF NOT EXISTS system_state (
	key TEXT PRIMARY KEY,
	value TEXT,
	updated_at INTEGER NOT NULL
);

-- 歷史紀錄匯入（LINE 官方帳號管理後台 CSV）
CREATE TABLE IF NOT EXISTS import_batches (
	id TEXT PRIMARY KEY,
	source TEXT NOT NULL,                   -- manager_csv
	file_name TEXT,
	account_name TEXT,                      -- CSV 裡代表官方帳號的發送者名稱
	range_start INTEGER,
	range_end INTEGER,
	total_rows INTEGER NOT NULL DEFAULT 0,
	inserted INTEGER NOT NULL DEFAULT 0,
	duplicates INTEGER NOT NULL DEFAULT 0,
	unmatched INTEGER NOT NULL DEFAULT 0,
	skipped INTEGER NOT NULL DEFAULT 0,
	report TEXT,                            -- JSON
	created_by TEXT,
	created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS import_rows (
	id TEXT PRIMARY KEY,
	batch_id TEXT NOT NULL REFERENCES import_batches (id),
	chat_name TEXT,
	sender TEXT,
	direction TEXT NOT NULL,
	text TEXT,
	sent_at INTEGER NOT NULL,
	status TEXT NOT NULL DEFAULT 'unmatched',  -- unmatched | assigned | skipped
	conversation_id TEXT,
	created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_import_rows_batch ON import_rows (batch_id, status);

-- 通知型訊息（PNP）中央發送紀錄
CREATE TABLE IF NOT EXISTS notifications (
	id TEXT PRIMARY KEY,
	phone_hash TEXT NOT NULL,               -- E.164 的 SHA-256，不存明碼
	phone_masked TEXT NOT NULL,             -- 只留末四碼
	messages TEXT NOT NULL,                 -- JSON
	source TEXT NOT NULL,                   -- console | api
	note TEXT,
	delivery_tag TEXT NOT NULL,             -- X-Line-Delivery-Tag，delivery 事件靠它對回來
	status TEXT NOT NULL,                   -- pending | sent | delivered | failed
	line_status INTEGER,
	line_request_id TEXT,
	error TEXT,
	sent_at INTEGER,
	delivered_at INTEGER,
	created_by TEXT,
	created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_notifications_tag ON notifications (delivery_tag);
CREATE INDEX IF NOT EXISTS idx_notifications_created ON notifications (created_at DESC);
