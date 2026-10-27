import { useCallback, useEffect, useState } from "react";
import type { IntegrityEvent, IntegrityHealth, IntegrityKind, IntegrityStatus } from "../../shared/types";
import { api } from "../api";
import { formatListTime } from "../format";

interface Props {
	/** App 收到 integrity.updated 時遞增，面板重新抓資料 */
	refreshKey: number;
	onOpenConversation: (id: string) => void;
	onClose: () => void;
}

const KIND_LABEL: Record<IntegrityKind, string> = {
	quote_missing: "引用找不到原文",
	media_failed: "附件下載失敗",
	media_expired: "附件已過期",
	send_failed: "發送被拒絕",
	send_unknown: "送達結果不明",
	webhook_redelivery: "LINE 曾重送",
	event_dead_lettered: "事件處理放棄",
	chat_mode: "Chat 模式",
	agent_report: "客服回報",
	import: "歷史匯入",
};

const SEVERITY_CLASS = {
	info: "bg-neutral-200 text-neutral-700 dark:bg-neutral-700 dark:text-neutral-200",
	warning: "bg-amber-100 text-amber-800 dark:bg-amber-900/50 dark:text-amber-300",
	error: "bg-red-100 text-red-700 dark:bg-red-900/50 dark:text-red-300",
};

function ago(ts: number | null, now: number): string {
	if (!ts) return "從未";
	const s = Math.max(0, Math.round((now - ts) / 1000));
	if (s < 60) return `${s} 秒前`;
	if (s < 3600) return `${Math.round(s / 60)} 分鐘前`;
	if (s < 86400) return `${Math.round(s / 3600)} 小時前`;
	return `${Math.round(s / 86400)} 天前`;
}

/**
 * 完整性中心：接收端健康 ≠ 資料完整。每個數字都只代表它自己能證明的事。
 */
