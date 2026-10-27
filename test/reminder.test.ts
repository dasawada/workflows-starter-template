import { env, introspectWorkflowInstance } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { getConversation, insertMessage, upsertConversation } from "../worker/db";

async function seedConversation(id: string) {
	const now = Date.now();
	await upsertConversation(env.DB, {
		id,
		channel: "line",
		externalId: id.replace("line:", ""),
		displayName: "Tester",
		now,
	});
	await insertMessage(env.DB, {
		id: crypto.randomUUID(),
		conversationId: id,
		direction: "inbound",
		sender: "user",
		type: "text",
		text: "還在嗎？",
		createdAt: now,
	});
}

describe("ReplyReminderWorkflow", () => {
	it("flags the conversation when no agent reply arrives in time", async () => {
		const conversationId = "line:U-slow";
		await seedConversation(conversationId);

		const instanceId = `reminder-${Date.now()}-timeout`;
		await using instance = await introspectWorkflowInstance(
			env.REPLY_REMINDER,
			instanceId,
		);
		await instance.modify(async (m) => {
			await m.forceEventTimeout({ name: "wait for agent reply" });
		});

		await env.REPLY_REMINDER.create({
			id: instanceId,
			params: { conversationId },
		});
		await instance.waitForStatus("complete");

		const conversation = await getConversation(env.DB, conversationId);
		expect(conversation?.needsAttention).toBe(true);
	});

	it("does nothing when the agent replies in time", async () => {
		const conversationId = "line:U-fast";
		await seedConversation(conversationId);

		const instanceId = `reminder-${Date.now()}-replied`;
		await using instance = await introspectWorkflowInstance(
			env.REPLY_REMINDER,
			instanceId,
		);
		await instance.modify(async (m) => {
			await m.mockEvent({ type: "agent-replied", payload: {} });
		});

		await env.REPLY_REMINDER.create({
			id: instanceId,
			params: { conversationId },
		});
		await instance.waitForStatus("complete");

		const conversation = await getConversation(env.DB, conversationId);
		expect(conversation?.needsAttention).toBe(false);
	});
});
