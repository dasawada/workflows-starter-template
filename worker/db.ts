import type {
	Conversation,
	ConversationStatus,
	DeliveryStatus,
	ImportBatch,
	ImportReport,
	ImportRowGroup,
	IntegrityEvent,
	IntegrityKind,
	IntegritySeverity,
	IntegrityStatus,
	MediaStatus,
	Message,
	MessageSource,
	MessageType,
	MessageSender,
	MessageDirection,
	Notification,
	NotificationStatus,
	Prompt,
	PromptOption,
	PromptStatus,
	Stats,
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
	mark_as_read_token: string | null;
	assigned_to: string | null;
	assigned_at: number | null;
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
	edited_at: number | null;
	unsent_at: number | null;
	source: string | null;
	delivery_status: string | null;
	retry_key: string | null;
	media_status: string | null;
	agent_name: string | null;
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
		assignedTo: row.assigned_to ?? null,
		assignedAt: row.assigned_at ?? null,
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
		editedAt: row.edited_at ?? null,
		unsentAt: row.unsent_at ?? null,
		source: (row.source as MessageSource) ?? "line_webhook",
		deliveryStatus: (row.delivery_status as DeliveryStatus) ?? null,
		mediaStatus: (row.media_status as MediaStatus) ?? null,
		agentName: row.agent_name ?? null,
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

/**
 * 對話清單：游標分頁（before = 上一頁最後一筆的 last_message_at）+ 名稱搜尋。
 * 每頁上限 100，預設 50；前端只保留畫面需要的幾頁，所以總對話數再多也不影響。
 */
export async function listConversations(
	db: D1Database,
	status: ConversationStatus | "all",
	options: { before?: number; q?: string; limit?: number } = {},
): Promise<Conversation[]> {
	const limit = Math.min(Math.max(options.limit ?? 50, 1), 100);
	const where: string[] = [];
	const binds: unknown[] = [];
	if (status !== "all") {
		where.push("status = ?");
		binds.push(status);
	}
	if (options.before) {
		where.push("last_message_at < ?");
		binds.push(options.before);
	}
	const q = options.q?.trim();
	if (q) {
		where.push("(display_name LIKE ? OR external_id LIKE ?)");
		const like = `%${q.replace(/[%_]/g, (c) => `\\${c}`)}%`;
		binds.push(like, like);
	}
	const sql = `SELECT * FROM conversations
		${where.length ? `WHERE ${where.join(" AND ")}` : ""}
		ORDER BY last_message_at DESC LIMIT ?`;
	const { results } = await db
		.prepare(sql)
		.bind(...binds, limit)
		.all<ConversationRow>();
	return results.map(toConversation);
}

export async function getStats(db: D1Database): Promise<Stats> {
	const row = await db
		.prepare(
			`SELECT
				COALESCE(SUM(CASE WHEN status = 'open' THEN unread_count ELSE 0 END), 0) AS unread_total,
				SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END) AS open_count,
				SUM(CASE WHEN status = 'open' AND needs_attention = 1 THEN 1 ELSE 0 END) AS needs_attention_count
			 FROM conversations`,
		)
		.first<{ unread_total: number; open_count: number; needs_attention_count: number }>();
	return {
		unreadTotal: row?.unread_total ?? 0,
		openCount: row?.open_count ?? 0,
		needsAttentionCount: row?.needs_attention_count ?? 0,
	};
}

/** D1 batch 的結果取第 n 筆的第一列 */
function firstRow<T>(results: D1Result[], index: number): T | null {
	const rows = results[index]?.results as T[] | undefined;
	return rows && rows.length ? rows[0] : null;
}

/**
 * 建立或更新對話的基本資料（顯示名稱、頭像）。一次往返。
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
	const upsert = db
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
		);
	const results = await db.batch([
		upsert,
		db.prepare("SELECT * FROM conversations WHERE id = ?").bind(input.id),
	]);
	const row = firstRow<ConversationRow>(results, 1);
	if (!row) {
		throw new Error(`conversation ${input.id} missing after upsert`);
	}
	return toConversation(row);
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
	/** 使用者訊息附的 markAsReadToken，記在對話上供客服讀過後呼叫已讀 API */
	markAsReadToken?: string | null;
	source?: MessageSource;
	deliveryStatus?: DeliveryStatus | null;
	retryKey?: string | null;
	mediaStatus?: MediaStatus | null;
	agentName?: string | null;
	/** 只寫時間軸、不動對話的未讀／最後訊息／逾時狀態（接手紀錄之類的系統註記） */
	silent?: boolean;
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
 * 寫入訊息並同步更新對話摘要，整個流程一次 D1 往返（batch）。
 * 使用者傳入的訊息會把對話重新打開並累加未讀；客服送出的訊息會清除「待處理」標記。
 * 對話摘要的 UPDATE 以「這則訊息真的存在」為條件，所以 LINE 重送（INSERT 被 IGNORE）不會重複累加未讀。
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
			 (id, conversation_id, direction, sender, type, text, media_key, media_content_type, metadata, external_id, created_at,
			  source, delivery_status, retry_key, media_status, agent_name)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
			input.source ?? (input.sender === "system" ? "system" : isInbound ? "line_webhook" : "console"),
			input.deliveryStatus ?? null,
			input.retryKey ?? null,
			input.mediaStatus ?? null,
			input.agentName ?? null,
		);

	const update = input.silent
		? db
				.prepare("UPDATE conversations SET updated_at = ? WHERE id = ? AND EXISTS (SELECT 1 FROM messages WHERE id = ?)")
				.bind(input.createdAt, input.conversationId, input.id)
		: isInbound
		? db
				.prepare(
					`UPDATE conversations SET
						last_message_text = ?, last_message_at = ?, last_inbound_at = ?,
						unread_count = unread_count + 1, status = 'open', updated_at = ?,
						mark_as_read_token = COALESCE(?, mark_as_read_token)
					 WHERE id = ? AND EXISTS (SELECT 1 FROM messages WHERE id = ?)`,
				)
				.bind(
					preview,
					input.createdAt,
					input.createdAt,
					input.createdAt,
					input.markAsReadToken ?? null,
					input.conversationId,
					input.id,
				)
		: db
				.prepare(
					`UPDATE conversations SET
						last_message_text = ?, last_message_at = ?, last_outbound_at = ?,
						needs_attention = 0, updated_at = ?
					 WHERE id = ? AND EXISTS (SELECT 1 FROM messages WHERE id = ?)`,
				)
				.bind(
					preview,
					input.createdAt,
					input.createdAt,
					input.createdAt,
					input.conversationId,
					input.id,
				);

	const results = await db.batch([
		insert,
		update,
		db.prepare("SELECT * FROM messages WHERE id = ?").bind(input.id),
		db.prepare("SELECT * FROM conversations WHERE id = ?").bind(input.conversationId),
	]);
	if (!results[0].meta.changes) {
		return null;
	}
	const row = firstRow<MessageRow>(results, 2);
	const convRow = firstRow<ConversationRow>(results, 3);
	if (!row || !convRow) {
		throw new Error("message/conversation missing after insert");
	}
	return { message: toMessage(row), conversation: toConversation(convRow) };
}

