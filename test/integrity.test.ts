import { SELF, env, introspectWorkflow, createMessageBatch, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { afterAll, afterEach, beforeAll, describe, it, expect, vi } from "vitest";
import worker from "../worker/index";
import { signLineBody } from "../worker/line";
import type { LineEventJob } from "../worker/webhook-line";
import type {
	Conversation,
	ImportBatch,
	ImportPreview,
	ImportRowGroup,
	IntegrityEvent,
	IntegrityHealth,
	Message,
	Notification,
	SendConflict,
} from "../shared/types";

type Handler = (req: Request) => Response | Promise<Response>;
const routes = new Map<string, { handler: Handler; remaining: number }>();
const realFetch = globalThis.fetch;

function mockLine(method: string, path: string, handler: Handler, times = 1) {
	routes.set(`${method} ${path}`, { handler, remaining: times });
}
const lineJson = (data: unknown, status = 200, headers: Record<string, string> = {}) => () =>
	Response.json(data, { status, headers });

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

const AUTH = { Authorization: `Bearer ${env.CONSOLE_TOKEN}` };
const JSON_AUTH = { ...AUTH, "Content-Type": "application/json" };
const asAgent = (name: string) => ({ ...JSON_AUTH, "X-Agent-Name": encodeURIComponent(name) });

async function postWebhook(events: unknown[]) {
	const body = JSON.stringify({ destination: "Ubot", events });
	return SELF.fetch("https://console.test/webhook/line", {
		method: "POST",
		headers: { "Content-Type": "application/json", "x-line-signature": await signLineBody(env.LINE_CHANNEL_SECRET, body) },
		body,
	});
}

function textEvent(userId: string, text: string, id: string, timestamp = Date.now()) {
	return { type: "message", timestamp, source: { type: "user", userId }, replyToken: "rt", message: { id, type: "text", text } };
}

async function seedUser(userId: string, name: string, text = "hi") {
	mockLine("GET", `/v2/bot/profile/${userId}`, lineJson({ displayName: name }));
	await postWebhook([textEvent(userId, text, `m-${userId}-seed`)]);
}

async function messagesOf(id: string): Promise<Message[]> {
	const res = await SELF.fetch(`https://console.test/api/conversations/${encodeURIComponent(id)}/messages`, { headers: AUTH });
	return ((await res.json()) as { messages: Message[] }).messages;
}

async function openEvents(kind?: string): Promise<IntegrityEvent[]> {
	const res = await SELF.fetch(`https://console.test/api/integrity/events?status=open${kind ? `&kind=${kind}` : ""}`, { headers: AUTH });
	return ((await res.json()) as { events: IntegrityEvent[] }).events;
}

const reply = (id: string, body: Record<string, unknown>, headers: Record<string, string> = JSON_AUTH) =>
	SELF.fetch(`https://console.test/api/conversations/${encodeURIComponent(id)}/reply`, { method: "POST", headers, body: JSON.stringify(body) });

const BOT_INFO = { userId: "Ubot", basicId: "@shop", displayName: "商店", chatMode: "chat", markAsReadMode: "manual" };
const maintenance = () => {
	mockLine("GET", "/v2/bot/info", lineJson(BOT_INFO));
	return SELF.fetch("https://console.test/api/integrity/maintenance", { method: "POST", headers: AUTH });
};

describe("outbox: retry key and delivery status", () => {
	it("sends once for the same clientKey and records the retry key header", async () => {
		await seedUser("U-ob1", "Outbox");
		const seen: string[] = [];
		mockLine("POST", "/v2/bot/message/push", (req) => {
			seen.push(req.headers.get("X-Line-Retry-Key") ?? "");
			return Response.json({ sentMessages: [{ id: "L-out-1", quoteToken: "qt-out-1" }] }, { headers: { "x-line-request-id": "req-1" } });
		});
		const key = "11111111-2222-4333-8444-555555555555";
		const first = await reply("line:U-ob1", { text: "第一次", clientKey: key });
		const second = await reply("line:U-ob1", { text: "第一次", clientKey: key });
		expect(first.status).toBe(200);
		expect(second.status).toBe(200);
		const a = (await first.json()) as { message: Message; reused: boolean };
		const b = (await second.json()) as { message: Message; reused: boolean };
		expect(seen).toEqual([key]);
		expect(a.message.deliveryStatus).toBe("sent");
		expect(a.message.metadata?.lineRequestId).toBe("req-1");
		expect(a.message.externalId).toBe("L-out-1");
		expect(a.message.metadata).toMatchObject({ lineMessageIds: ["L-out-1"], quoteToken: "qt-out-1" });
		expect(b.reused).toBe(true);
		expect(b.message.id).toBe(a.message.id);
		expect((await messagesOf("line:U-ob1")).filter((m) => m.sender === "agent")).toHaveLength(1);
	});

	it("keeps the message pending on a transient LINE error and confirms it via 409 on maintenance", async () => {
		await seedUser("U-ob2", "Pending");
		mockLine("POST", "/v2/bot/message/push", lineJson({ message: "boom" }, 500));
		const res = await reply("line:U-ob2", { text: "會卡住" });
		expect(res.status).toBe(200);
		const { message, status } = (await res.json()) as { message: Message; status: string };
		expect(status).toBe("pending");
		expect(message.deliveryStatus).toBe("pending");

		// 讓它看起來已經超過 1 分鐘
		await env.DB.prepare("UPDATE messages SET created_at = created_at - 120000 WHERE id = ?").bind(message.id).run();
		let retryKey: string | null = null;
		mockLine("POST", "/v2/bot/message/push", (req) => {
			retryKey = req.headers.get("X-Line-Retry-Key");
			return Response.json({ message: "already accepted" }, { status: 409 });
		});
		const m = await maintenance();
		expect(((await m.json()) as { outbound: number }).outbound).toBe(1);
		expect(retryKey).toMatch(/^[0-9a-f-]{36}$/);
		const stored = (await messagesOf("line:U-ob2")).find((x) => x.id === message.id)!;
		expect(stored.deliveryStatus).toBe("sent");
	});

	it("marks a hard LINE rejection as failed, records a gap, and resolves it after a successful retry", async () => {
		await seedUser("U-ob3", "Failed");
		mockLine("POST", "/v2/bot/message/push", lineJson({ message: "invalid" }, 400));
		const res = await reply("line:U-ob3", { text: "被拒絕" });
		expect(res.status).toBe(502);
		const { message, error } = (await res.json()) as { message: Message; error: string };
		expect(message.deliveryStatus).toBe("failed");
		expect(error).toContain("400");
		const events = await openEvents("send_failed");
		expect(events.some((e) => e.messageId === message.id)).toBe(true);

		mockLine("POST", "/v2/bot/message/push", lineJson({}));
		const retry = await SELF.fetch(`https://console.test/api/messages/${message.id}/retry`, { method: "POST", headers: AUTH });
		expect(retry.status).toBe(200);
		expect(((await retry.json()) as { message: Message }).message.deliveryStatus).toBe("sent");
		expect((await openEvents("send_failed")).some((e) => e.messageId === message.id)).toBe(false);
	});

	it("flags messages older than 24h still pending as unknown", async () => {
		await seedUser("U-ob4", "Unknown");
		mockLine("POST", "/v2/bot/message/push", lineJson({}, 503));
		const { message } = (await (await reply("line:U-ob4", { text: "永遠不確定" })).json()) as { message: Message };
		await env.DB.prepare("UPDATE messages SET created_at = created_at - 90000000 WHERE id = ?").bind(message.id).run();
		await maintenance();
		expect((await messagesOf("line:U-ob4")).find((x) => x.id === message.id)!.deliveryStatus).toBe("unknown");
		expect((await openEvents("send_unknown")).some((e) => e.messageId === message.id)).toBe(true);
	});
});

describe("quoting console-sent messages", () => {
	it("resolves a quote of an agent reply, including the 2nd message of a multi-message push", async () => {
		await seedUser("U-quote-agent", "Quoter");
		mockLine("POST", "/v2/bot/message/push", lineJson({ sentMessages: [{ id: "L-a1", quoteToken: "q1" }] }));
		await reply("line:U-quote-agent", { text: "請問要寄到台北還是新竹？" }, asAgent("小美"));
		mockLine("POST", "/v2/bot/message/push", lineJson({ sentMessages: [{ id: "L-b1" }, { id: "L-b2", quoteToken: "q2" }] }));
		await SELF.fetch("https://console.test/api/conversations/line%3AU-quote-agent/send", {
			method: "POST",
			headers: asAgent("小美"),
			body: JSON.stringify({ messages: [{ type: "text", text: "另外" }, { type: "text", text: "運費 60 元" }] }),
		});

		mockLine("GET", "/v2/bot/profile/U-quote-agent", lineJson({ displayName: "Quoter" }), 2);
		await postWebhook([
			{ ...textEvent("U-quote-agent", "新竹", "m-qa-1"), message: { id: "m-qa-1", type: "text", text: "新竹", quotedMessageId: "L-a1" } },
			{ ...textEvent("U-quote-agent", "運費可以免嗎", "m-qa-2"), message: { id: "m-qa-2", type: "text", text: "運費可以免嗎", quotedMessageId: "L-b2" } },
		]);
		const msgs = await messagesOf("line:U-quote-agent");
		const q1 = msgs.find((m) => m.externalId === "m-qa-1")!;
		const q2 = msgs.find((m) => m.externalId === "m-qa-2")!;
		expect(q1.metadata?.quote).toMatchObject({ externalId: "L-a1", text: "請問要寄到台北還是新竹？", sender: "agent" });
		expect((q1.metadata?.quote as { messageId: string }).messageId).toBeTruthy();
		expect(q2.metadata?.quote).toMatchObject({ externalId: "L-b2", sender: "agent" });
		expect((q2.metadata?.quote as { text: string }).text).toContain("運費 60 元");
		expect((await openEvents("quote_missing")).some((e) => e.conversationId === "line:U-quote-agent")).toBe(false);
	});
});

describe("quoting the user's message from the console", () => {
	it("sends quoteToken to LINE and keeps a quote snapshot on the outbound message", async () => {
		mockLine("GET", "/v2/bot/profile/U-q2", lineJson({ displayName: "Quoted" }));
		await postWebhook([{ ...textEvent("U-q2", "要寄到新竹", "m-q2-1"), message: { id: "m-q2-1", type: "text", text: "要寄到新竹", quoteToken: "qt-user-1" } }]);
		const [userMsg] = await messagesOf("line:U-q2");

		let pushed: { messages: { type: string; text: string; quoteToken?: string }[] } | null = null;
		mockLine("POST", "/v2/bot/message/push", async (req) => {
			pushed = (await req.json()) as typeof pushed;
			return Response.json({ sentMessages: [{ id: "L-q2", quoteToken: "qt-out" }] });
		});
		const res = await reply("line:U-q2", { text: "收到，新竹", quoteMessageId: userMsg.id }, asAgent("小美"));
		expect(res.status).toBe(200);
		expect(pushed!.messages[0]).toEqual({ type: "text", text: "收到，新竹", quoteToken: "qt-user-1" });
		const { message } = (await res.json()) as { message: Message };
		expect(message.metadata?.quote).toMatchObject({ messageId: userMsg.id, text: "要寄到新竹", sender: "user" });

		// 沒有 quoteToken 的訊息（例如舊資料）不能引用，要講清楚
		const bad = await reply("line:U-q2", { text: "x", quoteMessageId: message.id.replace(/./, "0") }, asAgent("小美"));
		expect(bad.status).toBe(400);
	});
});

describe("multi-agent: assignment, presence and conflicts", () => {
	it("blocks another agent while assigned, unless forced, and logs the hand-over", async () => {
		await seedUser("U-ma1", "Shared");
		const assign = await SELF.fetch("https://console.test/api/conversations/line%3AU-ma1/assign", {
			method: "POST",
			headers: asAgent("小美"),
			body: "{}",
		});
		expect(((await assign.json()) as { conversation: Conversation }).conversation.assignedTo).toBe("小美");

		const blocked = await reply("line:U-ma1", { text: "我也想回" }, asAgent("阿強"));
		expect(blocked.status).toBe(409);
		expect((await blocked.json()) as SendConflict).toMatchObject({ code: "assigned", assignedTo: "小美" });

		mockLine("POST", "/v2/bot/message/push", lineJson({}));
		const forced = await reply("line:U-ma1", { text: "我也想回", force: true }, asAgent("阿強"));
		expect(forced.status).toBe(200);
		expect(((await forced.json()) as { message: Message }).message.agentName).toBe("阿強");

		const takeover = await SELF.fetch("https://console.test/api/conversations/line%3AU-ma1/assign", {
			method: "POST",
			headers: asAgent("阿強"),
			body: "{}",
		});
		expect(((await takeover.json()) as { conversation: Conversation }).conversation.assignedTo).toBe("阿強");
		const texts = (await messagesOf("line:U-ma1")).filter((m) => m.sender === "system").map((m) => m.text);
		expect(texts).toEqual(["小美 已接手此對話", "阿強 已接手此對話（原負責人：小美）"]);
	});

	it("returns 409 when another agent replied after what the sender last saw", async () => {
		await seedUser("U-ma2", "Race");
		const [seed] = await messagesOf("line:U-ma2");
		mockLine("POST", "/v2/bot/message/push", lineJson({}), 2);
		await reply("line:U-ma2", { text: "小美先回了" }, asAgent("小美"));
		const late = await reply("line:U-ma2", { text: "阿強也回", lastSeenMessageId: seed.id }, asAgent("阿強"));
		expect(late.status).toBe(409);
		const conflict = (await late.json()) as SendConflict;
		expect(conflict.code).toBe("newer_reply");
		expect(conflict.messages?.[0]).toMatchObject({ text: "小美先回了", agentName: "小美" });
		// 同一位客服自己的回覆不算衝突
		const own = await reply("line:U-ma2", { text: "小美再補一句", lastSeenMessageId: seed.id }, asAgent("小美"));
		expect(own.status).toBe(200);
	});

	it("tracks who is viewing a conversation over the socket", async () => {
		const stub = env.INBOX.get(env.INBOX.idFromName("inbox"));
		const res = await stub.fetch("https://inbox/ws", { headers: { Upgrade: "websocket" } });
		const ws = res.webSocket!;
		ws.accept();
		ws.send(JSON.stringify({ type: "view", conversationId: "line:U-view", agent: "小美" }));
		await new Promise((r) => setTimeout(r, 20));
		expect(await stub.presence("line:U-view")).toEqual(["小美"]);
		ws.send(JSON.stringify({ type: "view", conversationId: null, agent: "小美" }));
		await new Promise((r) => setTimeout(r, 20));
		expect(await stub.presence("line:U-view")).toEqual([]);
		ws.close();
	});
});

describe("media retention", () => {
	const imageEvent = (userId: string, id: string) => ({
		type: "message",
		timestamp: Date.now(),
		source: { type: "user", userId },
		replyToken: "rt",
		message: { id, type: "image", contentProvider: { type: "line" } },
	});

	it("marks expired attachments and records a gap", async () => {
		mockLine("GET", "/v2/bot/profile/U-media1", lineJson({ displayName: "Media" }));
		mockLine("GET", "/v2/bot/message/m-gone/content", lineJson({}, 410));
		await postWebhook([imageEvent("U-media1", "m-gone")]);
		await new Promise((r) => setTimeout(r, 50));
		const [msg] = await messagesOf("line:U-media1");
		expect(msg.mediaStatus).toBe("expired");
		expect((await openEvents("media_expired")).some((e) => e.messageId === msg.id)).toBe(true);
	});

	it("retries failed downloads on maintenance and stores the file", async () => {
		mockLine("GET", "/v2/bot/profile/U-media2", lineJson({ displayName: "Retry" }));
		mockLine("GET", "/v2/bot/message/m-flaky/content", lineJson({}, 500));
		await postWebhook([imageEvent("U-media2", "m-flaky")]);
		await new Promise((r) => setTimeout(r, 50));
		let [msg] = await messagesOf("line:U-media2");
		expect(msg.mediaStatus).toBe("failed");
		expect(msg.metadata?.mediaAttempts).toBe(1);

		await env.DB.prepare("UPDATE messages SET created_at = created_at - 300000 WHERE id = ?").bind(msg.id).run();
		mockLine("GET", "/v2/bot/message/m-flaky/content", () => new Response("bytes", { headers: { "content-type": "image/png" } }));
		const m = await maintenance();
		expect(((await m.json()) as { media: number }).media).toBe(1);
		[msg] = await messagesOf("line:U-media2");
		expect(msg.mediaStatus).toBe("stored");
		expect(msg.mediaKey).toBe("line/m-flaky");
	});
});

describe("integrity center", () => {
	it("reports health, aggregates redeliveries per hour, takes agent reports and resolves events", async () => {
		mockLine("GET", "/v2/bot/profile/U-health", lineJson({ displayName: "Health" }));
		const ts = Date.now();
		await postWebhook([
			{ ...textEvent("U-health", "一", "m-h1", ts), deliveryContext: { isRedelivery: true }, webhookEventId: "e1" },
			{ ...textEvent("U-health", "二", "m-h2", ts + 1), deliveryContext: { isRedelivery: true }, webhookEventId: "e2" },
		]);
		await new Promise((r) => setTimeout(r, 30));
		const health = (await (await SELF.fetch("https://console.test/api/integrity/health", { headers: AUTH })).json()) as IntegrityHealth;
		expect(health.webhookMode).toBe("inline");
		expect(health.lastWebhookAt).toBeGreaterThan(0);
		expect(health.lastRedeliveryAt).toBeGreaterThan(0);
		expect(health.openByKind.webhook_redelivery).toBe(1);
		const [redelivery] = await openEvents("webhook_redelivery");
		expect(redelivery.details?.count).toBe(2);

		const [first] = await messagesOf("line:U-health");
		const report = await SELF.fetch(`https://console.test/api/messages/${first.id}/report`, {
			method: "POST",
			headers: asAgent("小美"),
			body: JSON.stringify({ note: "客人說早上有傳圖片，這裡沒有" }),
		});
		expect(report.status).toBe(200);
		expect(((await report.json()) as { message: Message }).message.metadata?.reportedAt).toBeTypeOf("number");
		// 再戳一次：同一筆事件計數 +1，不會多一筆
		await SELF.fetch(`https://console.test/api/messages/${first.id}/report`, { method: "POST", headers: asAgent("小美"), body: "{}" });
		const reports = (await openEvents("agent_report")).filter((e) => e.messageId === first.id);
		expect(reports).toHaveLength(1);
		const mine = reports[0];
		expect(mine).toMatchObject({ createdBy: "小美", conversationId: "line:U-health", status: "open" });
		expect(mine.details?.count).toBe(2);
		const context = mine.details?.context as { target: boolean; text: string | null }[];
		expect(context.some((c) => c.target && c.text === "一")).toBe(true);
		expect(context.map((c) => c.text)).toEqual(["一", "二"]);

		const resolve = await SELF.fetch(`https://console.test/api/integrity/events/${mine.id}/resolve`, {
			method: "POST",
			headers: asAgent("阿強"),
			body: JSON.stringify({ resolution: "已請客人重傳" }),
		});
		const resolved = ((await resolve.json()) as { event: IntegrityEvent }).event;
		expect(resolved.status).toBe("resolved");
		expect(resolved.resolution).toContain("已請客人重傳");
		expect(resolved.resolution).toContain("阿強");
	});

	it("records dead-lettered events with the raw payload instead of dropping them", async () => {
		const event = textEvent("U-dead", "lost", "m-dead");
		const batch = createMessageBatch<LineEventJob>("cs-console-line-events-dlq", [
			{ id: "d1", timestamp: new Date(), body: { event: { ...event, webhookEventId: "evt-dead" }, receivedAt: Date.now() }, attempts: 4 },
		]);
		const ctx = createExecutionContext();
		await worker.queue!(batch, env, ctx);
		await waitOnExecutionContext(ctx);
		const [dead] = await openEvents("event_dead_lettered");
		expect(dead).toMatchObject({ severity: "error", conversationId: "line:U-dead" });
		expect((dead.details?.event as { message: { text: string } }).message.text).toBe("lost");
	});

	it("records when the account's chat mode makes LINE auto-read", async () => {
		mockLine("GET", "/v2/bot/info", lineJson({ userId: "Ubot", basicId: "@shop", displayName: "商店", chatMode: "bot", markAsReadMode: "auto" }));
		await SELF.fetch("https://console.test/api/integrity/maintenance", { method: "POST", headers: AUTH });
		expect((await openEvents("chat_mode")).length).toBe(1);
		mockLine("GET", "/v2/bot/info", lineJson({ userId: "Ubot", basicId: "@shop", displayName: "商店", chatMode: "chat", markAsReadMode: "manual" }));
		await SELF.fetch("https://console.test/api/integrity/maintenance", { method: "POST", headers: AUTH });
		expect((await openEvents("chat_mode")).length).toBe(0);
		const health = (await (await SELF.fetch("https://console.test/api/integrity/health", { headers: AUTH })).json()) as IntegrityHealth;
		expect(health.botInfo?.markAsReadMode).toBe("manual");
	});
});

describe("manager CSV import", () => {
	const CSV = [
		"聊天室名稱,日期,時間,發送者,訊息內容",
		"王小美,2026/09/01,09:00,王小美,請問有貨嗎",
		"王小美,2026/09/01,09:05,商店,有的",
		"王小美,2026/09/01,09:06,王小美,hi", // 與 webhook 已收到的同分鐘同文字 → 重複
		"陌生人,2026/09/02,10:00,陌生人,我是誰",
		"壞列,不是日期,xx,壞列,略過",
	].join("\n");

	it("previews mapping and matches, imports idempotently, and lets agents assign unmatched rows", async () => {
		mockLine("GET", "/v2/bot/profile/U-csv", lineJson({ displayName: "王小美" }));
		await postWebhook([textEvent("U-csv", "hi", "m-csv-seed", Date.UTC(2026, 8, 1, 1, 6, 10))]);

		const preview = (await (
			await SELF.fetch("https://console.test/api/imports/preview", { method: "POST", headers: JSON_AUTH, body: JSON.stringify({ csv: CSV }) })
		).json()) as ImportPreview;
		expect(preview.mapping).toEqual({ chat: 0, date: 1, time: 2, sender: 3, text: 4 });
		expect(preview.missing).toEqual([]);
		expect(preview.invalidRows).toBe(1);
		expect(preview.chats.find((c) => c.name === "王小美")?.conversationId).toBe("line:U-csv");
		expect(preview.chats.find((c) => c.name === "陌生人")?.conversationId).toBeNull();

		const run = async () =>
			(await (
				await SELF.fetch("https://console.test/api/imports", {
					method: "POST",
					headers: asAgent("小美"),
					body: JSON.stringify({ csv: CSV, fileName: "chat.csv", accountName: "商店" }),
				})
			).json()) as { batch: ImportBatch };
		const { batch } = await run();
		expect(batch).toMatchObject({ totalRows: 5, inserted: 2, duplicates: 1, unmatched: 1, skipped: 1, createdBy: "小美" });

		const msgs = await messagesOf("line:U-csv");
		expect(msgs.map((m) => [m.source, m.direction, m.text])).toEqual([
			["manager_csv", "inbound", "請問有貨嗎"],
			["manager_csv", "outbound", "有的"],
			["line_webhook", "inbound", "hi"],
		]);
		expect(msgs[1].deliveryStatus).toBe("sent");

		// 同一份再匯一次：全部重複
		const again = await run();
		expect(again.batch).toMatchObject({ inserted: 0, duplicates: 3, unmatched: 1 });

		const rows = (await (await SELF.fetch(`https://console.test/api/imports/${batch.id}/rows`, { headers: AUTH })).json()) as { groups: ImportRowGroup[] };
		expect(rows.groups).toEqual([expect.objectContaining({ chatName: "陌生人", rows: 1, sample: "我是誰" })]);

		mockLine("GET", "/v2/bot/profile/U-stranger", lineJson({ displayName: "其實是熟人" }));
		await postWebhook([textEvent("U-stranger", "哈囉", "m-stranger")]);
		const assign = await SELF.fetch(`https://console.test/api/imports/${batch.id}/assign`, {
			method: "POST",
			headers: JSON_AUTH,
			body: JSON.stringify({ chatName: "陌生人", conversationId: "line:U-stranger" }),
		});
		expect(assign.status).toBe(200);
		const assigned = (await assign.json()) as { inserted: number; batch: ImportBatch };
		expect(assigned.inserted).toBe(1);
		expect(assigned.batch.unmatched).toBe(0);
		expect((await messagesOf("line:U-stranger")).map((m) => m.text)).toEqual(["我是誰", "哈囉"]);
		expect((await openEvents("import")).some((e) => e.details?.batchId === batch.id)).toBe(false);
	});

	it("refuses to run when a required column cannot be found", async () => {
		const res = await SELF.fetch("https://console.test/api/imports", { method: "POST", headers: JSON_AUTH, body: JSON.stringify({ csv: "a,b\n1,2" }) });
		expect(res.status).toBe(400);
		expect(((await res.json()) as { error: string }).error).toContain("缺少欄位對應");
	});
});

describe("notification messages (PNP)", () => {
	it("logs the send, links the delivery event by tag, and retries failures", async () => {
		let tag: string | null = null;
		let sentBody: { to: string; messages: unknown[] } | null = null;
		mockLine("POST", "/bot/pnp/push", async (req) => {
			tag = req.headers.get("X-Line-Delivery-Tag");
			sentBody = (await req.json()) as typeof sentBody;
			return Response.json({}, { headers: { "x-line-request-id": "pnp-1" } });
		});
		const res = await SELF.fetch("https://console.test/api/notifications", {
			method: "POST",
			headers: asAgent("小美"),
			body: JSON.stringify({ phone: "0912-345-678", messages: [{ type: "text", text: "您的訂單已出貨" }], note: "訂單 #123" }),
		});
		expect(res.status).toBe(200);
		const { notification } = (await res.json()) as { notification: Notification };
		expect(notification).toMatchObject({ status: "sent", phoneMasked: "+886****5678", lineRequestId: "pnp-1", createdBy: "小美" });
		expect(tag).toBe(notification.deliveryTag);
		expect(sentBody!.to).toHaveLength(64);

		await postWebhook([{ type: "delivery", timestamp: Date.now(), source: { type: "user", userId: "U-x" }, delivery: { data: notification.deliveryTag } }]);
		const list = (await (await SELF.fetch("https://console.test/api/notifications", { headers: AUTH })).json()) as { notifications: Notification[] };
		expect(list.notifications.find((n) => n.id === notification.id)?.status).toBe("delivered");

		mockLine("POST", "/bot/pnp/push", lineJson({ message: "not permitted" }, 403));
		const failed = await SELF.fetch("https://console.test/api/notifications", {
			method: "POST",
			headers: JSON_AUTH,
			body: JSON.stringify({ phone: "0987654321", messages: [{ type: "text", text: "x" }] }),
		});
		expect(failed.status).toBe(502);
		const f = ((await failed.json()) as { notification: Notification }).notification;
		expect(f.status).toBe("failed");
		expect(f.error).toContain("403");

		mockLine("POST", "/bot/pnp/push", lineJson({}));
		const retry = await SELF.fetch(`https://console.test/api/notifications/${f.id}/retry`, { method: "POST", headers: AUTH });
		expect(((await retry.json()) as { notification: Notification }).notification.status).toBe("sent");
	});
});
