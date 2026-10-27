import { DurableObject } from "cloudflare:workers";
import type { InboxEvent } from "../shared/types";

/**
 * InboxDO：全站只有一個實例（名稱 "inbox"），負責
 * - 接受客服台的 WebSocket 連線（hibernation API，閒置時不計費）
 * - 讓 Worker / Workflow 透過 RPC broadcast() 把事件推給所有在線客服
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

	async webSocketMessage(_ws: WebSocket, _message: string | ArrayBuffer) {
		// ping/pong 已由 setWebSocketAutoResponse 處理；目前客服台不會送其他訊息
	}

	async webSocketClose(ws: WebSocket, code: number, reason: string) {
		try {
			ws.close(code, reason);
		} catch {
			// ignore
		}
	}
}

export function inboxStub(env: Env) {
	return env.INBOX.get(env.INBOX.idFromName("inbox"));
}
