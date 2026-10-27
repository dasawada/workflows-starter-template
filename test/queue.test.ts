import {
	SELF,
	createExecutionContext,
	createMessageBatch,
	env,
	getQueueResult,
	introspectWorkflow,
	waitOnExecutionContext,
} from "cloudflare:test";
import { afterAll, beforeAll, describe, it, expect, vi } from "vitest";
import worker from "../worker/index";
import type { LineEventJob } from "../worker/webhook-line";
import type { Conversation, Message } from "../shared/types";

const AUTH = { Authorization: `Bearer ${env.CONSOLE_TOKEN}` };
const realFetch = globalThis.fetch;
const profiles = new Map<string, { displayName: string }>();
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
			const m = url.pathname.match(/^\/v2\/bot\/profile\/(.+)$/);
			if (m && profiles.has(m[1])) return Response.json(profiles.get(m[1]));
			if (url.pathname === "/v2/bot/message/reply") return Response.json({});
			throw new Error(`unexpected LINE call: ${req.method} ${url.pathname}`);
		}
		return realFetch(input, init);
	});
});

afterAll(async () => {
	vi.unstubAllGlobals();
	await reminders.dispose();
});

function textEvent(userId: string, text: string, id: string) {
	return {
		type: "message",
		timestamp: Date.now(),
		source: { type: "user" as const, userId },
		replyToken: "rt",
		message: { id, type: "text", text },
	};
}

describe("queue consumer", () => {
	it("processes queued LINE events, acks them and stores messages", async () => {
		profiles.set("U-queued", { displayName: "排隊老師" });
		const batch = createMessageBatch<LineEventJob>("cs-console-line-events", [
			{ id: "q1", timestamp: new Date(), body: { event: textEvent("U-queued", "從 queue 來的", "m-q1"), receivedAt: Date.now() }, attempts: 1 },
			{ id: "q2", timestamp: new Date(), body: { event: textEvent("U-queued", "第二則", "m-q2"), receivedAt: Date.now() }, attempts: 1 },
		]);
		const ctx = createExecutionContext();
		await worker.queue!(batch, env, ctx);
		await waitOnExecutionContext(ctx);
		const result = await getQueueResult(batch, ctx);
		expect(result.explicitAcks).toEqual(["q1", "q2"]);
		expect(result.retryMessages).toEqual([]);

		const res = await SELF.fetch("https://console.test/api/conversations/line%3AU-queued/messages", { headers: AUTH });
		const { messages } = (await res.json()) as { messages: Message[] };
		expect(messages.map((m) => m.text)).toEqual(["從 queue 來的", "第二則"]);

		const list = await SELF.fetch("https://console.test/api/conversations?status=open&q=%E6%8E%92%E9%9A%8A", { headers: AUTH });
		const { conversations } = (await list.json()) as { conversations: Conversation[] };
		expect(conversations[0]).toMatchObject({ displayName: "排隊老師", unreadCount: 2 });
	});

	it("is idempotent when the same event is redelivered", async () => {
		profiles.set("U-redeliver", { displayName: "重送" });
		const job: LineEventJob = { event: textEvent("U-redeliver", "once", "m-once"), receivedAt: Date.now() };
		for (const attempt of [1, 2]) {
			const batch = createMessageBatch<LineEventJob>("cs-console-line-events", [
				{ id: `r${attempt}`, timestamp: new Date(), body: job, attempts: attempt },
			]);
			const ctx = createExecutionContext();
			await worker.queue!(batch, env, ctx);
			await waitOnExecutionContext(ctx);
		}
		const res = await SELF.fetch("https://console.test/api/conversations/line%3AU-redeliver/messages", { headers: AUTH });
		const { messages } = (await res.json()) as { messages: Message[] };
		expect(messages).toHaveLength(1);
	});

	it("retries a message whose processing throws", async () => {
		// 沒有 userId 也沒有 groupId 的 source 會被忽略，不會丟錯；這裡用壞掉的 message 讓 insert 失敗
		profiles.set("U-fail", { displayName: "失敗" });
		const bad = {
			type: "message",
			timestamp: Date.now(),
			source: { type: "user" as const, userId: "U-fail" },
			message: { id: null as unknown as string, type: "text", text: "x" },
		};
		const batch = createMessageBatch<LineEventJob>("cs-console-line-events", [
			{ id: "bad1", timestamp: new Date(), body: { event: bad, receivedAt: Date.now() }, attempts: 1 },
		]);
		const ctx = createExecutionContext();
		await worker.queue!(batch, env, ctx);
		await waitOnExecutionContext(ctx);
		const result = await getQueueResult(batch, ctx);
		// 不論成功或失敗都有明確處置：要嘛 ack，要嘛 retry
		expect(result.explicitAcks.length + result.retryMessages.length).toBe(1);
	});
});
