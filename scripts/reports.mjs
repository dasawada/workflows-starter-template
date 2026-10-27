#!/usr/bin/env node
/**
 * 每日處理客服回報與系統缺口紀錄（給工程端用，客服台不顯示這些）。
 *
 *   npm run reports                      列出未處理的回報與缺口（含上下文，JSON 可直接讀）
 *   npm run reports -- --all             含已處理
 *   npm run reports -- --kind agent_report
 *   npm run reports -- --resolve <id> "處理說明"
 *
 * 透過 wrangler 直接讀正式 D1（需已 `npx wrangler login`），不經過客服台 API。
 */
import { execFileSync } from "node:child_process";

const args = process.argv.slice(2);
const flag = (name) => {
	const i = args.indexOf(name);
	return i >= 0 ? args[i + 1] : undefined;
};
const has = (name) => args.includes(name);

function d1(sql) {
	const out = execFileSync("npx", ["wrangler", "d1", "execute", "DB", "--remote", "--json", "--command", sql], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "inherit"],
	});
	const parsed = JSON.parse(out);
	return parsed[0]?.results ?? [];
}

const esc = (v) => String(v).replace(/'/g, "''");

if (has("--resolve")) {
	const id = flag("--resolve");
	const note = args[args.indexOf("--resolve") + 2] ?? "已處理";
	if (!id) {
		console.error("用法：npm run reports -- --resolve <id> \"處理說明\"");
		process.exit(1);
	}
	d1(`UPDATE integrity_events SET status = 'resolved', resolved_at = ${Date.now()}, resolution = '${esc(note)}' WHERE id = '${esc(id)}' AND status = 'open'`);
	console.log(`已結案 ${id}：${note}`);
	process.exit(0);
}

const where = [has("--all") ? "1 = 1" : "e.status = 'open'"];
const kind = flag("--kind");
if (kind) where.push(`e.kind = '${esc(kind)}'`);

const rows = d1(
	`SELECT e.*, c.display_name FROM integrity_events e LEFT JOIN conversations c ON c.id = e.conversation_id
	 WHERE ${where.join(" AND ")} ORDER BY CASE e.kind WHEN 'agent_report' THEN 0 ELSE 1 END, e.created_at DESC LIMIT 200`,
);

if (rows.length === 0) {
	console.log("沒有待處理的回報或缺口。");
	process.exit(0);
}

const fmt = (ts) => (ts ? new Date(Number(ts)).toLocaleString("zh-TW", { timeZone: "Asia/Taipei", hour12: false }) : "-");
for (const r of rows) {
	let details = null;
	try {
		details = r.details ? JSON.parse(r.details) : null;
	} catch {
		details = r.details;
	}
	console.log("=".repeat(100));
	console.log(`[${r.kind}] ${r.severity} ${r.status}  id=${r.id}`);
	console.log(`${r.title}`);
	console.log(`時間 ${fmt(r.created_at)}  對話 ${r.display_name ?? "-"} (${r.conversation_id ?? "-"})  訊息 ${r.message_id ?? "-"}  回報者 ${r.created_by ?? "-"}  次數 ${details?.count ?? 1}`);
	if (r.resolution) console.log(`處理結果：${r.resolution}（${fmt(r.resolved_at)}）`);
	if (details?.context) {
		console.log("--- 上下文（> 為被回報的那則）");
		for (const m of details.context) {
			const flags = [m.delivery, m.media, m.unsent ? "unsent" : null, m.edited ? "edited" : null, m.quote ? (m.quote.messageId ? "quote:ok" : "quote:MISSING") : null]
				.filter(Boolean)
				.join(",");
			console.log(`${m.target ? ">" : " "} ${m.at}  ${String(m.who).padEnd(10)} ${m.type.padEnd(8)} ${flags.padEnd(22)} ${(m.text ?? "").replace(/\n/g, "⏎").slice(0, 80)}`);
		}
		const { context: _c, message, conversation, ...rest } = details;
		console.log("--- 其他資料");
		console.log(JSON.stringify({ ...rest, message, conversation }, null, 2));
	} else if (details) {
		console.log(JSON.stringify(details, null, 2));
	}
}
console.log("=".repeat(100));
console.log(`共 ${rows.length} 筆。結案：npm run reports -- --resolve <id> "處理說明"`);
