import { DurableObject } from "cloudflare:workers";
import type { InboxClientMessage, InboxEvent } from "../shared/types";

/** 每條 WebSocket 掛著的狀態（hibernation 期間也保留） */
interface Attachment {
	agent: string | null;
	conversationId: string | null;
}

/**
 * InboxDO：全站只有一個實例（名稱 "inbox"），負責
 * - 接受客服台的 WebSocket 連線（hibernation API，閒置時不計費）
 * - 讓 Worker / Workflow 透過 RPC broadcast() 把事件推給所有在線客服
 * - 在看狀態：客服台送 { type: "view", conversationId, agent }，DO 把「誰正在看哪個對話」廣播給大家，
 *   讓兩位客服同時回同一個人之前就先看到彼此
 */
export class InboxDO extends DurableObject<Env> {
	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		// 前端每 25 秒送 "ping"：交給平台直接回 "pong"，DO 不會因此被喚醒，成本為零
		ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
	}

	async fetch(request: Request): Promise<Response> {
		if (request.headers.get("Upgrade") !== "websocket") {
			return new Response("Expected WebSocket", { status: 426 });
		}
		const pair = new WebSocketPair();
		const [client, server] = Object.values(pair);
		this.ctx.acceptWebSocket(server);
		server.send(
			JSON.stringify({ type: "hello", timestamp: Date.now() } satisfies InboxEvent),
		);
		return new Response(null, { status: 101, webSocket: client });
	}

	async broadcast(event: InboxEvent): Promise<void> {
		const json = JSON.stringify(event);
		for (const socket of this.ctx.getWebSockets()) {
			try {
				socket.send(json);
			} catch {
				// 已斷線的 socket 忽略
			}
		}
	}

	async connectionCount(): Promise<number> {
		return this.ctx.getWebSockets().length;
	}

	async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
		// ping/pong 已由 setWebSocketAutoResponse 處理
		if (typeof message !== "string") return;
		let data: InboxClientMessage;
		try {
			data = JSON.parse(message) as InboxClientMessage;
		} catch {
			return;
		}
		if (data.type !== "view") return;
		const previous = this.attachmentOf(ws);
		const next: Attachment = {
			agent: typeof data.agent === "string" ? data.agent.slice(0, 40) : null,
			conversationId: typeof data.conversationId === "string" ? data.conversationId : null,
		};
		ws.serializeAttachment(next);
		const affected = new Set([previous.conversationId, next.conversationId].filter((id): id is string => !!id));
		for (const id of affected) await this.broadcastPresence(id);
	}

	async webSocketClose(ws: WebSocket, code: number, reason: string) {
		const previous = this.attachmentOf(ws);
		try {
			ws.close(code, reason);
		} catch {
			// ignore
		}
		if (previous.conversationId) await this.broadcastPresence(previous.conversationId, ws);
	}

	private attachmentOf(ws: WebSocket): Attachment {
		try {
			return (ws.deserializeAttachment() as Attachment | null) ?? { agent: null, conversationId: null };
		} catch {
			return { agent: null, conversationId: null };
		}
	}

	/** 正在看某個對話的客服名單 */
	private viewers(conversationId: string, exclude?: WebSocket): string[] {
		const names = new Set<string>();
		for (const socket of this.ctx.getWebSockets()) {
			if (socket === exclude) continue;
			const a = this.attachmentOf(socket);
			if (a.conversationId === conversationId && a.agent) names.add(a.agent);
		}
		return [...names].sort();
	}

	private async broadcastPresence(conversationId: string, exclude?: WebSocket): Promise<void> {
		await this.broadcast({ type: "presence.updated", conversationId, agents: this.viewers(conversationId, exclude) });
	}

	async presence(conversationId: string): Promise<string[]> {
		return this.viewers(conversationId);
	}
}

export function inboxStub(env: Env) {
	return env.INBOX.get(env.INBOX.idFromName("inbox"));
}
