import {
	type LineClient,
	conversationTarget,
	markAsReadTokenOf,
	parsePromptPostback,
	stickerImageUrl,
	toMessageType,
	verifyLineSignature,
	type LineWebhookBody,
	type LineWebhookEvent,
} from "./line";
import {
	editMessageText,
	findMessageByExternalId,
	getPrompt,
	getReminderInstanceId,
	insertMessage,
	recordPromptResponse,
	setReminderInstanceId,
	setSystemState,
	unsendMessage,
	updateMessageMetadata,
	upsertConversation,
} from "./db";
import type { MessageQuote } from "../shared/types";
import { lineClientFor } from "./line-env";
import { storeMedia } from "./media";
import { recordIntegrity, STATE_KEYS } from "./integrity";
import { handleDeliveryEvent } from "./pnp";

export { lineClientFor };
import { inboxStub } from "./inbox-do";
import { recordMetric } from "./metrics";

/** 丟進 Queues 的訊息內容 */
export interface LineEventJob {
	event: LineWebhookEvent;
	receivedAt: number;
}

/**
 * POST /webhook/line
 * 1. 驗簽章（失敗一律 401，避免偽造）
 * 2. WEBHOOK_MODE=queue 且有 LINE_EVENTS binding：事件丟進 Queues 後立即回 200，由 queue() 消費（自帶重試與削峰）
 *    否則同步逐一處理；單一事件失敗不影響其他事件，最後回 200 讓 LINE 不要重送
 * 3. 媒體下載放到 waitUntil，不拖慢回應
 */
export async function handleLineWebhook(
	request: Request,
	env: Env,
	ctx: ExecutionContext,
): Promise<Response> {
	if (!env.LINE_CHANNEL_SECRET || !env.LINE_CHANNEL_ACCESS_TOKEN) {
		return Response.json(
			{ error: "LINE secrets not configured" },
			{ status: 500 },
		);
	}

	const rawBody = await request.text();
	const valid = await verifyLineSignature(
		env.LINE_CHANNEL_SECRET,
		rawBody,
		request.headers.get("x-line-signature"),
	);
	if (!valid) {
		return Response.json({ error: "Invalid signature" }, { status: 401 });
	}

	let body: LineWebhookBody;
	try {
		body = JSON.parse(rawBody);
	} catch {
		return Response.json({ error: "Invalid JSON" }, { status: 400 });
	}

	const events = body.events ?? [];
	const useQueue = (env.WEBHOOK_MODE as string) === "queue" && env.LINE_EVENTS;
	recordMetric(env, { name: "webhook.received", labels: [useQueue ? "queue" : "inline"], values: [events.length] });
	// 健康頁用：最後一次收到 webhook／重送的時間（不擋回應）
	if (events.length) {
		const now = Date.now();
		const state: Record<string, string> = { [STATE_KEYS.lastWebhookAt]: String(now) };
		if (events.some((e) => e.deliveryContext?.isRedelivery)) state[STATE_KEYS.lastRedeliveryAt] = String(now);
		ctx.waitUntil(setSystemState(env.DB, state, now).catch((err) => console.error("system state failed", err)));
	}

	if (useQueue && events.length) {
		const receivedAt = Date.now();
		// sendBatch 一次最多 100 則
		for (let i = 0; i < events.length; i += 100) {
			await env.LINE_EVENTS.sendBatch(
				events.slice(i, i + 100).map((event) => ({ body: { event, receivedAt } satisfies LineEventJob })),
			);
		}
		return Response.json({ ok: true, queued: events.length });
	}

	const client = lineClientFor(env);
	for (const event of events) {
		await processLineEvent(event, env, ctx, client);
	}
	return Response.json({ ok: true });
}

/** 處理單一事件並記錄耗時；錯誤會往上丟，讓 queue 消費者決定是否重試 */
export async function processLineEvent(
	event: LineWebhookEvent,
	env: Env,
	ctx: ExecutionContext,
	client: LineClient,
	options: { rethrow?: boolean } = {},
): Promise<void> {
	const start = Date.now();
	try {
		await handleEvent(event, env, ctx, client);
		recordMetric(env, { name: "line.event", labels: [event.type, "ok"], values: [Date.now() - start] });
	} catch (err) {
		recordMetric(env, { name: "line.event", labels: [event.type, "error"], values: [Date.now() - start] });
		console.error("LINE event failed", event.type, err);
		if (options.rethrow) throw err;
	}
}

