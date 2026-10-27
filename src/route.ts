/**
 * 以瀏覽器網址保存畫面狀態，讓「上一頁」能回到前一個對話、關閉面板或對話框：
 *   /                                   清單（桌機顯示提示、手機顯示清單）
 *   /conversations/<id>                 對話
 *   /prompts | /imports | /notifications   面板；?c=<id> 保留背後選取的對話
 *   #builder | #json                    互動訊息對話框
 */
export type Panel = null | "prompts" | "imports" | "notifications";
export type ComposeMode = "closed" | "builder" | "json";

export interface Route {
	conversationId: string | null;
	panel: Panel;
	compose: ComposeMode;
}

const PANELS: Exclude<Panel, null>[] = ["prompts", "imports", "notifications"];

export function parseRoute(loc: { pathname: string; search: string; hash: string }): Route {
	const segments = loc.pathname.split("/").filter(Boolean);
	let conversationId: string | null = null;
	let panel: Panel = null;
	if (segments[0] === "conversations" && segments[1]) {
		try {
			conversationId = decodeURIComponent(segments[1]);
		} catch {
			conversationId = null;
		}
	} else if (segments[0] && (PANELS as string[]).includes(segments[0])) {
		panel = segments[0] as Panel;
		conversationId = new URLSearchParams(loc.search).get("c");
	}
	const hash = loc.hash.replace(/^#/, "");
	const compose: ComposeMode = conversationId && (hash === "builder" || hash === "json") ? hash : "closed";
	return { conversationId, panel, compose };
}

export function routePath(route: Route): string {
	let path = "/";
	if (route.panel) {
		path = `/${route.panel}`;
		if (route.conversationId) path += `?c=${encodeURIComponent(route.conversationId)}`;
	} else if (route.conversationId) {
		path = `/conversations/${encodeURIComponent(route.conversationId)}`;
	}
	if (route.compose !== "closed" && route.conversationId) path += `#${route.compose}`;
	return path;
}

export function sameRoute(a: Route, b: Route): boolean {
	return a.conversationId === b.conversationId && a.panel === b.panel && a.compose === b.compose;
}
