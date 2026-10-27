import {
	LineClient,
	conversationTarget,
	parsePromptPostback,
	stickerImageUrl,
	toMessageType,
	verifyLineSignature,
	type LineWebhookBody,
	type LineWebhookEvent,
} from "./line";
import {
	getConversation,
	getPrompt,
	getReminderInstanceId,
	insertMessage,
	recordPromptResponse,
	setReminderInstanceId,
	updateMessageMedia,
	updateMessageMetadata,
	upsertConversation,
} from "./db";
import { inboxStub } from "./inbox-do";

/**
 * POST /webhook/line
 * 1. 驗簽章（失敗一律 401，避免偽造）
 * 2. 逐一處理事件；單一事件失敗不影響其他事件，最後回 200 讓 LINE 不要重送
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

	const client = new LineClient(env.LINE_CHANNEL_ACCESS_TOKEN);
	for (const event of body.events ?? []) {
		try {
			await handleEvent(event, env, ctx, client);
		} catch (err) {
			console.error("LINE event failed", event.type, err);
		}
	}

	return Response.json({ ok: true });
}

async function handleEvent(
	event: LineWebhookEvent,
	env: Env,
	ctx: ExecutionContext,
	client: LineClient,
): Promise<void> {
	const target = conversationTarget(event.source);
	if (!target) return;

	switch (event.type) {
		case "message":
			if (event.message) {
				await handleMessage(event, target, env, ctx, client);
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
		case "text":
			text = (content as { text: string }).text;
			break;
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
			};
			metadata = {
				provider: m.contentProvider?.type,
				externalUrl: m.contentProvider?.originalContentUrl,
				duration: m.duration,
			};
			break;
		}
		default:
			break;
	}

	// 群組訊息附上發言者名稱
	if (target.kind !== "user" && event.source.userId) {
		try {
			const member = await client.getProfile(event.source.userId, {
				kind: target.kind,
				id: target.recipientId,
			});
			metadata = { ...(metadata ?? {}), senderName: member?.displayName };
		} catch {
			// ignore
		}
	}

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
	});
	if (!inserted) return; // LINE 重送的重複事件

	await inboxStub(env).broadcast({
		type: "message.new",
		message: inserted.message,
		conversation: inserted.conversation,
	});

	// 媒體：先回應 LINE，再背景下載到 R2
	const needsDownload =
		(content.type === "image" ||
			content.type === "video" ||
			content.type === "audio" ||
			content.type === "file") &&
		!(metadata?.externalUrl as string | undefined);
	if (needsDownload) {
		ctx.waitUntil(
			storeMedia(inserted.message.id, content.id, target.conversationId, env, client),
		);
	}

	await startReminderIfNeeded(target.conversationId, env);
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
	const { prompt } = result;

	const inserted = await insertMessage(env.DB, {
		id: crypto.randomUUID(),
		conversationId: target.conversationId,
		direction: "inbound",
		sender: "user",
		type: "text",
		text: `已選擇：${label}`,
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
		const text = result.alreadyAnswered
			? `已更新您的選擇為「${label}」。`
			: `已收到您的選擇「${label}」，謝謝！`;
		try {
			await client.reply(event.replyToken, [{ type: "text", text }]);
			await insertMessage(env.DB, {
				id: crypto.randomUUID(),
				conversationId: target.conversationId,
				direction: "outbound",
				sender: "system",
				type: "text",
				text,
				createdAt: now + 1,
			});
		} catch (err) {
			console.error("postback reply failed", err);
		}
	}
}

async function storeMedia(
	messageId: string,
	lineMessageId: string,
	conversationId: string,
	env: Env,
	client: LineClient,
): Promise<void> {
	try {
		const content = await client.getContent(lineMessageId);
		if (!content) return;
		const key = `line/${lineMessageId}`;
		await env.MEDIA.put(key, content.body, {
			httpMetadata: { contentType: content.contentType },
			customMetadata: { conversationId, messageId },
		});
		const message = await updateMessageMedia(
			env.DB,
			messageId,
			key,
			content.contentType,
		);
		if (message) {
			const conversation = await getConversation(env.DB, conversationId);
			if (conversation) {
				await inboxStub(env).broadcast({
					type: "message.new",
					message,
					conversation,
				});
			}
		}
	} catch (err) {
		console.error("store media failed", lineMessageId, err);
	}
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
		event.type === "follow" ? "使用者加入好友" : "官方帳號被加入群組",
		now,
		env,
		target,
		client,
		true,
	);

	const welcome = env.WELCOME_MESSAGE?.trim();
	if (welcome && event.replyToken) {
		try {
			await client.reply(event.replyToken, [{ type: "text", text: welcome }]);
			const inserted = await insertMessage(env.DB, {
				id: crypto.randomUUID(),
				conversationId: target.conversationId,
				direction: "outbound",
				sender: "system",
				type: "text",
				text: welcome,
				createdAt: now + 1,
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
