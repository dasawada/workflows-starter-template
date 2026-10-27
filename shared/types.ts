/**
 * 前端與 Worker 共用的型別
 */

export type Channel = "line" | "teams";
/** 訊息從哪裡來：webhook 收到、客服台送出、系統產生、官方後台 CSV 匯入 */
export type MessageSource = "line_webhook" | "console" | "system" | "manager_csv";
/** 客服送出訊息的送達狀態；unknown = 送出結果無法在 24 小時內確認 */
export type DeliveryStatus = "pending" | "sent" | "failed" | "unknown";
/** 使用者附件的保存狀態 */
export type MediaStatus = "pending" | "stored" | "failed" | "expired";
export type ConversationStatus = "open" | "closed";
export type MessageDirection = "inbound" | "outbound";
export type MessageSender = "user" | "agent" | "system";
export type MessageType =
	| "text"
	| "image"
	| "video"
	| "audio"
	| "file"
	| "sticker"
	| "location"
	| "prompt"
	| "rich"
	| "unknown";

export interface Conversation {
	id: string;
	channel: Channel;
	externalId: string;
	displayName: string | null;
	pictureUrl: string | null;
	status: ConversationStatus;
	lastMessageText: string | null;
	lastMessageAt: number | null;
	lastInboundAt: number | null;
	lastOutboundAt: number | null;
	unreadCount: number;
	needsAttention: boolean;
	/** 接手中的客服名稱 */
	assignedTo: string | null;
	assignedAt: number | null;
	createdAt: number;
	updatedAt: number;
}

export interface Message {
	id: string;
	conversationId: string;
	direction: MessageDirection;
	sender: MessageSender;
	type: MessageType;
	text: string | null;
	/** 有媒體時，前端用 /api/media/:key 取得 */
	mediaKey: string | null;
	mediaContentType: string | null;
	/**
	 * 依類型存放的附加資料。與對話完整性有關的鍵：
	 * - quote: 使用者引用的訊息 { externalId, messageId, text, type, sender }；messageId 為 null 代表本地找不到原文
	 * - quoteToken: 這則訊息可被我方引用時的 token
	 * - imageSet: 一次傳多張圖片時的 { id, index, total }
	 * - senderUserId / senderName: 群組發言者
	 * - isRedelivery: LINE 標記為重送的事件
	 * - originalText: 被編輯前的第一版文字
	 */
	metadata: Record<string, unknown> | null;
	externalId: string | null;
	createdAt: number;
	/** 群組文字訊息被編輯的時間；text 已是最新版本 */
	editedAt: number | null;
	/** 使用者撤回的時間；撤回後 text / media 已清除，只保留時間軸位置 */
	unsentAt: number | null;
	source: MessageSource;
	/** 客服送出的訊息才有 */
	deliveryStatus: DeliveryStatus | null;
	/** 有附件的使用者訊息才有 */
	mediaStatus: MediaStatus | null;
	/** 送出這則訊息的客服 */
	agentName: string | null;
}

/** 引用訊息在 metadata.quote 的結構 */
export interface MessageQuote {
	externalId: string;
	messageId: string | null;
	text: string | null;
	type: MessageType | null;
	sender: MessageSender | null;
}

/** GET /v2/bot/info 的摘要，用來確認 Chat 模式與已讀模式 */
export interface LineBotInfo {
	userId: string;
	basicId: string;
	displayName: string;
	pictureUrl: string | null;
	chatMode: "chat" | "bot";
	markAsReadMode: "manual" | "auto";
}

export interface PromptOption {
	label: string;
	value: string;
}

export type PromptStatus = "pending" | "answered";

/** 可追蹤訊息：送出帶按鈕的訊息並記錄使用者選擇 */
export interface Prompt {
	id: string;
	conversationId: string;
	messageId: string | null;
	templateKey: string | null;
	body: string | null;
	question: string;
	options: PromptOption[];
	variables: Record<string, string> | null;
	status: PromptStatus;
	choice: string | null;
	choiceLabel: string | null;
	respondedAt: number | null;
	createdAt: number;
	/** 實際送出的 LINE 訊息陣列 */
	payload: unknown[] | null;
	/** 使用者重複按按鈕時是否採用最後一次（false = 第一次為準） */
	allowChange: boolean;
	/** 列表用：對話的顯示名稱 */
	displayName?: string | null;
}

/** 多客服協作：送出時附上的衝突偵測資訊 */
export interface SendGuard {
	/** 前端產生的 UUID，同一把 key 重送不會重複推給 LINE（也是 X-Line-Retry-Key） */
	clientKey?: string;
	/** 客服送出時畫面上最後一則訊息；之後若有其他客服回覆，伺服器會回 409 */
	lastSeenMessageId?: string;
	/** 已確認衝突仍要送出 */
	force?: boolean;
}

export interface ReplyInput extends SendGuard {
	text: string;
}

/** 直接送 LINE 訊息陣列（Flex / template / quick reply…）；postback 按鈕會自動加上追蹤 id */
export interface SendMessagesInput extends SendGuard {
	messages: unknown[];
	templateKey?: string;
	note?: string;
	/** 允許使用者更改回覆（取最後一次）；預設第一次為準 */
	allowChange?: boolean;
}

/** 409 回覆衝突時的內容 */
export interface SendConflict {
	code: "assigned" | "newer_reply";
	error: string;
	assignedTo?: string | null;
	/** 其他客服在你之後送出的訊息 */
	messages?: Message[];
}

export interface ConversationQuery {
	status: ConversationStatus | "all";
	/** 游標：只回傳 last_message_at 小於此值的對話 */
	before?: number;
	q?: string;
	limit?: number;
}

