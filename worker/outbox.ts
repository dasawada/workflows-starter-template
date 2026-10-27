import type { Conversation, Message, MessageType, SendConflict } from "../shared/types";
import {
	findMessageByRetryKey,
	getConversation,
	getMessageRetryKey,
	insertMessage,
	listAgentMessagesAfter,
	setDeliveryStatus,
} from "./db";
import { inboxStub } from "./inbox-do";
import type { LineClient } from "./line";
import { recordIntegrity, resolveIntegrity } from "./integrity";

/**
 * 發訊 outbox：所有客服台送往 LINE 的訊息都走這裡。
 *
 * 順序是「先寫 D1（pending）→ 帶 X-Line-Retry-Key 推 LINE → 更新狀態」：
 * - 推成功但狀態更新失敗：訊息留在 pending，排程用同一把 key 重推，LINE 回 409 就知道早已送達
 * - 客服連點／網路逾時重送：同一把 clientKey 直接回傳既有訊息，不會再推一次
 * - LINE 明確拒絕（4xx）：標 failed，客服台顯示錯誤並可重試
 * - 暫時性失敗（5xx／429／網路）：留 pending，排程重推
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface OutboundInput {
	conversation: Conversation;
	type: MessageType;
	text: string | null;
	/** 實際送給 LINE 的訊息陣列 */
	payload: unknown[];
	metadata?: Record<string, unknown> | null;
	agentName: string | null;
	clientKey?: string;
	lastSeenMessageId?: string;
	force?: boolean;
}

export type OutboundResult =
	| { kind: "sent" | "pending"; message: Message; conversation: Conversation; reused: boolean }
	| { kind: "failed"; message: Message; conversation: Conversation; error: string }
	| { kind: "conflict"; conflict: SendConflict };

/** 衝突偵測：別的客服接手中，或在你最後看到的訊息之後有別的客服回覆 */
export async function detectConflict(env: Env, input: OutboundInput): Promise<SendConflict | null> {
	if (input.force) return null;
	const { conversation, agentName } = input;
	if (conversation.assignedTo && conversation.assignedTo !== agentName) {
		return {
			code: "assigned",
			error: `此對話目前由 ${conversation.assignedTo} 負責`,
			assignedTo: conversation.assignedTo,
		};
	}
	if (input.lastSeenMessageId) {
		const newer = await listAgentMessagesAfter(env.DB, conversation.id, input.lastSeenMessageId, agentName);
		if (newer.length) {
			return {
				code: "newer_reply",
				error: `${newer[0].agentName ?? "其他客服人員"} 已於您之後回覆此對話`,
				messages: newer,
			};
		}
	}
	return null;
}

export async function sendOutbound(env: Env, client: LineClient, input: OutboundInput): Promise<OutboundResult> {
	const conflict = await detectConflict(env, input);
	if (conflict) return { kind: "conflict", conflict };

	const retryKey = input.clientKey && UUID_RE.test(input.clientKey) ? input.clientKey.toLowerCase() : crypto.randomUUID();
	const existing = await findMessageByRetryKey(env.DB, retryKey);
	if (existing) {
		// 同一把 clientKey 已處理過（客服連點或前端逾時重送）：直接回既有結果，不再推一次
		const conversation = (await getConversation(env.DB, existing.conversationId)) ?? input.conversation;
		if (existing.deliveryStatus === "failed") {
			return { kind: "failed", message: existing, conversation, error: String(existing.metadata?.deliveryError ?? "LINE 平台拒絕此訊息") };
		}
		return { kind: existing.deliveryStatus === "sent" ? "sent" : "pending", message: existing, conversation, reused: true };
	}

	const inserted = await insertMessage(env.DB, {
		id: crypto.randomUUID(),
		conversationId: input.conversation.id,
		direction: "outbound",
		sender: "agent",
		type: input.type,
		text: input.text,
		metadata: { ...(input.metadata ?? {}), payload: input.payload },
		createdAt: Date.now(),
		source: "console",
		deliveryStatus: "pending",
		retryKey,
		agentName: input.agentName,
	});
	if (!inserted) throw new Error("failed to persist outbound message");

	const inbox = inboxStub(env);
	await inbox.broadcast({ type: "message.new", message: inserted.message, conversation: inserted.conversation });

	const message = await pushOutboundMessage(env, client, inserted.message, input.conversation.externalId);
	const conversation = (await getConversation(env.DB, input.conversation.id)) ?? inserted.conversation;
	if (message.deliveryStatus === "failed") {
		return { kind: "failed", message, conversation, error: String(message.metadata?.deliveryError ?? "LINE 平台拒絕此訊息") };
	}
	return { kind: message.deliveryStatus === "sent" ? "sent" : "pending", message, conversation, reused: false };
}

/** 實際推送（首次或重推都走這裡）；回傳更新後的訊息 */
export async function pushOutboundMessage(
	env: Env,
	client: LineClient,
	message: Message,
	recipientId?: string,
): Promise<Message> {
	const to = recipientId ?? (await getConversation(env.DB, message.conversationId))?.externalId;
	if (!to) return message;
	const payload = payloadOf(message);
	// retry key 不隨 Message 回給前端，重推時從 D1 取
	const retryKey = (await getMessageRetryKey(env.DB, message.id)) ?? undefined;
	const result = await client.push(to, payload, { retryKey });

	let updated: Message | null;
	if (result.ok || result.status === 409) {
		// 409：同一把 retry key 先前已被 LINE 接受，代表早就送達（回應也會帶原本的 sentMessages）
		updated = await setDeliveryStatus(env.DB, message.id, "sent", {
			lineRequestId: result.requestId,
			lineStatus: result.status,
			sentMessages: result.sentMessages,
		});
		if (message.deliveryStatus === "failed" || message.deliveryStatus === "unknown") {
			await resolveIntegrity(env, `send_unknown:${message.id}`, "重新推送後 LINE 確認已送達");
			await resolveIntegrity(env, `send_failed:${message.id}`, "重新推送後 LINE 確認已送達");
		}
	} else if (result.transient) {
		// 留在 pending，排程會再試
		updated = await setDeliveryStatus(env.DB, message.id, "pending", {
			error: result.error,
			lineRequestId: result.requestId,
			lineStatus: result.status,
		});
	} else {
		updated = await setDeliveryStatus(env.DB, message.id, "failed", {
			error: result.error,
			lineRequestId: result.requestId,
			lineStatus: result.status,
		});
		await recordIntegrity(env, {
			kind: "send_failed",
			severity: "warning",
			conversationId: message.conversationId,
			messageId: message.id,
			dedupeKey: `send_failed:${message.id}`,
			title: "LINE 平台拒絕客服訊息，使用者未收到",
			details: { status: result.status, error: result.error, text: message.text?.slice(0, 200) ?? null, agentName: message.agentName },
			startedAt: message.createdAt,
		});
	}
	const final = updated ?? message;
	const conversation = await getConversation(env.DB, message.conversationId);
	if (conversation) {
		await inboxStub(env).broadcast({ type: "message.new", message: final, conversation });
	}
	return final;
}

function payloadOf(message: Message): unknown[] {
	const payload = message.metadata?.payload;
	if (Array.isArray(payload) && payload.length) return payload;
	return [{ type: "text", text: message.text ?? "" }];
}
