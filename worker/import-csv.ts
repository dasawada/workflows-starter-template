import type {
	ImportBatch,
	ImportChatMatch,
	ImportColumn,
	ImportMapping,
	ImportPreview,
	ImportReport,
	ImportRunInput,
	MessageDirection,
} from "../shared/types";
import {
	bumpImportBatch,
	createImportBatch,
	findConversationsByName,
	getSystemState,
	insertImportRows,
	insertImportedMessages,
	listMessageKeysInRange,
	listUnmatchedImportRows,
	markImportRows,
	messageDedupeKey,
	type ImportRowInput,
	type ImportedMessageInput,
} from "./db";
import { recordIntegrity, resolveIntegrity, STATE_KEYS } from "./integrity";

/**
 * LINE 官方帳號管理後台的聊天紀錄 CSV 匯入。
 *
 * 官方 CSV 只有文字、沒有 LINE userId，所以：
 * - 欄位用關鍵字自動偵測（中／英／日），偵測不到就要求使用者指定
 * - 以「顯示名稱完全相同且只有一筆」配對對話；同名多筆或沒有的，整批留在 import_rows 等人工指派
 * - 以內容雜湊當 external_id 去重，同一份 CSV 重複匯入不會重複寫入
 * - webhook 已收到的訊息（同一分鐘、同文字）視為重複，不再塞一次
 * - 匯入的訊息 source = manager_csv，前端標示為「匯入紀錄」，可信度與 webhook 事件不同
 */

export const MAX_IMPORT_ROWS = 50_000;

// ---------- CSV 解析（RFC 4180：引號、引號內換行、BOM） ----------

export function parseCsv(input: string, delimiter?: string): { delimiter: string; rows: string[][] } {
	const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
	const delim = delimiter ?? detectDelimiter(text);
	const rows: string[][] = [];
	let row: string[] = [];
	let field = "";
	let quoted = false;
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if (quoted) {
			if (ch === '"') {
				if (text[i + 1] === '"') {
					field += '"';
					i++;
				} else {
					quoted = false;
				}
			} else {
				field += ch;
			}
			continue;
		}
		if (ch === '"') {
			quoted = true;
		} else if (ch === delim) {
			row.push(field);
			field = "";
		} else if (ch === "\n" || ch === "\r") {
			if (ch === "\r" && text[i + 1] === "\n") i++;
			row.push(field);
			field = "";
			if (row.some((c) => c !== "")) rows.push(row);
			row = [];
		} else {
			field += ch;
		}
	}
	row.push(field);
	if (row.some((c) => c !== "")) rows.push(row);
	return { delimiter: delim, rows };
}

function detectDelimiter(text: string): string {
	const head = text.slice(0, 2000);
	const counts: [string, number][] = [",", "\t", ";"].map((d) => [d, (head.match(new RegExp(d === "\t" ? "\t" : `\\${d}`, "g")) ?? []).length]);
	counts.sort((a, b) => b[1] - a[1]);
	return counts[0][1] > 0 ? counts[0][0] : ",";
}

// ---------- 欄位偵測 ----------

const COLUMN_PATTERNS: { column: ImportColumn; re: RegExp }[] = [
	{ column: "timestamp", re: /^(timestamp|datetime|日期時間|日時|送信日時|傳送時間|發送時間|時間戳)$/i },
	{ column: "date", re: /^(date|日期|日付|年月日)$/i },
	{ column: "time", re: /^(time|時間|時刻)$/i },
	{ column: "chat", re: /(聊天室|對話|chat|room|使用者名稱|顧客|好友名稱|customer|user ?name|名稱|トーク|ユーザー名|name)/i },
	{ column: "sender", re: /(發送者|傳送者|發訊者|發言者|sender|from|送信者|發信者|作者)/i },
	{ column: "text", re: /(訊息內容|內容|訊息|message|content|text|body|本文|メッセージ)/i },
	{ column: "type", re: /^(類型|type|種類|訊息類型|メッセージ種別)$/i },
];

export function detectMapping(headers: string[]): ImportMapping {
	const mapping: ImportMapping = {};
	const used = new Set<number>();
	const norm = headers.map((h) => h.trim());
	// 先配精確的（timestamp/date/time/type），再配模糊的（chat/sender/text）
	for (const { column, re } of COLUMN_PATTERNS) {
		if (mapping[column] !== undefined) continue;
		const idx = norm.findIndex((h, i) => !used.has(i) && re.test(h));
		if (idx >= 0) {
			mapping[column] = idx;
			used.add(idx);
		}
	}
	// 「時間」同時符合 timestamp 與 time：若沒有 date 欄，就把它當完整時間戳
	if (mapping.timestamp === undefined && mapping.time !== undefined && mapping.date === undefined) {
		mapping.timestamp = mapping.time;
		delete mapping.time;
	}
	return mapping;
}