export async function updateMessageMedia(
	db: D1Database,
	messageId: string,
	mediaKey: string,
	contentType: string,
): Promise<Message | null> {
	const results = await db.batch([
		db
			.prepare("UPDATE messages SET media_key = ?, media_content_type = ?, media_status = 'stored' WHERE id = ?")
			.bind(mediaKey, contentType, messageId),
		db.prepare("SELECT * FROM messages WHERE id = ?").bind(messageId),
	]);
	const row = firstRow<MessageRow>(results, 1);
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

/**
 * 客服打開對話：清除未讀，並交回尚未用掉的 markAsReadToken（呼叫 LINE 已讀 API 用）。
 */
export async function markConversationRead(
	db: D1Database,
	conversationId: string,
): Promise<{ conversation: Conversation; markAsReadToken: string | null } | null> {
	const results = await db.batch([
		db
			.prepare("UPDATE conversations SET unread_count = 0, updated_at = ? WHERE id = ?")
			.bind(Date.now(), conversationId),
		db.prepare("SELECT * FROM conversations WHERE id = ?").bind(conversationId),
	]);
	const row = firstRow<ConversationRow>(results, 1);
	if (!row) return null;
	return { conversation: toConversation(row), markAsReadToken: row.mark_as_read_token };
}

/** 已讀 API 成功後清掉 token，避免重複呼叫；若期間又有新訊息（token 已換）則不動 */
export async function clearMarkAsReadToken(
	db: D1Database,
	conversationId: string,
	token: string,
): Promise<void> {
	await db
		.prepare("UPDATE conversations SET mark_as_read_token = NULL WHERE id = ? AND mark_as_read_token = ?")
		.bind(conversationId, token)
		.run();
}

/** 回報用：某則訊息前後各 n 則，給工程端讀上下文 */
export async function listMessagesAround(db: D1Database, message: Message, n = 5): Promise<Message[]> {
	const results = await db.batch([
		db
			.prepare("SELECT * FROM messages WHERE conversation_id = ? AND created_at <= ? AND id != ? ORDER BY created_at DESC LIMIT ?")
			.bind(message.conversationId, message.createdAt, message.id, n),
		db
			.prepare("SELECT * FROM messages WHERE conversation_id = ? AND created_at > ? ORDER BY created_at LIMIT ?")
			.bind(message.conversationId, message.createdAt, n),
	]);
	const before = ((results[0].results ?? []) as MessageRow[]).map(toMessage).reverse();
	const after = ((results[1].results ?? []) as MessageRow[]).map(toMessage);
	return [...before, message, ...after];
}

/** 標記訊息已被客服回報（泡泡上顯示） */
export async function markMessageReported(db: D1Database, messageId: string, reportedAt: number): Promise<Message | null> {
	const results = await db.batch([
		db
			.prepare("UPDATE messages SET metadata = json_set(COALESCE(metadata, '{}'), '$.reportedAt', ?) WHERE id = ?")
			.bind(reportedAt, messageId),
		db.prepare("SELECT * FROM messages WHERE id = ?").bind(messageId),
	]);
	const row = firstRow<MessageRow>(results, 1);
	return row ? toMessage(row) : null;
}

/**
 * 依 LINE message id 找本地訊息（引用訊息用）。
 * 使用者的訊息 external_id 就是 LINE id；我方一次推送多則時只有第一則在 external_id，
 * 其餘在 metadata.lineMessageIds，所以在同一個對話內再查一次 JSON 陣列。
 */
export async function findMessageByExternalId(
	db: D1Database,
	externalId: string,
	conversationId?: string,
): Promise<Message | null> {
	const row = await db
		.prepare("SELECT * FROM messages WHERE external_id = ?")
		.bind(externalId)
		.first<MessageRow>();
	if (row) return toMessage(row);
	if (!conversationId) return null;
	const inJson = await db
		.prepare(
			`SELECT * FROM messages WHERE conversation_id = ? AND direction = 'outbound'
			   AND EXISTS (SELECT 1 FROM json_each(json_extract(metadata, '$.lineMessageIds')) WHERE value = ?)
			 LIMIT 1`,
		)
		.bind(conversationId, externalId)
		.first<MessageRow>();
	return inJson ? toMessage(inJson) : null;
}

/**
 * 使用者撤回訊息：清掉內容與附件 key，只留時間軸位置與發言者；對話預覽若正是這則也一併改掉。
 * 以 unsent_at IS NULL 為條件，重送的 unsend 事件不會重複處理（回傳 null）。
 * 回傳撤回前的 media_key，讓呼叫端刪 R2 物件。
 */
export async function unsendMessage(
	db: D1Database,
	externalId: string,
	unsentAt: number,
): Promise<{ message: Message; conversation: Conversation; mediaKey: string | null } | null> {
	const results = await db.batch([
		db.prepare("SELECT * FROM messages WHERE external_id = ? AND unsent_at IS NULL").bind(externalId),
		db
			.prepare(
				`UPDATE messages SET
					text = NULL, media_key = NULL, media_content_type = NULL, unsent_at = ?,
					metadata = json_object(
						'senderName', json_extract(metadata, '$.senderName'),
						'senderUserId', json_extract(metadata, '$.senderUserId'))
				 WHERE external_id = ? AND unsent_at IS NULL`,
			)
			.bind(unsentAt, externalId),
		db
			.prepare(
				`UPDATE conversations SET last_message_text = '[訊息已撤回]', updated_at = ?
				 WHERE id = (SELECT conversation_id FROM messages WHERE external_id = ? AND unsent_at = ?)
				   AND last_message_at = (SELECT created_at FROM messages WHERE external_id = ?)`,
			)
			.bind(unsentAt, externalId, unsentAt, externalId),
		db.prepare("SELECT * FROM messages WHERE external_id = ?").bind(externalId),
		db
			.prepare("SELECT * FROM conversations WHERE id = (SELECT conversation_id FROM messages WHERE external_id = ?)")
			.bind(externalId),
	]);
	const before = firstRow<MessageRow>(results, 0);
	if (!before || !results[1].meta.changes) return null;
	const row = firstRow<MessageRow>(results, 3);
	const convRow = firstRow<ConversationRow>(results, 4);
	if (!row || !convRow) return null;
	return { message: toMessage(row), conversation: toConversation(convRow), mediaKey: before.media_key };
}

/**
 * 群組文字訊息被編輯：以同一個 LINE message id 更新文字，保留第一版在 metadata.originalText。
 * 事件可能亂序，只接受比目前 edited_at 更新的版本；已撤回的訊息不再更新。
 * 回傳 null 代表找不到、過期或重送。
 */
export async function editMessageText(
	db: D1Database,
	externalId: string,
	text: string,
	editedAt: number,
): Promise<{ message: Message; conversation: Conversation } | null> {
	const results = await db.batch([
		db
			.prepare(
				`UPDATE messages SET
					text = ?, edited_at = ?,
					metadata = json_set(COALESCE(metadata, '{}'), '$.originalText',
						COALESCE(json_extract(metadata, '$.originalText'), text))
				 WHERE external_id = ? AND unsent_at IS NULL AND (edited_at IS NULL OR edited_at < ?)`,
			)
			.bind(text, editedAt, externalId, editedAt),
		db
			.prepare(
				`UPDATE conversations SET last_message_text = ?, updated_at = ?
				 WHERE id = (SELECT conversation_id FROM messages WHERE external_id = ? AND edited_at = ?)
				   AND last_message_at = (SELECT created_at FROM messages WHERE external_id = ?)`,
			)
			.bind(text, editedAt, externalId, editedAt, externalId),
		db.prepare("SELECT * FROM messages WHERE external_id = ?").bind(externalId),
		db
			.prepare("SELECT * FROM conversations WHERE id = (SELECT conversation_id FROM messages WHERE external_id = ?)")
			.bind(externalId),
	]);
	if (!results[0].meta.changes) return null;
	const row = firstRow<MessageRow>(results, 2);
	const convRow = firstRow<ConversationRow>(results, 3);
	if (!row || !convRow) return null;
	return { message: toMessage(row), conversation: toConversation(convRow) };
}

export async function setConversationStatus(
	db: D1Database,
	conversationId: string,
	status: ConversationStatus,
): Promise<Conversation | null> {
	const results = await db.batch([
		db
			.prepare(
				`UPDATE conversations SET status = ?, updated_at = ?,
					needs_attention = CASE WHEN ? = 'closed' THEN 0 ELSE needs_attention END
				 WHERE id = ?`,
			)
			.bind(status, Date.now(), status, conversationId),
		db.prepare("SELECT * FROM conversations WHERE id = ?").bind(conversationId),
	]);
	const row = firstRow<ConversationRow>(results, 1);
	return row ? toConversation(row) : null;
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
	const results = await db.batch([
		db.prepare("UPDATE messages SET metadata = ? WHERE id = ?").bind(JSON.stringify(metadata), messageId),
		db.prepare("SELECT * FROM messages WHERE id = ?").bind(messageId),
	]);
	const row = firstRow<MessageRow>(results, 1);
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
	allow_change?: number;
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
		allowChange: row.allow_change === 1,
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
		allowChange?: boolean;
		createdAt: number;
	},
): Promise<Prompt> {
	const insert = db
		.prepare(
			`INSERT INTO prompts
			 (id, conversation_id, message_id, template_key, body, question, options, variables, payload, allow_change, status, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
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
			input.allowChange ? 1 : 0,
			input.createdAt,
		);
	const results = await db.batch([insert, promptSelect(db, input.id)]);
	const row = firstRow<PromptRow>(results, 1);
	if (!row) throw new Error("prompt missing after insert");
	return toPrompt(row);
}

function promptSelect(db: D1Database, id: string) {
	return db
		.prepare(
			`SELECT p.*, c.display_name FROM prompts p
			 LEFT JOIN conversations c ON c.id = p.conversation_id
			 WHERE p.id = ?`,
		)
		.bind(id);
}

export async function getPrompt(
	db: D1Database,
	id: string,
): Promise<Prompt | null> {
	const row = await promptSelect(db, id).first<PromptRow>();
	return row ? toPrompt(row) : null;
}

/**
 * 記錄一次點擊，一次 D1 往返。每一次都寫 prompt_responses（留痕）；
 * prompt 本身的選擇只在「尚未回覆」或「allow_change 開啟」時更新（條件寫在 SQL 裡）。
 * 回傳 applied 告訉呼叫端這次點擊有沒有改變結果。
 */
export async function recordPromptResponse(
	db: D1Database,
	promptId: string,
	choice: string,
	choiceLabel: string | null,
	now: number,
): Promise<{ prompt: Prompt; alreadyAnswered: boolean; applied: boolean } | null> {
	const results = await db.batch([
		db.prepare("SELECT status FROM prompts WHERE id = ?").bind(promptId),
		db
			.prepare(
				`INSERT INTO prompt_responses (id, prompt_id, choice, choice_label, created_at)
				 SELECT ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM prompts WHERE id = ?)`,
			)
			.bind(crypto.randomUUID(), promptId, choice, choiceLabel, now, promptId),
		db
			.prepare(
				`UPDATE prompts SET status = 'answered', choice = ?, choice_label = ?, responded_at = ?
				 WHERE id = ? AND (status != 'answered' OR allow_change = 1)`,
			)
			.bind(choice, choiceLabel, now, promptId),
		promptSelect(db, promptId),
	]);
	const before = firstRow<{ status: string }>(results, 0);
	if (!before) return null;
	const row = firstRow<PromptRow>(results, 3);
	if (!row) return null;
	return {
		prompt: toPrompt(row),
		alreadyAnswered: before.status === "answered",
		applied: (results[2].meta.changes ?? 0) > 0,
	};
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


// ---------- 發訊 outbox：送達狀態與重試 ----------

export async function findMessageByRetryKey(db: D1Database, retryKey: string): Promise<Message | null> {
	const row = await db.prepare("SELECT * FROM messages WHERE retry_key = ?").bind(retryKey).first<MessageRow>();
	return row ? toMessage(row) : null;
}

export async function getMessageRetryKey(db: D1Database, id: string): Promise<string | null> {
	const row = await db.prepare("SELECT retry_key FROM messages WHERE id = ?").bind(id).first<{ retry_key: string | null }>();
	return row?.retry_key ?? null;
}

export async function getMessage(db: D1Database, id: string): Promise<Message | null> {
	const row = await db.prepare("SELECT * FROM messages WHERE id = ?").bind(id).first<MessageRow>();
	return row ? toMessage(row) : null;
}

/**
 * 更新客服訊息的送達狀態；失敗原因與 LINE request id 一併記進 metadata。
 * LINE 回的 sentMessages 有值時：第一則的 id 寫進 external_id（引用查詢用），全部 id 與 quoteToken 存進 metadata。
 */
export async function setDeliveryStatus(
	db: D1Database,
	messageId: string,
	status: DeliveryStatus,
	extra: {
		error?: string | null;
		lineRequestId?: string | null;
		lineStatus?: number | null;
		sentMessages?: { id: string; quoteToken?: string }[];
	} = {},
): Promise<Message | null> {
	const sent = extra.sentMessages ?? [];
	const update = sent.length
		? db
				.prepare(
					`UPDATE messages SET delivery_status = ?,
						external_id = COALESCE(external_id, ?),
						metadata = json_set(COALESCE(metadata, '{}'),
							'$.deliveryError', ?, '$.lineRequestId', ?, '$.lineStatus', ?, '$.deliveryUpdatedAt', ?,
							'$.lineMessageIds', json(?), '$.quoteToken', ?)
					 WHERE id = ?`,
				)
				.bind(
					status,
					sent[0].id,
					extra.error ?? null,
					extra.lineRequestId ?? null,
					extra.lineStatus ?? null,
					Date.now(),
					JSON.stringify(sent.map((m) => m.id)),
					sent[0].quoteToken ?? null,
					messageId,
				)
		: db
				.prepare(
					`UPDATE messages SET delivery_status = ?,
						metadata = json_set(COALESCE(metadata, '{}'),
							'$.deliveryError', ?, '$.lineRequestId', ?, '$.lineStatus', ?, '$.deliveryUpdatedAt', ?)
					 WHERE id = ?`,
				)
				.bind(status, extra.error ?? null, extra.lineRequestId ?? null, extra.lineStatus ?? null, Date.now(), messageId);
	const results = await db.batch([update, db.prepare("SELECT * FROM messages WHERE id = ?").bind(messageId)]);
	const row = firstRow<MessageRow>(results, 1);
	return row ? toMessage(row) : null;
}

/** 排程用：送出中超過一段時間還沒確認的訊息 */
export async function listPendingOutbound(db: D1Database, olderThan: number, limit = 50): Promise<Message[]> {
	const { results } = await db
		.prepare(
			`SELECT * FROM messages WHERE delivery_status = 'pending' AND created_at < ?
			 ORDER BY created_at LIMIT ?`,
		)
		.bind(olderThan, limit)
		.all<MessageRow>();
	return results.map(toMessage);
}

// ---------- 附件保存狀態 ----------

export async function setMediaStatus(
	db: D1Database,
	messageId: string,
	status: MediaStatus,
	extra: { attempts?: number; error?: string | null } = {},
): Promise<Message | null> {
	const results = await db.batch([
		db
			.prepare(
				`UPDATE messages SET media_status = ?,
					metadata = json_set(COALESCE(metadata, '{}'), '$.mediaAttempts', ?, '$.mediaError', ?)
				 WHERE id = ?`,
			)
			.bind(status, extra.attempts ?? 0, extra.error ?? null, messageId),
		db.prepare("SELECT * FROM messages WHERE id = ?").bind(messageId),
	]);
	const row = firstRow<MessageRow>(results, 1);
	return row ? toMessage(row) : null;
}

/** 排程用：還沒抓到或抓失敗的附件 */
export async function listPendingMedia(db: D1Database, olderThan: number, limit = 20): Promise<Message[]> {
	const { results } = await db
		.prepare(
			`SELECT * FROM messages WHERE media_status IN ('pending', 'failed') AND unsent_at IS NULL AND created_at < ?
			 ORDER BY created_at LIMIT ?`,
		)
		.bind(olderThan, limit)
		.all<MessageRow>();
	return results.map(toMessage);
}

// ---------- 多客服 ----------

export async function assignConversation(
	db: D1Database,
	conversationId: string,
	agent: string | null,
): Promise<Conversation | null> {
	const now = Date.now();
	const results = await db.batch([
		db
			.prepare("UPDATE conversations SET assigned_to = ?, assigned_at = ?, updated_at = ? WHERE id = ?")
			.bind(agent, agent ? now : null, now, conversationId),
		db.prepare("SELECT * FROM conversations WHERE id = ?").bind(conversationId),
	]);
	const row = firstRow<ConversationRow>(results, 1);
	return row ? toConversation(row) : null;
}

/**
 * 衝突偵測：客服送出時畫面上最後一則是 sinceMessageId，找出之後其他客服送出的訊息。
 * sinceMessageId 找不到（例如被撤回）就視為沒有基準，不擋。
 */
export async function listAgentMessagesAfter(
	db: D1Database,
	conversationId: string,
	sinceMessageId: string,
	excludeAgent: string | null,
): Promise<Message[]> {
	const { results } = await db
		.prepare(
			`SELECT * FROM messages
			 WHERE conversation_id = ? AND sender = 'agent' AND unsent_at IS NULL
			   AND created_at > COALESCE((SELECT created_at FROM messages WHERE id = ?), 9007199254740991)
			   AND (agent_name IS NULL OR agent_name != ?)
			 ORDER BY created_at LIMIT 10`,
		)
		.bind(conversationId, sinceMessageId, excludeAgent ?? "")
		.all<MessageRow>();
	return results.map(toMessage);
}

// ---------- 系統狀態 ----------

export async function getSystemState(db: D1Database, keys: string[]): Promise<Record<string, { value: string | null; updatedAt: number }>> {
	if (keys.length === 0) return {};
	const { results } = await db
		.prepare(`SELECT key, value, updated_at FROM system_state WHERE key IN (${keys.map(() => "?").join(",")})`)
		.bind(...keys)
		.all<{ key: string; value: string | null; updated_at: number }>();
	const out: Record<string, { value: string | null; updatedAt: number }> = {};
	for (const r of results) out[r.key] = { value: r.value, updatedAt: r.updated_at };
	return out;
}

export function systemStateStatement(db: D1Database, key: string, value: string | null, now = Date.now()): D1PreparedStatement {
	return db
		.prepare(
			`INSERT INTO system_state (key, value, updated_at) VALUES (?, ?, ?)
			 ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
		)
		.bind(key, value, now);
}