export function IntegrityPanel({ refreshKey, onOpenConversation, onClose }: Props) {
	const [health, setHealth] = useState<IntegrityHealth | null>(null);
	const [events, setEvents] = useState<IntegrityEvent[]>([]);
	const [status, setStatus] = useState<IntegrityStatus | "all">("open");
	const [kind, setKind] = useState<IntegrityKind | "">("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const load = useCallback(async () => {
		try {
			const [h, e] = await Promise.all([api.integrityHealth(), api.integrityEvents(status, kind || undefined)]);
			setHealth(h);
			setEvents(e.events);
			setError(null);
		} catch (err) {
			setError(err instanceof Error ? err.message : "載入失敗");
		}
	}, [status, kind]);

	useEffect(() => {
		void load();
	}, [load, refreshKey]);

	const runMaintenance = async () => {
		setBusy(true);
		try {
			await api.runMaintenance();
			await load();
		} catch (err) {
			setError(err instanceof Error ? err.message : "執行失敗");
		} finally {
			setBusy(false);
		}
	};

	const resolve = async (event: IntegrityEvent) => {
		const resolution = window.prompt("處理結果（會留在紀錄裡）", "");
		if (resolution === null) return;
		try {
			await api.resolveIntegrityEvent(event.id, resolution);
			await load();
		} catch (err) {
			setError(err instanceof Error ? err.message : "更新失敗");
		}
	};

	const now = health?.now ?? Date.now();
	const webhookStale = !!health && (!health.lastWebhookAt || now - health.lastWebhookAt > 24 * 3600_000);
	const autoRead = health?.botInfo ? health.botInfo.markAsReadMode !== "manual" : null;

	return (
		<div className="flex flex-col h-full">
			<header className="flex items-center gap-2 px-4 py-3 border-b border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900">
				<h2 className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">對話完整性中心</h2>
				{health && health.openTotal > 0 && (
					<span className="text-[11px] px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-800 dark:bg-amber-900/50 dark:text-amber-300 font-semibold">
						{health.openTotal} 項未處理
					</span>
				)}
				<button
					onClick={() => void runMaintenance()}
					disabled={busy}
					title="補推送出中的訊息、補抓附件、重新讀取官方帳號設定（排程每 5 分鐘也會自動做）"
					className="ml-auto text-xs px-3 py-1.5 rounded-md border border-neutral-300 dark:border-neutral-700 text-neutral-700 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-800 disabled:opacity-50"
				>
					{busy ? "檢查中…" : "立即檢查"}
				</button>
				<button onClick={onClose} className="text-xs px-3 py-1.5 rounded-md text-neutral-600 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-800">
					關閉
				</button>
			</header>

			<div className="flex-1 overflow-auto bg-neutral-50 dark:bg-neutral-950 p-4 space-y-4">
				{error && <p className="text-xs text-red-600 dark:text-red-400">{error}</p>}

				{health && (
					<section className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
						<Card
							title="Webhook 接收"
							value={ago(health.lastWebhookAt, now)}
							tone={webhookStale ? "warn" : "ok"}
							hint={`最後收到事件的時間（${health.webhookMode === "queue" ? "queue 模式" : "inline 模式"}）。接收端正常不代表 LINE 的每一則都到了。`}
						/>
						<Card
							title="LINE 重送"
							value={ago(health.lastRedeliveryAt, now)}
							tone={health.lastRedeliveryAt && now - health.lastRedeliveryAt < 24 * 3600_000 ? "warn" : "ok"}
							hint="LINE 標記為重送的事件，代表接收端那段時間曾經失敗；重送不保證涵蓋所有事件。"
						/>
						<Card
							title="已讀模式"
							value={health.botInfo ? (autoRead ? "LINE 自動已讀" : "客服台控制") : "未知"}
							tone={autoRead === null ? "warn" : autoRead ? "warn" : "ok"}
							hint={
								health.botInfo
									? `Chat ${health.botInfo.chatMode === "chat" ? "開啟" : "關閉"}、markAsReadMode = ${health.botInfo.markAsReadMode}（${ago(health.botInfoAt, now)} 讀取）`
									: "尚未讀到官方帳號設定，按「立即檢查」"
							}
						/>
						<Card
							title="上次維護"
							value={ago(health.lastMaintenanceAt, now)}
							tone={health.lastMaintenanceAt && now - health.lastMaintenanceAt < 15 * 60_000 ? "ok" : "warn"}
							hint="排程每 5 分鐘：補推、補抓附件、刷新設定。超過 15 分鐘沒跑代表 cron 沒有啟用。"
						/>
						<Card
							title="客服訊息"
							value={`送出中 ${health.outbound.pending} · 失敗 ${health.outbound.failed} · 不明 ${health.outbound.unknown}`}
							tone={health.outbound.failed + health.outbound.unknown > 0 ? "bad" : health.outbound.pending > 0 ? "warn" : "ok"}
							hint="送出中會自動重推；失敗可在對話裡重試；不明 = 超過 24 小時無法確認，需人工向使用者確認。"
						/>
						<Card
							title="附件"
							value={`待抓 ${health.media.pending} · 失敗 ${health.media.failed} · 過期 ${health.media.expired}`}
							tone={health.media.expired > 0 ? "bad" : health.media.failed > 0 ? "warn" : "ok"}
							hint="LINE 只保留附件一段時間；過期的永久拿不到，對話裡會標示。"
						/>
						<Card
							title="匯入待配對"
							value={String(health.importsUnmatched)}
							tone={health.importsUnmatched > 0 ? "warn" : "ok"}
							hint="CSV 匯入後找不到對應對話的列，在「匯入」頁指派。"
						/>
						<Card
							title="未處理缺口"
							value={String(health.openTotal)}
							tone={health.openTotal > 0 ? "warn" : "ok"}
							hint={Object.entries(health.openByKind)
								.map(([k, n]) => `${KIND_LABEL[k as IntegrityKind]} ${n}`)
								.join("、") || "沒有已知缺口（不等於沒有缺口）"}
						/>
					</section>
				)}

				<section>
					<div className="flex items-center gap-2 mb-2">
						<div className="flex gap-1">
							{(["open", "resolved", "all"] as const).map((s) => (
								<button
									key={s}
									onClick={() => setStatus(s)}
									className={`text-xs px-2.5 py-1 rounded-md ${
										status === s
											? "bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900"
											: "text-neutral-600 dark:text-neutral-400 hover:bg-neutral-100 dark:hover:bg-neutral-800"
									}`}
								>
									{s === "open" ? "未處理" : s === "resolved" ? "已處理" : "全部"}
								</button>
							))}
						</div>
						<select
							value={kind}
							onChange={(e) => setKind(e.target.value as IntegrityKind | "")}
							className="text-xs rounded-md border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-800 px-2 py-1"
						>
							<option value="">所有類型</option>
							{(Object.keys(KIND_LABEL) as IntegrityKind[]).map((k) => (
								<option key={k} value={k}>
									{KIND_LABEL[k]}
								</option>
							))}
						</select>
					</div>

					{events.length === 0 ? (
						<p className="text-sm text-neutral-500 text-center py-6">沒有符合的紀錄</p>
					) : (
						<ul className="space-y-2">
							{events.map((e) => (
								<li key={e.id} className="rounded-lg bg-white dark:bg-neutral-900 ring-glass px-3 py-2 text-xs">
									<div className="flex items-center gap-2">
										<span className={`px-1.5 py-0.5 rounded font-medium ${SEVERITY_CLASS[e.severity]}`}>{KIND_LABEL[e.kind]}</span>
										{Number(e.details?.count) > 1 && (
											<span className="text-neutral-500">×{String(e.details!.count)}</span>
										)}
										<span className="text-neutral-500 ml-auto whitespace-nowrap">{formatListTime(e.createdAt)}</span>
									</div>
									<div className="mt-1 text-neutral-900 dark:text-neutral-100">{e.title}</div>
									<div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-neutral-500">
										{e.conversationId && (
											<button onClick={() => onOpenConversation(e.conversationId!)} className="underline">
												{e.displayName ?? e.conversationId}
											</button>
										)}
										{e.startedAt && (
											<span>
												期間 {formatListTime(e.startedAt)}
												{e.endedAt && e.endedAt !== e.startedAt ? ` – ${formatListTime(e.endedAt)}` : ""}
											</span>
										)}
										{e.createdBy && <span>由 {e.createdBy} 回報</span>}
										{e.status === "resolved" ? (
											<span className="text-emerald-600 dark:text-emerald-400">已處理{e.resolution ? `：${e.resolution}` : ""}</span>
										) : (
											<button onClick={() => void resolve(e)} className="ml-auto underline">
												標記已處理
											</button>
										)}
									</div>
									{e.details && (
										<details className="mt-1">
											<summary className="cursor-pointer text-neutral-400">詳細</summary>
											<pre className="mt-1 whitespace-pre-wrap break-all text-[10px] text-neutral-500 max-h-48 overflow-auto">
												{JSON.stringify(e.details, null, 2)}
											</pre>
										</details>
									)}
								</li>
							))}
						</ul>
					)}
				</section>
			</div>
		</div>
	);
}

function Card({ title, value, hint, tone }: { title: string; value: string; hint: string; tone: "ok" | "warn" | "bad" }) {
	const dot = tone === "ok" ? "bg-emerald-500" : tone === "warn" ? "bg-amber-500" : "bg-red-500";
	return (
		<div className="rounded-lg bg-white dark:bg-neutral-900 ring-glass px-3 py-2" title={hint}>
			<div className="flex items-center gap-1.5 text-neutral-500">
				<span className={`w-2 h-2 rounded-full ${dot}`} />
				{title}
			</div>
			<div className="mt-1 text-sm font-semibold text-neutral-900 dark:text-neutral-100 truncate">{value}</div>
			<div className="mt-0.5 text-[10px] text-neutral-400 line-clamp-2">{hint}</div>
		</div>
	);
}
