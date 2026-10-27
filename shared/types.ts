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
	metadata: Record<string, unknown> | null;
	externalId: string | null;
	createdAt: number;
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
	/** 列表用：對話的顯示名稱 */
	displayName?: string | null;
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
