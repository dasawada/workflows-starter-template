export { ReplyReminderWorkflow } from "./workflow";
export { InboxDO } from "./inbox-do";

import { isAuthorized, unauthorized } from "./auth";
import { handleLineWebhook } from "./webhook-line";
import { inboxStub } from "./inbox-do";
import { LineClient } from "./line";
import { AGENT_REPLIED_EVENT } from "./workflow";
import {
	getConversation,
	getReminderInstanceId,
	insertMessage,
	listConversations,
	listMessages,
	markConversationRead,
	setConversationStatus,
	setReminderInstanceId,
} from "./db";
import type { ConversationStatus } from "../shared/types";

/**
 * 路由
 * - POST /webhook/line                      LINE 平台呼叫（簽章驗證）
 * - GET  /ws?token=                         客服台即時連線
 * - GET  /api/me                            驗證 token 是否正確
 * - GET  /api/conversations?status=open     對話清單
 * - GET  /api/conversations/:id/messages    訊息（?before=<ts>&limit=）
 * - POST /api/conversations/:id/reply       客服回覆 { text }
 * - POST /api/conversations/:id/read        清除未讀
 * - POST /api/conversations/:id/status      { status: "open" | "closed" }
 * - GET  /api/media/:key                    R2 媒體
 */
export default {
	async fetch(request, env, ctx): Promise<Response> {
		const url = new URL(request.url);
		const { pathname } = url;

		if (pathname === "/webhook/line" && request.method === "POST") {
			return handleLineWebhook(request, env, ctx);
		}

		// 以下全部需要客服台 token
		if (pathname === "/ws" || pathname.startsWith("/api/")) {
			if (!isAuthorized(request, env)) return unauthorized();
		}

		if (pathname === "/ws") {
			if (request.headers.get("Upgrade") !== "websocket") {
				return new Response("Expected Upgrade: websocket", { status: 426 });
			}
			return inboxStub(env).fetch(request);
		}

		if (pathname === "/api/me") {
			return Response.json({ ok: true });
		}

		if (pathname === "/api/conversations" && request.method === "GET") {
			const status = (url.searchParams.get("status") ?? "open") as
				| ConversationStatus
				| "all";
			const conversations = await listConversations(env.DB, status);
			return Response.json({ conversations });
		}

		const convMatch = pathname.match(
			/^\/api\/conversations\/([^/]+)\/(messages|reply|read|status)$/,
		);
		if (convMatch) {
			const conversationId = decodeURIComponent(convMatch[1]);
			const action = convMatch[2];
			const conversation = await getConversation(env.DB, conversationId);
			if (!conversation) {
				return Response.json({ error: "Conversation not found" }, { status: 404 });
			}

			if (action === "messages" && request.method === "GET") {
				const before = Number(url.searchParams.get("before")) || undefined;
				const limit = Number(url.searchParams.get("limit")) || undefined;
				const messages = await listMessages(env.DB, conversationId, {
					before,
					limit,
				});
				return Response.json({ messages });
			}

			if (action === "read" && request.method === "POST") {
				const updated = await markConversationRead(env.DB, conversationId);
				if (updated) {
					await inboxStub(env).broadcast({
						type: "conversation.updated",
						conversation: updated,
					});
				}
				return Response.json({ conversation: updated });
			}

			if (action === "status" && request.method === "POST") {
				const body = (await request.json().catch(() => ({}))) as {
					status?: string;
				};
				if (body.status !== "open" && body.status !== "closed") {
					return Response.json({ error: "status must be open|closed" }, { status: 400 });
				}
				const updated = await setConversationStatus(
					env.DB,
					conversationId,
					body.status,
				);
				if (updated) {
					await inboxStub(env).broadcast({
						type: "conversation.updated",
						conversation: updated,
					});
				}
				return Response.json({ conversation: updated });
			}

			if (action === "reply" && request.method === "POST") {
				return handleReply(request, env, conversation.id, conversation.externalId, conversation.channel);
			}
		}

		const mediaMatch = pathname.match(/^\/api\/media\/(.+)$/);
		if (mediaMatch && request.method === "GET") {
			const key = decodeURIComponent(mediaMatch[1]);
			const object = await env.MEDIA.get(key);
			if (!object) return new Response("Not found", { status: 404 });
			const headers = new Headers();
			object.writeHttpMetadata(headers);
			headers.set("etag", object.httpEtag);
			headers.set("cache-control", "private, max-age=3600");
			return new Response(object.body, { headers });
		}

		return Response.json({ error: "Not Found" }, { status: 404 });
	},
} satisfies ExportedHandler<Env>;

async function handleReply(
	request: Request,
	env: Env,
	conversationId: string,
	recipientId: string,
	channel: string,
): Promise<Response> {
	const body = (await request.json().catch(() => ({}))) as { text?: string };
	const text = body.text?.trim();
	if (!text) {
		return Response.json({ error: "text is required" }, { status: 400 });
	}
	if (text.length > 5000) {
		return Response.json({ error: "text too long (max 5000)" }, { status: 400 });
	}

	if (channel !== "line") {
		return Response.json({ error: `channel ${channel} not supported yet` }, { status: 400 });
	}
	if (!env.LINE_CHANNEL_ACCESS_TOKEN) {
		return Response.json({ error: "LINE_CHANNEL_ACCESS_TOKEN not configured" }, { status: 500 });
	}

	try {
		await new LineClient(env.LINE_CHANNEL_ACCESS_TOKEN).pushText(recipientId, text);
	} catch (err) {
		console.error("push failed", err);
		return Response.json(
			{ error: err instanceof Error ? err.message : "LINE push failed" },
			{ status: 502 },
		);
	}

	const inserted = await insertMessage(env.DB, {
		id: crypto.randomUUID(),
		conversationId,
		direction: "outbound",
		sender: "agent",
		type: "text",
		text,
		createdAt: Date.now(),
	});
	if (!inserted) {
		return Response.json({ error: "failed to persist message" }, { status: 500 });
	}

	await inboxStub(env).broadcast({
		type: "message.new",
		message: inserted.message,
		conversation: inserted.conversation,
	});

	// 結束逾時提醒流程
	const reminderId = await getReminderInstanceId(env.DB, conversationId);
	if (reminderId) {
		try {
			const instance = await env.REPLY_REMINDER.get(reminderId);
			await instance.sendEvent({ type: AGENT_REPLIED_EVENT, payload: {} });
		} catch {
			// instance 可能已結束
		}
		await setReminderInstanceId(env.DB, conversationId, null);
	}

	return Response.json({ message: inserted.message, conversation: inserted.conversation });
}
