import { useEffect, useMemo, useState } from "react";
import type { SendMessagesInput } from "../../../shared/types";
import { LIMITS } from "../../builder/limits";
import { BUILDER_PRESETS } from "../../builder/presets";
import { countTrackable, toLineMessages, validateDraft } from "../../builder/toLine";
import type { BuilderDraft, MessageDraft, MessageKind } from "../../builder/types";
import { KIND_LABELS, newMessage } from "../../builder/types";
import { LinePreview } from "../LinePreview";
import { ActionList } from "./ActionEditor";
import { MessageForm } from "./MessageForm";
import { SmallButton, inputCls } from "./fields";

interface Props {
	onClose: () => void;
	onSend: (input: SendMessagesInput) => Promise<void>;
	onSwitchToJson: (messages: unknown[]) => void;
}

const DRAFT_KEY = "cs-console-builder-draft";

function loadDraft(): { presetKey: string; draft: BuilderDraft } | null {
	try {
		const raw = localStorage.getItem(DRAFT_KEY);
		if (!raw) return null;
		const parsed = JSON.parse(raw) as { presetKey: string; draft: BuilderDraft };
		if (!parsed?.draft?.messages) return null;
		return parsed;
	} catch {
		return null;
	}
}

export function BuilderDialog({ onClose, onSend, onSwitchToJson }: Props) {
	const saved = useMemo(loadDraft, []);
	const [presetKey, setPresetKey] = useState(saved?.presetKey ?? BUILDER_PRESETS[0].key);
	const [draft, setDraft] = useState<BuilderDraft>(saved?.draft ?? BUILDER_PRESETS[0].build());
	const [openId, setOpenId] = useState<string | null>(draft.messages[0]?.id ?? null);
	const [allowChange, setAllowChange] = useState(false);
	const [sending, setSending] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		try {
			localStorage.setItem(DRAFT_KEY, JSON.stringify({ presetKey, draft }));
		} catch {
			// ignore
		}
	}, [presetKey, draft]);

	const messages = useMemo(() => toLineMessages(draft), [draft]);
	const errors = useMemo(() => validateDraft(draft), [draft]);
	const trackable = useMemo(() => countTrackable(draft), [draft]);

	const pickPreset = (key: string) => {
		const p = BUILDER_PRESETS.find((x) => x.key === key);
		if (!p) return;
		if (draft.messages.length && !confirm("套用範本會覆蓋目前的內容，確定？")) return;
		const next = p.build();
		setPresetKey(key);
		setDraft(next);
		setOpenId(next.messages[0]?.id ?? null);
	};

	const addMessage = (kind: MessageKind) => {
		if (draft.messages.length >= LIMITS.messagesPerPush) return;
		const m = newMessage(kind);
		setDraft((d) => ({ ...d, messages: [...d.messages, m] }));
		setOpenId(m.id);
	};

	const updateMessage = (id: string, m: MessageDraft) =>
		setDraft((d) => ({ ...d, messages: d.messages.map((x) => (x.id === id ? m : x)) }));

	const removeMessage = (id: string) => setDraft((d) => ({ ...d, messages: d.messages.filter((x) => x.id !== id) }));

	const moveMessage = (id: string, dir: -1 | 1) =>
		setDraft((d) => {
			const i = d.messages.findIndex((x) => x.id === id);
			const j = i + dir;
			if (i < 0 || j < 0 || j >= d.messages.length) return d;
			const next = d.messages.slice();
			[next[i], next[j]] = [next[j], next[i]];
			return { ...d, messages: next };
		});

	const submit = async () => {
		if (sending || errors.length) return;
		setError(null);
		setSending(true);
		try {
			await onSend({ messages, templateKey: `builder:${presetKey}`, allowChange });
			onClose();
		} catch (err) {
			setError(err instanceof Error ? err.message : "送出失敗");
		} finally {
			setSending(false);
		}
	};

	const errorsFor = (i: number) => errors.filter((e) => e.messageIndex === i);

	return (
		<div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={onClose}>
			<div
				className="w-full max-w-6xl h-[94vh] flex flex-col bg-neutral-50 dark:bg-neutral-950 rounded-2xl shadow-float ring-glass overflow-hidden"
				onClick={(e) => e.stopPropagation()}
			>
				<div className="flex items-center gap-3 px-5 py-3 border-b border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900">
					<h2 className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">互動訊息編輯台</h2>
					<select value={presetKey} onChange={(e) => pickPreset(e.target.value)} className={`${inputCls} w-auto`}>
						{BUILDER_PRESETS.map((p) => (
							<option key={p.key} value={p.key}>
								{p.name}
							</option>
						))}
					</select>
					<button
						onClick={() => onSwitchToJson(messages)}
						className="text-xs text-neutral-500 hover:text-neutral-900 dark:hover:text-neutral-100 underline-offset-2 hover:underline"
						title="把目前內容轉成 JSON，自行微調"
					>
						進階：改 JSON
					</button>
					<button onClick={onClose} className="ml-auto text-neutral-500 hover:text-neutral-900 dark:hover:text-neutral-100 text-xl leading-none" aria-label="關閉">
						×
					</button>
				</div>

				<div className="flex-1 min-h-0 grid grid-cols-1 lg:grid-cols-5">
					{/* 左：訊息清單與表單 */}
					<div className="lg:col-span-3 overflow-y-auto p-4 space-y-3 border-r border-neutral-200 dark:border-neutral-800">
						{draft.messages.length === 0 && (
							<p className="text-sm text-neutral-500 text-center py-6">還沒有訊息，從下方加入一則</p>
						)}
						{draft.messages.map((m, i) => {
							const open = openId === m.id;
							const errs = errorsFor(i);
							return (
								<div key={m.id} className="rounded-xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900">
									<div
										className="flex items-center gap-2 px-3 py-2 cursor-pointer select-none"
										onClick={() => setOpenId(open ? null : m.id)}
									>
										<span className="text-[11px] text-neutral-400 w-4">{i + 1}</span>
										<span className="text-xs font-semibold text-neutral-800 dark:text-neutral-200">{KIND_LABELS[m.kind].name}</span>
										<span className="text-[11px] text-neutral-400 truncate">{summary(m)}</span>
										{errs.length > 0 && (
											<span className="text-[10px] px-1.5 py-0.5 rounded bg-red-100 text-red-700 dark:bg-red-900/50 dark:text-red-300">
												{errs.length} 項待修
											</span>
										)}
										<span className="ml-auto flex gap-1" onClick={(e) => e.stopPropagation()}>
											<SmallButton onClick={() => moveMessage(m.id, -1)} disabled={i === 0} title="上移">↑</SmallButton>
											<SmallButton onClick={() => moveMessage(m.id, 1)} disabled={i === draft.messages.length - 1} title="下移">↓</SmallButton>
											<SmallButton onClick={() => removeMessage(m.id)} danger>移除</SmallButton>
										</span>
										<span className="text-neutral-400 text-xs">{open ? "▾" : "▸"}</span>
									</div>
									{open && (
										<div className="px-3 pb-3 pt-1 border-t border-neutral-100 dark:border-neutral-800 space-y-2">
											{errs.length > 0 && (
												<ul className="text-[11px] text-red-600 list-disc pl-4">
													{errs.map((e, k) => (
														<li key={k}>{e.message}</li>
													))}
												</ul>
											)}
											<MessageForm message={m} onChange={(x) => updateMessage(m.id, x)} />
										</div>
									)}
								</div>
							);
						})}

						<div className="rounded-xl border border-dashed border-neutral-300 dark:border-neutral-700 p-3">
							<div className="text-xs font-medium text-neutral-600 dark:text-neutral-400 mb-2">
								加入一則訊息（{draft.messages.length}/{LIMITS.messagesPerPush}）
							</div>
							<div className="grid grid-cols-2 md:grid-cols-5 gap-2">
								{(Object.keys(KIND_LABELS) as MessageKind[]).map((kind) => (
									<button
										key={kind}
										type="button"
										onClick={() => addMessage(kind)}
										disabled={draft.messages.length >= LIMITS.messagesPerPush}
										className="text-left rounded-lg border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 hover:border-emerald-400 disabled:opacity-40 p-2"
									>
										<div className="text-xs font-semibold text-neutral-800 dark:text-neutral-200">{KIND_LABELS[kind].name}</div>
										<div className="text-[10px] text-neutral-500 leading-snug">{KIND_LABELS[kind].description}</div>
									</button>
								))}
							</div>
						</div>

						<div className="rounded-xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-3 space-y-2">
							<div className="text-xs font-semibold text-neutral-800 dark:text-neutral-200">快速回覆小圓鈕（掛在最後一則下方，選填）</div>
							<p className="text-[11px] text-neutral-500">點過或有新訊息就消失，適合立即追問；需要留痕的決定請用上方按鈕。</p>
							{errorsFor(-1).length > 0 && (
								<ul className="text-[11px] text-red-600 list-disc pl-4">
									{errorsFor(-1).map((e, k) => (
										<li key={k}>{e.message}</li>
									))}
								</ul>
							)}
							<ActionList
								actions={draft.quickReply}
								min={0}
								max={LIMITS.quickReplyItems}
								title="小圓鈕"
								onChange={(quickReply) => setDraft((d) => ({ ...d, quickReply }))}
							/>
						</div>
					</div>

					{/* 右：預覽 */}
					<div className="lg:col-span-2 flex flex-col min-h-0">
						<div className="px-4 py-2 text-[11px] font-medium text-neutral-500 border-b border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 flex items-center">
							預覽（近似）
							<span className="ml-auto text-neutral-400">
								{draft.messages.length} 則 · {trackable} 顆可追蹤按鈕
							</span>
						</div>
						<div className="flex-1 overflow-auto p-4 bg-[#8CABD9] dark:bg-[#3b4a63]">
							{messages.length ? <LinePreview messages={messages} /> : <p className="text-xs text-white/80">加入訊息後即可預覽</p>}
						</div>
					</div>
				</div>

				<div className="flex items-center gap-3 px-5 py-3 border-t border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900">
					{trackable > 0 && (
						<label className="flex items-center gap-1.5 text-xs text-neutral-600 dark:text-neutral-400" title="LINE 的按鈕可以反覆按；預設只採用第一次，之後再按只回覆提示不改結果">
							<input type="checkbox" checked={allowChange} onChange={(e) => setAllowChange(e.target.checked)} className="accent-emerald-600" />
							允許使用者更改回覆（取最後一次）
						</label>
					)}
					{error && <span className="text-xs text-red-600">{error}</span>}
					{!error && errors.length > 0 && (
						<span className="text-xs text-amber-600">還有 {errors.length} 項要修正才能送出</span>
					)}
					{!error && errors.length === 0 && draft.messages.length > 0 && (
						<span className="text-xs text-emerald-600">格式合法，可以送出</span>
					)}
					<button onClick={onClose} className="ml-auto text-sm px-4 py-2 rounded-lg text-neutral-600 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-800">
						取消
					</button>
					<button
						onClick={() => void submit()}
						disabled={sending || errors.length > 0 || draft.messages.length === 0}
						className="text-sm font-medium px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white"
					>
						{sending ? "送出中…" : "送出"}
					</button>
				</div>
			</div>
		</div>
	);
}

function summary(m: MessageDraft): string {
	switch (m.kind) {
		case "text":
			return m.text;
		case "confirm":
			return m.text;
		case "buttons":
			return m.title || m.text;
		case "carousel":
			return `${m.columns.length} 張卡`;
		case "card":
			return m.headerTitle || m.title || m.note;
	}
}