export async function setSystemState(db: D1Database, entries: Record<string, string | null>, now = Date.now()): Promise<void> {
	const statements = Object.entries(entries).map(([k, v]) => systemStateStatement(db, k, v, now));
	if (statements.length) await db.batch(statements);
}

// ---------- 完整性事件 ----------

interface IntegrityRow {
	id: string;
	kind: string;
	severity: string;
	status: string;
	conversation_id: string | null;
	message_id: string | null;
	dedupe_key: string | null;
	title: string;
	details: string | null;
	started_at: number | null;
	ended_at: number | null;
	resolved_at: number | null;
	resolution: string | null;
	created_by: string | null;
	created_at: number;
	display_name?: string | null;
}

function toIntegrityEvent(row: IntegrityRow): IntegrityEvent {
	return {
		id: row.id,
		kind: row.kind as IntegrityKind,
		severity: row.severity as IntegritySeverity,
		status: row.status as IntegrityStatus,
		conversationId: row.conversation_id,
		messageId: row.message_id,
		title: row.title,
		details: parseJson<Record<string, unknown> | null>(row.details, null),
		startedAt: row.started_at,
		endedAt: row.ended_at,
		resolvedAt: row.resolved_at,
		resolution: row.resolution,
		createdBy: row.created_by,
		createdAt: row.created_at,
		displayName: row.display_name ?? null,
	};
}

