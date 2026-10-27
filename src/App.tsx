import { useCallback, useEffect, useRef, useState } from "react";
import type {
	Conversation,
	ConversationStatus,
	InboxEvent,
	Message,
	Prompt,
	PromptStatus,
	SendMessagesInput,
	Stats,
} from "../shared/types";
import { api, ApiError, getToken, setToken } from "./api";
import { getAgentName, setAgentName } from "./agent";
import { parseRoute, routePath, sameRoute, type ComposeMode, type Panel, type Route } from "./route";
import { useInboxSocket } from "./hooks/useInboxSocket";
import { Login } from "./components/Login";
import { ConversationList } from "./components/ConversationList";
import { MessageThread } from "./components/MessageThread";
import { ComposeDialog } from "./components/ComposeDialog";
import { BuilderDialog } from "./components/builder/BuilderDialog";
import { PromptsPanel } from "./components/PromptsPanel";
import { ImportPanel } from "./components/ImportPanel";
import { NotificationsPanel } from "./components/NotificationsPanel";

const PAGE_SIZE = 50;
/** 對話清單每頁筆數與記憶體上限；清單用虛擬捲動，所以上限只影響記憶體不影響效能 */
const LIST_PAGE = 50;
const LIST_CAP = 1000;

type AuthState = "checking" | "anonymous" | "authed";

