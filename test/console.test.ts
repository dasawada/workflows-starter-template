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
		mockLine("GET", "/v2/bot/profile/U-bob", lineJson({ displayName: "Bob" }), 2);

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
			["system", "歡迎！"],
		]);
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
