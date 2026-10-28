import type { IntegrityHealth, IntegrityKind, IntegritySeverity, LineBotInfo } from "../shared/types";
import {
	getIntegrityCounts,
	getSystemState,
	listPendingMedia,
	listPendingOutbound,
	resolveIntegrityByDedupeKey,
	setDeliveryStatus,
	setSystemState,
	upsertIntegrityEvent,
	type NewIntegrityEvent,
} from "./db";
import { inboxStub } from "./inbox-do";
import { lineClientFor } from "./line-env";
import { storeMedia } from "./media";
import { pushOutboundMessage } from "./outbox";
import { recordMetric } from "./metrics";

/**
 * 對話完整性：缺口紀錄、同步健康狀態、排程維護。
 * 原則：沒有證據證明完整，就不宣稱完整。每個已知的缺口都要留下紀錄，由工程端以 npm run reports 判讀（客服台不顯示）。
 */

export const STATE_KEYS = {
	lastWebhookAt: "webhook.last_received_at",
	lastRedeliveryAt: "webhook.last_redelivery_at",
	lastMaintenanceAt: "maintenance.last_run_at",
	botInfo: "line.bot_info",
} as const;

/** X-Line-Retry-Key 的有效期：超過就無法靠重送確認結果 */
export const RETRY_KEY_TTL_MS = 24 * 60 * 60 * 1000;
/** 附件最多重抓幾次 */
export const MEDIA_MAX_ATTEMPTS = 5;

export async function recordIntegrity(
	env: Env,
	input: Omit<NewIntegrityEvent, "id" | "createdAt"> & { id?: string; createdAt?: number },
): Promise<void> {
	try {
		const event = await upsertIntegrityEvent(env.DB, {
			...input,
			id: input.id ?? crypto.randomUUID(),
			createdAt: input.createdAt ?? Date.now(),
		});
		recordMetric(env, { name: "integrity.event", labels: [input.kind, input.severity], values: [1] });
		await inboxStub(env).broadcast({ type: "integrity.updated", event });
	} catch (err) {
		// 缺口紀錄本身失敗不能影響主流程，但要留 log
		console.error("record integrity event failed", input.kind, err);
	}
}

export async function resolveIntegrity(env: Env, dedupeKey: string, resolution: string): Promise<void> {
	try {
		const event = await resolveIntegrityByDedupeKey(env.DB, dedupeKey, resolution);
		if (event) await inboxStub(env).broadcast({ type: "integrity.updated", event });
	} catch (err) {
		console.error("resolve integrity event failed", dedupeKey, err);
	}
}

export function severityOf(kind: IntegrityKind): IntegritySeverity {
	switch (kind) {
		case "event_dead_lettered":
		case "send_unknown":
		case "media_expired":
			return "error";
		case "import":
			return "info";
		default:
			return "warning";
	}
}

export async function getHealth(env: Env): Promise<IntegrityHealth> {
	const [state, counts] = await Promise.all([
		getSystemState(env.DB, Object.values(STATE_KEYS)),
		getIntegrityCounts(env.DB),
	]);
	const num = (key: string) => {
		const v = state[key]?.value;
		return v ? Number(v) || null : null;
	};
	let botInfo: LineBotInfo | null = null;
	try {
		botInfo = state[STATE_KEYS.botInfo]?.value ? (JSON.parse(state[STATE_KEYS.botInfo].value!) as LineBotInfo) : null;
	} catch {
		botInfo = null;
	}
	const openTotal = Object.values(counts.openByKind).reduce((a, b) => a + (b ?? 0), 0);
	return {
		now: Date.now(),
		webhookMode: (env.WEBHOOK_MODE as string) === "queue" && env.LINE_EVENTS ? "queue" : "inline",
		lastWebhookAt: num(STATE_KEYS.lastWebhookAt),
		lastRedeliveryAt: num(STATE_KEYS.lastRedeliveryAt),
		lastMaintenanceAt: num(STATE_KEYS.lastMaintenanceAt),
		botInfo,
		botInfoAt: state[STATE_KEYS.botInfo]?.updatedAt ?? null,
		openTotal,
		openByKind: counts.openByKind,
		outbound: counts.outbound,
		media: counts.media,
		importsUnmatched: counts.importsUnmatched,
	};
}

