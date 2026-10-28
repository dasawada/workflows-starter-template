#!/usr/bin/env node
/**
 * 中文文案檢查（規則見 docs/copy-style.md）。
 *
 *   npm run lint:copy            列出違反規則之處，有問題時以非零狀態結束
 *   npm run lint:copy -- --fix   自動修正可機械判斷的規則（空格、半形標點、全形英數）
 *
 * 程式檔以 TypeScript 編譯器抽出字串、JSX 文字與註解，不會誤判程式碼本身；
 * Markdown 略過程式碼區塊與行內程式碼的內容。
 * 單行排除：程式中前一行寫 `copy-lint-disable-next-line`；Markdown 以
 * `<!-- copy-lint-disable -->` 與 `<!-- copy-lint-enable -->` 包住。
 */
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import ts from "typescript";

const FIX = process.argv.includes("--fix");

/** 不檢查的檔案：示範內容與已套用的 migration（不改舊檔） */
const EXCLUDE = [/^src\/presets\.ts$/, /^src\/builder\/presets\.ts$/, /^migrations\//, /^test\//];
const CODE = /\.(ts|tsx|mjs|js)$/;
const LINE_BASED = /\.(md|sh|jsonc|example|html)$/;

const CJK = "\\u3400-\\u4dbf\\u4e00-\\u9fff\\uf900-\\ufaff";
const HAS_CJK = new RegExp(`[${CJK}]`);
const FW_PUNCT = "，。、；：？！「」『』（）《》〈〉";

/**
 * 規則：find 對 text（已遮蔽跳脫字元與程式碼）比對；fix 回傳替換字串（null 表示只報告）。
 * 所有規則都要求周圍有中文，避免誤判純英文與程式碼。
 */
const RULES = [
	{
		id: "space-cjk-ascii",
		message: "中文與英文、數字之間應加空格",
		find: new RegExp(`([${CJK}])([A-Za-z0-9\`])|([A-Za-z0-9\`%])([${CJK}])`, "g"),
		fix: (m) => `${m[0][0]} ${m[0][1]}`,
	},
	{
		id: "halfwidth-punct",
		message: "中文語境應使用全形標點",
		find: new RegExp(`(?<=[${CJK}])[,;:!?]|[,;:!?](?=[${CJK}])|(?<=[${CJK}])\\((?!\\))|\\)(?=[${CJK}])|(?<=[${CJK}])\\.(?=\\s|$)`, "g"),
		fix: (m) => ({ ",": "，", ";": "；", ":": "：", "!": "！", "?": "？", "(": "（", ")": "）", ".": "。" })[m[0]],
	},
	{
		id: "space-around-fullwidth",
		message: "全形標點與其他字元之間不加空格",
		find: new RegExp(`(?<=[^\\s|])[ ]+(?=[${FW_PUNCT}])|(?<=[${FW_PUNCT}])[ ]+(?=[^\\s|\\-])`, "g"),
		fix: () => "",
	},
	{
		id: "fullwidth-alnum",
		message: "數字與英文字母應使用半形",
		find: /[０-９Ａ-Ｚａ-ｚ]/g,
		fix: (m) => String.fromCharCode(m[0].charCodeAt(0) - 0xfee0),
	},
	{
		id: "quotes",
		message: "引號應使用「」或『』",
		find: new RegExp(`[“”‘’]|"[^"\\n]{0,40}[${CJK}][^"\\n]{0,40}"`, "g"),
		fix: null,
	},
	{
		id: "ellipsis",
		message: "刪節號應為「……」；進行中的狀態不加刪節號，列舉未完用「等」",
		find: new RegExp(`(?<=[${CJK}])(\\.{2,}|⋯+)|(?<!…)…(?!…)`, "g"),
		fix: null,
	},
	{
		id: "tilde",
		// copy-lint-disable-next-line
		message: "不用「～」或「~」，範圍以「至」表達",
		find: new RegExp(`～|(?<=[${CJK}0-9])~|~(?=[${CJK}0-9])`, "g"),
		fix: null,
	},
	{
		id: "duplicate-punct",
		message: "不重複使用標點",
		find: /([，。！？、；：])\1/g,
		fix: null,
	},
	{
		id: "exclamation",
		message: "不用驚嘆號",
		find: /！/g,
		fix: null,
	},
	{
		id: "colloquial",
		message: "不用口語",
		find: /搞|看看|塞進|塞入|拿到|拿不到|弄|啦|喔|囉|唷|嗎？吧/g,
		fix: null,
	},
	{
		id: "emoji",
		message: "不用表情符號",
		// 箭頭（↗ 等，U+2190–21FF）是標準符號，不算表情符號
		find: /(?![\u2190-\u21ff])\p{Extended_Pictographic}/gu,
		fix: null,
	},
	{
		id: "terms",
		message: "非台灣用語或非本專案統一用詞（見 docs/copy-style.md 四之 6、7）",
		find: /用戶|默認|設置|信息|數據|網絡|視頻|屏幕|服務器|鏈接|小編|專員|會話|認領/g,
		fix: null,
	},
];

/** 遮蔽字串中的跳脫序列，保留長度以對應原始位置 */
function maskEscapes(raw) {
	return raw.replace(/\\(u\{[0-9a-fA-F]+\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|.)/gs, (m) => "\u0000".repeat(m.length));
}

/** 註解符號（/**、*\/、行首 *、//）換成等長空白，避免被當成相鄰字元 */
function maskCommentSyntax(raw) {
	return raw
		.replace(/^\/\*\*?|\*\/$|^\/\/+/g, (m) => " ".repeat(m.length))
		.replace(/(\n[ \t]*)\*/g, (_, lead) => lead + " ");
}

/** Markdown：行內程式碼內容遮蔽成 x（保留前後的反引號，讓「`code`中文」仍被偵測到） */
function maskInlineCode(line) {
	return line.replace(/`[^`]*`/g, (m) => "`" + "x".repeat(m.length - 2) + "`").replace(/\*\*/g, "\u0000\u0000");
}

const problems = [];

/** 檢查一段文字；offset 是它在檔案中的起點。回傳修正（由後往前套用） */
function checkSegment(file, source, offset, text, kind) {
	if (!HAS_CJK.test(text) && !/[０-９Ａ-Ｚａ-ｚ]|\p{Extended_Pictographic}/u.test(text)) return [];
	const edits = [];
	for (const rule of RULES) {
		for (const m of text.matchAll(rule.find)) {
			// 反引號只在 Markdown 有「行內程式碼」意義；整行比對的檔案（sh、jsonc）裡的雙引號是程式語法
			if (rule.id === "space-cjk-ascii" && kind !== "md" && m[0].includes("`")) continue;
			if (rule.id === "quotes" && kind === "code-raw") continue;
			const pos = offset + m.index;
			const { line, col } = lineCol(source, pos);
			problems.push({ file, line, col, rule: rule.id, message: rule.message, snippet: snippet(source, pos) });
			if (FIX && rule.fix) {
				const replacement = rule.fix(m);
				if (replacement !== undefined && replacement !== null) edits.push({ pos, len: m[0].length, text: replacement });
			}
		}
	}
	return edits;
}

