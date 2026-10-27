import type { Conversation, ConversationStatus } from "../../shared/types";
import { formatListTime } from "../format";
import { Avatar } from "./Avatar";

interface Props {
	conversations: Conversation[];
	selectedId: string | null;
	filter: ConversationStatus | "all";
	loading: boolean;
	onSelect: (id: string) => void;
	onFilterChange: (filter: ConversationStatus | "all") => void;
}

const FILTERS: { value: ConversationStatus | "all"; label: string }[] = [
	{ value: "open", label: "進行中" },
	{ value: "closed", label: "已結案" },
	{ value: "all", label: "全部" },
];

export function ConversationList({
	conversations,
	selectedId,
	filter,
	loading,
	onSelect,
	onFilterChange,
}: Props) {
	return (
		<div className="flex flex-col h-full">
			<div className="flex gap-1 p-2 border-b border-neutral-200 dark:border-neutral-800">
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

			<ul className="flex-1 overflow-y-auto">
				{loading && conversations.length === 0 && (
					<li className="p-4 text-sm text-neutral-500">載入中…</li>
				)}
				{!loading && conversations.length === 0 && (
					<li className="p-6 text-sm text-center text-neutral-500">
						目前沒有對話
					</li>
				)}
				{conversations.map((c) => {
					const selected = c.id === selectedId;
					return (
						<li key={c.id}>
							<button
								onClick={() => onSelect(c.id)}
								className={`w-full text-left flex items-center gap-3 px-3 py-3 border-b border-neutral-100 dark:border-neutral-800/60 transition-colors ${
									selected
										? "bg-emerald-50 dark:bg-emerald-950/40"
										: "hover:bg-neutral-50 dark:hover:bg-neutral-800/60"
								}`}
							>
								<Avatar name={c.displayName} url={c.pictureUrl} />
								<div className="min-w-0 flex-1">
									<div className="flex items-center gap-2">
										<span className="truncate text-sm font-medium text-neutral-900 dark:text-neutral-100">
											{c.displayName ?? c.externalId}
										</span>
										{c.needsAttention && (
											<span
												title="逾時未回覆"
												className="shrink-0 text-[10px] font-semibold px-1.5 py-0.5 rounded bg-red-100 text-red-700 dark:bg-red-900/50 dark:text-red-300"
											>
												逾時
											</span>
										)}
										{c.status === "closed" && (
											<span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded bg-neutral-200 text-neutral-600 dark:bg-neutral-700 dark:text-neutral-300">
												已結案
											</span>
										)}
										<span className="ml-auto shrink-0 text-[11px] text-neutral-400">
											{formatListTime(c.lastMessageAt)}
										</span>
									</div>
									<div className="flex items-center gap-2 mt-0.5">
										<span className="truncate text-xs text-neutral-500 dark:text-neutral-400">
											{c.lastMessageText ?? ""}
										</span>
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
				})}
			</ul>
		</div>
	);
}