/** 抓官方帳號設定並快取；Chat 模式改變會留一筆事件，因為它直接影響已讀行為 */
export async function refreshBotInfo(env: Env): Promise<LineBotInfo | null> {
	if (!env.LINE_CHANNEL_ACCESS_TOKEN) return null;
	const info = await lineClientFor(env).getBotInfo();
	if (!info) return null;
	const previous = (await getSystemState(env.DB, [STATE_KEYS.botInfo]))[STATE_KEYS.botInfo]?.value ?? null;
	await setSystemState(env.DB, { [STATE_KEYS.botInfo]: JSON.stringify(info) });
	let prevInfo: LineBotInfo | null = null;
	try {
		prevInfo = previous ? (JSON.parse(previous) as LineBotInfo) : null;
	} catch {
		prevInfo = null;
	}
	if (info.markAsReadMode !== "manual") {
		await recordIntegrity(env, {
			kind: "chat_mode",
			severity: "warning",
			dedupeKey: "chat_mode:auto",
			title: "官方帳號的 Chat 功能目前為關閉狀態。LINE 會自動將收到的訊息標記為已讀，此狀態不代表客服人員已實際閱讀。",
			details: { chatMode: info.chatMode, markAsReadMode: info.markAsReadMode, previous: prevInfo?.markAsReadMode ?? null },
		});
	} else {
		await resolveIntegrity(env, "chat_mode:auto", "Chat 功能已開啟，已讀狀態改由客服台控制");
	}
	return info;
}

/**
 * 排程維護（cron 每 5 分鐘，也可用 POST /api/integrity/maintenance 手動觸發）：
 * 1. 送出中超過 1 分鐘未確認的客服訊息：用同一把 retry key 重推，LINE 回 409 代表早已送達；超過 24 小時標 unknown 並記缺口
 * 2. 附件還沒抓到或抓失敗：重抓，404/410 標過期並記缺口
 * 3. 重新抓 bot info
 */
export async function runMaintenance(env: Env): Promise<{ outbound: number; media: number; botInfo: boolean }> {
	const now = Date.now();
	let outbound = 0;
	let media = 0;

	if (env.LINE_CHANNEL_ACCESS_TOKEN) {
		const client = lineClientFor(env);
		for (const message of await listPendingOutbound(env.DB, now - 60_000)) {
			outbound++;
			if (now - message.createdAt > RETRY_KEY_TTL_MS) {
				await setDeliveryStatus(env.DB, message.id, "unknown", { error: "超過 24 小時仍無法確認送達結果" });
				await recordIntegrity(env, {
					kind: "send_unknown",
					severity: "error",
					conversationId: message.conversationId,
					messageId: message.id,
					dedupeKey: `send_unknown:${message.id}`,
					title: "客服訊息送達結果不明：無法確認 LINE 是否已發送，請向使用者確認",
					details: { text: message.text?.slice(0, 200) ?? null, agentName: message.agentName },
					startedAt: message.createdAt,
				});
				continue;
			}
			await pushOutboundMessage(env, client, message);
		}

		for (const message of await listPendingMedia(env.DB, now - 2 * 60_000)) {
			media++;
			await storeMedia(env, client, message);
		}
	}

	let botInfo = false;
	try {
		botInfo = (await refreshBotInfo(env)) !== null;
	} catch (err) {
		console.error("refresh bot info failed", err);
	}

	await setSystemState(env.DB, { [STATE_KEYS.lastMaintenanceAt]: String(now) });
	recordMetric(env, { name: "maintenance.run", labels: ["ok"], values: [Date.now() - now, outbound, media] });
	return { outbound, media, botInfo };
}
