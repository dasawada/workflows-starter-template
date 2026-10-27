import type { MessageType } from "../shared/types";

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

export type LineMessageContent =
	| { id: string; type: "text"; text: string }
	| {
			id: string;
			type: "image" | "video" | "audio";
			contentProvider: { type: "line" | "external"; originalContentUrl?: string };
			duration?: number;
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
	type: "message" | "follow" | "unfollow" | "join" | "leave" | string;
	timestamp: number;
	source: LineSource;
	replyToken?: string;
	webhookEventId?: string;
	deliveryContext?: { isRedelivery: boolean };
	message?: LineMessageContent;
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

export class LineClient {
	private readonly accessToken: string;
	constructor(accessToken: string) {
		this.accessToken = accessToken;
	}

	private headers(extra: Record<string, string> = {}): HeadersInit {
		return {
			Authorization: `Bearer ${this.accessToken}`,
			...extra,
		};
	}

	async getProfile(
		userId: string,
		groupOrRoom?: { kind: "group" | "room"; id: string },
	): Promise<{ displayName: string; pictureUrl?: string } | null> {
		const url = groupOrRoom
			? `${LINE_API}/${groupOrRoom.kind}/${groupOrRoom.id}/member/${userId}`
			: `${LINE_API}/profile/${userId}`;
		const res = await fetch(url, { headers: this.headers() });
		if (!res.ok) return null;
		return (await res.json()) as { displayName: string; pictureUrl?: string };
	}

	async getGroupSummary(
		kind: "group" | "room",
		id: string,
	): Promise<{ groupName?: string; pictureUrl?: string } | null> {
		if (kind !== "group") return null;
		const res = await fetch(`${LINE_API}/group/${id}/summary`, {
			headers: this.headers(),
		});
		if (!res.ok) return null;
		return (await res.json()) as { groupName: string; pictureUrl?: string };
	}

	async pushText(to: string, text: string): Promise<void> {
		await this.push(to, [{ type: "text", text }]);
	}

	async push(to: string, messages: unknown[]): Promise<void> {
		const res = await fetch(`${LINE_API}/message/push`, {
			method: "POST",
			headers: this.headers({ "Content-Type": "application/json" }),
			body: JSON.stringify({ to, messages }),
		});
		if (!res.ok) {
			throw new Error(`LINE push failed (${res.status}): ${await res.text()}`);
		}
	}

	async reply(replyToken: string, messages: unknown[]): Promise<void> {
		const res = await fetch(`${LINE_API}/message/reply`, {
			method: "POST",
			headers: this.headers({ "Content-Type": "application/json" }),
			body: JSON.stringify({ replyToken, messages }),
		});
		if (!res.ok) {
			throw new Error(`LINE reply failed (${res.status}): ${await res.text()}`);
		}
	}

	/** 下載使用者傳來的圖片／影片／語音／檔案 */
	async getContent(
		messageId: string,
	): Promise<{ body: ReadableStream; contentType: string } | null> {
		const res = await fetch(`${LINE_DATA_API}/message/${messageId}/content`, {
			headers: this.headers(),
		});
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
