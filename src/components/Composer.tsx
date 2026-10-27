import { useState, type KeyboardEvent } from "react";

interface Props {
	disabled: boolean;
	onSend: (text: string) => Promise<void>;
	onOpenPrompt: () => void;
}

export function Composer({ disabled, onSend, onOpenPrompt }: Props) {
	const [text, setText] = useState("");
	const [sending, setSending] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const send = async () => {
		const value = text.trim();
		if (!value || sending) return;
		setSending(true);
		setError(null);
		try {
			await onSend(value);
			setText("");
		} catch (err) {
			setError(err instanceof Error ? err.message : "送出失敗");
		} finally {
			setSending(false);
		}
	};

	const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
		if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
			e.preventDefault();
			void send();
		}
	};

	return (
		<div className="border-t border-neutral-200 dark:border-neutral-800 p-3 bg-white dark:bg-neutral-900">
			{error && <p className="text-xs text-red-600 dark:text-red-400 mb-2">{error}</p>}
			<div className="flex gap-2 items-end">
				<button
					type="button"
					onClick={onOpenPrompt}
					disabled={disabled}
					title="發送 Flex / 按鈕 / Quick reply 等互動訊息，按鈕回覆會自動追蹤"
					className="shrink-0 rounded-lg border border-neutral-300 dark:border-neutral-700 text-neutral-700 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-800 disabled:opacity-50 text-sm px-3 py-2"
				>
					互動訊息
				</button>
				<textarea
					value={text}
					onChange={(e) => setText(e.target.value)}
					onKeyDown={onKeyDown}
					disabled={disabled || sending}
					rows={2}
					placeholder={disabled ? "此對話已結案，重新開啟後才能回覆" : "輸入回覆，Enter 送出、Shift+Enter 換行"}
					className="flex-1 resize-none rounded-lg border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-800 px-3 py-2 text-sm text-neutral-900 dark:text-neutral-100 outline-none focus:ring-2 focus:ring-emerald-500 disabled:opacity-60"
				/>
				<button
					onClick={() => void send()}
					disabled={disabled || sending || !text.trim()}
					className="rounded-lg bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white text-sm font-medium px-4 py-2 transition-colors"
				>
					{sending ? "送出中…" : "送出"}
				</button>
			</div>
		</div>
	);
}
