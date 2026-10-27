import type {
	Conversation,
	ConversationStatus,
	Message,
	MessageType,
	MessageSender,
	MessageDirection,
	Prompt,
	PromptOption,
	PromptStatus,
} from "../shared/types";

/**
 * D1 存取層。所有 SQL 集中在這裡，路由與 LINE 介接層只呼叫這裡的函式。
 */

interface ConversationRow {
	id: string;
	channel: string;
	external_id: string;
	display_name: string | null;
	picture_url: string | null;
	status: string;
	last_message_text: string | null;
	last_message_at: number | null;
	last_inbound_at: number | null;
	last_outbound_at: number | null;
	unread_count: number;
	needs_attention: number;
	reminder_instance_id: string | null;
	created_at: number;
	updated_at: number;
}

interface MessageRow {
	id: string;
	conversation_id: string;
	direction: string;
	sender: string;
	type: string;
	text: string | null;
	media_key: string | null;
	media_content_type: string | null;
	metadata: string | null;
	external_id: string | null;
	created_at: number;
}

function toConversation(row: ConversationRow): Conversation {
	return {
		id: row.id,
		channel: row.channel as Conversation["channel"],
		externalId: row.external_id,
		displayName: row.display_name,
		pictureUrl: row.picture_url,
		status: row.status as ConversationStatus,
		lastMessageText: row.last_message_text,
		lastMessageAt: row.last_message_at,
		lastInboundAt: row.last_inbound_at,
		lastOutboundAt: row.last_outbound_at,
		unreadCount: row.unread_count,
		needsAttention: row.needs_attention === 1,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

function toMessage(row: MessageRow): Message {
	let metadata: Record<string, unknown> | null = null;
	if (row.metadata) {
		try {
			metadata = JSON.parse(row.metadata);
		} catch {
			metadata = null;
		}
	}
	return {
		id: row.id,
		conversationId: row.conversation_id,
		direction: row.direction as MessageDirection,
		sender: row.sender as MessageSender,
		type: row.type as MessageType,
		text: row.text,
		mediaKey: row.media_key,
		mediaContentType: row.media_content_type,
		metadata,
		externalId: row.external_id,
		createdAt: row.created_at,
	};
}

export async function getConversation(
	db: D1Database,
	id: string,
): Promise<Conversation | null> {
	const row = await db
		.prepare("SELECT * FROM conversations WHERE id = ?")
		.bind(id)
		.first<ConversationRow>();
	return row ? toConversation(row) : null;
}

export async function getReminderInstanceId(
	db: D1Database,
	conversationId: string,
): Promise<string | null> {
	const row = await db
		.prepare("SELECT reminder_instance_id FROM conversations WHERE id = ?")
		.bind(conversationId)
		.first<{ reminder_instance_id: string | null }>();
	return row?.reminder_instance_id ?? null;
}

export async function setReminderInstanceId(
	db: D1Database,
	conversationId: string,
	instanceId: string | null,
): Promise<void> {
	await db
		.prepare("UPDATE conversations SET reminder_instance_id = ? WHERE id = ?")
		.bind(instanceId, conversationId)
		.run();
}

export async function listConversations(
	db: D1Database,
	status: ConversationStatus | "all",
	limit = 100,
): Promise<Conversation[]> {
	const stmt =
		status === "all"
			? db
					.prepare(
						"SELECT * FROM conversations ORDER BY last_message_at DESC LIMIT ?",
					)
					.bind(limit)
			: db
					.prepare(
						"SELECT * FROM conversations WHERE status = ? ORDER BY last_message_at DESC LIMIT ?",
					)
					.bind(status, limit);
	const { results } = await stmt.all<ConversationRow>();
	return results.map(toConversation);
}

/**
 * 建立或更新對話的基本資料（顯示名稱、頭像）。
 */
export async function upsertConversation(
	db: D1Database,
	input: {
		id: string;
		channel: Conversation["channel"];
		externalId: string;
		displayName?: string | null;
		pictureUrl?: string | null;
		now: number;
	},
): Promise<Conversation> {
	await db
		.prepare(
			`INSERT INTO conversations (id, channel, external_id, display_name, picture_url, status, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, 'open', ?, ?)
			 ON CONFLICT(id) DO UPDATE SET
				display_name = COALESCE(excluded.display_name, conversations.display_name),
				picture_url = COALESCE(excluded.picture_url, conversations.picture_url),
				updated_at = excluded.updated_at`,
		)
		.bind(
			input.id,
			input.channel,
			input.externalId,
			input.displayName ?? null,
			input.pictureUrl ?? null,
			input.now,
			input.now,
		)
		.run();
	const conversation = await getConversation(db, input.id);
	if (!conversation) {
		throw new Error(`conversation ${input.id} missing after upsert`);
	}
	return conversation;
}

export interface NewMessageInput {
	id: string;
	conversationId: string;
	direction: MessageDirection;
	sender: MessageSender;
	type: MessageType;
	text?: string | null;
	mediaKey?: string | null;
	mediaContentType?: string | null;
	metadata?: Record<string, unknown> | null;
	externalId?: string | null;
	createdAt: number;
}

/** 對話清單上顯示的預覽文字 */
export function previewText(type: MessageType, text: string | null): string {
	if ((type === "text" || type === "prompt") && text) return text;
	const labels: Record<MessageType, string> = {
		text: "",
		image: "[圖片]",
		video: "[影片]",
		audio: "[語音]",
		file: "[檔案]",
		sticker: "[貼圖]",
		location: "[位置]",
		prompt: "[選擇題]",
		rich: "[互動訊息]",
		unknown: "[不支援的訊息]",
	};
	return labels[type] || "";
}

/**
 * 寫入訊息並同步更新對話摘要。
 * 使用者傳入的訊息會把對話重新打開並累加未讀；客服送出的訊息會清除「待處理」標記。
 * 回傳 null 代表這則訊息（依 external_id）已經存在，屬於 LINE 重送。
 */
export async function insertMessage(
	db: D1Database,
	input: NewMessageInput,
): Promise<{ message: Message; conversation: Conversation } | null> {
	const preview = previewText(input.type, input.text ?? null);
	const isInbound = input.direction === "inbound";

	const insert = db
		.prepare(
			`INSERT OR IGNORE INTO messages
			 (id, conversation_id, direction, sender, type, text, media_key, media_content_type, metadata, external_id, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.bind(
			input.id,
			input.conversationId,
			input.direction,
			input.sender,
			input.type,
			input.text ?? null,
			input.mediaKey ?? null,
			input.mediaContentType ?? null,
			input.metadata ? JSON.stringify(input.metadata) : null,
			input.externalId ?? null,
			input.createdAt,
		);

	const inserted = await insert.run();
	if (!inserted.meta.changes) {
		return null;
	}

	const update = isInbound
		? db
				.prepare(
					`UPDATE conversations SET
						last_message_text = ?, last_message_at = ?, last_inbound_at = ?,
						unread_count = unread_count + 1, status = 'open', updated_at = ?
					 WHERE id = ?`,
				)
				.bind(
					preview,
					input.createdAt,
					input.createdAt,
					input.createdAt,
					input.conversationId,
				)
		: db
				.prepare(
					`UPDATE conversations SET
						last_message_text = ?, last_message_at = ?, last_outbound_at = ?,
						needs_attention = 0, updated_at = ?
					 WHERE id = ?`,
				)
				.bind(
					preview,
					input.createdAt,
					input.createdAt,
					input.createdAt,
					input.conversationId,
				);
	await update.run();

	const row = await db
		.prepare("SELECT * FROM messages WHERE id = ?")
		.bind(input.id)
		.first<MessageRow>();
	const conversation = await getConversation(db, input.conversationId);
	if (!row || !conversation) {
		throw new Error("message/conversation missing after insert");
	}
	return { message: toMessage(row), conversation };
}

export async function updateMessageMedia(
	db: D1Database,
	messageId: string,
	mediaKey: string,
	contentType: string,
): Promise<Message | null> {
	await db
		.prepare(
			"UPDATE messages SET media_key = ?, media_content_type = ? WHERE id = ?",
		)
		.bind(mediaKey, contentType, messageId)
		.run();
	const row = await db
		.prepare("SELECT * FROM messages WHERE id = ?")
		.bind(messageId)
		.first<MessageRow>();
	return row ? toMessage(row) : null;
}

export async function listMessages(
	db: D1Database,
	conversationId: string,
	options: { before?: number; limit?: number } = {},
): Promise<Message[]> {
	const limit = Math.min(options.limit ?? 50, 200);
	const stmt = options.before
		? db
				.prepare(
					`SELECT * FROM messages WHERE conversation_id = ? AND created_at < ?
					 ORDER BY created_at DESC LIMIT ?`,
				)
				.bind(conversationId, options.before, limit)
		: db
				.prepare(
					`SELECT * FROM messages WHERE conversation_id = ?
					 ORDER BY created_at DESC LIMIT ?`,
				)
				.bind(conversationId, limit);
	const { results } = await stmt.all<MessageRow>();
	return results.map(toMessage).reverse();
}

export async function markConversationRead(
	db: D1Database,
	conversationId: string,
): Promise<Conversation | null> {
	await db
		.prepare(
			"UPDATE conversations SET unread_count = 0, updated_at = ? WHERE id = ?",
		)
		.bind(Date.now(), conversationId)
		.run();
	return getConversation(db, conversationId);
}

export async function setConversationStatus(
	db: D1Database,
	conversationId: string,
	status: ConversationStatus,
): Promise<Conversation | null> {
	await db
		.prepare(
			`UPDATE conversations SET status = ?, updated_at = ?,
				needs_attention = CASE WHEN ? = 'closed' THEN 0 ELSE needs_attention END
			 WHERE id = ?`,
		)
		.bind(status, Date.now(), status, conversationId)
		.run();
	return getConversation(db, conversationId);
}

/**
 * 逾時未回覆：只有在「最後一則仍是使用者的訊息」時才標記。
 * 回傳 null 代表客服已經回過，不需要提醒。
 */
export async function markNeedsAttentionIfUnanswered(
	db: D1Database,
	conversationId: string,
): Promise<Conversation | null> {
	const result = await db
		.prepare(
			`UPDATE conversations SET needs_attention = 1, updated_at = ?
			 WHERE id = ? AND status = 'open'
				 AND last_inbound_at IS NOT NULL
				 AND (last_outbound_at IS NULL OR last_inbound_at > last_outbound_at)`,
		)
		.bind(Date.now(), conversationId)
		.run();
	if (!result.meta.changes) return null;
	return getConversation(db, conversationId);
}

export async function updateMessageMetadata(
	db: D1Database,
	messageId: string,
	metadata: Record<string, unknown>,
): Promise<Message | null> {
	await db
		.prepare("UPDATE messages SET metadata = ? WHERE id = ?")
		.bind(JSON.stringify(metadata), messageId)
		.run();
	const row = await db
		.prepare("SELECT * FROM messages WHERE id = ?")
		.bind(messageId)
		.first<MessageRow>();
	return row ? toMessage(row) : null;
}

// ---------- 可追蹤訊息（prompts） ----------

interface PromptRow {
	id: string;
	conversation_id: string;
	message_id: string | null;
	template_key: string | null;
	body: string | null;
	question: string;
	options: string;
	variables: string | null;
	status: string;
	choice: string | null;
	choice_label: string | null;
	responded_at: number | null;
	created_at: number;
	payload?: string | null;
	display_name?: string | null;
}

function parseJson<T>(value: string | null, fallback: T): T {
	if (!value) return fallback;
	try {
		return JSON.parse(value) as T;
	} catch {
		return fallback;
	}
}

function toPrompt(row: PromptRow): Prompt {
	return {
		id: row.id,
		conversationId: row.conversation_id,
		messageId: row.message_id,
		templateKey: row.template_key,
		body: row.body,
		question: row.question,
		options: parseJson<PromptOption[]>(row.options, []),
		variables: parseJson<Record<string, string> | null>(row.variables, null),
		status: row.status as PromptStatus,
		choice: row.choice,
		choiceLabel: row.choice_label,
		respondedAt: row.responded_at,
		createdAt: row.created_at,
		payload: parseJson<unknown[] | null>(row.payload ?? null, null),
		displayName: row.display_name ?? undefined,
	};
}

export async function createPrompt(
	db: D1Database,
	input: {
		id: string;
		conversationId: string;
		messageId: string | null;
		templateKey?: string | null;
		body?: string | null;
		question: string;
		options: PromptOption[];
		variables?: Record<string, string> | null;
		payload?: unknown[] | null;
		createdAt: number;
	},
): Promise<Prompt> {
	await db
		.prepare(
			`INSERT INTO prompts
			 (id, conversation_id, message_id, template_key, body, question, options, variables, payload, status, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
		)
		.bind(
			input.id,
			input.conversationId,
			input.messageId,
			input.templateKey ?? null,
			input.body ?? null,
			input.question,
			JSON.stringify(input.options),
			input.variables ? JSON.stringify(input.variables) : null,
			input.payload ? JSON.stringify(input.payload) : null,
			input.createdAt,
		)
		.run();
	const prompt = await getPrompt(db, input.id);
	if (!prompt) throw new Error("prompt missing after insert");
	return prompt;
}

export async function getPrompt(
	db: D1Database,
	id: string,
): Promise<Prompt | null> {
	const row = await db
		.prepare(
			`SELECT p.*, c.display_name FROM prompts p
			 LEFT JOIN conversations c ON c.id = p.conversation_id
			 WHERE p.id = ?`,
		)
		.bind(id)
		.first<PromptRow>();
	return row ? toPrompt(row) : null;
}

/**
 * 記錄一次點擊，並把 prompt 的最新選擇更新上去。
 * 回傳 alreadyAnswered 讓呼叫端決定回覆文案。
 */
export async function recordPromptResponse(
	db: D1Database,
	promptId: string,
	choice: string,
	choiceLabel: string | null,
	now: number,
): Promise<{ prompt: Prompt; alreadyAnswered: boolean } | null> {
	const before = await getPrompt(db, promptId);
	if (!before) return null;

	await db.batch([
		db
			.prepare(
				"INSERT INTO prompt_responses (id, prompt_id, choice, choice_label, created_at) VALUES (?, ?, ?, ?, ?)",
			)
			.bind(crypto.randomUUID(), promptId, choice, choiceLabel, now),
		db
			.prepare(
				"UPDATE prompts SET status = 'answered', choice = ?, choice_label = ?, responded_at = ? WHERE id = ?",
			)
			.bind(choice, choiceLabel, now, promptId),
	]);

	const prompt = await getPrompt(db, promptId);
	if (!prompt) return null;
	return { prompt, alreadyAnswered: before.status === "answered" };
}

export async function listPrompts(
	db: D1Database,
	options: { status?: PromptStatus | "all"; conversationId?: string; limit?: number } = {},
): Promise<Prompt[]> {
	const limit = Math.min(options.limit ?? 100, 500);
	const where: string[] = [];
	const binds: unknown[] = [];
	if (options.status && options.status !== "all") {
		where.push("p.status = ?");
		binds.push(options.status);
	}
	if (options.conversationId) {
		where.push("p.conversation_id = ?");
		binds.push(options.conversationId);
	}
	const sql = `SELECT p.*, c.display_name FROM prompts p
		LEFT JOIN conversations c ON c.id = p.conversation_id
		${where.length ? `WHERE ${where.join(" AND ")}` : ""}
		ORDER BY p.created_at DESC LIMIT ?`;
	const { results } = await db
		.prepare(sql)
		.bind(...binds, limit)
		.all<PromptRow>();
	return results.map(toPrompt);
}
