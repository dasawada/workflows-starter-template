-- 保存實際送出的 LINE 訊息 JSON，方便之後查看或重送
ALTER TABLE prompts ADD COLUMN payload TEXT;