export function missingColumns(mapping: ImportMapping): ImportColumn[] {
	const missing: ImportColumn[] = [];
	if (mapping.timestamp === undefined && (mapping.date === undefined || mapping.time === undefined)) missing.push("timestamp");
	if (mapping.chat === undefined) missing.push("chat");
	if (mapping.text === undefined) missing.push("text");
	return missing;
}

// ---------- 時間解析 ----------

const DATE_RE = /(\d{4})[./年-](\d{1,2})[./月-](\d{1,2})日?/;
const US_DATE_RE = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/;
const TIME_RE = /(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(上午|下午|AM|PM)?/i;
const AMPM_PREFIX_RE = /(上午|下午|AM|PM)\s*(\d{1,2}):(\d{2})/i;
const TZ_RE = /(Z|[+-]\d{2}:?\d{2})\s*$/;

/** 解析常見的時間寫法；沒有時區資訊時用 tzOffsetMinutes */
export function parseTimestamp(value: string, tzOffsetMinutes: number): number | null {
	const v = value.trim();
	if (!v) return null;
	if (/^\d{13}$/.test(v)) return Number(v);
	if (/^\d{10}$/.test(v)) return Number(v) * 1000;

	let y: number;
	let mo: number;
	let d: number;
	const dm = v.match(DATE_RE);
	const us = v.match(US_DATE_RE);
	if (dm) {
		[y, mo, d] = [Number(dm[1]), Number(dm[2]), Number(dm[3])];
	} else if (us) {
		[mo, d, y] = [Number(us[1]), Number(us[2]), Number(us[3])];
	} else {
		return null;
	}

	let h = 0;
	let mi = 0;
	let s = 0;
	const rest = v.slice((dm ?? us)!.index! + (dm ?? us)![0].length);
	const prefix = rest.match(AMPM_PREFIX_RE);
	const tm = rest.match(TIME_RE);
	if (prefix) {
		h = Number(prefix[2]);
		mi = Number(prefix[3]);
		h = applyAmPm(h, prefix[1]);
	} else if (tm) {
		h = Number(tm[1]);
		mi = Number(tm[2]);
		s = Number(tm[3] ?? 0);
		if (tm[4]) h = applyAmPm(h, tm[4]);
	}
	if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 59) return null;

	const tz = rest.match(TZ_RE);
	let offset = tzOffsetMinutes;
	if (tz) {
		if (tz[1] === "Z") offset = 0;
		else {
			const sign = tz[1][0] === "-" ? -1 : 1;
			const digits = tz[1].slice(1).replace(":", "");
			offset = sign * (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2)));
		}
	}
	return Date.UTC(y, mo - 1, d, h, mi, s) - offset * 60_000;
}

function applyAmPm(h: number, marker: string): number {
	const pm = /下午|PM/i.test(marker);
	if (pm && h < 12) return h + 12;
	if (!pm && h === 12) return 0;
	return h;
}

// ---------- 列解析 ----------

export interface ParsedRow {
	chat: string | null;
	sender: string | null;
	text: string | null;
	type: string | null;
	sentAt: number | null;
}

export function parseRows(rows: string[][], mapping: ImportMapping, tzOffsetMinutes: number): ParsedRow[] {
	const get = (row: string[], idx: number | undefined) => (idx === undefined ? null : (row[idx] ?? "").trim() || null);
	return rows.map((row) => {
		let ts: string | null = null;
		if (mapping.timestamp !== undefined) ts = get(row, mapping.timestamp);
		else if (mapping.date !== undefined && mapping.time !== undefined) ts = `${get(row, mapping.date) ?? ""} ${get(row, mapping.time) ?? ""}`;
		return {
			chat: get(row, mapping.chat),
			sender: get(row, mapping.sender),
			text: get(row, mapping.text),
			type: get(row, mapping.type),
			sentAt: ts ? parseTimestamp(ts, tzOffsetMinutes) : null,
		};
	});
}

/** 發送者是官方帳號本身 → outbound；其餘 → inbound */
function directionOf(row: ParsedRow, accountName: string | null): MessageDirection {
	const sender = row.sender?.trim() ?? "";
	if (!sender) return "inbound";
	if (accountName && sender === accountName.trim()) return "outbound";
	if (/^(官方帳號|公式アカウント|official account|管理員|admin|bot)$/i.test(sender)) return "outbound";
	// 發送者與聊天室名稱相同 → 是對方
	if (row.chat && sender === row.chat.trim()) return "inbound";
	return "inbound";
}

