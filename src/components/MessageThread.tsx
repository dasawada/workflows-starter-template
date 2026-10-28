import { useEffect, useLayoutEffect, useRef, type ReactNode } from "react";
import type { Conversation, Message } from "../../shared/types";
import { formatDateHeading } from "../format";
import { Avatar } from "./Avatar";
import { ImageSetBubble, MessageBubble } from "./MessageBubble";
import { Composer } from "./Composer";

interface Props {
	conversation: Conversation;
	messages: Message[];
	loading: boolean;
	hasMore: boolean;
	agentName: string | null;
	/** 其他正在看這個對話的客服 */
	viewers: string[];
	onLoadMore: () => void;
	onSend: (text: string, force: boolean) => Promise<void>;
	onOpenPrompt: () => void;
	onToggleStatus: () => void;
	onAssign: () => void;
	onRelease: () => void;
	onRetryMessage: (messageId: string) => void;
	onReportMessage: (messageId: string, note?: string) => Promise<void>;
	quoting: Message | null;
	onQuote: (message: Message) => void;
	onCancelQuote: () => void;
	onBack?: () => void;
}

export function MessageThread({
	conversation,
	messages,
	loading,
	hasMore,
	agentName,
	viewers,
	onLoadMore,
	onSend,
	onOpenPrompt,
	onToggleStatus,
	onAssign,
	onRelease,
	onRetryMessage,
	onReportMessage,
	quoting,
	onQuote,
	onCancelQuote,
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
	const mine = !!agentName && conversation.assignedTo === agentName;
	const otherViewers = viewers.filter((v) => v !== agentName);

	// 同一個圖集（imageSet.id）的圖片收斂成一個泡泡，放在第一張出現的位置
	const imageSets = new Map<string, Message[]>();
	for (const m of messages) {
		const setId = (m.metadata?.imageSet as { id?: string } | undefined)?.id;
		if (setId && m.direction === "inbound" && !m.unsentAt) {
			imageSets.set(setId, [...(imageSets.get(setId) ?? []), m]);
		}
	}
	const renderedSets = new Set<string>();

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
		const setId = (m.metadata?.imageSet as { id?: string } | undefined)?.id;
		if (setId && imageSets.has(setId)) {
			if (renderedSets.has(setId)) continue;
			renderedSets.add(setId);
			items.push(<ImageSetBubble key={`set-${setId}`} messages={imageSets.get(setId)!} onReport={onReportMessage} onQuote={onQuote} />);
			continue;
		}
		items.push(<MessageBubble key={m.id} message={m} onRetry={onRetryMessage} onReport={onReportMessage} onQuote={onQuote} />);
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
					<div className="text-[11px] text-neutral-500 truncate flex items-center gap-2">
						<span>LINE · {conversation.externalId}</span>
						{conversation.assignedTo && (
							<span className="px-1.5 rounded bg-sky-100 text-sky-700 dark:bg-sky-900/50 dark:text-sky-300">
								{mine ? "由您負責" : `由「${conversation.assignedTo}」負責`}
							</span>
						)}
						{otherViewers.length > 0 && (
							<span className="text-amber-600 dark:text-amber-400" title="其他客服人員目前也開啟了此對話">
								{otherViewers.join("、")} 正在檢視此對話
							</span>
						)}
					</div>
				</div>
				{conversation.needsAttention && (
					<span className="text-[11px] font-semibold px-2 py-1 rounded bg-red-100 text-red-700 dark:bg-red-900/50 dark:text-red-300">
						逾時未回覆
					</span>
				)}
				{agentName && (
					<button
						onClick={mine ? onRelease : onAssign}
						title={mine ? "解除您的負責狀態" : conversation.assignedTo ? `接手「${conversation.assignedTo}」負責的對話` : "將此對話標記為由您負責"}
						className={`text-xs font-medium rounded-md px-3 py-1.5 border transition-colors ${
							mine
								? "border-sky-300 dark:border-sky-700 text-sky-700 dark:text-sky-300 hover:bg-sky-50 dark:hover:bg-sky-950/40"
								: "border-neutral-300 dark:border-neutral-700 text-neutral-700 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-800"
						}`}
					>
						{mine ? "交還" : "接手"}
					</button>
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
							{loading ? "載入中" : "載入更早的訊息"}
						</button>
					</div>
				)}
				{loading && messages.length === 0 && (
					<p className="text-sm text-neutral-500 text-center py-6">載入中</p>
				)}
				{items}
			</div>

			<Composer disabled={closed} onSend={onSend} onOpenPrompt={onOpenPrompt} quoting={quoting} onCancelQuote={onCancelQuote} />
		</div>
	);
}
