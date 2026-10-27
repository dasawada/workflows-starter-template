-- 對話完整性：撤回、編輯、已讀 token
ALTER TABLE messages ADD COLUMN edited_at INTEGER;   -- 群組訊息被編輯的時間（messageEdited 事件）
ALTER TABLE messages ADD COLUMN unsent_at INTEGER;   -- 使用者撤回的時間（unsend 事件），內容已清除
ALTER TABLE conversations ADD COLUMN mark_as_read_token TEXT;  -- 最新一則使用者訊息附的 markAsReadToken，客服讀過後呼叫 LINE 已讀 API
