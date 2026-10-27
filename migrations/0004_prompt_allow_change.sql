-- 重複按按鈕的規則：0 = 第一次回覆為準（預設），1 = 允許更改、取最後一次
ALTER TABLE prompts ADD COLUMN allow_change INTEGER NOT NULL DEFAULT 0;