/**
 * Queues 消費者：每則訊息獨立 ack / retry。
 * 重送安全：訊息靠 external_id、postback 靠 webhookEventId、follow/unfollow 靠 webhookEventId 去重。
 */
export async function consumeLineEvents(
	batch: MessageBatch<LineEventJob>,
	env: Env,
	ctx: ExecutionContext,
): Promise<void> {
	const client = lineClientFor(env);
	for (const msg of batch.messages) {
		const start = Date.now();
		try {
			await processLineEvent(msg.body.event, env, ctx, client, { rethrow: true });
			msg.ack();
			recordMetric(env, {
				name: "queue.consume",
				labels: ["ok"],
				values: [Date.now() - start, msg.attempts, start - msg.body.receivedAt],
			});
		} catch {
			msg.retry({ delaySeconds: Math.min(60, 5 * msg.attempts) });
			recordMetric(env, { name: "queue.consume", labels: ["retry"], values: [Date.now() - start, msg.attempts] });
		}
	}
}

async function handleEvent(
	event: LineWebhookEvent,
	env: Env,
	ctx: ExecutionContext,
	client: LineClient,
): Promise<void> {
	const target = conversationTarget(event.source);
	if (!target) return;

	// LINE 標記為重送的事件：這是「接收端曾經失敗」的證據。以小時為單位彙整成一筆缺口紀錄（count 累加），避免洗版
	if (event.deliveryContext?.isRedelivery) {
		recordMetric(env, { name: "webhook.redelivery", labels: [event.type], values: [1] });
		const hour = Math.floor((event.timestamp || Date.now()) / 3_600_000) * 3_600_000;
		await recordIntegrity(env, {
			kind: "webhook_redelivery",
			severity: "warning",
			dedupeKey: `redelivery:${hour}`,
			title: "LINE 平台重送事件：該時段接收端曾發生失敗，重送機制不保證涵蓋所有事件",
			details: { hour, lastEventType: event.type, lastWebhookEventId: event.webhookEventId ?? null },
			startedAt: hour,
			endedAt: event.timestamp || Date.now(),
		});
	}

	switch (event.type) {
		case "delivery":
			if (event.delivery?.data) {
				await handleDeliveryEvent(env, event.delivery.data, event.timestamp || Date.now());
			}
			return;
		case "message":
			if (event.message) {
				await handleMessage(event, target, env, ctx, client);
			}
			return;
		case "messageEdited":
			if (event.message) {
				await handleMessageEdited(event, env);
			}
			return;
		case "unsend":
			if (event.unsend?.messageId) {
				await handleUnsend(event, env);
			}
			return;
		case "postback":
			if (event.postback) {
				await handlePostback(event, target, env, client);
			}
			return;
		case "follow":
		case "join":
			await handleFollow(event, target, env, client);
			return;
		case "unfollow":
		case "leave":
			await recordSystemMessage(
				target.conversationId,
				event.type === "unfollow" ? "使用者已封鎖或刪除好友" : "官方帳號已離開群組",
				event.timestamp,
				env,
				target,
				client,
				false,
				event.webhookEventId ? `evt:${event.webhookEventId}` : null,
			);
			return;
		default:
			return;
	}
}

type Target = NonNullable<ReturnType<typeof conversationTarget>>;

/** 建立或補齊對話資料（名稱、頭像） */
async function ensureConversation(
	target: Target,
	source: LineWebhookEvent["source"],
	env: Env,
	client: LineClient,
	now: number,
) {
	let displayName: string | null = null;
	let pictureUrl: string | null = null;

	try {
		if (target.kind === "user" && source.userId) {
			const profile = await client.getProfile(source.userId);
			displayName = profile?.displayName ?? null;
			pictureUrl = profile?.pictureUrl ?? null;
		} else if (target.kind === "group") {
			const summary = await client.getGroupSummary("group", target.recipientId);
			displayName = summary?.groupName ?? null;
			pictureUrl = summary?.pictureUrl ?? null;
		}
	} catch {
		// 取不到個人資料就先用 id 顯示
	}

	return upsertConversation(env.DB, {
		id: target.conversationId,
		channel: "line",
		externalId: target.recipientId,
		displayName,
		pictureUrl,
		now,
	});
}

