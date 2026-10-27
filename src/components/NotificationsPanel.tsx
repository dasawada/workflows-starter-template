import { useCallback, useEffect, useState } from "react";
import type { Notification, NotificationStatus } from "../../shared/types";
import { api } from "../api";
import { formatListTime } from "../format";

interface Props {
	refreshKey: number;
	onClose: () => void;
}

const STATUS_LABEL: Record<NotificationStatus, { text: string; cls: string }> = {
	pending: { text: "發送中", cls: "bg-amber-100 text-amber-800 dark:bg-amber-900/50 dark:text-amber-300" },
	sent: { text: "LINE 已接受", cls: "bg-neutral-200 text-neutral-700 dark:bg-neutral-700 dark:text-neutral-200" },
	delivered: { text: "已送達", cls: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/50 dark:text-emerald-300" },
	failed: { text: "發送失敗", cls: "bg-red-100 text-red-700 dark:bg-red-900/50 dark:text-red-300" },
};

/**
 * 通知型訊息（PNP）：以電話號碼發送，不需要對方加好友；需要與 LINE 另外簽約開通。
 * 「已送達」來自 LINE 的 delivery 事件，只代表交付，不代表已讀。
 */
export function NotificationsPanel({ refreshKey, onClose }: Props) {
	const [items, setItems] = useState<Notification[]>([]);
	const [phone, setPhone] = useState("");
	const [text, setText] = useState("");
	const [note, setNote] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const load = useCallback(async () => {
		try {
			setItems((await api.listNotifications()).notifications);
		} catch (err) {
			setError(err instanceof Error ? err.message : "載入失敗");
		}
	}, []);

	useEffect(() => {
		void load();
	}, [load, refreshKey]);

	const send = async () => {
		if (!phone.trim() || !text.trim()) return;
		setBusy(true);
		setError(null);
		try {
			await api.sendNotification({ phone: phone.trim(), messages: [{ type: "text", text: text.trim() }], note: note.trim() || undefined });
			setText("");
			setNote("");
			await load();
		} catch (err) {
			setError(err instanceof Error ? err.message : "發送失敗");
			await load();
		} finally {
			setBusy(false);
		}
	};

	const retry = async (n: Notification) => {
		try {
			await api.retryNotification(n.id);
		} catch (err) {
			setError(err instanceof Error ? err.message : "重送失敗");
		}
		await load();
	};

	return (
		<div className="flex flex-col h-full">
			<header className="flex items-center gap-2 px-4 py-3 border-b border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900">
				<h2 className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">通知型訊息（PNP）</h2>
				<span className="text-[11px] text-neutral-500">以電話號碼為對象發送。此功能需向 LINE 申請開通；尚未開通時，發送結果會顯示失敗原因。</span>
				<button onClick={onClose} className="ml-auto text-xs px-3 py-1.5 rounded-md text-neutral-600 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-800">
					關閉
				</button>
			</header>

			<div className="flex-1 overflow-auto bg-neutral-50 dark:bg-neutral-950 p-4 space-y-4 text-xs">
				{error && <p className="text-red-600 dark:text-red-400">{error}</p>}
				<section className="rounded-lg bg-white dark:bg-neutral-900 ring-glass p-3 grid gap-2 md:grid-cols-[12rem_1fr_10rem_auto] items-end">
					<label className="flex flex-col gap-0.5 text-neutral-500">
						電話號碼
						<input
							value={phone}
							onChange={(e) => setPhone(e.target.value)}
							placeholder="例如 0912-345-678 或 +886912345678"
							className="rounded-md border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-800 px-2 py-1.5 text-neutral-900 dark:text-neutral-100"
						/>
					</label>
					<label className="flex flex-col gap-0.5 text-neutral-500">
						內容（純文字）
						<input
							value={text}
							onChange={(e) => setText(e.target.value)}
							maxLength={5000}
							placeholder="例如：您的訂單已出貨"
							className="rounded-md border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-800 px-2 py-1.5 text-neutral-900 dark:text-neutral-100"
						/>
					</label>
					<label className="flex flex-col gap-0.5 text-neutral-500">
						備註（例如訂單編號）
						<input
							value={note}
							onChange={(e) => setNote(e.target.value)}
							className="rounded-md border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-800 px-2 py-1.5 text-neutral-900 dark:text-neutral-100"
						/>
					</label>
					<button
						onClick={() => void send()}
						disabled={busy || !phone.trim() || !text.trim()}
						className="px-3 py-1.5 rounded-md bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50"
					>
						{busy ? "發送中…" : "發送"}
					</button>
				</section>

				{items.length === 0 ? (
					<p className="text-neutral-500 text-center py-6">尚無發送紀錄</p>
				) : (
					<table className="w-full bg-white dark:bg-neutral-900 ring-glass rounded-lg">
						<thead className="text-neutral-500">
							<tr>
								<th className="text-left px-3 py-2 font-medium">時間</th>
								<th className="text-left px-3 py-2 font-medium">收件者</th>
								<th className="text-left px-3 py-2 font-medium">內容</th>
								<th className="text-left px-3 py-2 font-medium">備註</th>
								<th className="text-left px-3 py-2 font-medium">狀態</th>
								<th className="text-left px-3 py-2 font-medium">送達時間</th>
								<th className="text-left px-3 py-2 font-medium">發送者</th>
							</tr>
						</thead>
						<tbody>
							{items.map((n) => {
								const first = n.messages[0] as { type?: string; text?: string; altText?: string } | undefined;
								const s = STATUS_LABEL[n.status];
								return (
									<tr key={n.id} className="border-t border-neutral-100 dark:border-neutral-800 align-top">
										<td className="px-3 py-2 whitespace-nowrap">{formatListTime(n.createdAt)}</td>
										<td className="px-3 py-2 whitespace-nowrap font-mono">{n.phoneMasked}</td>
										<td className="px-3 py-2 max-w-xs">
											<div className="line-clamp-2">{first?.text ?? first?.altText ?? `[${first?.type ?? "訊息"}]`}</div>
										</td>
										<td className="px-3 py-2">{n.note ?? ""}</td>
										<td className="px-3 py-2 whitespace-nowrap">
											<span className={`px-1.5 py-0.5 rounded font-medium ${s.cls}`} title={n.error ?? n.lineRequestId ?? ""}>
												{s.text}
											</span>
											{n.status === "failed" && (
												<>
													<div className="text-red-600 dark:text-red-400 mt-1 max-w-48 truncate" title={n.error ?? ""}>
														{n.error}
													</div>
													<button onClick={() => void retry(n)} className="underline mt-0.5">
														重新發送
													</button>
												</>
											)}
										</td>
										<td className="px-3 py-2 whitespace-nowrap">{n.deliveredAt ? formatListTime(n.deliveredAt) : ""}</td>
										<td className="px-3 py-2">{n.createdBy ?? ""}</td>
									</tr>
								);
							})}
						</tbody>
					</table>
				)}
			</div>
		</div>
	);
}
