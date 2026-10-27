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
		editedAt: row.edited_at ?? null,
		unsentAt: row.unsent_at ?? null,
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

	const update = isInbound
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
			.prepare("UPDATE messages SET media_key = ?, media_content_type = ? WHERE id = ?")
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

/** 依 LINE message id 找本地訊息（引用訊息用） */
export async function findMessageByExternalId(
	db: D1Database,
	externalId: string,
): Promise<Message | null> {
	const row = await db
		.prepare("SELECT * FROM messages WHERE external_id = ?")
		.bind(externalId)
		.first<MessageRow>();
	return row ? toMessage(row) : null;
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
