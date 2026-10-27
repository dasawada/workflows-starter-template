import { SELF, env, introspectWorkflow } from "cloudflare:test";
import { afterAll, afterEach, beforeAll, describe, it, expect, vi } from "vitest";
import {
	buildPromptMessages,
	parsePromptPostback,
	signLineBody,
} from "../worker/line";
import type { Message, Prompt } from "../shared/types";

const AUTH = { Authorization: `Bearer ${env.CONSOLE_TOKEN}` };

type Handler = (req: Request) => Response | Promise<Response>;
const routes = new Map<string, { handler: Handler; remaining: number }>();
const realFetch = globalThis.fetch;
function mockLine(method: string, path: string, handler: Handler, times = 1) {
	routes.set(`${method} ${path}`, { handler, remaining: times });
}
const ok = (data: unknown = {}) => () => Response.json(data);

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
			if (!route || route.remaining <= 0) throw new Error(`unexpected LINE call: ${key}`);
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

afterEach(() => {
	for (const [key, route] of routes) {
		expect(route.remaining, `LINE call not made: ${key}`).toBe(0);
	}
	routes.clear();
});

async function postWebhook(events: unknown[]) {
	const body = JSON.stringify({ destination: "Ubot", events });
	return SELF.fetch("https://console.test/webhook/line", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"x-line-signature": await signLineBody(env.LINE_CHANNEL_SECRET, body),
		},
		body,
	});
}

async function seedUser(userId: string, name: string) {
	mockLine("GET", `/v2/bot/profile/${userId}`, ok({ displayName: name }));
	await postWebhook([
		{
			type: "message",
			timestamp: Date.now(),
			source: { type: "user", userId },
			message: { id: `seed-${userId}`, type: "text", text: "hi" },
		},
	]);
}

describe("buildPromptMessages / parsePromptPostback", () => {
	it("builds text + confirm template with postback actions", () => {
		const messages = buildPromptMessages({
			promptId: "p1",
			body: "正文",
			question: "是否承接？",
			options: [
				{ label: "是", value: "yes" },
				{ label: "否", value: "no" },
			],
		}) as Array<Record<string, unknown>>;
		expect(messages).toHaveLength(2);
		expect(messages[0]).toEqual({ type: "text", text: "正文" });
		const template = messages[1].template as { type: string; text: string; actions: Array<Record<string, string>> };
		expect(template.type).toBe("confirm");
		expect(template.actions[0]).toMatchObject({ type: "postback", label: "是", displayText: "是" });
		expect(parsePromptPostback(template.actions[0].data)).toEqual({ promptId: "p1", choice: "yes" });
		expect(parsePromptPostback(template.actions[1].data)).toEqual({ promptId: "p1", choice: "no" });
	});

	it("omits the text message when body is empty", () => {
		const messages = buildPromptMessages({
			promptId: "p2",
			body: "",
			question: "Q",
			options: [{ label: "OK", value: "ok" }],
		});
		expect(messages).toHaveLength(1);
	});

	it("rejects foreign postback data", () => {
		expect(parsePromptPostback("action=buy&itemid=1")).toBeNull();
	});
});

