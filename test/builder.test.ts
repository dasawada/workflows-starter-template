import { describe, it, expect } from "vitest";
import { LIMITS } from "../src/builder/limits";
import { BUILDER_PRESETS } from "../src/builder/presets";
import { countTrackable, toLineMessages, validateDraft } from "../src/builder/toLine";
import { newMessage, postbackAction, type BuilderDraft } from "../src/builder/types";
import { validateLineMessages } from "../worker/line";

describe("builder presets", () => {
	it.each(BUILDER_PRESETS.filter((p) => p.key !== "blank"))("preset %s converts to a valid LINE payload", (preset) => {
		const draft = preset.build();
		const messages = toLineMessages(draft);
		const validated = validateLineMessages(messages);
		expect(validated.ok, JSON.stringify(validated)).toBe(true);
		expect(messages.length).toBeLessThanOrEqual(LIMITS.messagesPerPush);
	});
});

describe("toLineMessages", () => {
	it("truncates over-limit text so the output is always within LINE limits", () => {
		const confirm = newMessage("confirm");
		confirm.text = "很".repeat(1000);
		confirm.actions[0].label = "超級長的按鈕文字一定會被裁掉的喔喔喔喔喔";
		const draft: BuilderDraft = { messages: [confirm], quickReply: [] };
		const [msg] = toLineMessages(draft) as Array<{ template: { text: string; actions: Array<{ label: string }> } }>;
		expect([...msg.template.text].length).toBe(LIMITS.confirm.text);
		expect([...msg.template.actions[0].label].length).toBeLessThanOrEqual(LIMITS.actionLabel);
	});

	it("applies the stricter buttons text limit when a title is present", () => {
		const buttons = newMessage("buttons");
		buttons.title = "標題";
		buttons.text = "字".repeat(200);
		const [msg] = toLineMessages({ messages: [buttons], quickReply: [] }) as Array<{ template: { text: string } }>;
		expect([...msg.template.text].length).toBe(LIMITS.buttons.textWithTitleOrImage);
	});

	it("equalises carousel action counts and attaches quick reply to the last message", () => {
		const carousel = newMessage("carousel");
		carousel.columns[0].text = "A";
		carousel.columns.push({ title: "", text: "B", imageUrl: "", actions: [postbackAction("承接", "a"), postbackAction("拒", "b")] });
		const text = newMessage("text");
		text.text = "hi";
		const draft: BuilderDraft = {
			messages: [carousel, text],
			quickReply: [postbackAction("好", "ok")],
		};
		const out = toLineMessages(draft) as Array<Record<string, unknown>>;
		const columns = (out[0].template as { columns: Array<{ actions: unknown[] }> }).columns;
		expect(columns.every((c) => c.actions.length === 1)).toBe(true);
		expect(out[0].quickReply).toBeUndefined();
		expect((out[1].quickReply as { items: unknown[] }).items).toHaveLength(1);
	});

	it("renders the card as a flex bubble with kv rows and footer buttons", () => {
		const card = newMessage("card");
		card.headerTitle = "排課媒合通知";
		card.rows = [{ label: "首課日", value: "11/3" }];
		card.note = "備註";
		const [msg] = toLineMessages({ messages: [card], quickReply: [] }) as Array<{ type: string; altText: string; contents: Record<string, unknown> }>;
		expect(msg.type).toBe("flex");
		expect(msg.altText).toBe("排課媒合通知");
		expect(msg.contents.header).toBeDefined();
		expect((msg.contents.footer as { contents: unknown[] }).contents).toHaveLength(2);
		expect(countTrackable({ messages: [card], quickReply: [] })).toBe(2);
	});
});

describe("validateDraft", () => {
	it("flags missing required fields and inconsistent carousel columns", () => {
		const carousel = newMessage("carousel");
		carousel.columns[0].text = "";
		carousel.columns.push({ title: "有標題", text: "B", imageUrl: "", actions: [postbackAction("a", "a"), postbackAction("b", "b")] });
		const errors = validateDraft({ messages: [carousel], quickReply: [] });
		const text = errors.map((e) => e.message).join("\n");
		expect(text).toContain("內文必填");
		expect(text).toContain("按鈕數量須一致");
		expect(text).toContain("標題須所有卡片皆提供");
	});

	it("accepts a complete confirm message", () => {
		const confirm = newMessage("confirm");
		confirm.text = "是否承接？";
		expect(validateDraft({ messages: [confirm], quickReply: [] })).toEqual([]);
	});

	it("rejects bad uri and empty postback value", () => {
		const buttons = newMessage("buttons");
		buttons.text = "x";
		buttons.actions = [{ kind: "uri", label: "開", uri: "ftp://x" }, { ...postbackAction("選", "") }];
		const text = validateDraft({ messages: [buttons], quickReply: [] }).map((e) => e.message).join("\n");
		expect(text).toContain("網址需以");
		expect(text).toContain("選項值必填");
	});
});
