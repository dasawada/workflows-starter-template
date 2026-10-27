/**
 * 前端與 Worker 共用的型別
 */

export type Channel = "line" | "teams";
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

/** 直接送 LINE 訊息陣列（Flex / template / quick reply…）；postback 按鈕會自動加上追蹤 id */
export interface SendMessagesInput {
	messages: unknown[];
	templateKey?: string;
	note?: string;
	/** 允許使用者更改回覆（取最後一次）；預設第一次為準 */
	allowChange?: boolean;
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

/** InboxDO 透過 WebSocket 推給客服台的事件 */
export type InboxEvent =
	| { type: "hello"; timestamp: number }
	| { type: "message.new"; message: Message; conversation: Conversation }
	| { type: "conversation.updated"; conversation: Conversation }
	| { type: "prompt.updated"; prompt: Prompt };

export interface ConversationListResponse {
	conversations: Conversation[];
}

export interface MessageListResponse {
	messages: Message[];
}

export interface PromptListResponse {
	prompts: Prompt[];
}