function lineCol(source, pos) {
	let line = 1;
	let last = 0;
	for (let i = 0; i < pos; i++) {
		if (source.charCodeAt(i) === 10) {
			line++;
			last = i + 1;
		}
	}
	return { line, col: pos - last + 1 };
}

function snippet(source, pos) {
	const start = Math.max(0, pos - 12);
	return source.slice(start, pos + 16).replace(/\s+/g, " ");
}

function disabledLines(source, marker) {
	const set = new Set();
	source.split("\n").forEach((l, i) => {
		if (l.includes(marker)) set.add(i + 2);
	});
	return set;
}

function checkCode(file, source) {
	const kind = file.endsWith(".tsx") ? ts.ScriptKind.TSX : file.endsWith(".ts") ? ts.ScriptKind.TS : ts.ScriptKind.JS;
	const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, kind);
	const skip = disabledLines(source, "copy-lint-disable-next-line");
	const segments = [];
	const seenComments = new Set();

	const addComments = (ranges) => {
		for (const r of ranges ?? []) {
			if (seenComments.has(r.pos)) continue;
			seenComments.add(r.pos);
			segments.push({ start: r.pos, text: maskCommentSyntax(source.slice(r.pos, r.end)), kind: "code-raw" });
		}
	};

	const visit = (node) => {
		addComments(ts.getLeadingCommentRanges(source, node.pos));
		addComments(ts.getTrailingCommentRanges(source, node.end));
		if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
			const start = node.getStart(sf) + 1;
			const raw = source.slice(start, node.end - 1);
			segments.push({ start, text: maskEscapes(raw), kind: "code" });
		} else if (ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
			const start = node.getStart(sf) + 1;
			const end = ts.isTemplateTail(node) ? node.end - 1 : node.end - 2;
			segments.push({ start, text: maskEscapes(source.slice(start, end)), kind: "code" });
		} else if (node.kind === ts.SyntaxKind.JsxText) {
			const start = node.getStart(sf);
			segments.push({ start, text: source.slice(start, node.end), kind: "code" });
		}
		ts.forEachChild(node, visit);
	};
	visit(sf);
	addComments(ts.getLeadingCommentRanges(source, sf.endOfFileToken.pos));

	const edits = [];
	for (const seg of segments) {
		const { line } = lineCol(source, seg.start);
		if (skip.has(line)) continue;
		edits.push(...checkSegment(file, source, seg.start, seg.text, seg.kind));
	}
	return edits;
}

