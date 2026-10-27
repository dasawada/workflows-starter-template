import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { Message, SendConflict } from "../../shared/types";
import { ApiError } from "../api";

interface Props {
	disabled: boolean;
	/** force = 已確認衝突仍要送出 */
	onSend: (text: string, force: boolean) => Promise<void>;
	onOpenPrompt: () => void;
	/** 正在引用的訊息；送出後由 App 清除 */
	quoting?: Message | null;
	onCancelQuote?: () => void;
}

/** 觸控裝置上 Enter 換行、按鈕送出（和 LINE 手機版一致）；有鍵盤滑鼠時 Enter 送出 */
const touchInput = typeof window !== "undefined" && window.matchMedia?.("(pointer: coarse)").matches;

export function Composer({ disabled, onSend, onOpenPrompt, quoting, onCancelQuote }: Props) {
	const [text, setText] = useState("");
	const textareaRef = useRef<HTMLTextAreaElement>(null);
	useEffect(() => {
		if (quoting) textareaRef.current?.focus();
	}, [quoting]);
	const [sending, setSending] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [conflict, setConflict] = useState<SendConflict | null>(null);

	const send = async (force = false) => {
		const value = text.trim();
		if (!value || sending) return;
		setSending(true);
		setError(null);
		setConflict(null);
		try {
			await onSend(value, force);
			setText("");
		} catch (err) {
			if (err instanceof ApiError && err.status === 409 && err.data?.code) {
				setConflict(err.data as unknown as SendConflict);
			} else {
				setError(err instanceof Error ? err.message : "發送失敗");
			}
		} finally {
			setSending(false);
		}
	};

	const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
		if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && !touchInput) {
			e.preventDefault();
			void send();
		}
		if (e.key === "Escape" && quoting) onCancelQuote?.();
	};

	return (
		<div className="border-t border-neutral-200 dark:border-neutral-800 p-3 bg-white dark:bg-neutral-900">
			{error && <p className="text-xs text-red-600 dark:text-red-400 mb-2">{error}</p>}
			{quoting && (
				<div className="mb-2 flex items-start gap-2 rounded-lg bg-neutral-100 dark:bg-neutral-800 px-3 py-1.5 text-xs">
					<div className="border-l-2 border-emerald-500 pl-2 min-w-0 flex-1">
						<div className="text-neutral-500">引用{quoting.sender === "user" ? "對方" : "客服"}訊息</div>
						<div className="truncate text-neutral-900 dark:text-neutral-100">
							{quoting.text ?? (quoting.type === "image" ? "[圖片]" : quoting.type === "sticker" ? "[貼圖]" : `[${quoting.type}]`)}
						</div>
					</div>
					<button onClick={onCancelQuote} aria-label="取消引用" className="text-neutral-500 hover:text-neutral-900 dark:hover:text-neutral-100 text-base leading-none">
						×
					</button>
				</div>
			)}
			{conflict && (
				<div className="mb-2 rounded-lg border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-950/40 px-3 py-2 text-xs text-amber-900 dark:text-amber-200">
					<div className="font-medium">
						{conflict.code === "assigned" ? `此對話目前由 ${conflict.assignedTo} 負責` : conflict.error}
					</div>
					{conflict.messages?.slice(0, 3).map((m: Message) => (
						<div key={m.id} className="mt-1 truncate opacity-90">
							{m.agentName ?? "其他客服人員"}：{m.text}
						</div>
					))}
					<div className="mt-2 flex gap-2">
						<button onClick={() => void send(true)} className="px-2.5 py-1 rounded bg-amber-600 text-white hover:bg-amber-700">
							仍要發送
						</button>
						<button onClick={() => setConflict(null)} className="px-2.5 py-1 rounded border border-amber-400 hover:bg-amber-100 dark:hover:bg-amber-900/40">
							取消
						</button>
					</div>
				</div>
			)}
			<div className="flex gap-2 items-end">
				<button
					type="button"
					onClick={onOpenPrompt}
					disabled={disabled}
					title="發送 Flex、按鈕或快速回覆等互動訊息；按鈕回覆會自動追蹤"
					className="shrink-0 rounded-lg border border-neutral-300 dark:border-neutral-700 text-neutral-700 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-800 disabled:opacity-50 text-sm px-3 py-2"
				>
					互動訊息
				</button>
				<textarea
					ref={textareaRef}
					value={text}
					onChange={(e) => setText(e.target.value)}
					onKeyDown={onKeyDown}
					disabled={disabled || sending}
					rows={2}
					placeholder={disabled ? "此對話已結案，請重新開啟後再回覆" : touchInput ? "輸入回覆內容" : "輸入回覆內容；Enter 發送，Shift+Enter 換行"}
					className="flex-1 resize-none rounded-lg border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-800 px-3 py-2 text-sm text-neutral-900 dark:text-neutral-100 outline-none focus:ring-2 focus:ring-emerald-500 disabled:opacity-60"
				/>
				<button
					onClick={() => void send()}
					disabled={disabled || sending || !text.trim()}
					className="rounded-lg bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white text-sm font-medium px-4 py-2 transition-colors"
				>
					{sending ? "發送中…" : "發送"}
				</button>
			</div>
		</div>
	);
}
