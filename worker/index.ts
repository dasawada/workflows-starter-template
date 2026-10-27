export { ReplyReminderWorkflow } from "./workflow";
export { InboxDO } from "./inbox-do";

import { isAuthorized, unauthorized } from "./auth";
import { consumeLineEvents, handleLineWebhook, lineClientFor, type LineEventJob } from "./webhook-line";
import { recordMetric } from "./metrics";
import { inboxStub } from "./inbox-do";
import {
	TEXT_MESSAGE_MAX,
	buildPromptMessages,
	instrumentPostbacks,
	summarizeMessages,
	validateLineMessages,
} from "./line";
import { AGENT_REPLIED_EVENT } from "./workflow";
import {
	createPrompt,
	getConversation,
	getStats,
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
	SendMessagesInput,
	SendPromptInput,
} from "../shared/types";

/**
 * 路由
 * - POST /webhook/line                      LINE 平台呼叫（簽章驗證）
 * - GET  /ws?token=                         客服台即時連線
 * - GET  /api/me                            驗證 token 是否正確
 * - GET  /api/conversations?status=open&before=&q=&limit=  對話清單（游標分頁、搜尋）
 * - GET  /api/stats                         未讀總數等
 * - GET  /api/conversations/:id/messages    訊息（?before=<ts>&limit=）
 * - POST /api/conversations/:id/reply       客服回覆 { text }
 * - POST /api/conversations/:id/prompt      送可追蹤的選擇題 { body?, question, options[] }
 * - POST /api/conversations/:id/send        直接送 LINE 訊息陣列 { messages[] }，postback 自動追蹤
 * - GET  /api/prompts?status=&conversationId= 可追蹤訊息與回覆結果
 * - POST /api/conversations/:id/read        清除未讀
 * - POST /api/conversations/:id/status      { status: "open" | "closed" }
 * - GET  /api/media/:key                    R2 媒體
 */
export default {
	async fetch(request, env, ctx): Promise<Response> {
		const start = Date.now();
		const url = new URL(request.url);
		const response = await route(request, env, ctx);
		if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/webhook/")) {
			recordMetric(env, {
				name: "http.request",
				labels: [routeLabel(url.pathname), request.method, String(response.status)],
				values: [Date.now() - start],
			});
		}
		return response;
	},

	async queue(batch, env, ctx): Promise<void> {
		await consumeLineEvents(batch as MessageBatch<LineEventJob>, env, ctx);
	},
} satisfies ExportedHandler<Env, LineEventJob>;

/** 把 /api/conversations/line:U123/reply 之類的路徑化成 /api/conversations/:id/reply，方便彙總 */
function routeLabel(pathname: string): string {
	return pathname.replace(/^\/api\/conversations\/[^/]+/, "/api/conversations/:id").replace(/^\/api\/media\/.+$/, "/api/media/:key");
}

async function route(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
	{
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
			const conversations = await listConversations(env.DB, status, {
				before: Number(url.searchParams.get("before")) || undefined,
				q: url.searchParams.get("q") ?? undefined,
				limit: Number(url.searchParams.get("limit")) || undefined,
			});
			return Response.json({ conversations });
		}

		if (pathname === "/api/stats" && request.method === "GET") {
			return Response.json(await getStats(env.DB));
		}

		if (pathname === "/api/prompts" && request.method === "GET") {
			const status = (url.searchParams.get("status") ?? "all") as PromptStatus | "all";
			const conversationId = url.searchParams.get("conversationId") ?? undefined;
			const prompts = await listPrompts(env.DB, { status, conversationId });
			return Response.json({ prompts });
		}

		const convMatch = pathname.match(
			/^\/api\/conversations\/([^/]+)\/(messages|reply|read|status|prompt|send)$/,
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

			if (action === "send" && request.method === "POST") {
				return handleSendMessages(request, env, conversation.id, conversation.externalId, conversation.channel);
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
	}
}

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
		await lineClientFor(env).pushText(recipientId, text);
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
 * 送出可追蹤的選擇題：正文（選填）+ Confirm 按鈕。舊介面，內部轉成訊息陣列走 sendTracked。
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

	const variables =
		input.variables && typeof input.variables === "object"
			? Object.fromEntries(
					Object.entries(input.variables).filter(([, v]) => typeof v === "string"),
				)
			: null;

	// buildPromptMessages 會先放一個暫時 id，sendTracked 會再統一改寫成正式的 prompt id
	const messages = buildPromptMessages({ promptId: "pending", body, question, options }) as Record<string, unknown>[];
	return sendTracked(env, {
		conversationId,
		recipientId,
		channel,
		messages,
		templateKey: typeof input.templateKey === "string" ? input.templateKey : null,
		variables,
	});
}

