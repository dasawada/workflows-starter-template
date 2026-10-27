import type { LineBotInfo, MessageType } from "../shared/types";

/**
 * LINE Messaging API 介接層：簽章驗證、API 呼叫、webhook 事件型別。
 * https://developers.line.biz/en/reference/messaging-api/
 */

const LINE_API = "https://api.line.me/v2/bot";
const LINE_DATA_API = "https://api-data.line.me/v2/bot";

// ---------- 簽章 ----------

/**
 * 驗證 X-Line-Signature：HMAC-SHA256(channel secret, raw body) 的 base64。
 */
export async function verifyLineSignature(
	channelSecret: string,
	rawBody: string,
	signature: string | null,
): Promise<boolean> {
	if (!signature) return false;
	const key = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(channelSecret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const mac = await crypto.subtle.sign(
		"HMAC",
		key,
		new TextEncoder().encode(rawBody),
	);
	const expected = base64(new Uint8Array(mac));
	return timingSafeEqual(expected, signature);
}

export async function signLineBody(
	channelSecret: string,
	rawBody: string,
): Promise<string> {
	const key = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(channelSecret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const mac = await crypto.subtle.sign(
		"HMAC",
		key,
		new TextEncoder().encode(rawBody),
	);
	return base64(new Uint8Array(mac));
}

function base64(bytes: Uint8Array): string {
	let binary = "";
	for (const b of bytes) binary += String.fromCharCode(b);
	return btoa(binary);
}

function timingSafeEqual(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) {
		diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	}
	return diff === 0;
}

// ---------- Webhook 事件型別（只列出用得到的欄位） ----------

export interface LineSource {
	type: "user" | "group" | "room";
	userId?: string;
	groupId?: string;
	roomId?: string;
}

/** 多張圖片一次傳送時，每張圖都帶同一個 imageSet.id */
export interface LineImageSet {
	id: string;
	index: number;
	total: number;
}

export type LineMessageContent =
	| {
			id: string;
			type: "text";
			text: string;
			quoteToken?: string;
			/** 使用者引用的訊息 id；LINE 不附原文，要靠本地紀錄找 */
			quotedMessageId?: string;
			emojis?: unknown[];
			mention?: unknown;
	  }
	| {
			id: string;
			type: "image" | "video" | "audio";
			contentProvider: { type: "line" | "external"; originalContentUrl?: string };
			duration?: number;
			imageSet?: LineImageSet;
			quoteToken?: string;
	  }
	| { id: string; type: "file"; fileName: string; fileSize: number }
	| { id: string; type: "sticker"; packageId: string; stickerId: string }
	| {
			id: string;
			type: "location";
			title?: string;
			address?: string;
			latitude: number;
			longitude: number;
	  }
	| { id: string; type: string };

export interface LineWebhookEvent {
	type:
		| "message"
		| "messageEdited"
		| "unsend"
		| "follow"
		| "unfollow"
		| "join"
		| "leave"
		| "postback"
		| string;
	timestamp: number;
	source: LineSource;
	replyToken?: string;
	webhookEventId?: string;
	deliveryContext?: { isRedelivery: boolean };
	/** Module channel 才會用到：standby 代表聊天控制權在別的 channel */
	mode?: "active" | "standby";
	/** Chat 開啟時 message 事件附帶；呼叫 markAsRead 用，沒有到期日 */
	markAsReadToken?: string;
	message?: LineMessageContent;
	postback?: { data: string; params?: Record<string, string> };
	unsend?: { messageId: string };
}

/** 從事件取出 markAsReadToken；官方放在事件層，這裡同時容忍放在 message 內的變體 */
export function markAsReadTokenOf(event: LineWebhookEvent): string | null {
	const inMessage = (event.message as { markAsReadToken?: string } | undefined)?.markAsReadToken;
	return event.markAsReadToken ?? inMessage ?? null;
}

export interface LineWebhookBody {
	destination: string;
	events: LineWebhookEvent[];
}

/**
 * 從 source 推出對話 id 與推播對象。
 * 一對一用 userId；群組／多人聊天室則以群組為單位。
 */
export function conversationTarget(
	source: LineSource,
): { conversationId: string; recipientId: string; kind: LineSource["type"] } | null {
	if (source.type === "group" && source.groupId) {
		return {
			conversationId: `line:group:${source.groupId}`,
			recipientId: source.groupId,
			kind: "group",
		};
	}
	if (source.type === "room" && source.roomId) {
		return {
			conversationId: `line:room:${source.roomId}`,
			recipientId: source.roomId,
			kind: "room",
		};
	}
	if (source.userId) {
		return {
			conversationId: `line:${source.userId}`,
			recipientId: source.userId,
			kind: "user",
		};
	}
	return null;
}

/** LINE Confirm template 的文字上限 */
export const CONFIRM_TEXT_MAX = 240;
export const TEXT_MESSAGE_MAX = 5000;

/**
 * 組出「正文 + 是/否按鈕」的訊息陣列。
 * 按鈕用 postback，data 帶 prompt id 與選項值；displayText 讓使用者的選擇顯示在聊天室裡。
 */
export function buildPromptMessages(input: {
	promptId: string;
	body?: string | null;
	question: string;
	options: { label: string; value: string }[];
}): unknown[] {
	const messages: unknown[] = [];
	const body = input.body?.trim();
	if (body) messages.push({ type: "text", text: body });

	const actions = input.options.slice(0, 2).map((o) => ({
		type: "postback",
		label: o.label.slice(0, 20),
		data: new URLSearchParams({ prompt: input.promptId, choice: o.value }).toString(),
		displayText: o.label,
	}));

	messages.push({
		type: "template",
		altText: input.question.slice(0, 400),
		template: {
			type: "confirm",
			text: input.question.slice(0, CONFIRM_TEXT_MAX),
			actions,
		},
	});
	return messages;
}

const ALLOWED_MESSAGE_TYPES = new Set([
	"text",
	"sticker",
	"image",
	"video",
	"audio",
	"location",
	"imagemap",
	"template",
	"flex",
]);
export const MAX_MESSAGES_PER_PUSH = 5;
export const POSTBACK_DATA_MAX = 300;

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

/** 基本結構檢查；細節交給 LINE API 驗證並把錯誤回給客服台 */
export function validateLineMessages(raw: unknown): { ok: true; messages: Json[] } | { ok: false; error: string } {
	if (!Array.isArray(raw) || raw.length === 0) return { ok: false, error: "messages 必須是非空陣列" };
	if (raw.length > MAX_MESSAGES_PER_PUSH) return { ok: false, error: `一次最多 ${MAX_MESSAGES_PER_PUSH} 則訊息` };
	for (const [i, m] of raw.entries()) {
		if (!isObject(m) || typeof m.type !== "string") return { ok: false, error: `第 ${i + 1} 則缺少 type` };
		if (!ALLOWED_MESSAGE_TYPES.has(m.type)) return { ok: false, error: `第 ${i + 1} 則的 type「${m.type}」不支援` };
		if ((m.type === "template" || m.type === "flex") && typeof m.altText !== "string") {
			return { ok: false, error: `第 ${i + 1} 則（${m.type}）需要 altText` };
		}
	}
	return { ok: true, messages: raw as Json[] };
}

/**
 * 走訪訊息內所有 postback action，把 data 改寫成 prompt=<id>&choice=<value>。
 * value 取原本的 data（若有）否則取 label / displayText；回傳可供追蹤的選項清單。
 * 同一個 value 出現多次（例如 carousel 每張卡都有「承接」）會合併成一個選項。
 */
export function instrumentPostbacks(
	messages: Json[],
	promptId: string,
): { messages: Json[]; options: { label: string; value: string }[] } {
	const options: { label: string; value: string }[] = [];
	const seen = new Set<string>();
	let counter = 0;

	const visit = (node: unknown): unknown => {
		if (Array.isArray(node)) return node.map(visit);
		if (!isObject(node)) return node;
		const out: Json = {};
		for (const [k, v] of Object.entries(node)) out[k] = visit(v);
		if (out.type === "postback") {
			const label =
				(typeof out.label === "string" && out.label) ||
				(typeof out.displayText === "string" && out.displayText) ||
				`選項${++counter}`;
			let value = typeof out.data === "string" && out.data.trim() ? out.data.trim() : label;
			if (value.startsWith("prompt=")) {
				const parsed = parsePromptPostback(value);
				value = parsed?.choice ?? value;
			}
			value = value.slice(0, 50);
			if (!seen.has(value)) {
				seen.add(value);
				options.push({ label: label.slice(0, 20), value });
			}
			out.data = new URLSearchParams({ prompt: promptId, choice: value }).toString();
		}
		return out;
	};

	return { messages: visit(messages) as Json[], options };
}

/** 從訊息陣列取一段摘要文字，給對話清單與追蹤面板顯示 */
export function summarizeMessages(messages: Json[]): { body: string | null; question: string } {
	const texts: string[] = [];
	let alt: string | null = null;
	for (const m of messages) {
		if (m.type === "text" && typeof m.text === "string") texts.push(m.text);
		else if (typeof m.altText === "string" && !alt) alt = m.altText;
	}
	const body = texts.length ? texts.join("\n\n") : null;
	return { body, question: alt ?? texts[0]?.slice(0, 240) ?? "互動訊息" };
}

/** 解析 postback data；不是我們送出的格式就回 null */
export function parsePromptPostback(
	data: string,
): { promptId: string; choice: string } | null {
	try {
		const params = new URLSearchParams(data);
		const promptId = params.get("prompt");
		const choice = params.get("choice");
		if (!promptId || choice === null) return null;
		return { promptId, choice };
	} catch {
		return null;
	}
}

export function toMessageType(type: string): MessageType {
	switch (type) {
		case "text":
		case "image":
		case "video":
		case "audio":
		case "file":
		case "sticker":
		case "location":
			return type;
		default:
			return "unknown";
	}
}

// ---------- API 呼叫 ----------

/** 每次呼叫 LINE API 的回報：endpoint 是去掉 id 的路徑樣式，方便彙總 */
export type LineCallHook = (endpoint: string, status: number, durationMs: number) => void;

export class LineClient {
	private readonly accessToken: string;
	private readonly onCall?: LineCallHook;
	constructor(accessToken: string, onCall?: LineCallHook) {
		this.accessToken = accessToken;
		this.onCall = onCall;
	}

	private headers(extra: Record<string, string> = {}): HeadersInit {
		return {
			Authorization: `Bearer ${this.accessToken}`,
			...extra,
		};
	}

	private async request(endpoint: string, url: string, init: RequestInit = {}): Promise<Response> {
		const start = Date.now();
		let status = 0;
		try {
			const res = await fetch(url, { ...init, headers: this.headers(init.headers as Record<string, string>) });
			status = res.status;
			return res;
		} finally {
			this.onCall?.(endpoint, status, Date.now() - start);
		}
	}

	async getProfile(
		userId: string,
		groupOrRoom?: { kind: "group" | "room"; id: string },
	): Promise<{ displayName: string; pictureUrl?: string } | null> {
		const url = groupOrRoom
			? `${LINE_API}/${groupOrRoom.kind}/${groupOrRoom.id}/member/${userId}`
			: `${LINE_API}/profile/${userId}`;
		const res = await this.request(groupOrRoom ? "member-profile" : "profile", url);
		if (!res.ok) return null;
		return (await res.json()) as { displayName: string; pictureUrl?: string };
	}

	async getGroupSummary(
		kind: "group" | "room",
		id: string,
	): Promise<{ groupName?: string; pictureUrl?: string } | null> {
		if (kind !== "group") return null;
		const res = await this.request("group-summary", `${LINE_API}/group/${id}/summary`);
		if (!res.ok) return null;
		return (await res.json()) as { groupName: string; pictureUrl?: string };
	}

	async pushText(to: string, text: string): Promise<void> {
		await this.push(to, [{ type: "text", text }]);
	}

	async push(to: string, messages: unknown[]): Promise<void> {
		const res = await this.request("push", `${LINE_API}/message/push`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ to, messages }),
		});
		if (!res.ok) {
			throw new Error(`LINE push failed (${res.status}): ${await res.text()}`);
		}
	}

	async reply(replyToken: string, messages: unknown[]): Promise<void> {
		const res = await this.request("reply", `${LINE_API}/message/reply`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ replyToken, messages }),
		});
		if (!res.ok) {
			throw new Error(`LINE reply failed (${res.status}): ${await res.text()}`);
		}
	}

	/**
	 * 把 token 對應的訊息與之前的訊息標為已讀。
	 * 只有官方帳號 Chat 開啟（markAsReadMode = manual）時有效；token 無效回 400。
	 */
	async markAsRead(markAsReadToken: string): Promise<{ ok: boolean; status: number }> {
		const res = await this.request("mark-as-read", `${LINE_API}/chat/markAsRead`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ markAsReadToken }),
		});
		return { ok: res.ok, status: res.status };
	}

	/** 官方帳號基本資料，含 chatMode / markAsReadMode，用來確認已讀模式設定是否如預期 */
	async getBotInfo(): Promise<LineBotInfo | null> {
		const res = await this.request("bot-info", `${LINE_API}/info`);
		if (!res.ok) return null;
		const data = (await res.json()) as Partial<LineBotInfo>;
		return {
			userId: data.userId ?? "",
			basicId: data.basicId ?? "",
			displayName: data.displayName ?? "",
			pictureUrl: data.pictureUrl ?? null,
			chatMode: data.chatMode === "chat" ? "chat" : "bot",
			markAsReadMode: data.markAsReadMode === "manual" ? "manual" : "auto",
		};
	}

	/** 下載使用者傳來的圖片／影片／語音／檔案 */
	async getContent(
		messageId: string,
	): Promise<{ body: ReadableStream; contentType: string } | null> {
		const res = await this.request("content", `${LINE_DATA_API}/message/${messageId}/content`);
		if (!res.ok || !res.body) return null;
		return {
			body: res.body,
			contentType:
				res.headers.get("content-type") ?? "application/octet-stream",
		};
	}
}

/** LINE 官方貼圖圖檔 */
export function stickerImageUrl(stickerId: string): string {
	return `https://stickershop.line-scdn.net/stickershop/v1/sticker/${stickerId}/android/sticker.png`;
}