export interface Stats {
	unreadTotal: number;
	openCount: number;
	needsAttentionCount: number;
}

export interface SendPromptInput {
	body?: string;
	question: string;
	options: PromptOption[];
	templateKey?: string;
	variables?: Record<string, string>;
}

// ---------- 對話完整性 ----------

export type IntegrityKind =
	| "quote_missing"
	| "media_failed"
	| "media_expired"
	| "send_failed"
	| "send_unknown"
	| "webhook_redelivery"
	| "event_dead_lettered"
	| "chat_mode"
	| "agent_report"
	| "import";
export type IntegritySeverity = "info" | "warning" | "error";
export type IntegrityStatus = "open" | "resolved";

/** 一筆資料缺口或完整性事件 */
export interface IntegrityEvent {
	id: string;
	kind: IntegrityKind;
	severity: IntegritySeverity;
	status: IntegrityStatus;
	conversationId: string | null;
	messageId: string | null;
	title: string;
	details: Record<string, unknown> | null;
	startedAt: number | null;
	endedAt: number | null;
	resolvedAt: number | null;
	resolution: string | null;
	createdBy: string | null;
	createdAt: number;
	/** 列表用 */
	displayName?: string | null;
}

/** 同步健康狀態：接收端正常不等於所有訊息都完整，所以每項都分開給 */
export interface IntegrityHealth {
	now: number;
	webhookMode: "queue" | "inline";
	lastWebhookAt: number | null;
	lastRedeliveryAt: number | null;
	lastMaintenanceAt: number | null;
	botInfo: LineBotInfo | null;
	botInfoAt: number | null;
	openTotal: number;
	openByKind: Partial<Record<IntegrityKind, number>>;
	outbound: { pending: number; failed: number; unknown: number };
	media: { pending: number; failed: number; expired: number };
	importsUnmatched: number;
}

export interface IntegrityReportInput {
	conversationId: string;
	note: string;
	/** 客服認為缺漏發生的大概時間 */
	from?: number;
	to?: number;
}

// ---------- 歷史匯入 ----------

export type ImportColumn = "timestamp" | "date" | "time" | "chat" | "sender" | "text" | "type";

export interface ImportMapping {
	timestamp?: number;
	date?: number;
	time?: number;
	chat?: number;
	sender?: number;
	text?: number;
	type?: number;
}

export interface ImportPreview {
	delimiter: string;
	headers: string[];
	mapping: ImportMapping;
	/** 欄位偵測不到時列在這裡，前端要求使用者指定 */
	missing: ImportColumn[];
	totalRows: number;
	sample: { chat: string | null; sender: string | null; text: string | null; sentAt: number | null }[];
	rangeStart: number | null;
	rangeEnd: number | null;
	/** CSV 裡出現的聊天室／使用者名稱，與本地對話的配對結果 */
	chats: ImportChatMatch[];
	accountName: string | null;
	/** 無法解析時間的列數 */
	invalidRows: number;
}

export interface ImportChatMatch {
	name: string;
	rows: number;
	/** 唯一配對到的對話；多筆同名或沒有時為 null */
	conversationId: string | null;
	candidates: { id: string; displayName: string | null; externalId: string }[];
}

export interface ImportRunInput {
	csv: string;
	fileName?: string;
	mapping?: ImportMapping;
	accountName?: string;
	/** 沒有時區資訊的時間一律視為此時差（分鐘），預設 480 = 台北 */
	tzOffsetMinutes?: number;
	/** 指定名稱 → 對話，覆蓋自動配對 */
	assignments?: Record<string, string>;
}

export interface ImportBatch {
	id: string;
	source: "manager_csv";
	fileName: string | null;
	accountName: string | null;
	rangeStart: number | null;
	rangeEnd: number | null;
	totalRows: number;
	inserted: number;
	duplicates: number;
	unmatched: number;
	skipped: number;
	report: ImportReport | null;
	createdBy: string | null;
	createdAt: number;
}

export interface ImportReport {
	chats: { name: string; rows: number; conversationId: string | null; inserted: number; duplicates: number }[];
	invalidRows: number;
}

export interface ImportRowGroup {
	chatName: string;
	rows: number;
	firstAt: number;
	lastAt: number;
	sample: string | null;
}

// ---------- 通知型訊息（PNP） ----------

export type NotificationStatus = "pending" | "sent" | "delivered" | "failed";

export interface Notification {
	id: string;
	phoneMasked: string;
	messages: unknown[];
	source: "console" | "api";
	note: string | null;
	deliveryTag: string;
	status: NotificationStatus;
	lineStatus: number | null;
	lineRequestId: string | null;
	error: string | null;
	sentAt: number | null;
	deliveredAt: number | null;
	createdBy: string | null;
	createdAt: number;
}

export interface SendNotificationInput {
	phone: string;
	messages: unknown[];
	note?: string;
}

/** 客服台送給 InboxDO 的訊息（除了 ping） */
export type InboxClientMessage = { type: "view"; conversationId: string | null; agent: string | null };

/** InboxDO 透過 WebSocket 推給客服台的事件 */
export type InboxEvent =
	| { type: "hello"; timestamp: number }
	| { type: "message.new"; message: Message; conversation: Conversation }
	| { type: "conversation.updated"; conversation: Conversation }
	| { type: "prompt.updated"; prompt: Prompt }
	| { type: "presence.updated"; conversationId: string; agents: string[] }
	| { type: "integrity.updated"; event: IntegrityEvent }
	| { type: "notification.updated"; notification: Notification };

export interface ConversationListResponse {
	conversations: Conversation[];
}

export interface MessageListResponse {
	messages: Message[];
}

export interface PromptListResponse {
	prompts: Prompt[];
}
