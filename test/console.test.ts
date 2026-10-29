import { SELF, env, introspectWorkflow } from "cloudflare:test";
import { afterAll, afterEach, beforeAll, describe, it, expect, vi } from "vitest";
import { signLineBody } from "../worker/line";
import type { Conversation, Message } from "../shared/types";

/**
 * 攔截 Worker 對 LINE API 的外送 fetch。
 * SELF 與測試程式跑在同一個 isolate，所以 stub 全域 fetch 即可。
 */
type Handler = (req: Request) => Response | Promise<Response>;
const routes = new Map<string, { handler: Handler; remaining: number }>();
const realFetch = globalThis.fetch;

function mockLine(method: string, path: string, handler: Handler, times = 1) {
	routes.set(`${method} ${path}`, { handler, remaining: times });
}

function lineJson(data: unknown, status = 200) {
	return () => Response.json(data, { status });
}

// webhook 會啟動 ReplyReminderWorkflow；這裡讓它立刻收到客服回覆事件結束，避免測試期間一直等待
let reminders: Awaited<ReturnType<typeof introspectWorkflow>>;

beforeAll(async () => {
	reminders = await introspectWorkflow(env.REPLY_REMINDER);
	await reminders.modifyAll(async (m) => {
		await m.mockEvent({ type: "agent-replied", payload: {} });
	});
	vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
		const req = new Request(input, init);
		const url = new URL(req.url);
		if (url.hostname.endsWith("line.me")) {
			const key = `${req.method} ${url.pathname}`;
			const route = routes.get(key);
			if (!route || route.remaining <= 0) {
				throw new Error(`unexpected LINE call: ${key}`);
			}
			route.remaining -= 1;
			return route.handler(req);
		}
		return realFetch(input, init);
	});
});

afterAll(async () => {
	vi.unstubAllGlobals();
	await reminders.dispose();
});

const AUTH = { Authorization: `Bearer ${env.CONSOLE_TOKEN}` };

async function postWebhook(events: unknown[], secret = env.LINE_CHANNEL_SECRET) {
	const body = JSON.stringify({ destination: "Ubot", events });
	return SELF.fetch("https://console.test/webhook/line", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"x-line-signature": await signLineBody(secret, body),
		},
		body,
	});
}

function textEvent(userId: string, text: string, id: string) {
	return {
		type: "message",
		timestamp: Date.now(),
		source: { type: "user", userId },
		replyToken: "rt",
		message: { id, type: "text", text },
	};
}

afterEach(() => {
	for (const [key, route] of routes) {
		expect(route.remaining, `LINE call not made: ${key}`).toBe(0);
	}
	routes.clear();
});

describe("auth", () => {
	it("rejects console APIs without the token", async () => {
		const res = await SELF.fetch("https://console.test/api/conversations");
		expect(res.status).toBe(401);
	});

	it("accepts the token", async () => {
		const res = await SELF.fetch("https://console.test/api/me", { headers: AUTH });
		expect(res.status).toBe(200);
	});
});

