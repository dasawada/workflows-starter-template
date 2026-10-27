import { describe, it, expect } from "vitest";
import {
	conversationTarget,
	signLineBody,
	verifyLineSignature,
} from "../worker/line";

describe("verifyLineSignature", () => {
	const secret = "abc123";
	const body = '{"events":[]}';

	it("accepts a correct HMAC-SHA256 signature", async () => {
		const sig = await signLineBody(secret, body);
		expect(await verifyLineSignature(secret, body, sig)).toBe(true);
	});

	it("rejects a tampered body", async () => {
		const sig = await signLineBody(secret, body);
		expect(await verifyLineSignature(secret, body + " ", sig)).toBe(false);
	});

	it("rejects a missing or wrong signature", async () => {
		expect(await verifyLineSignature(secret, body, null)).toBe(false);
		expect(await verifyLineSignature(secret, body, "nope")).toBe(false);
	});
});

describe("conversationTarget", () => {
	it("maps users, groups and rooms", () => {
		expect(conversationTarget({ type: "user", userId: "U1" })).toEqual({
			conversationId: "line:U1",
			recipientId: "U1",
			kind: "user",
		});
		expect(
			conversationTarget({ type: "group", groupId: "G1", userId: "U1" }),
		).toEqual({ conversationId: "line:group:G1", recipientId: "G1", kind: "group" });
		expect(conversationTarget({ type: "room", roomId: "R1" })).toMatchObject({
			conversationId: "line:room:R1",
		});
	});

	it("returns null when nothing identifies the source", () => {
		expect(conversationTarget({ type: "user" })).toBeNull();
	});
});
