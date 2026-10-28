export { ReplyReminderWorkflow } from "./workflow";
export { InboxDO } from "./inbox-do";

import { isAuthorized, unauthorized } from "./auth";
import { consumeLineEvents, handleLineWebhook, type LineEventJob } from "./webhook-line";
import { lineClientFor } from "./line-env";
import { recordMetric } from "./metrics";
import { inboxStub } from "./inbox-do";
import {
	TEXT_MESSAGE_MAX,
	conversationTarget,
	instrumentPostbacks,
	summarizeMessages,
	validateLineMessages,
} from "./line";
import { AGENT_REPLIED_EVENT } from "./workflow";
import {
	assignConversation,
	clearMarkAsReadToken,
	createPrompt,
	getConversation,
	getImportBatch,
	getMessage,
	getMessageRetryKey,
	getStats,
	getReminderInstanceId,
	insertMessage,
	listConversations,
	listImportBatches,
	listImportRowGroups,
	listIntegrityEvents,
	listMessages,
	listMessagesAround,
	markMessageReported,
	listNotifications,
	listPrompts,
	markConversationRead,
	resolveIntegrityEvent,
	setConversationStatus,
	setReminderInstanceId,
} from "./db";
import { getHealth, recordIntegrity, runMaintenance } from "./integrity";
import { pushOutboundMessage, sendOutbound, type OutboundInput } from "./outbox";
import { assignImportRows, previewImport, runImport, skipImportRows } from "./import-csv";
import { retryNotification, sendNotification } from "./pnp";
import type {
	Conversation,
	ConversationStatus,
	ImportMapping,
	ImportRunInput,
	IntegrityKind,
	IntegrityStatus,
	PromptStatus,
	ReplyInput,
	SendMessagesInput,
	SendNotificationInput,
} from "../shared/types";

/**
 * 路由
 * - POST /webhook/line                      LINE 平台呼叫（簽章驗證）
 * - GET  /ws?token=                         客服台即時連線
 * - GET  /api/me                            驗證 token 是否正確
 * - GET  /api/conversations?status=open&before=&q=&limit=  對話清單（游標分頁、搜尋）
 * - GET  /api/stats                         未讀總數等
 * - GET  /api/conversations/:id/messages    訊息（?before=<ts>&limit=）
 * - POST /api/conversations/:id/reply       客服回覆 { text, clientKey?, lastSeenMessageId?, force? }
 * - POST /api/conversations/:id/send        直接送 LINE 訊息陣列 { messages[] }，postback 自動追蹤
 * - POST /api/conversations/:id/assign      接手 { agent? }；/release 交還
 * - GET  /api/conversations/:id/presence    正在看這個對話的客服
 * - POST /api/messages/:id/report           客服對某則訊息按驚嘆號 { note? }；系統自動收齊上下文供工程端判讀
 * - POST /api/messages/:id/retry            重推發送失敗／不明的客服訊息
 * - GET  /api/prompts?status=&conversationId= 可追蹤訊息與回覆結果
 * - POST /api/conversations/:id/read        清除未讀（並通知 LINE 已讀）
 * - POST /api/conversations/:id/status      { status: "open" | "closed" }
 * - GET  /api/media/:key                    R2 媒體
 * 工程端健檢與修復（只需 CONSOLE_TOKEN，不需登入 Cloudflare；客服台不使用）：
 * - GET  /api/integrity/health              同步健康狀態快照（webhook、送達、附件、官方帳號 Chat 設定）
 * - GET  /api/integrity/events?status=&kind= 缺口與回報紀錄；POST /api/integrity/events/:id/resolve 結案
 * - POST /api/integrity/maintenance         立即執行排程維護（補推、補抓附件、刷新官方帳號設定）
 *   （npm run reports 是同一批資料的另一個入口，經 wrangler 直接讀寫正式 D1）
 * - POST /api/imports/preview               CSV 欄位偵測與配對預覽 { csv, mapping? }
 * - POST /api/imports                       執行匯入；GET /api/imports 歷史批次
 * - GET  /api/imports/:id/rows              未配對的列（依名稱分組）；POST /api/imports/:id/assign、/skip
 * - GET  /api/notifications                 通知型訊息發送紀錄；POST /api/notifications 發送；POST /api/notifications/:id/retry
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
		if (batch.queue.endsWith("-dlq")) {
			await consumeDeadLetters(batch as MessageBatch<LineEventJob>, env);
			return;
		}
		await consumeLineEvents(batch as MessageBatch<LineEventJob>, env, ctx);
	},

	async scheduled(_controller, env, ctx): Promise<void> {
		ctx.waitUntil(runMaintenance(env).catch((err) => console.error("maintenance failed", err)));
	},
} satisfies ExportedHandler<Env, LineEventJob>;

/**
 * DLQ：重試三次仍失敗的事件。原始事件整個存進缺口紀錄，之後可以人工檢視或重放，
 * 不能讓它靜靜消失。
 */
