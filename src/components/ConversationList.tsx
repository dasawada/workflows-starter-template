import { memo, useCallback, useEffect, useRef, useState } from "react";
import type { Conversation, ConversationStatus } from "../../shared/types";
import { formatListTime } from "../format";
import { Avatar } from "./Avatar";

interface Props {
	conversations: Conversation[];
	selectedId: string | null;
	filter: ConversationStatus | "all";
	query: string;
	loading: boolean;
	hasMore: boolean;
	onSelect: (id: string) => void;
	onFilterChange: (filter: ConversationStatus | "all") => void;
	onQueryChange: (q: string) => void;
	onLoadMore: () => void;
}

const FILTERS: { value: ConversationStatus | "all"; label: string }[] = [
	{ value: "open", label: "進行中" },
	{ value: "closed", label: "已結案" },
	{ value: "all", label: "全部" },
];

/** 每列固定高度，虛擬捲動才能直接算出可見範圍 */
const ROW_HEIGHT = 68;
const OVERSCAN = 6;
const LOAD_MORE_THRESHOLD = ROW_HEIGHT * 10;

export function ConversationList({
	conversations,
	selectedId,
	filter,
	query,
	loading,
	hasMore,
	onSelect,
	onFilterChange,
	onQueryChange,
	onLoadMore,
}: Props) {
	const scrollRef = useRef<HTMLDivElement>(null);
	const [scrollTop, setScrollTop] = useState(0);
	const [viewport, setViewport] = useState(600);
	const [draft, setDraft] = useState(query);

	// 搜尋字 300ms 防抖
	useEffect(() => {
		const t = window.setTimeout(() => {
			if (draft !== query) onQueryChange(draft);
		}, 300);
		return () => window.clearTimeout(t);
	}, [draft, query, onQueryChange]);

	useEffect(() => {
		const el = scrollRef.current;
		if (!el) return;
		const update = () => setViewport(el.clientHeight);
		update();
		const ro = new ResizeObserver(update);
		ro.observe(el);
		return () => ro.disconnect();
	}, []);

	// 切換篩選或搜尋時回到頂端（改 scrollTop 會觸發 onScroll，狀態隨之更新）
	useEffect(() => {
		if (scrollRef.current) scrollRef.current.scrollTop = 0;
	}, [filter, query]);

	const total = conversations.length;
	const totalHeight = total * ROW_HEIGHT;
	const start = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
	const end = Math.min(total, Math.ceil((scrollTop + viewport) / ROW_HEIGHT) + OVERSCAN);
	const visible = conversations.slice(start, end);

	const onScroll = useCallback(() => {
		const el = scrollRef.current;
		if (!el) return;
		setScrollTop(el.scrollTop);
		if (hasMore && !loading && el.scrollTop + el.clientHeight > el.scrollHeight - LOAD_MORE_THRESHOLD) {
			onLoadMore();
		}
	}, [hasMore, loading, onLoadMore]);

	return (
		<div className="flex flex-col h-full">
			<div className="p-2 space-y-2 border-b border-neutral-200 dark:border-neutral-800">
				<input
					id="conversation-search"
					type="search"
					value={draft}
					onChange={(e) => setDraft(e.target.value)}
					placeholder="搜尋名稱或 ID"
					className="w-full rounded-lg border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-800 px-3 py-1.5 text-sm text-neutral-900 dark:text-neutral-100 outline-none focus:ring-2 focus:ring-emerald-500"
				/>
				<div className="flex gap-1">
					{FILTERS.map((f) => (
						<button
							key={f.value}
							onClick={() => onFilterChange(f.value)}
							className={`flex-1 text-xs font-medium rounded-md py-1.5 transition-colors ${
								filter === f.value
									? "bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900"
									: "text-neutral-600 dark:text-neutral-400 hover:bg-neutral-100 dark:hover:bg-neutral-800"
							}`}
						>
							{f.label}
						</button>
					))}
				</div>
			</div>

			<div ref={scrollRef} onScroll={onScroll} className="flex-1 overflow-y-auto">
				{loading && total === 0 && <p className="p-4 text-sm text-neutral-500">載入中</p>}
				{!loading && total === 0 && (
					<p className="p-6 text-sm text-center text-neutral-500">{query ? "查無符合條件的對話" : "目前沒有對話"}</p>
				)}
				{total > 0 && (
					<ul style={{ height: totalHeight, position: "relative" }}>
						{visible.map((c, i) => (
							<Row
								key={c.id}
								conversation={c}
								selected={c.id === selectedId}
								top={(start + i) * ROW_HEIGHT}
								onSelect={onSelect}
							/>
						))}
					</ul>
				)}
				{loading && total > 0 && <p className="py-2 text-center text-[11px] text-neutral-400">載入更多</p>}
				{!hasMore && total > 0 && <p className="py-2 text-center text-[11px] text-neutral-400">已顯示全部</p>}
			</div>
		</div>
	);
}

interface RowProps {
	conversation: Conversation;
	selected: boolean;
	top: number;
	onSelect: (id: string) => void;
}

/** memo：一則新訊息進來只會重繪受影響的那一列 */
const Row = memo(function Row({ conversation: c, selected, top, onSelect }: RowProps) {
	return (
		<li style={{ position: "absolute", top, left: 0, right: 0, height: ROW_HEIGHT }}>
			<button
				onClick={() => onSelect(c.id)}
				className={`w-full h-full text-left flex items-center gap-3 px-3 border-b border-neutral-100 dark:border-neutral-800/60 transition-colors ${
					selected ? "bg-emerald-50 dark:bg-emerald-950/40" : "hover:bg-neutral-50 dark:hover:bg-neutral-800/60"
				}`}
			>
				<Avatar name={c.displayName} url={c.pictureUrl} />
				<div className="min-w-0 flex-1">
					<div className="flex items-center gap-2">
						<span className="truncate text-sm font-medium text-neutral-900 dark:text-neutral-100">
							{c.displayName ?? c.externalId}
						</span>
						{c.needsAttention && (
							<span title="逾時未回覆" className="shrink-0 text-[10px] font-semibold px-1.5 py-0.5 rounded bg-red-100 text-red-700 dark:bg-red-900/50 dark:text-red-300">
								逾時
							</span>
						)}
						{c.status === "closed" && (
							<span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded bg-neutral-200 text-neutral-600 dark:bg-neutral-700 dark:text-neutral-300">
								已結案
							</span>
						)}
						{c.assignedTo && (
							<span title={`由「${c.assignedTo}」負責`} className="shrink-0 max-w-16 truncate text-[10px] px-1.5 py-0.5 rounded bg-sky-100 text-sky-700 dark:bg-sky-900/50 dark:text-sky-300">
								{c.assignedTo}
							</span>
						)}
						<span className="ml-auto shrink-0 text-[11px] text-neutral-400">{formatListTime(c.lastMessageAt)}</span>
					</div>
					<div className="flex items-center gap-2 mt-0.5">
						<span className="truncate text-xs text-neutral-500 dark:text-neutral-400">{c.lastMessageText ?? ""}</span>
						{c.unreadCount > 0 && (
							<span className="ml-auto shrink-0 min-w-5 h-5 px-1.5 rounded-full bg-emerald-600 text-white text-[11px] font-semibold flex items-center justify-center">
								{c.unreadCount > 99 ? "99+" : c.unreadCount}
							</span>
						)}
					</div>
				</div>
			</button>
		</li>
	);
});