describe("LINE webhook", () => {
	it("rejects an invalid signature", async () => {
		const res = await postWebhook([], "wrong-secret");
		expect(res.status).toBe(401);
	});

	it("stores an inbound text message and exposes it to the console", async () => {
		mockLine("GET", "/v2/bot/profile/U-alice", lineJson({ displayName: "Alice", pictureUrl: "https://img/alice.png" }));

		const res = await postWebhook([textEvent("U-alice", "你好，請問營業時間？", "m-1")]);
		expect(res.status).toBe(200);

		const list = await SELF.fetch(
			"https://console.test/api/conversations?status=open",
			{ headers: AUTH },
		);
		const { conversations } = (await list.json()) as { conversations: Conversation[] };
		const conv = conversations.find((c) => c.id === "line:U-alice");
		expect(conv).toBeDefined();
		expect(conv!.displayName).toBe("Alice");
		expect(conv!.unreadCount).toBe(1);
		expect(conv!.lastMessageText).toBe("你好，請問營業時間？");

		const msgs = await SELF.fetch(
			"https://console.test/api/conversations/line%3AU-alice/messages",
			{ headers: AUTH },
		);
		const { messages } = (await msgs.json()) as { messages: Message[] };
		expect(messages).toHaveLength(1);
		expect(messages[0]).toMatchObject({
			direction: "inbound",
			sender: "user",
			type: "text",
			text: "你好，請問營業時間？",
			externalId: "m-1",
		});
	});

	it("ignores LINE redelivery of the same message id", async () => {
		mockLine("GET", "/v2/bot/profile/U-bob", lineJson({ displayName: "Bob" }));

		await postWebhook([textEvent("U-bob", "first", "m-dup")]);
		await postWebhook([textEvent("U-bob", "first", "m-dup")]);

		const msgs = await SELF.fetch(
			"https://console.test/api/conversations/line%3AU-bob/messages",
			{ headers: AUTH },
		);
		const { messages } = (await msgs.json()) as { messages: Message[] };
		expect(messages).toHaveLength(1);
	});

	it("sends the welcome message on follow", async () => {
		mockLine("GET", "/v2/bot/profile/U-new", lineJson({ displayName: "Newbie" }));
		mockLine("POST", "/v2/bot/message/reply", lineJson({}));

		const res = await postWebhook([
			{
				type: "follow",
				timestamp: Date.now(),
				source: { type: "user", userId: "U-new" },
				replyToken: "rt-follow",
			},
		]);
		expect(res.status).toBe(200);

		const msgs = await SELF.fetch(
			"https://console.test/api/conversations/line%3AU-new/messages",
			{ headers: AUTH },
		);
		const { messages } = (await msgs.json()) as { messages: Message[] };
		expect(messages.map((m) => [m.sender, m.text])).toEqual([
			["system", "使用者加入好友"],
			["system", "歡迎加入。"],
		]);
	});

	it("fetches the profile only for a new conversation, and refreshes it on re-follow", async () => {
		// afterEach 會確認：兩則訊息只取一次個人資料
		mockLine("GET", "/v2/bot/profile/U-rename", lineJson({ displayName: "舊名" }));
		await postWebhook([textEvent("U-rename", "第一則", "m-rename-1")]);
		await postWebhook([textEvent("U-rename", "第二則", "m-rename-2")]);

		mockLine("GET", "/v2/bot/profile/U-rename", lineJson({ displayName: "新名" }));
		await postWebhook([{ type: "follow", timestamp: Date.now(), source: { type: "user", userId: "U-rename" } }]);

		const list = await SELF.fetch("https://console.test/api/conversations?status=all&q=U-rename", { headers: AUTH });
		const { conversations } = (await list.json()) as { conversations: Conversation[] };
		expect(conversations[0]?.displayName).toBe("新名");
	});
});

describe("agent reply", () => {
	it("pushes via LINE, stores the outbound message and clears unread", async () => {
		mockLine("GET", "/v2/bot/profile/U-carol", lineJson({ displayName: "Carol" }));
		await postWebhook([textEvent("U-carol", "hi", "m-carol-1")]);

		let pushed: unknown = null;
		mockLine("POST", "/v2/bot/message/push", async (req) => {
			pushed = await req.json();
			return Response.json({});
		});

		const reply = await SELF.fetch(
			"https://console.test/api/conversations/line%3AU-carol/reply",
			{
				method: "POST",
				headers: { ...AUTH, "Content-Type": "application/json" },
				body: JSON.stringify({ text: "您好，我們 9 點開門" }),
			},
		);
		expect(reply.status).toBe(200);
		expect(pushed).toEqual({
			to: "U-carol",
			messages: [{ type: "text", text: "您好，我們 9 點開門" }],
		});

		const { conversation, message } = (await reply.json()) as {
			conversation: Conversation;
			message: Message;
		};
		expect(message).toMatchObject({ direction: "outbound", sender: "agent" });
		expect(conversation.lastMessageText).toBe("您好，我們 9 點開門");
		expect(conversation.needsAttention).toBe(false);
	});

	it("surfaces LINE push failures", async () => {
		mockLine("GET", "/v2/bot/profile/U-dave", lineJson({ displayName: "Dave" }));
		await postWebhook([textEvent("U-dave", "hi", "m-dave-1")]);

		mockLine(
			"POST",
			"/v2/bot/message/push",
			lineJson({ message: "The property, 'to', in the request body is invalid" }, 400),
		);

		const reply = await SELF.fetch(
			"https://console.test/api/conversations/line%3AU-dave/reply",
			{
				method: "POST",
				headers: { ...AUTH, "Content-Type": "application/json" },
				body: JSON.stringify({ text: "x" }),
			},
		);
		expect(reply.status).toBe(502);
	});

	it("rejects empty text", async () => {
		mockLine("GET", "/v2/bot/profile/U-eve", lineJson({ displayName: "Eve" }));
		await postWebhook([textEvent("U-eve", "hi", "m-eve-1")]);

		const reply = await SELF.fetch(
			"https://console.test/api/conversations/line%3AU-eve/reply",
			{
				method: "POST",
				headers: { ...AUTH, "Content-Type": "application/json" },
				body: JSON.stringify({ text: "   " }),
			},
		);
		expect(reply.status).toBe(400);
	});
});