export interface NewIntegrityEvent {
	id: string;
	kind: IntegrityKind;
	severity: IntegritySeverity;
	conversationId?: string | null;
	messageId?: string | null;
	/** 有 dedupeKey 時同一把 key 只會有一筆；再次發生會累加 details.count 並延長 ended_at */
	dedupeKey?: string | null;
	title: string;
	details?: Record<string, unknown> | null;
	startedAt?: number | null;
	endedAt?: number | null;
	createdBy?: string | null;
	createdAt: number;
}

/** 寫入事件；重複的 dedupeKey 會合併（count +1）。回傳目前這筆的狀態。 */
export async function upsertIntegrityEvent(db: D1Database, input: NewIntegrityEvent): Promise<IntegrityEvent> {
	const details = JSON.stringify({ count: 1, ...(input.details ?? {}) });
	const results = await db.batch([
		db
			.prepare(
				`INSERT INTO integrity_events
				 (id, kind, severity, status, conversation_id, message_id, dedupe_key, title, details, started_at, ended_at, created_by, created_at)
				 VALUES (?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?, ?)
				 ON CONFLICT(dedupe_key) WHERE dedupe_key IS NOT NULL DO UPDATE SET
					details = json_set(integrity_events.details, '$.count', COALESCE(json_extract(integrity_events.details, '$.count'), 1) + 1),
					ended_at = COALESCE(excluded.ended_at, integrity_events.ended_at),
					status = 'open', resolved_at = NULL`,
			)
			.bind(
				input.id,
				input.kind,
				input.severity,
				input.conversationId ?? null,
				input.messageId ?? null,
				input.dedupeKey ?? null,
				input.title,
				details,
				input.startedAt ?? input.createdAt,
				input.endedAt ?? null,
				input.createdBy ?? null,
				input.createdAt,
			),
		input.dedupeKey
			? db.prepare("SELECT * FROM integrity_events WHERE dedupe_key = ?").bind(input.dedupeKey)
			: db.prepare("SELECT * FROM integrity_events WHERE id = ?").bind(input.id),
	]);
	const row = firstRow<IntegrityRow>(results, 1);
	if (!row) throw new Error("integrity event missing after insert");
	return toIntegrityEvent(row);
}