async function hashRow(conversationKey: string, sentAt: number, direction: string, text: string): Promise<string> {
	const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${conversationKey}|${sentAt}|${direction}|${text}`));
	return `csv:${Array.from(new Uint8Array(buf).slice(0, 16), (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

async function defaultAccountName(env: Env): Promise<string | null> {
	try {
		const state = await getSystemState(env.DB, [STATE_KEYS.botInfo]);
		const raw = state[STATE_KEYS.botInfo]?.value;
		return raw ? ((JSON.parse(raw) as { displayName?: string }).displayName ?? null) : null;
	} catch {
		return null;
	}
}

// ---------- 預覽 ----------

export async function previewImport(env: Env, csv: string, mappingOverride?: ImportMapping, tzOffsetMinutes = 480): Promise<ImportPreview | { error: string }> {
	const { delimiter, rows } = parseCsv(csv);
	if (rows.length < 2) return { error: "CSV 至少要有標題列與一列資料" };
	if (rows.length - 1 > MAX_IMPORT_ROWS) return { error: `一次最多匯入 ${MAX_IMPORT_ROWS} 列，請分割檔案` };
	const headers = rows[0];
	const mapping = { ...detectMapping(headers), ...(mappingOverride ?? {}) };
	const missing = missingColumns(mapping);
	const parsed = missing.length ? [] : parseRows(rows.slice(1), mapping, tzOffsetMinutes);
	const valid = parsed.filter((r) => r.sentAt !== null);
	const chatNames = [...new Set(valid.map((r) => r.chat ?? ""))];
	const matches = chatNames.length ? await findConversationsByName(env.DB, chatNames.filter(Boolean)) : new Map();
	const chats: ImportChatMatch[] = chatNames.map((name) => {
		const candidates = matches.get(name) ?? [];
		return {
			name,
			rows: valid.filter((r) => (r.chat ?? "") === name).length,
			conversationId: candidates.length === 1 ? candidates[0].id : null,
			candidates,
		};
	});
	const times = valid.map((r) => r.sentAt!);
	return {
		delimiter,
		headers,
		mapping,
		missing,
		totalRows: rows.length - 1,
		sample: parsed.slice(0, 5).map((r) => ({ chat: r.chat, sender: r.sender, text: r.text, sentAt: r.sentAt })),
		rangeStart: times.length ? Math.min(...times) : null,
		rangeEnd: times.length ? Math.max(...times) : null,
		chats: chats.sort((a, b) => b.rows - a.rows),
		accountName: await defaultAccountName(env),
		invalidRows: parsed.length - valid.length,
	};
}

// ---------- 執行 ----------

export async function runImport(env: Env, input: ImportRunInput, createdBy: string | null): Promise<ImportBatch | { error: string }> {
	const tz = input.tzOffsetMinutes ?? 480;
	const { rows } = parseCsv(input.csv);
	if (rows.length < 2) return { error: "CSV 至少要有標題列與一列資料" };
	if (rows.length - 1 > MAX_IMPORT_ROWS) return { error: `一次最多匯入 ${MAX_IMPORT_ROWS} 列，請分割檔案` };
	const mapping = { ...detectMapping(rows[0]), ...(input.mapping ?? {}) };
	const missing = missingColumns(mapping);
	if (missing.length) return { error: `缺少欄位對應：${missing.join("、")}` };

	const accountName = input.accountName?.trim() || (await defaultAccountName(env));
	const parsed = parseRows(rows.slice(1), mapping, tz);
	const valid = parsed.filter((r): r is ParsedRow & { sentAt: number } => r.sentAt !== null && !!(r.text ?? "").trim());
	const invalidRows = parsed.length - valid.length;

	const chatNames = [...new Set(valid.map((r) => r.chat ?? ""))];
	const matches = await findConversationsByName(env.DB, chatNames.filter(Boolean));
	const batchId = crypto.randomUUID();
	const now = Date.now();
	const report: ImportReport = { chats: [], invalidRows };
	let inserted = 0;
	let duplicates = 0;
	let unmatched = 0;
	const pendingRows: ImportRowInput[] = [];

	for (const name of chatNames) {
		const group = valid.filter((r) => (r.chat ?? "") === name);
		const assigned = input.assignments?.[name];
		const candidates = matches.get(name) ?? [];
		const conversationId = assigned ?? (candidates.length === 1 ? candidates[0].id : null);
		if (!conversationId) {
			unmatched += group.length;
			for (const r of group) {
				pendingRows.push({
					id: crypto.randomUUID(),
					batchId,
					chatName: name || null,
					sender: r.sender,
					direction: directionOf(r, accountName),
					text: r.text,
					sentAt: r.sentAt,
					createdAt: now,
				});
			}
			report.chats.push({ name, rows: group.length, conversationId: null, inserted: 0, duplicates: 0 });
			continue;
		}
		const result = await importGroup(env, batchId, conversationId, group, accountName);
		inserted += result.inserted;
		duplicates += result.duplicates;
		report.chats.push({ name, rows: group.length, conversationId, ...result });
	}
	const times = valid.map((r) => r.sentAt);
	const batch = await createImportBatch(env.DB, {
		id: batchId,
		fileName: input.fileName ?? null,
		accountName,
		rangeStart: times.length ? Math.min(...times) : null,
		rangeEnd: times.length ? Math.max(...times) : null,
		totalRows: rows.length - 1,
		inserted,
		duplicates,
		unmatched,
		skipped: invalidRows,
		report,
		createdBy,
		createdAt: now,
	});
	// import_rows 參照 import_batches，所以批次先建
	if (pendingRows.length) await insertImportRows(env.DB, pendingRows);

	await recordIntegrity(env, {
		kind: "import",
		severity: unmatched > 0 ? "warning" : "info",
		dedupeKey: `import:${batchId}`,
		title: unmatched > 0 ? `匯入完成，但有 ${unmatched} 列找不到對應的對話，需人工指派` : `匯入完成：寫入 ${inserted} 則，略過重複 ${duplicates} 則`,
		details: { batchId, fileName: input.fileName ?? null, inserted, duplicates, unmatched, invalidRows },
		startedAt: batch.rangeStart,
		endedAt: batch.rangeEnd,
		createdBy,
	});
	if (unmatched === 0) await resolveIntegrity(env, `import:${batchId}`, "全部配對完成");
	return batch;
}

async function importGroup(
	env: Env,
	batchId: string,
	conversationId: string,
	group: (ParsedRow & { sentAt: number })[],
	accountName: string | null,
): Promise<{ inserted: number; duplicates: number }> {
	const start = Math.min(...group.map((r) => r.sentAt));
	const end = Math.max(...group.map((r) => r.sentAt));
	const existing = await listMessageKeysInRange(env.DB, conversationId, start, end);
	const toInsert: ImportedMessageInput[] = [];
	let duplicates = 0;
	for (const r of group) {
		const text = (r.text ?? "").trim();
		if (existing.has(messageDedupeKey(r.sentAt, text))) {
			duplicates++;
			continue;
		}
		const direction = directionOf(r, accountName);
		toInsert.push({
			id: crypto.randomUUID(),
			conversationId,
			direction,
			text,
			externalId: await hashRow(conversationId, r.sentAt, direction, text),
			createdAt: r.sentAt,
			batchId,
			sender: r.sender,
		});
	}
	const inserted = await insertImportedMessages(env.DB, toInsert);
	return { inserted, duplicates: duplicates + (toInsert.length - inserted) };
}

/** 人工指派：把某個名稱的未配對列寫進指定對話 */
export async function assignImportRows(
	env: Env,
	batchId: string,
	chatName: string,
	conversationId: string,
): Promise<{ inserted: number; duplicates: number } | { error: string }> {
	const rows = await listUnmatchedImportRows(env.DB, batchId, chatName);
	if (!rows.length) return { error: "沒有待指派的列" };
	const group = rows.map((r) => ({ chat: r.chatName, sender: r.sender, text: r.text, type: null, sentAt: r.sentAt }));
	// 方向在存入 import_rows 時已算好，這裡沿用
	const start = Math.min(...rows.map((r) => r.sentAt));
	const end = Math.max(...rows.map((r) => r.sentAt));
	const existing = await listMessageKeysInRange(env.DB, conversationId, start, end);
	const toInsert: ImportedMessageInput[] = [];
	let duplicates = 0;
	for (const [i, r] of rows.entries()) {
		const text = (r.text ?? "").trim();
		if (!text || existing.has(messageDedupeKey(r.sentAt, text))) {
			duplicates++;
			continue;
		}
		toInsert.push({
			id: crypto.randomUUID(),
			conversationId,
			direction: r.direction,
			text,
			externalId: await hashRow(conversationId, r.sentAt, r.direction, text),
			createdAt: r.sentAt,
			batchId,
			sender: group[i].sender,
		});
	}
	const inserted = await insertImportedMessages(env.DB, toInsert);
	duplicates += toInsert.length - inserted;
	await markImportRows(env.DB, batchId, chatName, "assigned", conversationId);
	const batch = await bumpImportBatch(env.DB, batchId, { inserted, duplicates, unmatched: -rows.length, skipped: 0 });
	if (batch && batch.unmatched <= 0) await resolveIntegrity(env, `import:${batchId}`, "全部配對完成");
	return { inserted, duplicates };
}

export async function skipImportRows(env: Env, batchId: string, chatName: string): Promise<number> {
	const changed = await markImportRows(env.DB, batchId, chatName, "skipped", null);
	if (changed) {
		const batch = await bumpImportBatch(env.DB, batchId, { inserted: 0, duplicates: 0, unmatched: -changed, skipped: changed });
		if (batch && batch.unmatched <= 0) await resolveIntegrity(env, `import:${batchId}`, "剩餘未配對列已標記略過");
	}
	return changed;
}