describe("conversation status", () => {
	it("closes and reopens a conversation", async () => {
		mockLine("GET", "/v2/bot/profile/U-frank", lineJson({ displayName: "Frank" }));
		await postWebhook([textEvent("U-frank", "hi", "m-frank-1")]);

		const close = await SELF.fetch(
			"https://console.test/api/conversations/line%3AU-frank/status",
			{
				method: "POST",
				headers: { ...AUTH, "Content-Type": "application/json" },
				body: JSON.stringify({ status: "closed" }),
			},
		);
		expect(((await close.json()) as { conversation: Conversation }).conversation.status).toBe("closed");

		const open = await SELF.fetch(
			"https://console.test/api/conversations?status=open",
			{ headers: AUTH },
		);
		const { conversations } = (await open.json()) as { conversations: Conversation[] };
		expect(conversations.find((c) => c.id === "line:U-frank")).toBeUndefined();
	});
});

describe("conversation list paging, search and stats", () => {
	it("pages by cursor, searches by name and reports stats", async () => {
		for (const [i, name] of ["甲老師", "乙老師", "丙老師"].entries()) {
			mockLine("GET", `/v2/bot/profile/U-page-${i}`, lineJson({ displayName: name }));
			await postWebhook([{ ...textEvent(`U-page-${i}`, `msg ${i}`, `m-page-${i}`), timestamp: 1_700_000_000_000 + i * 1000 }]);
		}
		const first = await SELF.fetch("https://console.test/api/conversations?status=all&limit=2", { headers: AUTH });
		const page1 = ((await first.json()) as { conversations: Conversation[] }).conversations;
		expect(page1.length).toBe(2);
		const cursor = page1[page1.length - 1].lastMessageAt!;
		const second = await SELF.fetch(`https://console.test/api/conversations?status=all&limit=2&before=${cursor}`, { headers: AUTH });
		const page2 = ((await second.json()) as { conversations: Conversation[] }).conversations;
		expect(page2.every((c) => c.lastMessageAt! < cursor)).toBe(true);
		expect(new Set([...page1, ...page2].map((c) => c.id)).size).toBe(page1.length + page2.length);

		const search = await SELF.fetch("https://console.test/api/conversations?status=all&q=%E4%B9%99", { headers: AUTH });
		const found = ((await search.json()) as { conversations: Conversation[] }).conversations;
		expect(found.some((c) => c.displayName === "乙老師")).toBe(true);
		expect(found.every((c) => c.displayName?.includes("乙") || c.externalId.includes("乙"))).toBe(true);

		const stats = await SELF.fetch("https://console.test/api/stats", { headers: AUTH });
		const s = (await stats.json()) as { unreadTotal: number; openCount: number };
		expect(s.openCount).toBeGreaterThanOrEqual(3);
		expect(s.unreadTotal).toBeGreaterThanOrEqual(3);
	});
});