export async function resolveIntegrityEvent(
	db: D1Database,
	id: string,
	resolution: string | null,
	resolvedBy: string | null,
): Promise<IntegrityEvent | null> {
	const results = await db.batch([
		db
			.prepare(
				`UPDATE integrity_events SET status = 'resolved', resolved_at = ?, resolution = ?
				 WHERE id = ? AND status = 'open'`,
			)
			.bind(Date.now(), resolvedBy ? `${resolution ?? ""}（${resolvedBy}）`.trim() : resolution, id),
		db.prepare("SELECT * FROM integrity_events WHERE id = ?").bind(id),
	]);
	const row = firstRow<IntegrityRow>(results, 1);
	return row ? toIntegrityEvent(row) : null;
}

/** 系統自行判定問題已消失時（例如附件補抓成功）用 dedupe key 關閉 */
export async function resolveIntegrityByDedupeKey(db: D1Database, dedupeKey: string, resolution: string): Promise<IntegrityEvent | null> {
	const results = await db.batch([
		db
			.prepare(
				`UPDATE integrity_events SET status = 'resolved', resolved_at = ?, resolution = ?
				 WHERE dedupe_key = ? AND status = 'open'`,
			)
			.bind(Date.now(), resolution, dedupeKey),
		db.prepare("SELECT * FROM integrity_events WHERE dedupe_key = ? AND resolved_at IS NOT NULL").bind(dedupeKey),
	]);
	if (!results[0].meta.changes) return null;
	const row = firstRow<IntegrityRow>(results, 1);
	return row ? toIntegrityEvent(row) : null;
}