describe("trackable prompts", () => {
	it("sends a prompt, records the user's choice from postback, and lists it", async () => {
		await seedUser("U-teacher", "王老師");

		let pushed: { to: string; messages: Array<Record<string, unknown>> } | null = null;
		mockLine("POST", "/v2/bot/message/push", async (req) => {
			pushed = (await req.json()) as typeof pushed;
			return Response.json({});
		});

		const send = await SELF.fetch(
			"https://console.test/api/conversations/line%3AU-teacher/prompt",
			{
				method: "POST",
				headers: { ...AUTH, "Content-Type": "application/json" },
				body: JSON.stringify({
					body: "老師好，媒合到【小明】「數學」",
					question: "請問老師是否方便承接？",
					options: [
						{ label: "是", value: "yes" },
						{ label: "否", value: "no" },
					],
					templateKey: "course-offer",
					variables: { 學生姓名: "小明", 科目: "數學" },
				}),
			},
		);
		expect(send.status).toBe(200);
		const { prompt, message } = (await send.json()) as { prompt: Prompt; message: Message };
		expect(prompt.status).toBe("pending");
		expect(prompt.variables).toEqual({ 學生姓名: "小明", 科目: "數學" });
		expect(message.type).toBe("prompt");
		expect(pushed!.to).toBe("U-teacher");
		expect(pushed!.messages).toHaveLength(2);

		// 待回覆清單
		const pending = await SELF.fetch("https://console.test/api/prompts?status=pending", { headers: AUTH });
		const pendingList = (await pending.json()) as { prompts: Prompt[] };
		expect(pendingList.prompts.some((p) => p.id === prompt.id)).toBe(true);

		// 使用者按「是」
		const template = pushed!.messages[1].template as { actions: Array<{ data: string }> };
		mockLine("POST", "/v2/bot/message/reply", ok());
		const postback = await postWebhook([
			{
				type: "postback",
				timestamp: Date.now(),
				source: { type: "user", userId: "U-teacher" },
				replyToken: "rt-pb",
				webhookEventId: "evt-pb-1",
				postback: { data: template.actions[0].data },
			},
		]);
		expect(postback.status).toBe(200);

		const answered = await SELF.fetch("https://console.test/api/prompts?status=answered", { headers: AUTH });
		const answeredList = (await answered.json()) as { prompts: Prompt[] };
		const got = answeredList.prompts.find((p) => p.id === prompt.id);
		expect(got).toMatchObject({
			status: "answered",
			choice: "yes",
			choiceLabel: "是",
			displayName: "王老師",
		});
		expect(got!.respondedAt).toBeTypeOf("number");

		// 對話裡留下使用者的選擇與系統確認，原本的選擇題訊息狀態更新
		const msgs = await SELF.fetch(
			"https://console.test/api/conversations/line%3AU-teacher/messages",
			{ headers: AUTH },
		);
		const { messages } = (await msgs.json()) as { messages: Message[] };
		const promptMsg = messages.find((m) => m.id === message.id);
		expect(promptMsg?.metadata).toMatchObject({ status: "answered", choice: "yes", choiceLabel: "是" });
		expect(messages.some((m) => m.sender === "user" && m.text === "已選擇：是")).toBe(true);
		expect(messages.some((m) => m.sender === "system" && m.text?.includes("已收到您的選擇「是」"))).toBe(true);

		// 重複點擊：更新為「否」，並留下第二筆回覆紀錄
		mockLine("POST", "/v2/bot/message/reply", ok());
		await postWebhook([
			{
				type: "postback",
				timestamp: Date.now() + 10,
				source: { type: "user", userId: "U-teacher" },
				replyToken: "rt-pb2",
				webhookEventId: "evt-pb-2",
				postback: { data: template.actions[1].data },
			},
		]);
		const after = await SELF.fetch(`https://console.test/api/prompts?conversationId=line%3AU-teacher`, { headers: AUTH });
		const afterList = (await after.json()) as { prompts: Prompt[] };
		expect(afterList.prompts.find((p) => p.id === prompt.id)).toMatchObject({ choice: "no", choiceLabel: "否" });
		const responses = await env.DB.prepare("SELECT COUNT(*) AS n FROM prompt_responses WHERE prompt_id = ?")
			.bind(prompt.id)
			.first<{ n: number }>();
		expect(responses?.n).toBe(2);
	});

	it("ignores postbacks for unknown prompts", async () => {
		await seedUser("U-stranger", "路人");
		const res = await postWebhook([
			{
				type: "postback",
				timestamp: Date.now(),
				source: { type: "user", userId: "U-stranger" },
				replyToken: "rt-x",
				postback: { data: "prompt=does-not-exist&choice=yes" },
			},
		]);
		expect(res.status).toBe(200);
	});

	it("validates input", async () => {
		await seedUser("U-val", "驗證");
		const bad = await SELF.fetch(
			"https://console.test/api/conversations/line%3AU-val/prompt",
			{
				method: "POST",
				headers: { ...AUTH, "Content-Type": "application/json" },
				body: JSON.stringify({ question: "", options: [] }),
			},
		);
		expect(bad.status).toBe(400);

		const tooMany = await SELF.fetch(
			"https://console.test/api/conversations/line%3AU-val/prompt",
			{
				method: "POST",
				headers: { ...AUTH, "Content-Type": "application/json" },
				body: JSON.stringify({
					question: "Q",
					options: [{ label: "A" }, { label: "B" }, { label: "C" }],
				}),
			},
		);
		expect(tooMany.status).toBe(400);
	});
});

