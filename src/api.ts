import type {
	Conversation,
	ConversationListResponse,
	ConversationQuery,
	ConversationStatus,
	ImportBatch,
	ImportMapping,
	ImportPreview,
	ImportRowGroup,
	ImportRunInput,
	IntegrityEvent,
	IntegrityHealth,
	IntegrityKind,
	IntegrityReportInput,
	IntegrityStatus,
	LineBotInfo,
	Message,
	MessageListResponse,
	Notification,
	Prompt,
	PromptListResponse,
	PromptStatus,
	ReplyInput,
	SendMessagesInput,
	SendNotificationInput,
	SendPromptInput,
	Stats,
} from "../shared/types";
import { getAgentName } from "./agent";

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
	/** 伺服器回的完整內容（409 衝突、502 已寫入的訊息等） */
	data: Record<string, unknown> | null;
	constructor(status: number, message: string, data: Record<string, unknown> | null = null) {
		super(message);
		this.status = status;
		this.data = data;
	}
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
	const token = getToken();
	const headers = new Headers(init.headers);
	if (token) headers.set("Authorization", `Bearer ${token}`);
	if (init.body) headers.set("Content-Type", "application/json");
	const agent = getAgentName();
	if (agent) headers.set("X-Agent-Name", encodeURIComponent(agent));
	const res = await fetch(path, { ...init, headers });
	if (!res.ok) {
		let message = res.statusText;
		let data: Record<string, unknown> | null = null;
		try {
			data = (await res.json()) as Record<string, unknown>;
			if (typeof data.error === "string") message = data.error;
		} catch {
			// ignore
		}
		throw new ApiError(res.status, message, data);
	}
	return (await res.json()) as T;
}

const conv = (id: string) => `/api/conversations/${encodeURIComponent(id)}`;

export const api = {
	me: () => request<{ ok: boolean }>("/api/me"),

	listConversations: (query: ConversationQuery) => {
		const params = new URLSearchParams({ status: query.status });
		if (query.before) params.set("before", String(query.before));
		if (query.q) params.set("q", query.q);
		if (query.limit) params.set("limit", String(query.limit));
		return request<ConversationListResponse>(`/api/conversations?${params}`);
	},

	stats: () => request<Stats>("/api/stats"),

	listMessages: (conversationId: string, before?: number) =>
		request<MessageListResponse>(
			`/api/conversations/${encodeURIComponent(conversationId)}/messages${
				before ? `?before=${before}` : ""
			}`,
		),

	reply: (conversationId: string, input: ReplyInput) =>
		request<{ message: Message; conversation: Conversation; status: "sent" | "pending"; reused: boolean }>(
			`${conv(conversationId)}/reply`,
			{ method: "POST", body: JSON.stringify(input) },
		),

	retryMessage: (messageId: string) =>
		request<{ message: Message }>(`/api/messages/${encodeURIComponent(messageId)}/retry`, { method: "POST" }),

	assign: (conversationId: string) =>
		request<{ conversation: Conversation }>(`${conv(conversationId)}/assign`, { method: "POST", body: "{}" }),
	release: (conversationId: string) =>
		request<{ conversation: Conversation }>(`${conv(conversationId)}/release`, { method: "POST", body: "{}" }),
	presence: (conversationId: string) => request<{ agents: string[] }>(`${conv(conversationId)}/presence`),
	conversationIntegrity: (conversationId: string) =>
		request<{ events: IntegrityEvent[] }>(`${conv(conversationId)}/integrity?status=open`),
	reportGap: (input: IntegrityReportInput) =>
		request<{ events: IntegrityEvent[] }>(`${conv(input.conversationId)}/report`, {
			method: "POST",
			body: JSON.stringify({ note: input.note, from: input.from, to: input.to }),
		}),

	// ---------- 完整性中心 ----------
	integrityHealth: () => request<IntegrityHealth>("/api/integrity/health"),
	integrityEvents: (status: IntegrityStatus | "all" = "open", kind?: IntegrityKind) =>
		request<{ events: IntegrityEvent[] }>(
			`/api/integrity/events?status=${status}${kind ? `&kind=${kind}` : ""}&limit=200`,
		),
	resolveIntegrityEvent: (id: string, resolution: string) =>
		request<{ event: IntegrityEvent }>(`/api/integrity/events/${encodeURIComponent(id)}/resolve`, {
			method: "POST",
			body: JSON.stringify({ resolution }),
		}),
	runMaintenance: () =>
		request<{ outbound: number; media: number; botInfo: boolean }>("/api/integrity/maintenance", { method: "POST" }),
	lineInfo: () => request<LineBotInfo>("/api/line/info"),

	// ---------- 歷史匯入 ----------
	previewImport: (csv: string, mapping?: ImportMapping) =>
		request<ImportPreview>("/api/imports/preview", { method: "POST", body: JSON.stringify({ csv, mapping }) }),
	runImport: (input: ImportRunInput) =>
		request<{ batch: ImportBatch }>("/api/imports", { method: "POST", body: JSON.stringify(input) }),
	listImports: () => request<{ batches: ImportBatch[] }>("/api/imports"),
	importRows: (batchId: string) =>
		request<{ batch: ImportBatch; groups: ImportRowGroup[] }>(`/api/imports/${encodeURIComponent(batchId)}/rows`),
	assignImportRows: (batchId: string, chatName: string, conversationId: string) =>
		request<{ inserted: number; duplicates: number; batch: ImportBatch }>(
			`/api/imports/${encodeURIComponent(batchId)}/assign`,
			{ method: "POST", body: JSON.stringify({ chatName, conversationId }) },
		),
	skipImportRows: (batchId: string, chatName: string) =>
		request<{ skipped: number; batch: ImportBatch }>(`/api/imports/${encodeURIComponent(batchId)}/skip`, {
			method: "POST",
			body: JSON.stringify({ chatName }),
		}),

	// ---------- 通知型訊息 ----------
	listNotifications: () => request<{ notifications: Notification[] }>("/api/notifications"),
	sendNotification: (input: SendNotificationInput) =>
		request<{ notification: Notification }>("/api/notifications", { method: "POST", body: JSON.stringify(input) }),
	retryNotification: (id: string) =>
		request<{ notification: Notification }>(`/api/notifications/${encodeURIComponent(id)}/retry`, { method: "POST" }),

	sendPrompt: (conversationId: string, input: SendPromptInput) =>
		request<{ prompt: Prompt; message: Message; conversation: Conversation }>(
			`/api/conversations/${encodeURIComponent(conversationId)}/prompt`,
			{ method: "POST", body: JSON.stringify(input) },
		),

	sendMessages: (conversationId: string, input: SendMessagesInput) =>
		request<{ prompt: Prompt | null; message: Message; conversation: Conversation }>(
			`/api/conversations/${encodeURIComponent(conversationId)}/send`,
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
