export { ReplyReminderWorkflow } from "./workflow";
export { InboxDO } from "./inbox-do";

import { isAuthorized, unauthorized } from "./auth";
import { handleLineWebhook } from "./webhook-line";
import { inboxStub } from "./inbox-do";
import { LineClient, TEXT_MESSAGE_MAX, buildPromptMessages } from "./line";
import { AGENT_REPLIED_EVENT } from "./workflow";
import {
	createPrompt,
	getConversation,
	getReminderInstanceId,
	insertMessage,
	listConversations,
	listMessages,
	listPrompts,
	markConversationRead,
	setConversationStatus,
	setReminderInstanceId,
} from "./db";
import type {
	ConversationStatus,
	PromptOption,
	PromptStatus,
	SendPromptInput,
} from "../shared/types";

/**
 * 路由
 * - POST /webhook/line                      LINE 平台呼叫（簽章驗證）
 * - GET  /ws?token=                         客服台即時連線
 * - GET  /api/me                            驗證 token 是否正確
 * - GET  /api/conversations?status=open     對話清單
 * - GET  /api/conversations/:id/messages    訊息（?before=<ts>&limit=）
 * - POST /api/conversations/:id/reply       客服回覆 { text }
 * - POST /api/conversations/:id/prompt      送可追蹤的選擇題 { body?, question, options[] }
 * - GET  /api/prompts?status=&conversationId= 可追蹤訊息與回覆結果
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

		if (pathname === "/api/prompts" && request.method === "GET") {
			const status = (url.searchParams.get("status") ?? "all") as PromptStatus | "all";
			const conversationId = url.searchParams.get("conversationId") ?? undefined;
			const prompts = await listPrompts(env.DB, { status, conversationId });
			return Response.json({ prompts });
		}

		const convMatch = pathname.match(
			/^\/api\/conversations\/([^/]+)\/(messages|reply|read|status|prompt)$/,
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

			if (action === "prompt" && request.method === "POST") {
				return handleSendPrompt(request, env, conversation.id, conversation.externalId, conversation.channel);
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

	await finishReminder(env, conversationId);

	return Response.json({ message: inserted.message, conversation: inserted.conversation });
}

/** 客服已回覆：結束逾時提醒流程 */
async function finishReminder(env: Env, conversationId: string): Promise<void> {
	const reminderId = await getReminderInstanceId(env.DB, conversationId);
	if (!reminderId) return;
	try {
		const instance = await env.REPLY_REMINDER.get(reminderId);
		await instance.sendEvent({ type: AGENT_REPLIED_EVENT, payload: {} });
	} catch {
		// instance 可能已結束
	}
	await setReminderInstanceId(env.DB, conversationId, null);
}

function normalizeOptions(raw: unknown): PromptOption[] | null {
	if (!Array.isArray(raw) || raw.length < 1 || raw.length > 2) return null;
	const options: PromptOption[] = [];
	for (const item of raw) {
		const label = typeof item?.label === "string" ? item.label.trim() : "";
		const value = typeof item?.value === "string" ? item.value.trim() : label;
		if (!label || !value || label.length > 20 || value.length > 50) return null;
		options.push({ label, value });
	}
	if (new Set(options.map((o) => o.value)).size !== options.length) return null;
	return options;
}

/**
 * 送出可追蹤的選擇題：正文（選填）+ Confirm 按鈕。
 * 先推 LINE，成功才寫 prompts 與 messages，避免留下沒送出的紀錄。
 */
async function handleSendPrompt(
	request: Request,
	env: Env,
	conversationId: string,
	recipientId: string,
	channel: string,
): Promise<Response> {
	const input = (await request.json().catch(() => ({}))) as Partial<SendPromptInput>;
	const question = input.question?.trim();
	const body = input.body?.trim() || null;
	const options = normalizeOptions(input.options);

	if (!question) return Response.json({ error: "question is required" }, { status: 400 });
	if (question.length > 240) return Response.json({ error: "question too long (max 240)" }, { status: 400 });
	if (body && body.length > TEXT_MESSAGE_MAX) return Response.json({ error: "body too long (max 5000)" }, { status: 400 });
	if (!options) return Response.json({ error: "options must be 1-2 items with label/value" }, { status: 400 });
	if (channel !== "line") return Response.json({ error: `channel ${channel} not supported yet` }, { status: 400 });
	if (!env.LINE_CHANNEL_ACCESS_TOKEN) return Response.json({ error: "LINE_CHANNEL_ACCESS_TOKEN not configured" }, { status: 500 });

	const variables =
		input.variables && typeof input.variables === "object"
			? Object.fromEntries(
					Object.entries(input.variables).filter(([, v]) => typeof v === "string"),
				)
			: null;

	const promptId = crypto.randomUUID();
	const now = Date.now();

	try {
		await new LineClient(env.LINE_CHANNEL_ACCESS_TOKEN).push(
			recipientId,
			buildPromptMessages({ promptId, body, question, options }),
		);
	} catch (err) {
		console.error("prompt push failed", err);
		return Response.json(
			{ error: err instanceof Error ? err.message : "LINE push failed" },
			{ status: 502 },
		);
	}

	const messageId = crypto.randomUUID();
	const inserted = await insertMessage(env.DB, {
		id: messageId,
		conversationId,
		direction: "outbound",
		sender: "agent",
		type: "prompt",
		text: body ? `${body}\n\n${question}` : question,
		metadata: { promptId, question, options, status: "pending" },
		createdAt: now,
	});
	if (!inserted) return Response.json({ error: "failed to persist message" }, { status: 500 });

	const prompt = await createPrompt(env.DB, {
		id: promptId,
		conversationId,
		messageId,
		templateKey: typeof input.templateKey === "string" ? input.templateKey : null,
		body,
		question,
		options,
		variables,
		createdAt: now,
	});

	const inbox = inboxStub(env);
	await inbox.broadcast({
		type: "message.new",
		message: inserted.message,
		conversation: inserted.conversation,
	});
	await inbox.broadcast({ type: "prompt.updated", prompt });
	await finishReminder(env, conversationId);

	return Response.json({ prompt, message: inserted.message, conversation: inserted.conversation });
}