describe("POST /api/conversations/:id/send (raw LINE messages)", () => {
	it("instruments postback actions in a flex message and tracks the reply", async () => {
		await seedUser("U-flex", "Flex老師");

		let pushed: { messages: Array<Record<string, unknown>> } | null = null;
		mockLine("POST", "/v2/bot/message/push", async (req) => {
			pushed = (await req.json()) as typeof pushed;
			return Response.json({});
		});

		const res = await SELF.fetch("https://console.test/api/conversations/line%3AU-flex/send", {
			method: "POST",
			headers: { ...AUTH, "Content-Type": "application/json" },
			body: JSON.stringify({
				templateKey: "flex-card",
				messages: [
					{
						type: "flex",
						altText: "排課媒合通知",
						contents: {
							type: "bubble",
							body: { type: "box", layout: "vertical", contents: [{ type: "text", text: "王小明｜數學" }] },
							footer: {
								type: "box",
								layout: "horizontal",
								contents: [
									{ type: "button", action: { type: "postback", label: "承接", data: "accept" } },
									{ type: "button", action: { type: "postback", label: "不承接", data: "decline" } },
									{ type: "button", action: { type: "uri", label: "詳情", uri: "https://example.com" } },
								],
							},
						},
					},
				],
			}),
		});
		expect(res.status).toBe(200);
		const { prompt, message } = (await res.json()) as { prompt: Prompt; message: Message };
		expect(prompt).not.toBeNull();
		expect(prompt.options).toEqual([
			{ label: "承接", value: "accept" },
			{ label: "不承接", value: "decline" },
		]);
		expect(prompt.templateKey).toBe("flex-card");
		expect(prompt.question).toBe("排課媒合通知");
		expect(message.type).toBe("prompt");
		expect(Array.isArray(prompt.payload)).toBe(true);

		// postback data 已被改寫成 prompt=<id>&choice=<value>
		const footer = (pushed!.messages[0].contents as { footer: { contents: Array<{ action: Record<string, string> }> } }).footer;
		expect(parsePromptPostback(footer.contents[0].action.data)).toEqual({ promptId: prompt.id, choice: "accept" });
		expect(parsePromptPostback(footer.contents[1].action.data)).toEqual({ promptId: prompt.id, choice: "decline" });
		expect(footer.contents[2].action.uri).toBe("https://example.com");

		mockLine("POST", "/v2/bot/message/reply", ok());
		await postWebhook([
			{
				type: "postback",
				timestamp: Date.now(),
				source: { type: "user", userId: "U-flex" },
				replyToken: "rt-flex",
				webhookEventId: "evt-flex-1",
				postback: { data: footer.contents[1].action.data },
			},
		]);
		const list = await SELF.fetch("https://console.test/api/prompts?conversationId=line%3AU-flex", { headers: AUTH });
		const { prompts } = (await list.json()) as { prompts: Prompt[] };
		expect(prompts.find((p) => p.id === prompt.id)).toMatchObject({ status: "answered", choice: "decline", choiceLabel: "不承接" });
	});

	it("tracks quick reply postbacks and merges duplicated values across carousel cards", async () => {
		await seedUser("U-qr", "QR老師");
		let pushed: { messages: Array<Record<string, unknown>> } | null = null;
		mockLine("POST", "/v2/bot/message/push", async (req) => {
			pushed = (await req.json()) as typeof pushed;
			return Response.json({});
		});
		const res = await SELF.fetch("https://console.test/api/conversations/line%3AU-qr/send", {
			method: "POST",
			headers: { ...AUTH, "Content-Type": "application/json" },
			body: JSON.stringify({
				messages: [
					{
						type: "text",
						text: "方便嗎？",
						quickReply: {
							items: [
								{ type: "action", action: { type: "postback", label: "承接", data: "accept" } },
								{ type: "action", action: { type: "postback", label: "承接", data: "accept" } },
								{ type: "action", action: { type: "message", label: "問題", text: "我有問題" } },
							],
						},
					},
				],
			}),
		});
		expect(res.status).toBe(200);
		const { prompt } = (await res.json()) as { prompt: Prompt };
		expect(prompt.options).toEqual([{ label: "承接", value: "accept" }]);
		const items = (pushed!.messages[0].quickReply as { items: Array<{ action: Record<string, string> }> }).items;
		expect(items[0].action.data).toContain(`prompt=${prompt.id}`);
		expect(items[2].action.text).toBe("我有問題");
	});

	it("stores untracked rich messages without creating a prompt", async () => {
		await seedUser("U-rich", "Rich老師");
		mockLine("POST", "/v2/bot/message/push", ok());
		const res = await SELF.fetch("https://console.test/api/conversations/line%3AU-rich/send", {
			method: "POST",
			headers: { ...AUTH, "Content-Type": "application/json" },
			body: JSON.stringify({
				messages: [
					{ type: "flex", altText: "純資訊卡", contents: { type: "bubble", body: { type: "box", layout: "vertical", contents: [{ type: "text", text: "hi" }] } } },
				],
			}),
		});
		expect(res.status).toBe(200);
		const { prompt, message } = (await res.json()) as { prompt: Prompt | null; message: Message };
		expect(prompt).toBeNull();
		expect(message.type).toBe("rich");
		expect(message.text).toBe("純資訊卡");
	});

	it("rejects malformed message arrays", async () => {
		await seedUser("U-bad", "Bad");
		const cases: unknown[] = [
			{ messages: [] },
			{ messages: [{ type: "flex" }] },
			{ messages: [{ type: "weird" }] },
			{ messages: new Array(6).fill({ type: "text", text: "x" }) },
		];
		for (const body of cases) {
			const res = await SELF.fetch("https://console.test/api/conversations/line%3AU-bad/send", {
				method: "POST",
				headers: { ...AUTH, "Content-Type": "application/json" },
				body: JSON.stringify(body),
			});
			expect(res.status, JSON.stringify(body)).toBe(400);
		}
	});
});