export async function listIntegrityEvents(
	db: D1Database,
	options: { status?: IntegrityStatus | "all"; conversationId?: string; kind?: IntegrityKind; limit?: number } = {},
): Promise<IntegrityEvent[]> {
	const where: string[] = [];
	const binds: unknown[] = [];
	if (options.status && options.status !== "all") {
		where.push("e.status = ?");
		binds.push(options.status);
	}
	if (options.conversationId) {
		where.push("e.conversation_id = ?");
		binds.push(options.conversationId);
	}
	if (options.kind) {
		where.push("e.kind = ?");
		binds.push(options.kind);
	}
	const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
	const { results } = await db
		.prepare(
			`SELECT e.*, c.display_name FROM integrity_events e
			 LEFT JOIN conversations c ON c.id = e.conversation_id
			 ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
			 ORDER BY e.created_at DESC LIMIT ?`,
		)
		.bind(...binds, limit)
		.all<IntegrityRow>();
	return results.map(toIntegrityEvent);
}

/** 健康頁用的各種計數，一次 batch 取回 */
export async function getIntegrityCounts(db: D1Database): Promise<{
	openByKind: Partial<Record<IntegrityKind, number>>;
	outbound: { pending: number; failed: number; unknown: number };
	media: { pending: number; failed: number; expired: number };
	importsUnmatched: number;
}> {
	const results = await db.batch([
		db.prepare("SELECT kind, COUNT(*) AS n FROM integrity_events WHERE status = 'open' GROUP BY kind"),
		db.prepare(
			`SELECT delivery_status AS k, COUNT(*) AS n FROM messages
			 WHERE delivery_status IN ('pending', 'failed', 'unknown') GROUP BY delivery_status`,
		),
		db.prepare(
			`SELECT media_status AS k, COUNT(*) AS n FROM messages
			 WHERE media_status IN ('pending', 'failed', 'expired') GROUP BY media_status`,
		),
		db.prepare("SELECT COUNT(*) AS n FROM import_rows WHERE status = 'unmatched'"),
	]);
	const openByKind: Partial<Record<IntegrityKind, number>> = {};
	for (const r of (results[0].results ?? []) as { kind: IntegrityKind; n: number }[]) openByKind[r.kind] = r.n;
	const outbound = { pending: 0, failed: 0, unknown: 0 };
	for (const r of (results[1].results ?? []) as { k: keyof typeof outbound; n: number }[]) outbound[r.k] = r.n;
	const media = { pending: 0, failed: 0, expired: 0 };
	for (const r of (results[2].results ?? []) as { k: keyof typeof media; n: number }[]) media[r.k] = r.n;
	const importsUnmatched = ((results[3].results?.[0] as { n: number } | undefined)?.n) ?? 0;
	return { openByKind, outbound, media, importsUnmatched };
}

// ---------- 歷史匯入 ----------

interface ImportBatchRow {
	id: string;
	source: string;
	file_name: string | null;
	account_name: string | null;
	range_start: number | null;
	range_end: number | null;
	total_rows: number;
	inserted: number;
	duplicates: number;
	unmatched: number;
	skipped: number;
	report: string | null;
	created_by: string | null;
	created_at: number;
}

function toImportBatch(row: ImportBatchRow): ImportBatch {
	return {
		id: row.id,
		source: "manager_csv",
		fileName: row.file_name,
		accountName: row.account_name,
		rangeStart: row.range_start,
		rangeEnd: row.range_end,
		totalRows: row.total_rows,
		inserted: row.inserted,
		duplicates: row.duplicates,
		unmatched: row.unmatched,
		skipped: row.skipped,
		report: parseJson<ImportReport | null>(row.report, null),
		createdBy: row.created_by,
		createdAt: row.created_at,
	};
}

