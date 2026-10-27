import type { Notification, SendNotificationInput } from "../shared/types";
import { createNotification, getNotification, getNotificationPhoneHash, markNotificationDelivered, setNotificationResult } from "./db";
import { inboxStub } from "./inbox-do";
import { hashPhoneNumber, validateLineMessages, type LineClient } from "./line";
import { recordIntegrity } from "./integrity";

/**
 * 通知型訊息（PNP）中央發送紀錄。
 * - 先寫 notifications（pending）再呼叫 LINE，LINE 的回應與 request id 都存回去
 * - 發送時帶 X-Line-Delivery-Tag = 本筆 id，delivery 事件回來時用它對應，標 delivered
 * - delivery 只證明「LINE 已交付」，不代表使用者已讀；也無法反推訊息內容，所以內容一定先在本地保存
 * - PNP 需要與 LINE 另外簽約開通；未開通時 LINE 會回 4xx，狀態會是 failed 並附原因
 */

/** 輸入錯誤之類的失敗；跟 Notification 本身的 error 欄位（LINE 回的錯誤）不同 */
export interface PnpError {
	error: string;
	httpStatus: number;
}

export async function sendNotification(
	env: Env,
	client: LineClient,
	input: SendNotificationInput,
	source: "console" | "api",
	createdBy: string | null,
): Promise<Notification | PnpError> {
	const phone = await hashPhoneNumber(input.phone ?? "");
	if (!phone) return { error: "電話號碼格式不正確", httpStatus: 400 };
	const validated = validateLineMessages(input.messages);
	if (!validated.ok) return { error: validated.error, httpStatus: 400 };

	const id = crypto.randomUUID();
	const notification = await createNotification(env.DB, {
		id,
		phoneHash: phone.hash,
		phoneMasked: phone.masked,
		messages: validated.messages,
		source,
		note: input.note?.trim() || null,
		deliveryTag: id,
		createdBy,
		createdAt: Date.now(),
	});
	await inboxStub(env).broadcast({ type: "notification.updated", notification });
	return pushNotification(env, client, notification, phone.hash);
}

async function pushNotification(env: Env, client: LineClient, notification: Notification, phoneHash: string): Promise<Notification> {
	const result = await client.pushNotification(phoneHash, notification.messages, notification.deliveryTag);
	const updated = await setNotificationResult(env.DB, notification.id, result.ok ? "sent" : "failed", {
		lineStatus: result.status,
		lineRequestId: result.requestId,
		error: result.error,
		sentAt: result.ok ? Date.now() : null,
	});
	const final = updated ?? notification;
	if (!result.ok) {
		await recordIntegrity(env, {
			kind: "send_failed",
			severity: "warning",
			dedupeKey: `pnp_failed:${notification.id}`,
			title: `通知型訊息發送失敗（${result.status || "網路錯誤"}）`,
			details: { notificationId: notification.id, phoneMasked: notification.phoneMasked, error: result.error },
		});
	}
	await inboxStub(env).broadcast({ type: "notification.updated", notification: final });
	return final;
}

/** 只允許重送 failed 的；PNP 沒有 retry key，sent 的重送會真的再送一次 */
export async function retryNotification(env: Env, client: LineClient, id: string): Promise<Notification | PnpError> {
	const notification = await getNotification(env.DB, id);
	if (!notification) return { error: "找不到這筆通知", httpStatus: 404 };
	if (notification.status !== "failed") return { error: "只有發送失敗的通知可以重送", httpStatus: 409 };
	const hash = await getNotificationPhoneHash(env.DB, id);
	if (!hash) return { error: "找不到收件者", httpStatus: 500 };
	return pushNotification(env, client, notification, hash);
}

/** webhook delivery 事件 */
export async function handleDeliveryEvent(env: Env, deliveryTag: string, timestamp: number): Promise<void> {
	const notification = await markNotificationDelivered(env.DB, deliveryTag, timestamp);
	if (!notification) {
		// 不是我們發的（別的系統用同一個 channel 送 PNP）：留紀錄，這是「未受監控的發訊來源」
		await recordIntegrity(env, {
			kind: "send_unknown",
			severity: "info",
			dedupeKey: `pnp_foreign:${deliveryTag}`,
			title: "收到不屬於本系統的通知型訊息送達事件，可能有其他系統共用此 channel 發送 PNP",
			details: { deliveryTag, timestamp },
		});
		return;
	}
	await inboxStub(env).broadcast({ type: "notification.updated", notification });
}