/**
 * 直接送 LINE 訊息陣列（Flex、template、quick reply…）。
 * 任何 postback 按鈕都會自動掛上追蹤 id，使用者點選後寫回 prompts。
 */
async function handleSendMessages(
	request: Request,
	env: Env,
	conversationId: string,
	recipientId: string,
	channel: string,
): Promise<Response> {
	const input = (await request.json().catch(() => ({}))) as Partial<SendMessagesInput>;
	const validated = validateLineMessages(input.messages);
	if (!validated.ok) return Response.json({ error: validated.error }, { status: 400 });
	return sendTracked(env, {
		conversationId,
		recipientId,
		channel,
		messages: validated.messages,
		templateKey: typeof input.templateKey === "string" ? input.templateKey : null,
		variables: null,
		allowChange: input.allowChange === true,
	});
}

/**
 * 共用：先推 LINE，成功才寫 messages 與 prompts（若含 postback），再廣播。
 */
async function sendTracked(
	env: Env,
	input: {
		conversationId: string;
		recipientId: string;
		channel: string;
		messages: Record<string, unknown>[];
		templateKey: string | null;
		variables: Record<string, string> | null;
		allowChange?: boolean;
	},
): Promise<Response> {
	if (input.channel !== "line") return Response.json({ error: `channel ${input.channel} not supported yet` }, { status: 400 });
	if (!env.LINE_CHANNEL_ACCESS_TOKEN) return Response.json({ error: "LINE_CHANNEL_ACCESS_TOKEN not configured" }, { status: 500 });

	const promptId = crypto.randomUUID();
	const { messages, options } = instrumentPostbacks(input.messages, promptId);
	const tracked = options.length > 0;
	const { body, question } = summarizeMessages(messages);
	const now = Date.now();

	try {
		await lineClientFor(env).push(input.recipientId, messages);
	} catch (err) {
		console.error("push failed", err);
		return Response.json(
			{ error: err instanceof Error ? err.message : "LINE push failed" },
			{ status: 502 },
		);
	}

	const messageId = crypto.randomUUID();
	const inserted = await insertMessage(env.DB, {
		id: messageId,
		conversationId: input.conversationId,
		direction: "outbound",
		sender: "agent",
		type: tracked ? "prompt" : "rich",
		text: body ? (body === question ? body : `${body}\n\n${question}`) : question,
		metadata: tracked
			? { promptId, question, options, status: "pending", payload: messages }
			: { question, payload: messages },
		createdAt: now,
	});
	if (!inserted) return Response.json({ error: "failed to persist message" }, { status: 500 });

	const inbox = inboxStub(env);
	await inbox.broadcast({
		type: "message.new",
		message: inserted.message,
		conversation: inserted.conversation,
	});

	let prompt = null;
	if (tracked) {
		prompt = await createPrompt(env.DB, {
			id: promptId,
			conversationId: input.conversationId,
			messageId,
			templateKey: input.templateKey,
			body,
			question,
			options,
			variables: input.variables,
			payload: messages,
			allowChange: input.allowChange ?? false,
			createdAt: now,
		});
		await inbox.broadcast({ type: "prompt.updated", prompt });
	}
	await finishReminder(env, input.conversationId);

	return Response.json({ prompt, message: inserted.message, conversation: inserted.conversation });
}
