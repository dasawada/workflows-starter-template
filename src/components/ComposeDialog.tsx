import { useMemo, useState } from "react";
import type { SendMessagesInput } from "../../shared/types";
import { MESSAGE_PRESETS } from "../presets";
import { LinePreview } from "./LinePreview";

interface Props {
	onClose: () => void;
	onSend: (input: SendMessagesInput) => Promise<void>;
	/** 從編輯台切過來時帶入的訊息 */
	initialMessages?: unknown[];
	onBackToBuilder?: () => void;
}

const DRAFT_KEY = "cs-console-compose-draft";

function loadDraft(): { key: string; text: string } | null {
	try {
		const raw = localStorage.getItem(DRAFT_KEY);
		return raw ? (JSON.parse(raw) as { key: string; text: string }) : null;
	} catch {
		return null;
	}
}

function saveDraft(key: string, text: string) {
	try {
		localStorage.setItem(DRAFT_KEY, JSON.stringify({ key, text }));
	} catch {
		// ignore
	}
}

export function ComposeDialog({ onClose, onSend, initialMessages, onBackToBuilder }: Props) {
	const draft = useMemo(loadDraft, []);
	const [presetKey, setPresetKey] = useState(initialMessages ? "custom" : (draft?.key ?? MESSAGE_PRESETS[0].key));
	const [text, setText] = useState(
		initialMessages
			? JSON.stringify(initialMessages, null, 2)
			: (draft?.text ?? JSON.stringify(MESSAGE_PRESETS[0].messages, null, 2)),
	);
	const [allowChange, setAllowChange] = useState(false);
	const [sending, setSending] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const preset = MESSAGE_PRESETS.find((p) => p.key === presetKey);

	const parsed = useMemo<{ messages: unknown[] | null; error: string | null }>(() => {
		try {
			const value: unknown = JSON.parse(text);
			if (!Array.isArray(value)) return { messages: null, error: "最外層必須是陣列 [ ... ]" };
			if (value.length === 0) return { messages: null, error: "至少要有一則訊息" };
			if (value.length > 5) return { messages: null, error: "一次最多 5 則訊息" };
			return { messages: value, error: null };
		} catch (err) {
			return { messages: null, error: `JSON 格式錯誤：${err instanceof Error ? err.message : String(err)}` };
		}
	}, [text]);

	const postbackCount = useMemo(() => countPostbacks(parsed.messages ?? []), [parsed.messages]);
	const bytes = new TextEncoder().encode(text).length;

	const pickPreset = (key: string) => {
		const p = MESSAGE_PRESETS.find((x) => x.key === key);
		if (!p) return;
		if (text.trim() && text !== JSON.stringify(preset?.messages, null, 2) && !confirm("切換範例會覆蓋目前的內容，確定？")) return;
		setPresetKey(key);
		const next = JSON.stringify(p.messages, null, 2);
		setText(next);
		saveDraft(key, next);
	};

	const onChange = (value: string) => {
		setText(value);
		saveDraft(presetKey, value);
	};

	const format = () => {
		if (parsed.messages) onChange(JSON.stringify(parsed.messages, null, 2));
	};

	const submit = async () => {
		if (sending || !parsed.messages) return;
		setError(null);
		setSending(true);
		try {
			await onSend({ messages: parsed.messages, templateKey: presetKey, allowChange });
			onClose();
		} catch (err) {
			setError(err instanceof Error ? err.message : "送出失敗");
		} finally {
			setSending(false);
		}
	};

	const field =
		"w-full rounded-lg border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-800 px-3 py-2 text-sm text-neutral-900 dark:text-neutral-100 outline-none focus:ring-2 focus:ring-emerald-500";

	return (
		<div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={onClose}>
			<div
				className="w-full max-w-5xl h-[92vh] flex flex-col bg-white dark:bg-neutral-900 rounded-2xl shadow-float ring-glass"
				onClick={(e) => e.stopPropagation()}
			>
				<div className="flex items-center gap-3 px-5 py-3 border-b border-neutral-200 dark:border-neutral-800">
					<h2 className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">互動訊息（JSON 模式）</h2>
					{onBackToBuilder && (
						<button onClick={onBackToBuilder} className="text-xs text-neutral-500 hover:text-neutral-900 dark:hover:text-neutral-100 hover:underline underline-offset-2">
							← 回編輯台
						</button>
					)}
					<select value={presetKey} onChange={(e) => pickPreset(e.target.value)} className={`${field} w-auto py-1.5`}>
						{presetKey === "custom" && <option value="custom">（來自編輯台）</option>}
						{MESSAGE_PRESETS.map((p) => (
							<option key={p.key} value={p.key}>
								{p.name}
							</option>
						))}
					</select>
					<button
						onClick={format}
						disabled={!parsed.messages}
						className="text-xs px-3 py-1.5 rounded-md border border-neutral-300 dark:border-neutral-700 text-neutral-700 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-800 disabled:opacity-50"
					>
						整理排版
					</button>
					<a
						href="https://developers.line.biz/flex-simulator/"
						target="_blank"
						rel="noreferrer"
						className="text-xs text-sky-600 hover:underline"
					>
						Flex Simulator ↗
					</a>
					<button onClick={onClose} className="ml-auto text-neutral-500 hover:text-neutral-900 dark:hover:text-neutral-100 text-xl leading-none" aria-label="關閉">
						×
					</button>
				</div>

				{preset && (
					<p className="px-5 py-2 text-[11px] text-neutral-500 dark:text-neutral-400 border-b border-neutral-100 dark:border-neutral-800">
						{preset.hint}{" "}postback 的 <code>data</code> 只要填選項值，送出時會自動加上追蹤 id。
					</p>
				)}

				<div className="flex-1 min-h-0 grid grid-cols-1 md:grid-cols-5">
					<div className="md:col-span-3 flex flex-col min-h-0 border-r border-neutral-200 dark:border-neutral-800">
						<textarea
							value={text}
							onChange={(e) => onChange(e.target.value)}
							spellCheck={false}
							className="flex-1 w-full resize-none p-4 font-mono text-xs leading-5 bg-neutral-50 dark:bg-neutral-950 text-neutral-900 dark:text-neutral-100 outline-none"
						/>
						<div className="flex items-center gap-3 px-4 py-2 text-[11px] border-t border-neutral-200 dark:border-neutral-800">
							{parsed.error ? (
								<span className="text-red-600">{parsed.error}</span>
							) : (
								<span className="text-emerald-600">
									JSON 正確 · {parsed.messages?.length} 則 · {postbackCount} 顆可追蹤按鈕
								</span>
							)}
							<span className="ml-auto text-neutral-400">{(bytes / 1024).toFixed(1)} KB</span>
						</div>
					</div>

					<div className="md:col-span-2 flex flex-col min-h-0">
						<div className="px-4 py-2 text-[11px] font-medium text-neutral-500 border-b border-neutral-100 dark:border-neutral-800">
							預覽（近似）
						</div>
						<div className="flex-1 overflow-auto p-4 bg-[#8CABD9] dark:bg-[#3b4a63]">
							{parsed.messages ? <LinePreview messages={parsed.messages} /> : <p className="text-xs text-white/80">修正 JSON 後即可預覽</p>}
						</div>
					</div>
				</div>

				<div className="flex items-center justify-end gap-3 px-5 py-3 border-t border-neutral-200 dark:border-neutral-800">
					{postbackCount > 0 && (
						<label className="mr-auto flex items-center gap-1.5 text-xs text-neutral-600 dark:text-neutral-400">
							<input type="checkbox" checked={allowChange} onChange={(e) => setAllowChange(e.target.checked)} className="accent-emerald-600" />
							允許使用者更改回覆（取最後一次）
						</label>
					)}
					{error && <span className="text-xs text-red-600">{error}</span>}
					<button onClick={onClose} className="text-sm px-4 py-2 rounded-lg text-neutral-600 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-800">
						取消
					</button>
					<button
						onClick={() => void submit()}
						disabled={sending || !parsed.messages}
						className="text-sm font-medium px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white"
					>
						{sending ? "送出中…" : "送出"}
					</button>
				</div>
			</div>
		</div>
	);
}

function countPostbacks(node: unknown): number {
	if (Array.isArray(node)) return node.reduce((n, c) => n + countPostbacks(c), 0);
	if (typeof node !== "object" || node === null) return 0;
	const o = node as Record<string, unknown>;
	let n = o.type === "postback" ? 1 : 0;
	for (const v of Object.values(o)) n += countPostbacks(v);
	return n;
}
