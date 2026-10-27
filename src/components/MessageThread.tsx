import { useEffect, useLayoutEffect, useRef, type ReactNode } from "react";
import type { Conversation, Message } from "../../shared/types";
import { formatDateHeading } from "../format";
import { Avatar } from "./Avatar";
import { MessageBubble } from "./MessageBubble";
import { Composer } from "./Composer";

interface Props {
	conversation: Conversation;
	messages: Message[];
	loading: boolean;
	hasMore: boolean;
	onLoadMore: () => void;
	onSend: (text: string) => Promise<void>;
	onOpenPrompt: () => void;
	onToggleStatus: () => void;
	onBack?: () => void;
}

export function MessageThread({
	conversation,
	messages,
	loading,
	hasMore,
	onLoadMore,
	onSend,
	onOpenPrompt,
	onToggleStatus,
	onBack,
}: Props) {
	const scrollRef = useRef<HTMLDivElement>(null);
	const lastIdRef = useRef<string | null>(null);
	const prevHeightRef = useRef(0);

	// 新訊息抵達時捲到最底；往上載入舊訊息時維持原本位置
	useLayoutEffect(() => {
		const el = scrollRef.current;
		if (!el) return;
		const lastId = messages[messages.length - 1]?.id ?? null;
		if (lastId !== lastIdRef.current) {
			el.scrollTop = el.scrollHeight;
			lastIdRef.current = lastId;
		} else if (prevHeightRef.current && el.scrollHeight > prevHeightRef.current) {
			el.scrollTop += el.scrollHeight - prevHeightRef.current;
		}
		prevHeightRef.current = el.scrollHeight;
	}, [messages]);

	useEffect(() => {
		lastIdRef.current = null;
		prevHeightRef.current = 0;
	}, [conversation.id]);

	const closed = conversation.status === "closed";

	const items: ReactNode[] = [];
	let lastDay = "";
	for (const m of messages) {
		const day = formatDateHeading(m.createdAt);
		if (day !== lastDay) {
			items.push(
				<div key={`day-${m.id}`} className="flex justify-center my-3">
					<span className="text-[11px] text-neutral-500 bg-neutral-200/70 dark:bg-neutral-800 rounded-full px-3 py-0.5">
						{day}
					</span>
				</div>,
			);
			lastDay = day;
		}
		items.push(<MessageBubble key={m.id} message={m} />);
	}

	return (
		<div className="flex flex-col h-full">
			<header className="flex items-center gap-3 px-4 py-3 border-b border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900">
				{onBack && (
					<button
						onClick={onBack}
						className="lg:hidden text-neutral-500 hover:text-neutral-900 dark:hover:text-neutral-100 text-xl leading-none px-1"
						aria-label="返回"
					>
						←
					</button>
				)}
				<Avatar name={conversation.displayName} url={conversation.pictureUrl} size={36} />
				<div className="min-w-0 flex-1">
					<div className="truncate text-sm font-semibold text-neutral-900 dark:text-neutral-100">
						{conversation.displayName ?? conversation.externalId}
					</div>
					<div className="text-[11px] text-neutral-500 truncate">
						LINE · {conversation.externalId}
					</div>
				</div>
				{conversation.needsAttention && (
					<span className="text-[11px] font-semibold px-2 py-1 rounded bg-red-100 text-red-700 dark:bg-red-900/50 dark:text-red-300">
						逾時未回覆
					</span>
				)}
				<button
					onClick={onToggleStatus}
					className="text-xs font-medium rounded-md px-3 py-1.5 border border-neutral-300 dark:border-neutral-700 text-neutral-700 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-800 transition-colors"
				>
					{closed ? "重新開啟" : "結案"}
				</button>
			</header>

			<div
				ref={scrollRef}
				className="flex-1 overflow-y-auto px-4 py-3 bg-neutral-50 dark:bg-neutral-950"
			>
				{hasMore && (
					<div className="flex justify-center mb-2">
						<button
							onClick={onLoadMore}
							disabled={loading}
							className="text-xs text-neutral-500 hover:text-neutral-900 dark:hover:text-neutral-100 disabled:opacity-50"
						>
							{loading ? "載入中…" : "載入更早的訊息"}
						</button>
					</div>
				)}
				{loading && messages.length === 0 && (
					<p className="text-sm text-neutral-500 text-center py-6">載入中…</p>
				)}
				{items}
			</div>

			<Composer disabled={closed} onSend={onSend} onOpenPrompt={onOpenPrompt} />
		</div>
	);
}
