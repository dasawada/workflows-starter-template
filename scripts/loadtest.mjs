#!/usr/bin/env node
/**
 * 對正式環境的 LINE webhook 做壓測：發出 N 則合法簽章的假事件，量測回應時間與入庫完成時間。
 *
 * 用法：
 *   LINE_CHANNEL_SECRET=xxx CONSOLE_TOKEN=yyy node scripts/loadtest.mjs \
 *     --url https://workflows-starter-template.<subdomain>.workers.dev --count 200 --concurrency 20
 *
 * - LINE_CHANNEL_SECRET：只用來算簽章，從環境變數讀，不寫入任何檔案
 * - CONSOLE_TOKEN：選填，有的話會透過 /api/conversations 核對是否全部入庫
 * - 每次執行會產生獨立的 run id，結束時印出清理 SQL
 */
import { createHmac, randomBytes } from "node:crypto";
import { performance } from "node:perf_hooks";

const args = parseArgs(process.argv.slice(2));
const url = (args.url ?? "").replace(/\/$/, "");
const count = Number(args.count ?? 200);
const concurrency = Number(args.concurrency ?? 20);
const secret = process.env.LINE_CHANNEL_SECRET;
const token = process.env.CONSOLE_TOKEN;

if (!url || !secret) {
	console.error("需要 --url 與環境變數 LINE_CHANNEL_SECRET");
	process.exit(1);
}

const run = randomBytes(3).toString("hex");
const userPrefix = `U-loadtest-${run}-`;
console.log(`run=${run} url=${url} count=${count} concurrency=${concurrency}`);

// ---------- 發送 ----------
const latencies = [];
const statuses = new Map();
let nextIndex = 0;
const startAll = performance.now();

async function worker() {
	while (true) {
		const i = nextIndex++;
		if (i >= count) return;
		const body = JSON.stringify({
			destination: "Uloadtest",
			events: [
				{
					type: "message",
					timestamp: Date.now(),
					webhookEventId: `lt-${run}-${i}`,
					deliveryContext: { isRedelivery: false },
					source: { type: "user", userId: `${userPrefix}${String(i).padStart(4, "0")}` },
					replyToken: `rt-${run}-${i}`,
					message: { id: `ltm-${run}-${i}`, type: "text", text: `壓測訊息 ${i}` },
				},
			],
		});
		const signature = createHmac("sha256", secret).update(body).digest("base64");
		const t0 = performance.now();
		let status = 0;
		let placement = "";
		try {
			const res = await fetch(`${url}/webhook/line`, {
				method: "POST",
				headers: { "Content-Type": "application/json", "x-line-signature": signature },
				body,
			});
			status = res.status;
			placement = res.headers.get("cf-placement") ?? "";
			await res.arrayBuffer();
		} catch {
			status = -1;
		}
		latencies.push(performance.now() - t0);
		statuses.set(status, (statuses.get(status) ?? 0) + 1);
		if (placement && !statuses.has(`placement:${placement}`)) statuses.set(`placement:${placement}`, 1);
	}
}

await Promise.all(Array.from({ length: concurrency }, worker));
const sendSeconds = (performance.now() - startAll) / 1000;

latencies.sort((a, b) => a - b);
const pct = (p) => latencies[Math.min(latencies.length - 1, Math.floor((p / 100) * latencies.length))].toFixed(0);
console.log("\n== webhook 回應時間（ms）");
console.log(`p50=${pct(50)} p95=${pct(95)} p99=${pct(99)} max=${latencies[latencies.length - 1].toFixed(0)}`);
console.log(`總耗時 ${sendSeconds.toFixed(1)} 秒，吞吐 ${(count / sendSeconds).toFixed(1)} 則/秒`);
console.log("狀態碼分布：", Object.fromEntries([...statuses].filter(([k]) => typeof k === "number")));
const placementKey = [...statuses.keys()].find((k) => typeof k === "string" && k.startsWith("placement:"));
console.log(
	"cf-placement：",
	placementKey ? placementKey.slice("placement:".length) + "（remote-* 代表 Smart Placement 已生效）" : "（無此標頭，Smart Placement 尚未生效）",
);

// ---------- 核對入庫 ----------
if (token) {
	console.log("\n== 核對入庫（透過 /api/conversations 搜尋）");
	const deadline = Date.now() + 90_000;
	let persisted = 0;
	const t1 = performance.now();
	while (Date.now() < deadline) {
		persisted = await countConversations(userPrefix);
		if (persisted >= count) break;
		await new Promise((r) => setTimeout(r, 1000));
	}
	const drainSeconds = (performance.now() - t1) / 1000;
	if (persisted >= count) {
		console.log(`${persisted}/${count} 筆全部入庫，從送完到入庫完成 ${drainSeconds.toFixed(1)} 秒（queue 模式下這是消費延遲）`);
	} else {
		console.log(`!! 90 秒內只有 ${persisted}/${count} 筆入庫，請到 Queues dashboard 看 backlog 與 dead letter queue`);
	}
} else {
	console.log("\n（未提供 CONSOLE_TOKEN，略過入庫核對）");
}

// ---------- 清理指令 ----------
console.log("\n== 清理這次壓測資料（在專案目錄執行）");
console.log(
	`npx wrangler d1 execute DB --remote --command "DELETE FROM prompt_responses WHERE prompt_id IN (SELECT id FROM prompts WHERE conversation_id LIKE 'line:${userPrefix}%'); DELETE FROM prompts WHERE conversation_id LIKE 'line:${userPrefix}%'; DELETE FROM messages WHERE conversation_id LIKE 'line:${userPrefix}%'; DELETE FROM conversations WHERE id LIKE 'line:${userPrefix}%';"`,
);
console.log("逾時提醒的 Workflow 實例會在 REPLY_SLA_MINUTES 後自行結束，不需處理。");

async function countConversations(prefix) {
	let total = 0;
	let before;
	for (let page = 0; page < 20; page++) {
		const params = new URLSearchParams({ status: "all", q: prefix, limit: "100" });
		if (before) params.set("before", String(before));
		const res = await fetch(`${url}/api/conversations?${params}`, { headers: { Authorization: `Bearer ${token}` } });
		if (!res.ok) throw new Error(`/api/conversations ${res.status}`);
		const { conversations } = await res.json();
		total += conversations.length;
		if (conversations.length < 100) break;
		before = conversations[conversations.length - 1].lastMessageAt;
	}
	return total;
}

function parseArgs(argv) {
	const out = {};
	for (let i = 0; i < argv.length; i++) {
		if (argv[i].startsWith("--")) {
			out[argv[i].slice(2)] = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "true";
		}
	}
	return out;
}