async function consumeDeadLetters(batch: MessageBatch<LineEventJob>, env: Env): Promise<void> {
	for (const msg of batch.messages) {
		const event = msg.body.event;
		const target = conversationTarget(event.source ?? { type: "user" });
		await recordIntegrity(env, {
			kind: "event_dead_lettered",
			severity: "error",
			conversationId: target?.conversationId ?? null,
			dedupeKey: event.webhookEventId ? `dlq:${event.webhookEventId}` : null,
			title: `LINE 事件處理連續失敗，已中止處理：${event.type}`,
			details: { event, receivedAt: msg.body.receivedAt, attempts: msg.attempts },
			startedAt: event.timestamp ?? msg.body.receivedAt,
		});
		msg.ack();
		recordMetric(env, { name: "queue.dead_letter", labels: [event.type], values: [1] });
	}
}

/** 把 /api/conversations/line:U123/reply 之類的路徑化成 /api/conversations/:id/reply，方便彙總 */
function routeLabel(pathname: string): string {
	return pathname
		.replace(/^\/api\/conversations\/[^/]+/, "/api/conversations/:id")
		.replace(/^\/api\/messages\/[^/]+/, "/api/messages/:id")
		.replace(/^\/api\/imports\/[^/]+/, "/api/imports/:id")
		.replace(/^\/api\/notifications\/[^/]+/, "/api/notifications/:id")
		.replace(/^\/api\/integrity\/events\/[^/]+/, "/api/integrity/events/:id")
		.replace(/^\/api\/media\/.+$/, "/api/media/:key");
}

/** 客服名稱：前端以 X-Agent-Name（URI 編碼）帶上來。只用於協作顯示，不是身分驗證。 */
function agentNameOf(request: Request): string | null {
	const raw = request.headers.get("X-Agent-Name");
	if (!raw) return null;
	try {
		const name = decodeURIComponent(raw).trim().slice(0, 40);
		return name || null;
	} catch {
		return null;
	}
}

async function readJson<T>(request: Request): Promise<Partial<T>> {
	return (await request.json().catch(() => ({}))) as Partial<T>;
}

