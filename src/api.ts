import type {
	Conversation,
	ConversationListResponse,
	ConversationStatus,
	Message,
	MessageListResponse,
	Prompt,
	PromptListResponse,
	PromptStatus,
	SendPromptInput,
} from "../shared/types";

const TOKEN_KEY = "cs-console-token";

export function getToken(): string | null {
	try {
		return localStorage.getItem(TOKEN_KEY);
	} catch {
		return null;
	}
}

export function setToken(token: string | null) {
	try {
		if (token) localStorage.setItem(TOKEN_KEY, token);
		else localStorage.removeItem(TOKEN_KEY);
	} catch {
		// ignore
	}
}

export class ApiError extends Error {
	status: number;
	constructor(status: number, message: string) {
		super(message);
		this.status = status;
	}
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
	const token = getToken();
	const headers = new Headers(init.headers);
	if (token) headers.set("Authorization", `Bearer ${token}`);
	if (init.body) headers.set("Content-Type", "application/json");
	const res = await fetch(path, { ...init, headers });
	if (!res.ok) {
		let message = res.statusText;
		try {
			const data = (await res.json()) as { error?: string };
			if (data.error) message = data.error;
		} catch {
			// ignore
		}
		throw new ApiError(res.status, message);
	}
	return (await res.json()) as T;
}

export const api = {
	me: () => request<{ ok: boolean }>("/api/me"),

	listConversations: (status: ConversationStatus | "all") =>
		request<ConversationListResponse>(
			`/api/conversations?status=${encodeURIComponent(status)}`,
		),

	listMessages: (conversationId: string, before?: number) =>
		request<MessageListResponse>(
			`/api/conversations/${encodeURIComponent(conversationId)}/messages${
				before ? `?before=${before}` : ""
			}`,
		),

	reply: (conversationId: string, text: string) =>
		request<{ message: Message; conversation: Conversation }>(
			`/api/conversations/${encodeURIComponent(conversationId)}/reply`,
			{ method: "POST", body: JSON.stringify({ text }) },
		),

	sendPrompt: (conversationId: string, input: SendPromptInput) =>
		request<{ prompt: Prompt; message: Message; conversation: Conversation }>(
			`/api/conversations/${encodeURIComponent(conversationId)}/prompt`,
			{ method: "POST", body: JSON.stringify(input) },
		),

	listPrompts: (status: PromptStatus | "all" = "all") =>
		request<PromptListResponse>(`/api/prompts?status=${encodeURIComponent(status)}`),

	markRead: (conversationId: string) =>
		request<{ conversation: Conversation }>(
			`/api/conversations/${encodeURIComponent(conversationId)}/read`,
			{ method: "POST" },
		),

	setStatus: (conversationId: string, status: ConversationStatus) =>
		request<{ conversation: Conversation }>(
			`/api/conversations/${encodeURIComponent(conversationId)}/status`,
			{ method: "POST", body: JSON.stringify({ status }) },
		),

	mediaUrl: (key: string) => {
		const token = getToken() ?? "";
		return `/api/media/${encodeURIComponent(key)}?token=${encodeURIComponent(token)}`;
	},
};
