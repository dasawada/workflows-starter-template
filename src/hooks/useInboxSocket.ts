import { useEffect, useRef, useState } from "react";
import type { InboxEvent } from "../../shared/types";
import { getToken } from "../api";

/**
 * 維持與 /ws 的連線，斷線自動重連（指數退避），每 25 秒送 ping。
 */
export function useInboxSocket(
	enabled: boolean,
	onEvent: (event: InboxEvent) => void,
): { connected: boolean } {
	const [connected, setConnected] = useState(false);
	const handlerRef = useRef(onEvent);
	handlerRef.current = onEvent;

	useEffect(() => {
		if (!enabled) return;

		let ws: WebSocket | null = null;
		let closedByUs = false;
		let retry = 0;
		let reconnectTimer: number | undefined;
		let pingTimer: number | undefined;

		const connect = () => {
			const token = getToken() ?? "";
			const protocol = location.protocol === "https:" ? "wss:" : "ws:";
			ws = new WebSocket(
				`${protocol}//${location.host}/ws?token=${encodeURIComponent(token)}`,
			);

			ws.onopen = () => {
				retry = 0;
				setConnected(true);
				pingTimer = window.setInterval(() => {
					if (ws?.readyState === WebSocket.OPEN) ws.send("ping");
				}, 25_000);
			};

			ws.onmessage = (evt) => {
				if (typeof evt.data !== "string" || evt.data === "pong") return;
				try {
					const data = JSON.parse(evt.data) as InboxEvent;
					handlerRef.current(data);
				} catch {
					// ignore
				}
			};

			ws.onclose = () => {
				setConnected(false);
				window.clearInterval(pingTimer);
				if (closedByUs) return;
				const delay = Math.min(30_000, 1000 * 2 ** retry++);
				reconnectTimer = window.setTimeout(connect, delay);
			};

			ws.onerror = () => {
				// onclose 會接手
			};
		};

		connect();

		return () => {
			closedByUs = true;
			window.clearTimeout(reconnectTimer);
			window.clearInterval(pingTimer);
			ws?.close();
		};
	}, [enabled]);

	return { connected };
}