async function route(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
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
		const status = (url.searchParams.get("status") ?? "open") as ConversationStatus | "all";
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

	// ---------- 工程端健檢與修復 ----------
	if (pathname === "/api/integrity/health" && request.method === "GET") {
		return Response.json(await getHealth(env));
	}
	if (pathname === "/api/integrity/events" && request.method === "GET") {
		const events = await listIntegrityEvents(env.DB, {
			status: (url.searchParams.get("status") ?? "open") as IntegrityStatus | "all",
			kind: (url.searchParams.get("kind") as IntegrityKind | null) ?? undefined,
			limit: Number(url.searchParams.get("limit")) || undefined,
		});
		return Response.json({ events });
	}
	const resolveMatch = pathname.match(/^\/api\/integrity\/events\/([^/]+)\/resolve$/);
	if (resolveMatch && request.method === "POST") {
		const body = await readJson<{ resolution?: string }>(request);
		const event = await resolveIntegrityEvent(env.DB, resolveMatch[1], body.resolution?.trim() || null, agentNameOf(request));
		if (!event) return Response.json({ error: "找不到此筆紀錄。" }, { status: 404 });
		return Response.json({ event });
	}
	if (pathname === "/api/integrity/maintenance" && request.method === "POST") {
		return Response.json(await runMaintenance(env));
	}

	// ---------- 歷史匯入 ----------
	if (pathname === "/api/imports/preview" && request.method === "POST") {
		const body = await readJson<{ csv?: string; mapping?: ImportMapping; tzOffsetMinutes?: number }>(request);
		if (typeof body.csv !== "string" || !body.csv.trim()) return Response.json({ error: "未提供 CSV 內容。請選擇檔案或貼上內容。" }, { status: 400 });
		const preview = await previewImport(env, body.csv, body.mapping, body.tzOffsetMinutes);
		if ("error" in preview) return Response.json(preview, { status: 400 });
		return Response.json(preview);
	}
	if (pathname === "/api/imports" && request.method === "POST") {
		const body = await readJson<ImportRunInput>(request);
		if (typeof body.csv !== "string" || !body.csv.trim()) return Response.json({ error: "未提供 CSV 內容。請選擇檔案或貼上內容。" }, { status: 400 });
		const batch = await runImport(env, body as ImportRunInput, agentNameOf(request));
		if ("error" in batch) return Response.json(batch, { status: 400 });
		return Response.json({ batch });
	}
	if (pathname === "/api/imports" && request.method === "GET") {
		return Response.json({ batches: await listImportBatches(env.DB) });
	}
	const importMatch = pathname.match(/^\/api\/imports\/([^/]+)\/(rows|assign|skip)$/);
	if (importMatch) {
		const batchId = importMatch[1];
		const batch = await getImportBatch(env.DB, batchId);
		if (!batch) return Response.json({ error: "找不到此匯入批次。請重新整理頁面後再試。" }, { status: 404 });
		if (importMatch[2] === "rows" && request.method === "GET") {
			return Response.json({ batch, groups: await listImportRowGroups(env.DB, batchId) });
		}
		if (importMatch[2] === "assign" && request.method === "POST") {
			const body = await readJson<{ chatName?: string; conversationId?: string }>(request);
			if (typeof body.chatName !== "string" || !body.conversationId) {
				return Response.json({ error: "未指定聊天室名稱或對話。請選擇要指派的對話。" }, { status: 400 });
			}
			if (!(await getConversation(env.DB, body.conversationId))) {
				return Response.json({ error: "找不到此對話。請重新整理頁面後再試。" }, { status: 404 });
			}
			const result = await assignImportRows(env, batchId, body.chatName, body.conversationId);
			if ("error" in result) return Response.json(result, { status: 400 });
			return Response.json({ ...result, batch: await getImportBatch(env.DB, batchId) });
		}
		if (importMatch[2] === "skip" && request.method === "POST") {
			const body = await readJson<{ chatName?: string }>(request);
			if (typeof body.chatName !== "string") return Response.json({ error: "未指定聊天室名稱。" }, { status: 400 });
			const skipped = await skipImportRows(env, batchId, body.chatName);
			return Response.json({ skipped, batch: await getImportBatch(env.DB, batchId) });
		}
	}

	// ---------- 通知型訊息 ----------
	if (pathname === "/api/notifications" && request.method === "GET") {
		return Response.json({ notifications: await listNotifications(env.DB, Number(url.searchParams.get("limit")) || 100) });
	}
	if (pathname === "/api/notifications" && request.method === "POST") {
		if (!env.LINE_CHANNEL_ACCESS_TOKEN) return Response.json({ error: "尚未設定 LINE_CHANNEL_ACCESS_TOKEN，無法發送訊息。請聯絡系統管理員。" }, { status: 500 });
		const body = await readJson<SendNotificationInput>(request);
		const result = await sendNotification(env, lineClientFor(env), body as SendNotificationInput, "console", agentNameOf(request));
		if ("httpStatus" in result) return Response.json({ error: result.error }, { status: result.httpStatus });
		return Response.json({ notification: result }, { status: result.status === "failed" ? 502 : 200 });
	}
	const notificationRetry = pathname.match(/^\/api\/notifications\/([^/]+)\/retry$/);
	if (notificationRetry && request.method === "POST") {
		const result = await retryNotification(env, lineClientFor(env), notificationRetry[1]);
		if ("httpStatus" in result) return Response.json({ error: result.error }, { status: result.httpStatus });
		return Response.json({ notification: result }, { status: result.status === "failed" ? 502 : 200 });
	}

	// ---------- 訊息回報：客服只要戳一下，上下文由系統收齊 ----------
	const reportMatch = pathname.match(/^\/api\/messages\/([^/]+)\/report$/);
	if (reportMatch && request.method === "POST") {
		const message = await getMessage(env.DB, reportMatch[1]);
		if (!message) return Response.json({ error: "找不到此訊息。請重新整理頁面後再試。" }, { status: 404 });
		const body = await readJson<{ note?: string }>(request);
		const note = body.note?.trim().slice(0, 500) || null;
		const now = Date.now();
		const [conversation, around, related, retryKey] = await Promise.all([
			getConversation(env.DB, message.conversationId),
			listMessagesAround(env.DB, message),
			listIntegrityEvents(env.DB, { conversationId: message.conversationId, status: "open", limit: 20 }),
			message.direction === "outbound" ? getMessageRetryKey(env.DB, message.id) : Promise.resolve(null),
		]);
		await recordIntegrity(env, {
			kind: "agent_report",
			severity: "warning",
			conversationId: message.conversationId,
			messageId: message.id,
			dedupeKey: `report:${message.id}`,
			title: note ? `客服回報：${note.slice(0, 80)}` : `客服回報此訊息有異常（${message.direction === "inbound" ? "使用者" : "客服"}訊息）`,
			details: {
				note,
				reportedBy: agentNameOf(request),
				message: { ...message, retryKey },
				conversation,
				context: around.map((m) => ({
					id: m.id,
					at: new Date(m.createdAt).toISOString(),
					who: m.sender === "user" ? (m.metadata?.senderName ?? "user") : (m.agentName ?? m.sender),
					type: m.type,
					text: m.text,
					externalId: m.externalId,
					delivery: m.deliveryStatus,
					media: m.mediaStatus,
					unsent: !!m.unsentAt,
					edited: !!m.editedAt,
					quote: m.metadata?.quote ?? null,
					target: m.id === message.id,
				})),
				relatedOpenEvents: related.map((e) => ({ id: e.id, kind: e.kind, title: e.title, createdAt: e.createdAt })),
			},
			startedAt: message.createdAt,
			createdBy: agentNameOf(request),
		});
		const updated = await markMessageReported(env.DB, message.id, now);
		if (updated && conversation) {
			await inboxStub(env).broadcast({ type: "message.new", message: updated, conversation });
		}
		return Response.json({ message: updated ?? message });
	}

	// ---------- 客服訊息重推 ----------
	const retryMatch = pathname.match(/^\/api\/messages\/([^/]+)\/retry$/);
	if (retryMatch && request.method === "POST") {
		const message = await getMessage(env.DB, retryMatch[1]);
		if (!message || message.direction !== "outbound" || message.sender !== "agent") {
			return Response.json({ error: "找不到可重新發送的訊息。請重新整理頁面後再試。" }, { status: 404 });
		}
		if (message.deliveryStatus === "sent") return Response.json({ message });
		const updated = await pushOutboundMessage(env, lineClientFor(env), message);
		return Response.json({ message: updated }, { status: updated.deliveryStatus === "failed" ? 502 : 200 });
	}

	const convMatch = pathname.match(
		/^\/api\/conversations\/([^/]+)\/(messages|reply|read|status|send|assign|release|presence)$/,
	);
	if (convMatch) {
		const conversationId = decodeURIComponent(convMatch[1]);
		const action = convMatch[2];
		const conversation = await getConversation(env.DB, conversationId);
		if (!conversation) {
			return Response.json({ error: "找不到此對話。請重新整理頁面後再試。" }, { status: 404 });
		}

		if (action === "messages" && request.method === "GET") {
			const before = Number(url.searchParams.get("before")) || undefined;
			const limit = Number(url.searchParams.get("limit")) || undefined;
			const messages = await listMessages(env.DB, conversationId, { before, limit });
			return Response.json({ messages });
		}

		if (action === "read" && request.method === "POST") {
			const result = await markConversationRead(env.DB, conversationId);
			if (result) {
				await inboxStub(env).broadcast({ type: "conversation.updated", conversation: result.conversation });
				// 真人客服打開對話才通知 LINE 已讀；Chat 關閉（auto 模式）時 LINE 會回 400，吞掉即可
				if (result.markAsReadToken && conversation.channel === "line" && env.LINE_CHANNEL_ACCESS_TOKEN) {
					await markReadOnLine(env, conversationId, result.markAsReadToken);
				}
			}
			return Response.json({ conversation: result?.conversation ?? null });
		}

		if (action === "status" && request.method === "POST") {
			const body = await readJson<{ status?: string }>(request);
			if (body.status !== "open" && body.status !== "closed") {
				return Response.json({ error: "對話狀態只能是 open 或 closed。" }, { status: 400 });
			}
			const updated = await setConversationStatus(env.DB, conversationId, body.status);
			if (updated) await inboxStub(env).broadcast({ type: "conversation.updated", conversation: updated });
			return Response.json({ conversation: updated });
		}

		if ((action === "assign" || action === "release") && request.method === "POST") {
			const body = await readJson<{ agent?: string }>(request);
			const agent = action === "assign" ? (body.agent?.trim().slice(0, 40) || agentNameOf(request)) : null;
			if (action === "assign" && !agent) return Response.json({ error: "缺少客服名稱。請登出後重新登入並輸入名稱。" }, { status: 400 });
			const previous = conversation.assignedTo;
			const updated = await assignConversation(env.DB, conversationId, agent);
			if (!updated) return Response.json({ error: "找不到此對話。請重新整理頁面後再試。" }, { status: 404 });
			const note =
				action === "assign"
					? previous && previous !== agent
						? `「${agent}」已接手此對話（原負責人：${previous}）`
						: `「${agent}」已接手此對話`
					: `「${previous ?? agentNameOf(request) ?? "客服人員"}」已交還此對話`;
			const inserted = await insertMessage(env.DB, {
				id: crypto.randomUUID(),
				conversationId,
				direction: "outbound",
				sender: "system",
				type: "text",
				text: note,
				metadata: { assignment: { from: previous, to: agent, by: agentNameOf(request) } },
				createdAt: Date.now(),
				source: "system",
				silent: true,
			});
			const inbox = inboxStub(env);
			if (inserted) await inbox.broadcast({ type: "message.new", message: inserted.message, conversation: updated });
			await inbox.broadcast({ type: "conversation.updated", conversation: updated });
			return Response.json({ conversation: updated });
		}

		if (action === "presence" && request.method === "GET") {
			return Response.json({ agents: await inboxStub(env).presence(conversationId) });
		}

		if (action === "reply" && request.method === "POST") {
			return handleReply(request, env, conversation);
		}

		if (action === "send" && request.method === "POST") {
			return handleSendMessages(request, env, conversation);
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

	return Response.json({ error: "找不到此 API 路徑。" }, { status: 404 });
}

/** 呼叫 LINE 已讀 API；成功才清掉 token，失敗只記 log 不影響客服台 */
async function markReadOnLine(env: Env, conversationId: string, token: string): Promise<void> {
	try {
		const { ok, status } = await lineClientFor(env).markAsRead(token);
		if (ok) {
			await clearMarkAsReadToken(env.DB, conversationId, token);
		} else {
			console.warn("LINE markAsRead rejected", status, conversationId);
		}
	} catch (err) {
		console.error("LINE markAsRead failed", err);
	}
}

function guardOf(request: Request, body: { clientKey?: unknown; lastSeenMessageId?: unknown; force?: unknown }) {
	return {
		agentName: agentNameOf(request),
		clientKey: typeof body.clientKey === "string" ? body.clientKey : undefined,
		lastSeenMessageId: typeof body.lastSeenMessageId === "string" ? body.lastSeenMessageId : undefined,
		force: body.force === true,
	};
}

/** outbox 結果 → HTTP 回應；409 帶衝突內容、502 帶已寫入的訊息讓客服台能顯示並重試 */
function outboundResponse(result: Awaited<ReturnType<typeof sendOutbound>>, extra: Record<string, unknown> = {}): Response {
	if (result.kind === "conflict") return Response.json(result.conflict, { status: 409 });
	if (result.kind === "failed") {
		return Response.json({ error: result.error, message: result.message, conversation: result.conversation, ...extra }, { status: 502 });
	}
	return Response.json({ message: result.message, conversation: result.conversation, status: result.kind, reused: result.reused, ...extra });
}

async function handleReply(request: Request, env: Env, conversation: Conversation): Promise<Response> {
	const body = await readJson<ReplyInput>(request);
	const text = body.text?.trim();
	if (!text) return Response.json({ error: "請輸入訊息內容。" }, { status: 400 });
	if (text.length > TEXT_MESSAGE_MAX) return Response.json({ error: `訊息超過 ${TEXT_MESSAGE_MAX} 字的上限。請縮短後再發送。` }, { status: 400 });
	if (conversation.channel !== "line") return Response.json({ error: `此對話的渠道（${conversation.channel}）尚未支援發送訊息。` }, { status: 400 });
	if (!env.LINE_CHANNEL_ACCESS_TOKEN) return Response.json({ error: "尚未設定 LINE_CHANNEL_ACCESS_TOKEN，無法發送訊息。請聯絡系統管理員。" }, { status: 500 });

	// 引用：LINE 只讓文字與貼圖帶 quoteToken；token 來自使用者訊息的 webhook 或我方發送時的 sentMessages
	let quote: Record<string, unknown> | null = null;
	let quoteToken: string | null = null;
	if (body.quoteMessageId) {
		const target = await getMessage(env.DB, body.quoteMessageId);
		if (!target || target.conversationId !== conversation.id) {
			return Response.json({ error: "找不到要引用的訊息。請重新整理頁面後再試。" }, { status: 400 });
		}
		quoteToken = typeof target.metadata?.quoteToken === "string" ? target.metadata.quoteToken : null;
		if (!quoteToken || target.unsentAt) {
			return Response.json({ error: "此訊息無法引用。LINE 未提供引用憑證，或訊息已撤回。" }, { status: 400 });
		}
		quote = { externalId: target.externalId, messageId: target.id, text: target.text, type: target.type, sender: target.sender };
	}

	const result = await sendOutbound(env, lineClientFor(env), {
		conversation,
		type: "text",
		text,
		payload: [quoteToken ? { type: "text", text, quoteToken } : { type: "text", text }],
		metadata: quote ? { quote } : null,
		...guardOf(request, body),
	});
	if (result.kind === "sent" || result.kind === "pending") await finishReminder(env, conversation.id);
	return outboundResponse(result);
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

/**
 * 直接送 LINE 訊息陣列（Flex、template、quick reply 等）。
 * 任何 postback 按鈕都會自動掛上追蹤 id，使用者點選後寫回 prompts。
 */
async function handleSendMessages(request: Request, env: Env, conversation: Conversation): Promise<Response> {
	const input = await readJson<SendMessagesInput>(request);
	const validated = validateLineMessages(input.messages);
	if (!validated.ok) return Response.json({ error: validated.error }, { status: 400 });
	return sendTracked(env, conversation, {
		messages: validated.messages,
		templateKey: typeof input.templateKey === "string" ? input.templateKey : null,
		allowChange: input.allowChange === true,
		...guardOf(request, input),
	});
}

/**
 * 共用：改寫 postback → 走 outbox 發送 → 有 postback 才建立 prompts，再廣播。
 */
async function sendTracked(
	env: Env,
	conversation: Conversation,
	input: {
		messages: Record<string, unknown>[];
		templateKey: string | null;
		allowChange?: boolean;
	} & Pick<OutboundInput, "agentName" | "clientKey" | "lastSeenMessageId" | "force">,
): Promise<Response> {
	if (conversation.channel !== "line") return Response.json({ error: `此對話的渠道（${conversation.channel}）尚未支援發送訊息。` }, { status: 400 });
	if (!env.LINE_CHANNEL_ACCESS_TOKEN) return Response.json({ error: "尚未設定 LINE_CHANNEL_ACCESS_TOKEN，無法發送訊息。請聯絡系統管理員。" }, { status: 500 });

	const promptId = crypto.randomUUID();
	const { messages, options, tooLong } = instrumentPostbacks(input.messages, promptId);
	if (tooLong) return Response.json({ error: "字數超出上限。" }, { status: 400 });
	const tracked = options.length > 0;
	const { body, question } = summarizeMessages(messages);

	const result = await sendOutbound(env, lineClientFor(env), {
		conversation,
		type: tracked ? "prompt" : "rich",
		text: body ? (body === question ? body : `${body}\n\n${question}`) : question,
		payload: messages,
		metadata: tracked ? { promptId, question, options, status: "pending" } : { question },
		agentName: input.agentName,
		clientKey: input.clientKey,
		lastSeenMessageId: input.lastSeenMessageId,
		force: input.force,
	});
	if (result.kind === "conflict" || result.kind === "failed") return outboundResponse(result, { prompt: null });

	let prompt = null;
	if (tracked && !result.reused) {
		prompt = await createPrompt(env.DB, {
			id: promptId,
			conversationId: conversation.id,
			messageId: result.message.id,
			templateKey: input.templateKey,
			body,
			question,
			options,
			payload: messages,
			allowChange: input.allowChange ?? false,
			createdAt: result.message.createdAt,
		});
		await inboxStub(env).broadcast({ type: "prompt.updated", prompt });
	}
	await finishReminder(env, conversation.id);
	return outboundResponse(result, { prompt });
}