describe("conversation integrity", () => {
	async function messagesOf(id: string): Promise<Message[]> {
		const res = await SELF.fetch(
			`https://console.test/api/conversations/${encodeURIComponent(id)}/messages`,
			{ headers: AUTH },
		);
		return ((await res.json()) as { messages: Message[] }).messages;
	}

	async function conversationOf(id: string): Promise<Conversation | undefined> {
		const res = await SELF.fetch("https://console.test/api/conversations?status=all&limit=100", { headers: AUTH });
		const { conversations } = (await res.json()) as { conversations: Conversation[] };
		return conversations.find((c) => c.id === id);
	}

	it("snapshots the quoted message when it exists locally, and flags it when it does not", async () => {
		mockLine("GET", "/v2/bot/profile/U-quote", lineJson({ displayName: "Quoter" }));
		await postWebhook([textEvent("U-quote", "請問要寄到台北還是新竹？", "m-q-original")]);
		await postWebhook([
			{
				...textEvent("U-quote", "新竹，謝謝。", "m-q-reply"),
				message: { id: "m-q-reply", type: "text", text: "新竹，謝謝。", quoteToken: "qt-1", quotedMessageId: "m-q-original" },
			},
			{
				...textEvent("U-quote", "那個呢？", "m-q-orphan"),
				message: { id: "m-q-orphan", type: "text", text: "那個呢？", quotedMessageId: "m-before-integration" },
			},
		]);

		const messages = await messagesOf("line:U-quote");
		const original = messages.find((m) => m.externalId === "m-q-original")!;
		const reply = messages.find((m) => m.externalId === "m-q-reply")!;
		const orphan = messages.find((m) => m.externalId === "m-q-orphan")!;
		expect(reply.metadata).toMatchObject({
			quoteToken: "qt-1",
			quote: { externalId: "m-q-original", messageId: original.id, text: "請問要寄到台北還是新竹？", sender: "user" },
		});
		expect(orphan.metadata?.quote).toEqual({
			externalId: "m-before-integration",
			messageId: null,
			text: null,
			type: null,
			sender: null,
		});
	});

	it("clears content on unsend, deletes the media object and updates the preview", async () => {
		mockLine("GET", "/v2/bot/profile/U-unsend", lineJson({ displayName: "Undo" }));
		mockLine("GET", "/v2/bot/message/m-unsend-img/content", () =>
			new Response("png-bytes", { headers: { "content-type": "image/png" } }),
		);
		await postWebhook([textEvent("U-unsend", "先傳個字", "m-unsend-text")]);
		await postWebhook([
			{
				type: "message",
				timestamp: Date.now(),
				source: { type: "user", userId: "U-unsend" },
				replyToken: "rt",
				message: { id: "m-unsend-img", type: "image", contentProvider: { type: "line" } },
			},
		]);
		// 媒體下載在 waitUntil，讓它跑完
		await new Promise((r) => setTimeout(r, 50));
		let [, image] = await messagesOf("line:U-unsend");
		expect(image.mediaKey).toBe("line/m-unsend-img");
		expect(await env.MEDIA.head("line/m-unsend-img")).not.toBeNull();

		const unsend = {
			type: "unsend",
			timestamp: Date.now(),
			source: { type: "user", userId: "U-unsend" },
			unsend: { messageId: "m-unsend-img" },
		};
		await postWebhook([unsend]);
		await postWebhook([unsend]); // 重送不會出錯

		[, image] = await messagesOf("line:U-unsend");
		expect(image.unsentAt).toBeTypeOf("number");
		expect(image.text).toBeNull();
		expect(image.mediaKey).toBeNull();
		expect(await env.MEDIA.head("line/m-unsend-img")).toBeNull();
		expect((await conversationOf("line:U-unsend"))?.lastMessageText).toBe("[訊息已撤回]");
	});

	it("applies group message edits by message id, keeps the first version and ignores stale edits", async () => {
		mockLine("GET", "/v2/bot/group/G-edit/summary", lineJson({ groupName: "編輯群" }));
		mockLine("GET", "/v2/bot/group/G-edit/member/U-editor", lineJson({ displayName: "小編" }));
		const t0 = Date.now();
		await postWebhook([
			{
				type: "message",
				timestamp: t0,
				source: { type: "group", groupId: "G-edit", userId: "U-editor" },
				replyToken: "rt",
				message: { id: "m-edit", type: "text", text: "明天 3 點開會" },
			},
		]);
		const edited = (text: string, timestamp: number) => ({
			type: "messageEdited",
			timestamp,
			source: { type: "group", groupId: "G-edit", userId: "U-editor" },
			message: { id: "m-edit", type: "text", text },
		});
		await postWebhook([edited("明天 4 點開會", t0 + 2000)]);
		await postWebhook([edited("明天 3 點半開會", t0 + 1000)]); // 較舊的編輯晚到，必須忽略

		const [message] = await messagesOf("line:group:G-edit");
		expect(message.text).toBe("明天 4 點開會");
		expect(message.editedAt).toBe(t0 + 2000);
		expect(message.metadata).toMatchObject({
			originalText: "明天 3 點開會",
			senderUserId: "U-editor",
			senderName: "小編",
		});
		expect((await conversationOf("line:group:G-edit"))?.lastMessageText).toBe("明天 4 點開會");
	});

	it("keeps image set information and the sender id even when the profile is unavailable", async () => {
		mockLine("GET", "/v2/bot/group/G-set/summary", lineJson({ groupName: "圖集群" }));
		mockLine("GET", "/v2/bot/group/G-set/member/U-anon", lineJson({ message: "not found" }, 404), 2);
		mockLine("GET", "/v2/bot/message/m-set-1/content", () => new Response("a", { headers: { "content-type": "image/jpeg" } }));
		mockLine("GET", "/v2/bot/message/m-set-2/content", () => new Response("b", { headers: { "content-type": "image/jpeg" } }));
		const imageEvent = (id: string, index: number) => ({
			type: "message",
			timestamp: Date.now(),
			source: { type: "group", groupId: "G-set", userId: "U-anon" },
			replyToken: "rt",
			deliveryContext: { isRedelivery: index === 2 },
			message: { id, type: "image", contentProvider: { type: "line" }, imageSet: { id: "set-1", index, total: 2 } },
		});
		await postWebhook([imageEvent("m-set-2", 2), imageEvent("m-set-1", 1)]);
		await new Promise((r) => setTimeout(r, 50));

		const messages = await messagesOf("line:group:G-set");
		expect(messages.map((m) => m.metadata?.imageSet)).toEqual([
			{ id: "set-1", index: 2, total: 2 },
			{ id: "set-1", index: 1, total: 2 },
		]);
		expect(messages[0].metadata).toMatchObject({ senderUserId: "U-anon", isRedelivery: true });
		expect(messages[0].metadata?.senderName).toBeUndefined();
		expect(messages[1].metadata?.isRedelivery).toBeUndefined();
	});

	it("marks the chat as read on LINE when an agent opens the conversation", async () => {
		mockLine("GET", "/v2/bot/profile/U-read", lineJson({ displayName: "Reader" }));
		await postWebhook([
			{ ...textEvent("U-read", "有人在嗎", "m-read-1"), markAsReadToken: "mart-1" },
			{ ...textEvent("U-read", "在嗎？", "m-read-2"), markAsReadToken: "mart-2" },
		]);

		let sent: unknown = null;
		mockLine("POST", "/v2/bot/chat/markAsRead", async (req) => {
			sent = await req.json();
			return Response.json({});
		});
		const read = async () =>
			SELF.fetch("https://console.test/api/conversations/line%3AU-read/read", { method: "POST", headers: AUTH });

		let res = await read();
		expect(res.status).toBe(200);
		expect(sent).toEqual({ markAsReadToken: "mart-2" }); // 最新一則的 token，LINE 會連同之前的一起標已讀

		// 第二次打開沒有新訊息，不再呼叫 LINE（afterEach 會確認沒有多餘的呼叫）
		res = await read();
		expect(res.status).toBe(200);

		// Chat 關閉時 LINE 回 400：客服台照常運作，token 保留
		await postWebhook([{ ...textEvent("U-read", "再問一次", "m-read-3"), markAsReadToken: "mart-3" }]);
		mockLine("POST", "/v2/bot/chat/markAsRead", lineJson({ message: "invalid token" }, 400));
		res = await read();
		expect(res.status).toBe(200);
		expect(((await res.json()) as { conversation: Conversation }).conversation.unreadCount).toBe(0);
	});
});