async function handleMessage(
	event: LineWebhookEvent,
	target: Target,
	env: Env,
	ctx: ExecutionContext,
	client: LineClient,
): Promise<void> {
	const content = event.message!;
	const now = event.timestamp || Date.now();
	await ensureConversation(target, event.source, env, client, now);

	const type = toMessageType(content.type);
	let text: string | null = null;
	let metadata: Record<string, unknown> | null = null;

	switch (content.type) {
		case "text": {
			const t = content as Extract<typeof content, { type: "text" }>;
			text = t.text;
			if (t.quoteToken || t.quotedMessageId || t.mention) {
				metadata = {};
				if (t.quoteToken) metadata.quoteToken = t.quoteToken;
				if (t.quotedMessageId) metadata.quote = await resolveQuote(env, target.conversationId, t.quotedMessageId);
				if (t.mention) metadata.mention = t.mention;
			}
			break;
		}
		case "sticker": {
			const s = content as { packageId: string; stickerId: string };
			metadata = {
				packageId: s.packageId,
				stickerId: s.stickerId,
				imageUrl: stickerImageUrl(s.stickerId),
			};
			break;
		}
		case "location": {
			const l = content as {
				title?: string;
				address?: string;
				latitude: number;
				longitude: number;
			};
			text = [l.title, l.address].filter(Boolean).join("\n") || null;
			metadata = { latitude: l.latitude, longitude: l.longitude };
			break;
		}
		case "file": {
			const f = content as { fileName: string; fileSize: number };
			text = f.fileName;
			metadata = { fileName: f.fileName, fileSize: f.fileSize };
			break;
		}
		case "image":
		case "video":
		case "audio": {
			const m = content as {
				contentProvider?: { type: string; originalContentUrl?: string };
				duration?: number;
				imageSet?: { id: string; index: number; total: number };
				quoteToken?: string;
			};
			metadata = {
				provider: m.contentProvider?.type,
				externalUrl: m.contentProvider?.originalContentUrl,
				duration: m.duration,
			};
			// 多張圖片：保留圖集資訊，前端依 index 標示，而不是靠到達順序
			if (m.imageSet) metadata.imageSet = m.imageSet;
			if (m.quoteToken) metadata.quoteToken = m.quoteToken;
			break;
		}
		default:
			break;
	}

	// 群組訊息：一定保留發言者 userId（同名成員才分得開），名稱拿得到再補
	if (target.kind !== "user" && event.source.userId) {
		metadata = { ...(metadata ?? {}), senderUserId: event.source.userId };
		try {
			const member = await client.getProfile(event.source.userId, {
				kind: target.kind,
				id: target.recipientId,
			});
			if (member?.displayName) metadata.senderName = member.displayName;
		} catch {
			// 拿不到個人資料（未授權或已離群）就只留 userId
		}
	}
	if (event.deliveryContext?.isRedelivery) {
		metadata = { ...(metadata ?? {}), isRedelivery: true };
	}

	// 媒體：先回應 LINE，再背景下載到 R2；狀態先標 pending，排程會補抓沒抓到的
	const needsDownload =
		(content.type === "image" ||
			content.type === "video" ||
			content.type === "audio" ||
			content.type === "file") &&
		!(metadata?.externalUrl as string | undefined);

	const inserted = await insertMessage(env.DB, {
		id: crypto.randomUUID(),
		conversationId: target.conversationId,
		direction: "inbound",
		sender: "user",
		type,
		text,
		metadata,
		externalId: content.id,
		createdAt: now,
		markAsReadToken: markAsReadTokenOf(event),
		source: "line_webhook",
		mediaStatus: needsDownload ? "pending" : null,
	});
	if (!inserted) return; // LINE 重送的重複事件

	await inboxStub(env).broadcast({
		type: "message.new",
		message: inserted.message,
		conversation: inserted.conversation,
	});

	if (needsDownload) {
		ctx.waitUntil(storeMedia(env, client, inserted.message));
	}

	if (metadata?.quote && (metadata.quote as MessageQuote).messageId === null) {
		await recordIntegrity(env, {
			kind: "quote_missing",
			severity: "warning",
			conversationId: target.conversationId,
			messageId: inserted.message.id,
			dedupeKey: `quote_missing:${inserted.message.id}`,
			title: "使用者引用的訊息不存在於本系統（可能發送於串接之前，或來自未同步的來源）",
			details: { quotedMessageId: (metadata.quote as MessageQuote).externalId, text: text?.slice(0, 200) ?? null },
			startedAt: now,
		});
	}

	await startReminderIfNeeded(target.conversationId, env);
}