function checkLines(file, source) {
	const md = file.endsWith(".md");
	const edits = [];
	let offset = 0;
	let inFence = false;
	let disabled = false;
	for (const line of source.split("\n")) {
		if (md && /^\s*```/.test(line)) inFence = !inFence;
		else if (md && line.includes("<!-- copy-lint-disable -->")) disabled = true;
		else if (md && line.includes("<!-- copy-lint-enable -->")) disabled = false;
		else if (!inFence && !disabled) {
			const text = md ? maskInlineCode(line) : line;
			edits.push(...checkSegment(file, source, offset, text, md ? "md" : "code-raw"));
		}
		offset += line.length + 1;
	}
	return edits;
}

function applyEdits(source, edits) {
	const sorted = [...edits].sort((a, b) => b.pos - a.pos);
	let out = source;
	let lastPos = Infinity;
	for (const e of sorted) {
		if (e.pos + e.len > lastPos) continue; // 重疊的修正留到下一輪
		out = out.slice(0, e.pos) + e.text + out.slice(e.pos + e.len);
		lastPos = e.pos;
	}
	return out;
}

const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], { encoding: "utf8" })
	.split("\n")
	.filter((f) => f && !f.startsWith("node_modules/") && f !== "worker-configuration.d.ts" && f !== "package-lock.json")
	.filter((f) => (CODE.test(f) || LINE_BASED.test(f)) && !EXCLUDE.some((re) => re.test(f)));

let fixedFiles = 0;
for (const file of files) {
	let source;
	try {
		source = readFileSync(file, "utf8");
	} catch {
		continue;
	}
	// 修正可能產生新的相鄰情況，最多重跑三輪
	for (let round = 0; round < (FIX ? 3 : 1); round++) {
		const before = problems.length;
		const edits = CODE.test(file) ? checkCode(file, source) : checkLines(file, source);
		if (!FIX || edits.length === 0) break;
		problems.length = before;
		source = applyEdits(source, edits);
		writeFileSync(file, source);
		if (round === 0) fixedFiles++;
	}
}

if (FIX) {
	// 修正後重新檢查，只列出仍需人工處理的項目
	problems.length = 0;
	for (const file of files) {
		const source = readFileSync(file, "utf8");
		if (CODE.test(file)) checkCode(file, source);
		else checkLines(file, source);
	}
	console.log(`已自動修正 ${fixedFiles} 個檔案。`);
}

for (const p of problems) {
	console.log(`${p.file}:${p.line}:${p.col}  ${p.rule}  ${p.message}  «${p.snippet}»`);
}
if (problems.length > 0) {
	console.log(`\n共 ${problems.length} 個問題。`);
	process.exit(1);
}
console.log("中文文案檢查通過。");
