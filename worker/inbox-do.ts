import { DurableObject } from "cloudflare:workers";
import type { InboxEvent } from "../shared/types";

/**
 * InboxDO：全站只有一個實例（名稱 "inbox"），負責
 * - 接受客服台的 WebSocket 連線（hibernation API，閒置時不計費）
 * - 讓 Worker / Workflow 透過 RPC broadcast() 把事件推給所有在線客服
 */
export class InboxDO extends DurableObject<Env> {
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
		// 前端定期送 ping 維持連線
		if (message === "ping") ws.send("pong");
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
