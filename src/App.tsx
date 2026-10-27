import { useCallback, useEffect, useMemo, useState } from "react";
import type {
	Conversation,
	ConversationStatus,
	InboxEvent,
	Message,
	Prompt,
	PromptStatus,
	SendPromptInput,
} from "../shared/types";
import { api, ApiError, getToken, setToken } from "./api";
import { useInboxSocket } from "./hooks/useInboxSocket";
import { Login } from "./components/Login";
import { ConversationList } from "./components/ConversationList";
import { MessageThread } from "./components/MessageThread";
import { PromptDialog } from "./components/PromptDialog";
import { PromptsPanel } from "./components/PromptsPanel";

const PAGE_SIZE = 50;

type AuthState = "checking" | "anonymous" | "authed";

function App() {
	const [auth, setAuth] = useState<AuthState>(getToken() ? "checking" : "anonymous");
	const [loginError, setLoginError] = useState<string | null>(null);
	const [loginBusy, setLoginBusy] = useState(false);

	const [filter, setFilter] = useState<ConversationStatus | "all">("open");
	const [conversations, setConversations] = useState<Conversation[]>([]);
	const [listLoading, setListLoading] = useState(false);

	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [messages, setMessages] = useState<Message[]>([]);
	const [messagesLoading, setMessagesLoading] = useState(false);
	const [hasMore, setHasMore] = useState(false);

	const [promptDialogOpen, setPromptDialogOpen] = useState(false);
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
		setMessages([]);
	};

	// ---------- 對話清單 ----------
	const loadConversations = useCallback(async () => {
		setListLoading(true);
		try {
			const { conversations } = await api.listConversations(filter);
			setConversations(conversations);
		} catch (err) {
			if (err instanceof ApiError && err.status === 401) handleLogout();
		} finally {
			setListLoading(false);
		}
	}, [filter]);

	useEffect(() => {
		if (auth === "authed") void loadConversations();
	}, [auth, loadConversations]);

	const upsertConversation = useCallback(
		(conversation: Conversation) => {
			setConversations((prev) => {
				const matchesFilter = filter === "all" || conversation.status === filter;
				const rest = prev.filter((c) => c.id !== conversation.id);
				if (!matchesFilter) return rest;
				return [conversation, ...rest].sort(
					(a, b) => (b.lastMessageAt ?? 0) - (a.lastMessageAt ?? 0),
				);
			});
		},
		[filter],
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
			.then(({ conversation }) => conversation && upsertConversation(conversation))
			.catch(() => {});

		return () => {
			cancelled = true;
		};
	}, [selectedId, upsertConversation]);

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
			} else if (event.type === "conversation.updated") {
				upsertConversation(event.conversation);
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
		[selectedId, upsertConversation, promptsFilter],
	);

	const { connected } = useInboxSocket(auth === "authed", onEvent);

	// 重連後重新抓一次清單，補上斷線期間漏掉的更新
	useEffect(() => {
		if (connected && auth === "authed") void loadConversations();
	}, [connected, auth, loadConversations]);

	// ---------- 操作 ----------
	const selected = useMemo(
		() => conversations.find((c) => c.id === selectedId) ?? null,
		[conversations, selectedId],
	);

	const handleSend = async (text: string) => {
		if (!selectedId) return;
		const { message, conversation } = await api.reply(selectedId, text);
		setMessages((prev) => (prev.some((m) => m.id === message.id) ? prev : [...prev, message]));
		upsertConversation(conversation);
	};

	const handleSendPrompt = async (input: SendPromptInput) => {
		if (!selectedId) return;
		const { message, conversation } = await api.sendPrompt(selectedId, input);
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
		if (filter !== "all" && conversation.status !== filter) setSelectedId(null);
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

	const totalUnread = conversations.reduce((n, c) => n + c.unreadCount, 0);

	return (
		<div className="h-screen flex flex-col bg-white dark:bg-neutral-900 text-neutral-900 dark:text-neutral-100">
			<header className="flex items-center gap-3 px-4 h-12 border-b border-neutral-200 dark:border-neutral-800 shrink-0">
				<span className="text-sm font-semibold">客服收發台</span>
				{totalUnread > 0 && (
					<span className="text-[11px] px-1.5 py-0.5 rounded-full bg-emerald-600 text-white font-semibold">
						{totalUnread}
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
						loading={listLoading}
						onSelect={setSelectedId}
						onFilterChange={(f) => {
							setFilter(f);
							setSelectedId(null);
						}}
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
								setFilter("all");
								setSelectedId(id);
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
							onOpenPrompt={() => setPromptDialogOpen(true)}
							onToggleStatus={() => void handleToggleStatus()}
							onBack={() => setSelectedId(null)}
						/>
					) : (
						<div className="h-full flex items-center justify-center text-sm text-neutral-400">
							從左側選擇一個對話
						</div>
					)}
				</main>
			</div>

			{promptDialogOpen && selected && (
				<PromptDialog onClose={() => setPromptDialogOpen(false)} onSend={handleSendPrompt} />
			)}
		</div>
	);
}

export default App;
