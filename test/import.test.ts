import { describe, it, expect } from "vitest";
import { detectMapping, missingColumns, parseCsv, parseRows, parseTimestamp } from "../worker/import-csv";
import { hashPhoneNumber } from "../worker/line";

describe("parseCsv", () => {
	it("handles BOM, quoted commas, escaped quotes and newlines inside quotes", () => {
		const csv = '﻿日期,發送者,內容\n"2026/10/01 09:30","小美","你好，請問\n有貨嗎？"\n2026/10/01 09:31,商店,"有的 ""現貨"""\n';
		const { delimiter, rows } = parseCsv(csv);
		expect(delimiter).toBe(",");
		expect(rows).toEqual([
			["日期", "發送者", "內容"],
			["2026/10/01 09:30", "小美", "你好，請問\n有貨嗎？"],
			["2026/10/01 09:31", "商店", '有的 "現貨"'],
		]);
	});

	it("detects tab delimited files", () => {
		const { delimiter, rows } = parseCsv("a\tb\n1\t2\n");
		expect(delimiter).toBe("\t");
		expect(rows).toHaveLength(2);
	});
});

describe("detectMapping", () => {
	it("maps Chinese headers", () => {
		const mapping = detectMapping(["聊天室名稱", "日期", "時間", "發送者", "訊息內容", "類型"]);
		expect(mapping).toEqual({ chat: 0, date: 1, time: 2, sender: 3, text: 4, type: 5 });
		expect(missingColumns(mapping)).toEqual([]);
	});

	it("maps English headers with a single timestamp column", () => {
		const mapping = detectMapping(["Timestamp", "User name", "Sender", "Message"]);
		expect(mapping).toEqual({ timestamp: 0, chat: 1, sender: 2, text: 3 });
	});

	it("treats a lone 時間 column as the timestamp", () => {
		const mapping = detectMapping(["時間", "名稱", "訊息"]);
		expect(mapping.timestamp).toBe(0);
		expect(mapping.time).toBeUndefined();
	});

	it("reports missing columns", () => {
		expect(missingColumns(detectMapping(["foo", "bar"]))).toEqual(["timestamp", "chat", "text"]);
	});
});

describe("parseTimestamp", () => {
	const TPE = 480;
	it("parses common formats as Taipei time by default", () => {
		const expected = Date.UTC(2026, 9, 1, 1, 30); // 09:30 台北 = 01:30 UTC
		expect(parseTimestamp("2026/10/01 09:30", TPE)).toBe(expected);
		expect(parseTimestamp("2026-10-01 09:30:00", TPE)).toBe(expected);
		expect(parseTimestamp("2026年10月1日 上午9:30", TPE)).toBe(expected);
		expect(parseTimestamp("2026/10/1 下午9:30", TPE)).toBe(Date.UTC(2026, 9, 1, 13, 30));
		expect(parseTimestamp("10/01/2026 9:30 AM", TPE)).toBe(expected);
	});

	it("honours explicit timezones and epoch values", () => {
		expect(parseTimestamp("2026-10-01T09:30:00Z", TPE)).toBe(Date.UTC(2026, 9, 1, 9, 30));
		expect(parseTimestamp("2026-10-01T09:30:00+09:00", TPE)).toBe(Date.UTC(2026, 9, 1, 0, 30));
		expect(parseTimestamp("1760000000000", TPE)).toBe(1760000000000);
	});

	it("rejects garbage", () => {
		expect(parseTimestamp("昨天", TPE)).toBeNull();
		expect(parseTimestamp("2026/13/40", TPE)).toBeNull();
	});
});

describe("parseRows", () => {
	it("joins separate date and time columns", () => {
		const rows = parseRows([["小美", "2026/10/01", "09:30", "hi"]], { chat: 0, date: 1, time: 2, text: 3 }, 480);
		expect(rows[0]).toEqual({ chat: "小美", sender: null, text: "hi", type: null, sentAt: Date.UTC(2026, 9, 1, 1, 30) });
	});
});

describe("hashPhoneNumber", () => {
	it("normalises Taiwanese local numbers to E.164 before hashing", async () => {
		const a = await hashPhoneNumber("0912-345-678");
		const b = await hashPhoneNumber("+886 912 345 678");
		const c = await hashPhoneNumber("886912345678");
		expect(a?.e164).toBe("+886912345678");
		expect(a?.hash).toBe(b?.hash);
		expect(a?.hash).toBe(c?.hash);
		expect(a?.masked).toBe("+886****5678");
		expect(a?.hash).toHaveLength(64);
	});

	it("rejects obviously invalid input", async () => {
		expect(await hashPhoneNumber("")).toBeNull();
		expect(await hashPhoneNumber("12")).toBeNull();
	});
});