/**
 * 引用訊息：LINE 只給 quotedMessageId，不給原文。本地找得到就做快照，找不到也要留關聯並明確標示，
 * 讓客服知道「這是在回某則我們沒有的訊息」，而不是只看到一句沒頭沒尾的話。
 */
async function resolveQuote(env: Env, conversationId: string, quotedMessageId: string): Promise<MessageQuote> {
	const original = await findMessageByExternalId(env.DB, quotedMessageId, conversationId);
	if (!original) {
		return { externalId: quotedMessageId, messageId: null, text: null, type: null, sender: null };
	}
	return {
		externalId: quotedMessageId,
		messageId: original.id,
		text: original.unsentAt ? null : original.text,
		type: original.type,
		sender: original.sender,
	};
}

/** 使用者撤回：清除內容與 R2 附件，時間軸上留下「已撤回」的位置 */
async function handleUnsend(event: LineWebhookEvent, env: Env): Promise<void> {
	const result = await unsendMessage(env.DB, event.unsend!.messageId, event.timestamp || Date.now());
	if (!result) return; // 本地沒有這則，或已處理過（重送）
	if (result.mediaKey) {
		try {
			await env.MEDIA.delete(result.mediaKey);
		} catch (err) {
			console.error("delete unsent media failed", result.mediaKey, err);
		}
	}
	await inboxStub(env).broadcast({
		type: "message.new",
		message: result.message,
		conversation: result.conversation,
	});
}

/**
 * 群組文字訊息被編輯（messageEdited）：message.id 與原訊息相同，以此更新內容；
 * 事件可能亂序，db 層只接受較新的版本。
 */
async function handleMessageEdited(event: LineWebhookEvent, env: Env): Promise<void> {
	const content = event.message!;
	if (content.type !== "text") return;
	const text = (content as { text?: string }).text;
	if (typeof text !== "string") return;
	const result = await editMessageText(env.DB, content.id, text, event.timestamp || Date.now());
	if (!result) return;
	await inboxStub(env).broadcast({
		type: "message.new",
		message: result.message,
		conversation: result.conversation,
	});
}

/**
 * 使用者按下可追蹤訊息的按鈕：
 * 1. 寫入 prompt_responses 並更新 prompts 的最新選擇
 * 2. 在對話裡留一則使用者訊息「已選擇：是」，客服台看得到
 * 3. 更新原本那則選擇題訊息的狀態，並廣播給客服台
 * 4. 用 reply token 回一句確認
 */
async function handlePostback(
	event: LineWebhookEvent,
	target: Target,
	env: Env,
	client: LineClient,
): Promise<void> {
	const parsed = parsePromptPostback(event.postback!.data);
	if (!parsed) return;
	const now = event.timestamp || Date.now();

	const existing = await getPrompt(env.DB, parsed.promptId);
	if (!existing || existing.conversationId !== target.conversationId) return;
	const label =
		existing.options.find((o) => o.value === parsed.choice)?.label ?? parsed.choice;

	const result = await recordPromptResponse(
		env.DB,
		parsed.promptId,
		parsed.choice,
		label,
		now,
	);
	if (!result) return;
	const { prompt, applied } = result;

	const inserted = await insertMessage(env.DB, {
		id: crypto.randomUUID(),
		conversationId: target.conversationId,
		direction: "inbound",
		sender: "user",
		type: "text",
		text: applied ? `已選擇：${label}` : `再次點選：${label}（未採用，以先前回覆為準）`,
		metadata: { promptId: prompt.id, choice: parsed.choice },
		externalId: event.webhookEventId ? `postback:${event.webhookEventId}` : null,
		createdAt: now,
	});
	if (!inserted) return; // 重送

	const inbox = inboxStub(env);
	await inbox.broadcast({
		type: "message.new",
		message: inserted.message,
		conversation: inserted.conversation,
	});

	if (prompt.messageId) {
		const updated = await updateMessageMetadata(env.DB, prompt.messageId, {
			promptId: prompt.id,
			question: prompt.question,
			options: prompt.options,
			status: prompt.status,
			choice: prompt.choice,
			choiceLabel: prompt.choiceLabel,
			respondedAt: prompt.respondedAt,
			payload: prompt.payload,
		});
		if (updated) {
			await inbox.broadcast({
				type: "message.new",
				message: updated,
				conversation: inserted.conversation,
			});
		}
	}
	await inbox.broadcast({ type: "prompt.updated", prompt });

	if (event.replyToken) {
		const text = !applied
			? `您已於 ${formatTime(prompt.respondedAt ?? now)} 回覆「${prompt.choiceLabel ?? prompt.choice}」，本題以第一次回覆為準。如需更改，請直接留言告知。`
			: result.alreadyAnswered
				? `已更新您的選擇為「${label}」。`
				: `已收到您的選擇「${label}」，謝謝。`;
		try {
			const sent = await client.reply(event.replyToken, [{ type: "text", text }]);
			await insertMessage(env.DB, {
				id: crypto.randomUUID(),
				conversationId: target.conversationId,
				direction: "outbound",
				sender: "system",
				type: "text",
				text,
				createdAt: now + 1,
				source: "system",
				deliveryStatus: "sent",
				externalId: sent[0]?.id ?? null,
				metadata: sent.length ? { lineMessageIds: sent.map((m) => m.id), quoteToken: sent[0].quoteToken ?? null } : null,
			});
		} catch (err) {
			console.error("postback reply failed", err);
		}
	}
}