function App() {
	const [auth, setAuth] = useState<AuthState>(getToken() && getAgentName() ? "checking" : "anonymous");
	const [agentName, setAgent] = useState<string | null>(getAgentName());
	const [loginError, setLoginError] = useState<string | null>(null);
	const [loginBusy, setLoginBusy] = useState(false);

	const [filter, setFilter] = useState<ConversationStatus | "all">("open");
	const [query, setQuery] = useState("");
	const [conversations, setConversations] = useState<Conversation[]>([]);
	const [listLoading, setListLoading] = useState(false);
	const [listHasMore, setListHasMore] = useState(true);
	const [stats, setStats] = useState<Stats | null>(null);
	const conversationsRef = useRef<Conversation[]>([]);
	conversationsRef.current = conversations;
	const listHasMoreRef = useRef(true);
	listHasMoreRef.current = listHasMore;
	const loadingRef = useRef(false);

	// ---------- 路由：選取的對話、面板、對話框都存在網址裡，瀏覽器上一頁才有作用 ----------
	const [route, setRoute] = useState<Route>(() => parseRoute(window.location));
	const routeRef = useRef(route);
	routeRef.current = route;
	useEffect(() => {
		const onPop = () => setRoute(parseRoute(window.location));
		window.addEventListener("popstate", onPop);
		return () => window.removeEventListener("popstate", onPop);
	}, []);
	const navigate = useCallback((update: Partial<Route> | ((prev: Route) => Route), replace = false) => {
		const prev = routeRef.current;
		const next = typeof update === "function" ? update(prev) : { ...prev, ...update };
		if (sameRoute(prev, next)) return;
		const path = routePath(next);
		if (path !== window.location.pathname + window.location.search + window.location.hash) {
			window.history[replace ? "replaceState" : "pushState"](null, "", path);
		}
		routeRef.current = next;
		setRoute(next);
	}, []);
	const selectedId = route.conversationId;
	const panel = route.panel;
	const composeMode = route.compose;
	const setPanel = useCallback((p: Panel) => navigate({ panel: p, compose: "closed" }), [navigate]);
	const setComposeMode = useCallback((m: ComposeMode) => navigate({ compose: m }), [navigate]);
	/** 選中的對話獨立保存，即使它被捲出清單或不符合目前篩選也不會消失 */
	const [selected, setSelected] = useState<Conversation | null>(null);
	const [messages, setMessages] = useState<Message[]>([]);
	const [messagesLoading, setMessagesLoading] = useState(false);
	const [hasMore, setHasMore] = useState(false);

	const [jsonSeed, setJsonSeed] = useState<unknown[] | undefined>(undefined);
	const promptsPanelOpen = panel === "prompts";
	const setPromptsPanelOpen = (open: boolean) => setPanel(open ? "prompts" : null);
	/** 通知更新時遞增，讓面板重抓 */
	const [notificationKey, setNotificationKey] = useState(0);
	/** 目前對話的在看客服 */
	const [viewers, setViewers] = useState<string[]>([]);
	const [prompts, setPrompts] = useState<Prompt[]>([]);
	const [promptsLoading, setPromptsLoading] = useState(false);
	const [promptsFilter, setPromptsFilter] = useState<PromptStatus | "all">("all");

	// ---------- 驗證 ----------
	useEffect(() => {
		if (auth !== "checking") return;
		api
			.me()
			.then(() => setAuth("authed"))
			.catch(() => {
				setToken(null);
				setAuth("anonymous");
			});
	}, [auth]);

	const handleLogin = async (token: string, name: string) => {
		setLoginBusy(true);
		setLoginError(null);
		setToken(token);
		setAgentName(name);
		setAgent(name);
		try {
			await api.me();
			setAuth("authed");
		} catch (err) {
			setToken(null);
			setLoginError(
				err instanceof ApiError && err.status === 401 ? "密鑰不正確" : "無法連線至伺服器",
			);
		} finally {
			setLoginBusy(false);
		}
	};

	const handleLogout = useCallback(() => {
		setToken(null);
		setAuth("anonymous");
		setConversations([]);
		navigate({ conversationId: null, panel: null, compose: "closed" }, true);
		setSelected(null);
		setMessages([]);
	}, [navigate]);

	// ---------- 對話清單（游標分頁） ----------
	const loadConversations = useCallback(
		async (reset: boolean) => {
			if (loadingRef.current) return;
			if (!reset && !listHasMoreRef.current) return;
			loadingRef.current = true;
			setListLoading(true);
			try {
				const current = reset ? [] : conversationsRef.current;
				const before = current.length ? (current[current.length - 1].lastMessageAt ?? undefined) : undefined;
				const { conversations: page } = await api.listConversations({
					status: filter,
					q: query || undefined,
					before,
					limit: LIST_PAGE,
				});
				setConversations((prev) => {
					const base = reset ? [] : prev;
					const seen = new Set(base.map((c) => c.id));
					const merged = [...base, ...page.filter((c) => !seen.has(c.id))];
					return merged.length > LIST_CAP ? merged.slice(0, LIST_CAP) : merged;
				});
				setListHasMore(page.length >= LIST_PAGE);
			} catch (err) {
				if (err instanceof ApiError && err.status === 401) handleLogout();
			} finally {
				loadingRef.current = false;
				setListLoading(false);
			}
		},
		[filter, query, handleLogout],
	);

	useEffect(() => {
		if (auth === "authed") void loadConversations(true);
	}, [auth, loadConversations]);

	// 直接以網址開啟（重新整理、書籤、上一頁）時，選取的對話可能不在清單裡，補抓一次
	useEffect(() => {
		if (auth !== "authed" || !selectedId) return;
		if (selected?.id === selectedId) return;
		const known = conversationsRef.current.find((c) => c.id === selectedId);
		if (known) {
			setSelected(known);
			return;
		}
		const externalId = selectedId.split(":").pop() ?? selectedId;
		api
			.listConversations({ status: "all", q: externalId, limit: 5 })
			.then(({ conversations }) => {
				const found = conversations.find((c) => c.id === selectedId);
				if (found) setSelected((prev) => (prev?.id === selectedId ? prev : found));
			})
			.catch(() => {});
	}, [auth, selectedId, selected?.id, conversations]);

	const refreshStats = useCallback(() => {
		api.stats().then(setStats).catch(() => {});
	}, []);

	// 事件很多時統計只每秒更新一次
	const statsTimer = useRef<number | undefined>(undefined);
	const scheduleStats = useCallback(() => {
		if (statsTimer.current) return;
		statsTimer.current = window.setTimeout(() => {
			statsTimer.current = undefined;
			refreshStats();
		}, 1000);
	}, [refreshStats]);

	useEffect(() => {
		if (auth === "authed") refreshStats();
	}, [auth, refreshStats]);

	/**
	 * 把一筆對話放回清單的正確位置（清單依 last_message_at 由新到舊）。
	 * 不符合篩選或搜尋就移除；比已載入的最後一筆還舊且後面還有頁，就不插入（它屬於未載入的頁）。
	 */
	const upsertConversation = useCallback(
		(conversation: Conversation) => {
			if (conversation.id === selectedId) setSelected(conversation);
			setConversations((prev) => {
				const matchesFilter = filter === "all" || conversation.status === filter;
				const q = query.trim().toLowerCase();
				const matchesQuery =
					!q ||
					(conversation.displayName ?? "").toLowerCase().includes(q) ||
					conversation.externalId.toLowerCase().includes(q);
				const rest = prev.filter((c) => c.id !== conversation.id);
				if (!matchesFilter || !matchesQuery) return rest;

				const ts = conversation.lastMessageAt ?? 0;
				let idx = rest.findIndex((c) => (c.lastMessageAt ?? 0) < ts);
				if (idx === -1) {
					if (listHasMoreRef.current && rest.length > 0) return rest;
					idx = rest.length;
				}
				const next = rest.slice();
				next.splice(idx, 0, conversation);
				return next.length > LIST_CAP ? next.slice(0, LIST_CAP) : next;
			});
		},
		[filter, query, selectedId],
	);

	// ---------- 訊息 ----------
	useEffect(() => {
		if (!selectedId) {
			setMessages([]);
			setHasMore(false);
			return;
		}
		let cancelled = false;
		setMessagesLoading(true);
		setMessages([]);
		api
			.listMessages(selectedId)
			.then(({ messages }) => {
				if (cancelled) return;
				setMessages(messages);
				setHasMore(messages.length >= PAGE_SIZE);
			})
			.catch(() => {})
			.finally(() => !cancelled && setMessagesLoading(false));

		api
			.markRead(selectedId)
			.then(({ conversation }) => {
				if (!conversation) return;
				setSelected(conversation);
				upsertConversation(conversation);
				scheduleStats();
			})
			.catch(() => {});

		setViewers([]);
		api.presence(selectedId).then(({ agents }) => !cancelled && setViewers(agents)).catch(() => {});

		return () => {
			cancelled = true;
		};
	}, [selectedId, upsertConversation, scheduleStats]);

	const loadMore = async () => {
		if (!selectedId || messages.length === 0) return;
		setMessagesLoading(true);
		try {
			const { messages: older } = await api.listMessages(
				selectedId,
				messages[0].createdAt,
			);
			setMessages((prev) => [...older, ...prev]);
			setHasMore(older.length >= PAGE_SIZE);
		} finally {
			setMessagesLoading(false);
		}
	};

	// ---------- 即時事件 ----------
	const onEvent = useCallback(
		(event: InboxEvent) => {
			if (event.type === "message.new") {
				const isCurrent = event.conversation.id === selectedId;
				if (isCurrent) {
					setMessages((prev) => {
						const idx = prev.findIndex((m) => m.id === event.message.id);
						if (idx >= 0) {
							const next = prev.slice();
							next[idx] = event.message;
							return next;
						}
						return [...prev, event.message];
					});
					// 正在看這個對話，立即清除未讀
					if (event.message.direction === "inbound" && event.conversation.unreadCount > 0) {
						api.markRead(event.conversation.id).catch(() => {});
						upsertConversation({ ...event.conversation, unreadCount: 0 });
						return;
					}
				}
				upsertConversation(event.conversation);
				scheduleStats();
			} else if (event.type === "conversation.updated") {
				upsertConversation(event.conversation);
				scheduleStats();
			} else if (event.type === "prompt.updated") {
				setPrompts((prev) => {
					const matches =
						promptsFilter === "all" || event.prompt.status === promptsFilter;
					const rest = prev.filter((p) => p.id !== event.prompt.id);
					if (!matches) return rest;
					return [event.prompt, ...rest].sort((a, b) => b.createdAt - a.createdAt);
				});
			} else if (event.type === "presence.updated") {
				if (event.conversationId === selectedId) setViewers(event.agents);
			} else if (event.type === "notification.updated") {
				setNotificationKey((k) => k + 1);
			}
		},
		[selectedId, upsertConversation, promptsFilter, scheduleStats],
	);

	const { connected, send: sendSocket } = useInboxSocket(auth === "authed", onEvent);

	// 告訴其他客服我正在看哪個對話（重連後 hook 會自動重送）
	useEffect(() => {
		if (auth !== "authed") return;
		sendSocket({ type: "view", conversationId: selectedId, agent: agentName });
	}, [auth, selectedId, agentName, sendSocket]);

	// 重連後重新抓一次清單與統計，補上斷線期間漏掉的更新
	useEffect(() => {
		if (connected && auth === "authed") {
			void loadConversations(true);
			refreshStats();
		}
	}, [connected, auth, loadConversations, refreshStats]);

	// ---------- 操作 ----------
	/** 選取對話只改網址；selected 由上方的 effect 依 selectedId 補齊（含不在清單裡的對話） */
	const selectConversation = useCallback((id: string | null) => {
		navigate({ conversationId: id, panel: null, compose: "closed" });
		setSelected(id ? (conversationsRef.current.find((c) => c.id === id) ?? null) : null);
	}, [navigate]);

	const mergeMessage = useCallback((message: Message) => {
		setMessages((prev) => {
			const idx = prev.findIndex((m) => m.id === message.id);
			if (idx < 0) return [...prev, message];
			const next = prev.slice();
			next[idx] = message;
			return next;
		});
	}, []);

	/** 送出時附上畫面上最後一則訊息，伺服器用它判斷有沒有其他客服在這之後回覆 */
	const lastSeenMessageId = () => messages[messages.length - 1]?.id;

	const handleSend = async (text: string, force: boolean) => {
		if (!selectedId) return;
		try {
			const { message, conversation } = await api.reply(selectedId, {
				text,
				force,
				clientKey: crypto.randomUUID(),
				lastSeenMessageId: lastSeenMessageId(),
			});
			mergeMessage(message);
			upsertConversation(conversation);
		} catch (err) {
			// 502：訊息已寫入但 LINE 拒絕，先放進畫面讓客服看到失敗狀態與重試
			if (err instanceof ApiError && err.status === 502 && err.data?.message) {
				mergeMessage(err.data.message as Message);
				if (err.data.conversation) upsertConversation(err.data.conversation as Conversation);
			}
			throw err;
		}
	};

	const handleSendMessages = async (input: SendMessagesInput) => {
		if (!selectedId) return;
		try {
			const { message, conversation } = await api.sendMessages(selectedId, {
				...input,
				clientKey: input.clientKey ?? crypto.randomUUID(),
				lastSeenMessageId: lastSeenMessageId(),
			});
			mergeMessage(message);
			upsertConversation(conversation);
		} catch (err) {
			if (err instanceof ApiError && err.status === 502 && err.data?.message) {
				mergeMessage(err.data.message as Message);
			}
			if (err instanceof ApiError && err.status === 409) {
				// 互動訊息對話框沒有衝突確認 UI：直接用 force 再送一次前先問
				const data = err.data as { error?: string } | null;
				if (window.confirm(`${data?.error ?? "發生衝突"}\n仍要發送嗎？`)) {
					const { message, conversation } = await api.sendMessages(selectedId, { ...input, force: true, clientKey: crypto.randomUUID() });
					mergeMessage(message);
					upsertConversation(conversation);
					return;
				}
			}
			throw err;
		}
	};

	const handleRetryMessage = async (messageId: string) => {
		try {
			const { message } = await api.retryMessage(messageId);
			mergeMessage(message);
		} catch (err) {
			if (err instanceof ApiError && err.data?.message) mergeMessage(err.data.message as Message);
		}
	};

	const handleAssign = async () => {
		if (!selectedId) return;
		const { conversation } = await api.assign(selectedId);
		upsertConversation(conversation);
	};

	const handleRelease = async () => {
		if (!selectedId) return;
		const { conversation } = await api.release(selectedId);
		upsertConversation(conversation);
	};

	const handleReportMessage = async (messageId: string, note?: string) => {
		const { message } = await api.reportMessage(messageId, note);
		mergeMessage(message);
	};

	const changeAgentName = () => {
		const next = window.prompt("請輸入客服名稱（供同事識別）", agentName ?? "");
		if (next === null) return;
		const name = next.trim().slice(0, 40);
		if (!name) return;
		setAgentName(name);
		setAgent(name);
	};

	const loadPrompts = useCallback(async (status: PromptStatus | "all") => {
		setPromptsFilter(status);
		setPromptsLoading(true);
		try {
			const { prompts } = await api.listPrompts(status);
			setPrompts(prompts);
		} catch {
			// 顯示空清單即可
		} finally {
			setPromptsLoading(false);
		}
	}, []);

	const handleToggleStatus = async () => {
		if (!selected) return;
		const next: ConversationStatus = selected.status === "open" ? "closed" : "open";
		const { conversation } = await api.setStatus(selected.id, next);
		upsertConversation(conversation);
		scheduleStats();
	};

	// ---------- 畫面 ----------
	if (auth === "checking") {
		return (
			<div className="min-h-screen flex items-center justify-center text-sm text-neutral-500 dark:bg-neutral-950">
				載入中…
			</div>
		);
	}
	if (auth === "anonymous") {
		return <Login error={loginError} busy={loginBusy} initialName={agentName} onSubmit={handleLogin} />;
	}

	const totalUnread = stats?.unreadTotal ?? 0;

	return (
		<div className="h-screen flex flex-col bg-white dark:bg-neutral-900 text-neutral-900 dark:text-neutral-100">
			<header className="flex items-center gap-3 px-4 h-12 border-b border-neutral-200 dark:border-neutral-800 shrink-0">
				<span className="text-sm font-semibold">客服收發台</span>
				{totalUnread > 0 && (
					<span className="text-[11px] px-1.5 py-0.5 rounded-full bg-emerald-600 text-white font-semibold" title="未讀訊息總數">
						{totalUnread > 999 ? "999+" : totalUnread}
					</span>
				)}
				{(stats?.needsAttentionCount ?? 0) > 0 && (
					<span className="text-[11px] px-1.5 py-0.5 rounded-full bg-red-100 text-red-700 dark:bg-red-900/50 dark:text-red-300 font-semibold" title="逾時未回覆">
						逾時 {stats!.needsAttentionCount}
					</span>
				)}
				{(
					[
						["prompts", "追蹤訊息"],
						["imports", "歷史匯入"],
						["notifications", "通知型訊息"],
					] as [Panel, string][]
				).map(([key, label]) => (
					<button
						key={key}
						onClick={() => setPanel(panel === key ? null : key)}
						className={`text-xs px-2.5 py-1 rounded-md flex items-center gap-1 ${
							panel === key
								? "bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900"
								: "text-neutral-600 dark:text-neutral-400 hover:bg-neutral-100 dark:hover:bg-neutral-800"
						}`}
					>
						{label}
					</button>
				))}
				<button
					onClick={changeAgentName}
					title="變更客服名稱"
					className="ml-auto text-[11px] text-neutral-600 dark:text-neutral-300 hover:underline"
				>
					{agentName ?? "未設定名稱"}
				</button>
				<span
					className={`flex items-center gap-1.5 text-[11px] ${
						connected ? "text-emerald-600" : "text-amber-600"
					}`}
				>
					<span
						className={`w-2 h-2 rounded-full ${connected ? "bg-emerald-500" : "bg-amber-500 animate-pulse"}`}
					/>
					{connected ? "即時連線中" : "重新連線中…"}
				</span>
				<button
					onClick={handleLogout}
					className="text-xs text-neutral-500 hover:text-neutral-900 dark:hover:text-neutral-100"
				>
					登出
				</button>
			</header>

			<div className="flex-1 flex min-h-0">
				<aside
					className={`w-full lg:w-80 xl:w-96 border-r border-neutral-200 dark:border-neutral-800 shrink-0 ${
						selectedId ? "hidden lg:block" : "block"
					}`}
				>
					<ConversationList
						conversations={conversations}
						selectedId={selectedId}
						filter={filter}
						query={query}
						loading={listLoading}
						hasMore={listHasMore}
						onSelect={selectConversation}
						onFilterChange={(f) => {
							setFilter(f);
							selectConversation(null);
						}}
						onQueryChange={setQuery}
						onLoadMore={() => void loadConversations(false)}
					/>
				</aside>

				<main className={`flex-1 min-w-0 ${selectedId || panel ? "block" : "hidden lg:block"}`}>
					{promptsPanelOpen ? (
						<PromptsPanel
							prompts={prompts}
							loading={promptsLoading}
							onRefresh={loadPrompts}
							onOpenConversation={(id) => {
								setPromptsPanelOpen(false);
								selectConversation(id);
							}}
							onClose={() => setPromptsPanelOpen(false)}
						/>
					) : panel === "imports" ? (
						<ImportPanel
							onOpenConversation={(id) => {
								setPanel(null);
								selectConversation(id);
							}}
							onClose={() => setPanel(null)}
						/>
					) : panel === "notifications" ? (
						<NotificationsPanel refreshKey={notificationKey} onClose={() => setPanel(null)} />
					) : selected ? (
						<MessageThread
							conversation={selected}
							messages={messages}
							loading={messagesLoading}
							hasMore={hasMore}
							agentName={agentName}
							viewers={viewers}
							onLoadMore={() => void loadMore()}
							onSend={handleSend}
							onOpenPrompt={() => setComposeMode("builder")}
							onToggleStatus={() => void handleToggleStatus()}
							onAssign={() => void handleAssign()}
							onRelease={() => void handleRelease()}
							onRetryMessage={(id) => void handleRetryMessage(id)}
							onReportMessage={handleReportMessage}
							onBack={() => selectConversation(null)}
						/>
					) : (
						<div className="h-full flex items-center justify-center text-sm text-neutral-400">
							請從左側清單選擇對話
						</div>
					)}
				</main>
			</div>

			{composeMode === "builder" && selected && (
				<BuilderDialog
					onClose={() => setComposeMode("closed")}
					onSend={handleSendMessages}
					onSwitchToJson={(messages) => {
						setJsonSeed(messages);
						setComposeMode("json");
					}}
				/>
			)}
			{composeMode === "json" && selected && (
				<ComposeDialog
					onClose={() => setComposeMode("closed")}
					onSend={handleSendMessages}
					initialMessages={jsonSeed}
					onBackToBuilder={() => setComposeMode("builder")}
				/>
			)}
		</div>
	);
}

export default App;