export async function createImportBatch(
	db: D1Database,
	input: {
		id: string;
		fileName: string | null;
		accountName: string | null;
		rangeStart: number | null;
		rangeEnd: number | null;
		totalRows: number;
		inserted: number;
		duplicates: number;
		unmatched: number;
		skipped: number;
		report: ImportReport;
		createdBy: string | null;
		createdAt: number;
	},
): Promise<ImportBatch> {
	const results = await db.batch([
		db
			.prepare(
				`INSERT INTO import_batches
				 (id, source, file_name, account_name, range_start, range_end, total_rows, inserted, duplicates, unmatched, skipped, report, created_by, created_at)
				 VALUES (?, 'manager_csv', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.bind(
				input.id,
				input.fileName,
				input.accountName,
				input.rangeStart,
				input.rangeEnd,
				input.totalRows,
				input.inserted,
				input.duplicates,
				input.unmatched,
				input.skipped,
				JSON.stringify(input.report),
				input.createdBy,
				input.createdAt,
			),
		db.prepare("SELECT * FROM import_batches WHERE id = ?").bind(input.id),
	]);
	const row = firstRow<ImportBatchRow>(results, 1);
	if (!row) throw new Error("import batch missing after insert");
	return toImportBatch(row);
}

/** 指派完成後更新批次計數 */
export async function bumpImportBatch(
	db: D1Database,
	batchId: string,
	delta: { inserted: number; duplicates: number; unmatched: number; skipped: number },
): Promise<ImportBatch | null> {
	const results = await db.batch([
		db
			.prepare(
				`UPDATE import_batches SET inserted = inserted + ?, duplicates = duplicates + ?,
					unmatched = unmatched + ?, skipped = skipped + ? WHERE id = ?`,
			)
			.bind(delta.inserted, delta.duplicates, delta.unmatched, delta.skipped, batchId),
		db.prepare("SELECT * FROM import_batches WHERE id = ?").bind(batchId),
	]);
	const row = firstRow<ImportBatchRow>(results, 1);
	return row ? toImportBatch(row) : null;
}

export async function listImportBatches(db: D1Database, limit = 50): Promise<ImportBatch[]> {
	const { results } = await db
		.prepare("SELECT * FROM import_batches ORDER BY created_at DESC LIMIT ?")
		.bind(Math.min(limit, 200))
		.all<ImportBatchRow>();
	return results.map(toImportBatch);
}

export async function getImportBatch(db: D1Database, id: string): Promise<ImportBatch | null> {
	const row = await db.prepare("SELECT * FROM import_batches WHERE id = ?").bind(id).first<ImportBatchRow>();
	return row ? toImportBatch(row) : null;
}

export interface ImportRowInput {
	id: string;
	batchId: string;
	chatName: string | null;
	sender: string | null;
	direction: MessageDirection;
	text: string | null;
	sentAt: number;
	createdAt: number;
}

/** 配不到對話的列先存起來，等人工指派 */
export async function insertImportRows(db: D1Database, rows: ImportRowInput[]): Promise<void> {
	for (let i = 0; i < rows.length; i += 50) {
		await db.batch(
			rows.slice(i, i + 50).map((r) =>
				db
					.prepare(
						`INSERT INTO import_rows (id, batch_id, chat_name, sender, direction, text, sent_at, status, created_at)
						 VALUES (?, ?, ?, ?, ?, ?, ?, 'unmatched', ?)`,
					)
					.bind(r.id, r.batchId, r.chatName, r.sender, r.direction, r.text, r.sentAt, r.createdAt),
			),
		);
	}
}

export async function listImportRowGroups(db: D1Database, batchId: string): Promise<ImportRowGroup[]> {
	const { results } = await db
		.prepare(
			`SELECT chat_name, COUNT(*) AS rows, MIN(sent_at) AS first_at, MAX(sent_at) AS last_at,
				(SELECT text FROM import_rows r2 WHERE r2.batch_id = r.batch_id AND r2.chat_name IS r.chat_name AND r2.status = 'unmatched' ORDER BY sent_at LIMIT 1) AS sample
			 FROM import_rows r WHERE batch_id = ? AND status = 'unmatched'
			 GROUP BY chat_name ORDER BY rows DESC`,
		)
		.bind(batchId)
		.all<{ chat_name: string | null; rows: number; first_at: number; last_at: number; sample: string | null }>();
	return results.map((r) => ({ chatName: r.chat_name ?? "", rows: r.rows, firstAt: r.first_at, lastAt: r.last_at, sample: r.sample }));
}

export async function listUnmatchedImportRows(db: D1Database, batchId: string, chatName: string): Promise<ImportRowInput[]> {
	const { results } = await db
		.prepare("SELECT * FROM import_rows WHERE batch_id = ? AND chat_name IS ? AND status = 'unmatched' ORDER BY sent_at")
		.bind(batchId, chatName || null)
		.all<{ id: string; batch_id: string; chat_name: string | null; sender: string | null; direction: string; text: string | null; sent_at: number; created_at: number }>();
	return results.map((r) => ({
		id: r.id,
		batchId: r.batch_id,
		chatName: r.chat_name,
		sender: r.sender,
		direction: r.direction as MessageDirection,
		text: r.text,
		sentAt: r.sent_at,
		createdAt: r.created_at,
	}));
}

export async function markImportRows(
	db: D1Database,
	batchId: string,
	chatName: string,
	status: "assigned" | "skipped",
	conversationId: string | null,
): Promise<number> {
	const result = await db
		.prepare("UPDATE import_rows SET status = ?, conversation_id = ? WHERE batch_id = ? AND chat_name IS ? AND status = 'unmatched'")
		.bind(status, conversationId, batchId, chatName || null)
		.run();
	return result.meta.changes ?? 0;
}

/** 以顯示名稱找對話（匯入配對用）；名稱完全相同才算 */
export async function findConversationsByName(db: D1Database, names: string[]): Promise<Map<string, { id: string; displayName: string | null; externalId: string }[]>> {
	const out = new Map<string, { id: string; displayName: string | null; externalId: string }[]>();
	for (let i = 0; i < names.length; i += 50) {
		const chunk = names.slice(i, i + 50);
		const { results } = await db
			.prepare(`SELECT id, display_name, external_id FROM conversations WHERE display_name IN (${chunk.map(() => "?").join(",")})`)
			.bind(...chunk)
			.all<{ id: string; display_name: string | null; external_id: string }>();
		for (const r of results) {
			const list = out.get(r.display_name ?? "") ?? [];
			list.push({ id: r.id, displayName: r.display_name, externalId: r.external_id });
			out.set(r.display_name ?? "", list);
		}
	}
	return out;
}

/**
 * 匯入前先取對話在該時間範圍內已有的訊息（分鐘 + 文字），避免 webhook 已收到的訊息被 CSV 再塞一次。
 */
export async function listMessageKeysInRange(
	db: D1Database,
	conversationId: string,
	start: number,
	end: number,
): Promise<Set<string>> {
	const { results } = await db
		.prepare("SELECT created_at, text FROM messages WHERE conversation_id = ? AND created_at BETWEEN ? AND ? AND text IS NOT NULL")
		.bind(conversationId, start - 60_000, end + 60_000)
		.all<{ created_at: number; text: string }>();
	return new Set(results.map((r) => messageDedupeKey(r.created_at, r.text)));
}

export function messageDedupeKey(createdAt: number, text: string): string {
	return `${Math.floor(createdAt / 60_000)}|${text.trim()}`;
}

export interface ImportedMessageInput {
	id: string;
	conversationId: string;
	direction: MessageDirection;
	text: string;
	externalId: string;
	createdAt: number;
	batchId: string;
	sender: string | null;
}

/**
 * 寫入匯入的歷史訊息：不動未讀數、不觸發提醒；對話的 last_message 只在匯入的比現有的新時才更新。
 * 以 external_id（內容雜湊）去重，重複匯入同一份 CSV 不會產生重複。
 * 回傳實際寫入的筆數。
 */
export async function insertImportedMessages(db: D1Database, rows: ImportedMessageInput[]): Promise<number> {
	let inserted = 0;
	for (let i = 0; i < rows.length; i += 40) {
		const chunk = rows.slice(i, i + 40);
		const results = await db.batch(
			chunk.flatMap((r) => [
				db
					.prepare(
						`INSERT OR IGNORE INTO messages
						 (id, conversation_id, direction, sender, type, text, metadata, external_id, created_at, source, delivery_status)
						 VALUES (?, ?, ?, ?, 'text', ?, ?, ?, ?, 'manager_csv', ?)`,
					)
					.bind(
						r.id,
						r.conversationId,
						r.direction,
						r.direction === "inbound" ? "user" : "agent",
						r.text,
						JSON.stringify({ importBatchId: r.batchId, importedSender: r.sender }),
						r.externalId,
						r.createdAt,
						r.direction === "outbound" ? "sent" : null,
					),
				db
					.prepare(
						`UPDATE conversations SET last_message_text = ?, last_message_at = ?, updated_at = ?
						 WHERE id = ? AND (last_message_at IS NULL OR last_message_at < ?)
						   AND EXISTS (SELECT 1 FROM messages WHERE id = ?)`,
					)
					.bind(r.text, r.createdAt, Date.now(), r.conversationId, r.createdAt, r.id),
			]),
		);
		for (let j = 0; j < results.length; j += 2) inserted += results[j].meta.changes ? 1 : 0;
	}
	return inserted;
}

// ---------- 通知型訊息（PNP） ----------

interface NotificationRow {
	id: string;
	phone_hash: string;
	phone_masked: string;
	messages: string;
	source: string;
	note: string | null;
	delivery_tag: string;
	status: string;
	line_status: number | null;
	line_request_id: string | null;
	error: string | null;
	sent_at: number | null;
	delivered_at: number | null;
	created_by: string | null;
	created_at: number;
}

function toNotification(row: NotificationRow): Notification {
	return {
		id: row.id,
		phoneMasked: row.phone_masked,
		messages: parseJson<unknown[]>(row.messages, []),
		source: row.source === "api" ? "api" : "console",
		note: row.note,
		deliveryTag: row.delivery_tag,
		status: row.status as NotificationStatus,
		lineStatus: row.line_status,
		lineRequestId: row.line_request_id,
		error: row.error,
		sentAt: row.sent_at,
		deliveredAt: row.delivered_at,
		createdBy: row.created_by,
		createdAt: row.created_at,
	};
}

export async function createNotification(
	db: D1Database,
	input: {
		id: string;
		phoneHash: string;
		phoneMasked: string;
		messages: unknown[];
		source: "console" | "api";
		note: string | null;
		deliveryTag: string;
		createdBy: string | null;
		createdAt: number;
	},
): Promise<Notification> {
	const results = await db.batch([
		db
			.prepare(
				`INSERT INTO notifications (id, phone_hash, phone_masked, messages, source, note, delivery_tag, status, created_by, created_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
			)
			.bind(input.id, input.phoneHash, input.phoneMasked, JSON.stringify(input.messages), input.source, input.note, input.deliveryTag, input.createdBy, input.createdAt),
		db.prepare("SELECT * FROM notifications WHERE id = ?").bind(input.id),
	]);
	const row = firstRow<NotificationRow>(results, 1);
	if (!row) throw new Error("notification missing after insert");
	return toNotification(row);
}

export async function getNotification(db: D1Database, id: string): Promise<Notification | null> {
	const row = await db.prepare("SELECT * FROM notifications WHERE id = ?").bind(id).first<NotificationRow>();
	return row ? toNotification(row) : null;
}

/** 發送結果；phoneHash 只在重送時需要 */
export async function getNotificationPhoneHash(db: D1Database, id: string): Promise<string | null> {
	const row = await db.prepare("SELECT phone_hash FROM notifications WHERE id = ?").bind(id).first<{ phone_hash: string }>();
	return row?.phone_hash ?? null;
}

export async function setNotificationResult(
	db: D1Database,
	id: string,
	status: NotificationStatus,
	extra: { lineStatus?: number | null; lineRequestId?: string | null; error?: string | null; sentAt?: number | null },
): Promise<Notification | null> {
	const results = await db.batch([
		db
			.prepare(
				`UPDATE notifications SET status = ?, line_status = ?, line_request_id = ?, error = ?, sent_at = COALESCE(?, sent_at)
				 WHERE id = ?`,
			)
			.bind(status, extra.lineStatus ?? null, extra.lineRequestId ?? null, extra.error ?? null, extra.sentAt ?? null, id),
		db.prepare("SELECT * FROM notifications WHERE id = ?").bind(id),
	]);
	const row = firstRow<NotificationRow>(results, 1);
	return row ? toNotification(row) : null;
}

/** delivery 事件：用 X-Line-Delivery-Tag 對回發送紀錄 */
export async function markNotificationDelivered(db: D1Database, deliveryTag: string, deliveredAt: number): Promise<Notification | null> {
	const results = await db.batch([
		db
			.prepare("UPDATE notifications SET status = 'delivered', delivered_at = COALESCE(delivered_at, ?) WHERE delivery_tag = ?")
			.bind(deliveredAt, deliveryTag),
		db.prepare("SELECT * FROM notifications WHERE delivery_tag = ?").bind(deliveryTag),
	]);
	const row = firstRow<NotificationRow>(results, 1);
	return row ? toNotification(row) : null;
}

export async function listNotifications(db: D1Database, limit = 100): Promise<Notification[]> {
	const { results } = await db
		.prepare("SELECT * FROM notifications ORDER BY created_at DESC LIMIT ?")
		.bind(Math.min(limit, 500))
		.all<NotificationRow>();
	return results.map(toNotification);
}