function formatTime(ts: number): string {
	return new Intl.DateTimeFormat("zh-TW", {
		timeZone: "Asia/Taipei",
		month: "numeric",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
		hour12: false,
	}).format(new Date(ts));
}

/**
 * 每個對話同時只有一個提醒流程；客服回覆時由 /api 端送 agent-replied 事件結束它。
 */
async function startReminderIfNeeded(
	conversationId: string,
	env: Env,
): Promise<void> {
	const existing = await getReminderInstanceId(env.DB, conversationId);
	if (existing) {
		try {
			const instance = await env.REPLY_REMINDER.get(existing);
			const status = await instance.status();
			if (status.status === "running" || status.status === "waiting" || status.status === "queued") {
				return;
			}
		} catch {
			// 找不到舊 instance 就重新建立
		}
	}
	try {
		const instance = await env.REPLY_REMINDER.create({
			params: { conversationId },
		});
		await setReminderInstanceId(env.DB, conversationId, instance.id);
	} catch (err) {
		console.error("start reminder failed", err);
	}
}

async function handleFollow(
	event: LineWebhookEvent,
	target: Target,
	env: Env,
	client: LineClient,
): Promise<void> {
	const now = event.timestamp || Date.now();
	await ensureConversation(target, event.source, env, client, now);
	await recordSystemMessage(
		target.conversationId,
		event.type === "follow" ? "使用者加入好友" : "官方帳號已加入群組",
		now,
		env,
		target,
		client,
		true,
		event.webhookEventId ? `evt:${event.webhookEventId}` : null,
	);

	const welcome = env.WELCOME_MESSAGE?.trim();
	if (welcome && event.replyToken) {
		try {
			const sent = await client.reply(event.replyToken, [{ type: "text", text: welcome }]);
			const inserted = await insertMessage(env.DB, {
				id: crypto.randomUUID(),
				conversationId: target.conversationId,
				direction: "outbound",
				sender: "system",
				type: "text",
				text: welcome,
				createdAt: now + 1,
				source: "system",
				deliveryStatus: "sent",
				externalId: sent[0]?.id ?? null,
				metadata: sent.length ? { lineMessageIds: sent.map((m) => m.id), quoteToken: sent[0].quoteToken ?? null } : null,
			});
			if (inserted) {
				await inboxStub(env).broadcast({
					type: "message.new",
					message: inserted.message,
					conversation: inserted.conversation,
				});
			}
		} catch (err) {
			console.error("welcome reply failed", err);
		}
	}
}

async function recordSystemMessage(
	conversationId: string,
	text: string,
	timestamp: number,
	env: Env,
	target: Target,
	client: LineClient,
	alreadyEnsured = false,
	externalId: string | null = null,
): Promise<void> {
	if (!alreadyEnsured) {
		await ensureConversation(
			target,
			{ type: target.kind, userId: target.kind === "user" ? target.recipientId : undefined },
			env,
			client,
			timestamp,
		);
	}
	const inserted = await insertMessage(env.DB, {
		id: crypto.randomUUID(),
		conversationId,
		direction: "inbound",
		sender: "system",
		type: "text",
		text,
		externalId,
		createdAt: timestamp,
	});
	if (inserted) {
		await inboxStub(env).broadcast({
			type: "message.new",
			message: inserted.message,
			conversation: inserted.conversation,
		});
	}
}
