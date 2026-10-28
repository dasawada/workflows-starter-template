import { SELF, env, introspectWorkflow } from "cloudflare:test";
import { afterAll, afterEach, beforeAll, describe, it, expect, vi } from "vitest";
import { parsePromptPostback, signLineBody } from "../worker/line";
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

describe("parsePromptPostback", () => {
	it("parses tracked postback data", () => {
		expect(parsePromptPostback("prompt=p1&choice=yes")).toEqual({ promptId: "p1", choice: "yes" });
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

		const send = await SELF.fetch("https://console.test/api/conversations/line%3AU-teacher/send", {
			method: "POST",
			headers: { ...AUTH, "Content-Type": "application/json" },
			body: JSON.stringify({
				templateKey: "course-offer",
				messages: [
					{ type: "text", text: "老師好，媒合到【小明】「數學」" },
					{
						type: "template",
						altText: "請問老師是否方便承接？",
						template: {
							type: "confirm",
							text: "請問老師是否方便承接？",
							actions: [
								{ type: "postback", label: "是", data: "yes", displayText: "是" },
								{ type: "postback", label: "否", data: "no", displayText: "否" },
							],
						},
					},
				],
			}),
		});
		expect(send.status).toBe(200);
		const { prompt, message } = (await send.json()) as { prompt: Prompt; message: Message };
		expect(prompt.status).toBe("pending");
		expect(prompt.templateKey).toBe("course-offer");
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

		// 重複點擊：預設以第一次為準，結果不變，但留下第二筆回覆紀錄並回覆提示
		let replied: { messages: Array<{ text: string }> } | null = null;
		mockLine("POST", "/v2/bot/message/reply", async (req) => {
			replied = (await req.json()) as typeof replied;
			return Response.json({});
		});
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
		expect(afterList.prompts.find((p) => p.id === prompt.id)).toMatchObject({ choice: "yes", choiceLabel: "是" });
		expect(replied!.messages[0].text).toContain("以第一次回覆為準");
		const responses = await env.DB.prepare("SELECT COUNT(*) AS n FROM prompt_responses WHERE prompt_id = ?")
			.bind(prompt.id)
			.first<{ n: number }>();
		expect(responses?.n).toBe(2);
		const msgsAfter = await SELF.fetch(
			"https://console.test/api/conversations/line%3AU-teacher/messages",
			{ headers: AUTH },
		);
		const { messages: all } = (await msgsAfter.json()) as { messages: Message[] };
		expect(all.some((m) => m.text?.startsWith("再次點選：否"))).toBe(true);
	});

	it("takes the latest answer when allowChange is on", async () => {
		await seedUser("U-change", "可改老師");
		let pushed: { messages: Array<Record<string, unknown>> } | null = null;
		mockLine("POST", "/v2/bot/message/push", async (req) => {
			pushed = (await req.json()) as typeof pushed;
			return Response.json({});
		});
		const res = await SELF.fetch("https://console.test/api/conversations/line%3AU-change/send", {
			method: "POST",
			headers: { ...AUTH, "Content-Type": "application/json" },
			body: JSON.stringify({
				allowChange: true,
				messages: [
					{
						type: "template",
						altText: "Q",
						template: {
							type: "confirm",
							text: "Q",
							actions: [
								{ type: "postback", label: "是", data: "yes" },
								{ type: "postback", label: "否", data: "no" },
							],
						},
					},
				],
			}),
		});
		const { prompt } = (await res.json()) as { prompt: Prompt };
		expect(prompt.allowChange).toBe(true);
		const actions = (pushed!.messages[0].template as { actions: Array<{ data: string }> }).actions;
		for (const [i, data] of [actions[0].data, actions[1].data].entries()) {
			mockLine("POST", "/v2/bot/message/reply", ok());
			await postWebhook([
				{
					type: "postback",
					timestamp: Date.now() + i,
					source: { type: "user", userId: "U-change" },
					replyToken: `rt-c${i}`,
					webhookEventId: `evt-change-${i}`,
					postback: { data },
				},
			]);
		}
		const list = await SELF.fetch("https://console.test/api/prompts?conversationId=line%3AU-change", { headers: AUTH });
		const { prompts } = (await list.json()) as { prompts: Prompt[] };
		expect(prompts.find((p) => p.id === prompt.id)).toMatchObject({ choice: "no", choiceLabel: "否" });
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

	it("rejects postback data that exceeds LINE's limit after tracking is added, without pushing", async () => {
		await seedUser("U-long", "長選項");
		// 中文經網址編碼後一字占 9 字元：40 字的選項值改寫後必定超過 300 字元
		const res = await SELF.fetch("https://console.test/api/conversations/line%3AU-long/send", {
			method: "POST",
			headers: { ...AUTH, "Content-Type": "application/json" },
			body: JSON.stringify({
				messages: [
					{
						type: "template",
						altText: "Q",
						template: {
							type: "confirm",
							text: "Q",
							actions: [
								{ type: "postback", label: "是", data: "承".repeat(40) },
								{ type: "postback", label: "否", data: "no" },
							],
						},
					},
				],
			}),
		});
		expect(res.status).toBe(400);
		expect(((await res.json()) as { error: string }).error).toBe("字數超出上限。");
		const stored = await env.DB.prepare("SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ? AND direction = 'outbound'")
			.bind("line:U-long")
			.first<{ n: number }>();
		expect(stored?.n).toBe(0);
	});
});
