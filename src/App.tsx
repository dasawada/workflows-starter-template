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
import { useInboxSocket } from "./hooks/useInboxSocket";
import { Login } from "./components/Login";
import { ConversationList } from "./components/ConversationList";
import { MessageThread } from "./components/MessageThread";
import { ComposeDialog } from "./components/ComposeDialog";
import { BuilderDialog } from "./components/builder/BuilderDialog";
import { PromptsPanel } from "./components/PromptsPanel";

const PAGE_SIZE = 50;
/** 對話清單每頁筆數與記憶體上限；清單用虛擬捲動，所以上限只影響記憶體不影響效能 */
const LIST_PAGE = 50;
const LIST_CAP = 1000;

type AuthState = "checking" | "anonymous" | "authed";

function App() {
	const [auth, setAuth] = useState<AuthState>(getToken() ? "checking" : "anonymous");
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

	const [selectedId, setSelectedId] = useState<string | null>(null);
	/** 選中的對話獨立保存，即使它被捲出清單或不符合目前篩選也不會消失 */
	const [selected, setSelected] = useState<Conversation | null>(null);
	const [messages, setMessages] = useState<Message[]>([]);
	const [messagesLoading, setMessagesLoading] = useState(false);
	const [hasMore, setHasMore] = useState(false);

	const [composeMode, setComposeMode] = useState<"closed" | "builder" | "json">("closed");
	const [jsonSeed, setJsonSeed] = useState<unknown[] | undefined>(undefined);
	const [promptsPanelOpen, setPromptsPanelOpen] = useState(false);
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

	const handleLogin = async (token: string) => {
		setLoginBusy(true);
		setLoginError(null);
		setToken(token);
		try {
			await api.me();
			setAuth("authed");
		} catch (err) {
			setToken(null);
			setLoginError(
				err instanceof ApiError && err.status === 401 ? "密鑰不正確" : "無法連線到伺服器",
			);
		} finally {
			setLoginBusy(false);
		}
	};

	const handleLogout = () => {
		setToken(null);
		setAuth("anonymous");
		setConversations([]);
		setSelectedId(null);
		setSelected(null);
		setMessages([]);
	};

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
		[filter, query],
	);

	useEffect(() => {
		if (auth === "authed") void loadConversations(true);
	}, [auth, loadConversations]);

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
			}
		},
		[selectedId, upsertConversation, promptsFilter, scheduleStats],
	);

	const { connected } = useInboxSocket(auth === "authed", onEvent);

	// 重連後重新抓一次清單與統計，補上斷線期間漏掉的更新
	useEffect(() => {
		if (connected && auth === "authed") {
			void loadConversations(true);
			refreshStats();
		}
	}, [connected, auth, loadConversations, refreshStats]);

	// ---------- 操作 ----------
	const selectConversation = useCallback((id: string | null) => {
		setSelectedId(id);
		setSelected(id ? (conversationsRef.current.find((c) => c.id === id) ?? null) : null);
	}, []);

	const handleSend = async (text: string) => {
		if (!selectedId) return;
		const { message, conversation } = await api.reply(selectedId, text);
		setMessages((prev) => (prev.some((m) => m.id === message.id) ? prev : [...prev, message]));
		upsertConversation(conversation);
	};

	const handleSendMessages = async (input: SendMessagesInput) => {
		if (!selectedId) return;
		const { message, conversation } = await api.sendMessages(selectedId, input);
		setMessages((prev) => (prev.some((m) => m.id === message.id) ? prev : [...prev, message]));
		upsertConversation(conversation);
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
		return <Login error={loginError} busy={loginBusy} onSubmit={handleLogin} />;
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
				<button
					onClick={() => setPromptsPanelOpen((v) => !v)}
					className={`text-xs px-2.5 py-1 rounded-md ${
						promptsPanelOpen
							? "bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900"
							: "text-neutral-600 dark:text-neutral-400 hover:bg-neutral-100 dark:hover:bg-neutral-800"
					}`}
				>
					追蹤訊息
				</button>
				<span
					className={`ml-auto flex items-center gap-1.5 text-[11px] ${
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

				<main className={`flex-1 min-w-0 ${selectedId || promptsPanelOpen ? "block" : "hidden lg:block"}`}>
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
					) : selected ? (
						<MessageThread
							conversation={selected}
							messages={messages}
							loading={messagesLoading}
							hasMore={hasMore}
							onLoadMore={() => void loadMore()}
							onSend={handleSend}
							onOpenPrompt={() => setComposeMode("builder")}
							onToggleStatus={() => void handleToggleStatus()}
							onBack={() => selectConversation(null)}
						/>
					) : (
						<div className="h-full flex items-center justify-center text-sm text-neutral-400">
							從左側選擇一個對話
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
