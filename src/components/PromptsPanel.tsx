import { useEffect, useState } from "react";
import type { Prompt, PromptStatus } from "../../shared/types";

import { formatListTime } from "../format";

interface Props {
	prompts: Prompt[];
	loading: boolean;
	onRefresh: (status: PromptStatus | "all") => void;
	onOpenConversation: (id: string) => void;
	onClose: () => void;
}

const FILTERS: { value: PromptStatus | "all"; label: string }[] = [
	{ value: "all", label: "全部" },
	{ value: "pending", label: "待回覆" },
	{ value: "answered", label: "已回覆" },
];

export function PromptsPanel({ prompts, loading, onRefresh, onOpenConversation, onClose }: Props) {
	const [filter, setFilter] = useState<PromptStatus | "all">("all");

	useEffect(() => {
		onRefresh(filter);
	}, [filter, onRefresh]);

	const exportCsv = () => {
		const header = ["送出時間", "對象", "範本", "問句", "狀態", "選擇", "回覆時間", "變數"];
		const rows = prompts.map((p) => [
			new Date(p.createdAt).toLocaleString("zh-TW"),
			p.displayName ?? p.conversationId,
			p.templateKey ?? "",
			p.question,
			p.status === "answered" ? "已回覆" : "待回覆",
			p.choiceLabel ?? "",
			p.respondedAt ? new Date(p.respondedAt).toLocaleString("zh-TW") : "",
			p.variables ? JSON.stringify(p.variables) : "",
		]);
		const csv = [header, ...rows]
			.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(","))
			.join("\n");
		const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" });
		const url = URL.createObjectURL(blob);
		const a = document.createElement("a");
		a.href = url;
		a.download = `prompts-${Date.now()}.csv`;
		a.click();
		URL.revokeObjectURL(url);
	};

	return (
		<div className="flex flex-col h-full">
			<header className="flex items-center gap-2 px-4 py-3 border-b border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900">
				<h2 className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">追蹤訊息</h2>
				<div className="flex gap-1 ml-2">
					{FILTERS.map((f) => (
						<button
							key={f.value}
							onClick={() => setFilter(f.value)}
							className={`text-xs px-2.5 py-1 rounded-md ${
								filter === f.value
									? "bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900"
									: "text-neutral-600 dark:text-neutral-400 hover:bg-neutral-100 dark:hover:bg-neutral-800"
							}`}
						>
							{f.label}
						</button>
					))}
				</div>
				<button
					onClick={exportCsv}
					disabled={prompts.length === 0}
					className="ml-auto text-xs px-3 py-1.5 rounded-md border border-neutral-300 dark:border-neutral-700 text-neutral-700 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-800 disabled:opacity-50"
				>
					匯出 CSV
				</button>
				<button
					onClick={onClose}
					className="text-xs px-3 py-1.5 rounded-md text-neutral-600 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-800"
				>
					關閉
				</button>
			</header>

			<div className="flex-1 overflow-auto bg-neutral-50 dark:bg-neutral-950">
				{loading && prompts.length === 0 && (
					<p className="p-6 text-sm text-neutral-500 text-center">載入中…</p>
				)}
				{!loading && prompts.length === 0 && (
					<p className="p-6 text-sm text-neutral-500 text-center">還沒有發送過可追蹤的訊息</p>
				)}
				{prompts.length > 0 && (
					<table className="w-full text-xs">
						<thead className="sticky top-0 bg-neutral-100 dark:bg-neutral-900 text-neutral-600 dark:text-neutral-400">
							<tr>
								<th className="text-left px-3 py-2 font-medium">送出</th>
								<th className="text-left px-3 py-2 font-medium">對象</th>
								<th className="text-left px-3 py-2 font-medium">內容</th>
								<th className="text-left px-3 py-2 font-medium">狀態</th>
								<th className="text-left px-3 py-2 font-medium">回覆時間</th>
							</tr>
						</thead>
						<tbody>
							{prompts.map((p) => (
								<tr
									key={p.id}
									onClick={() => onOpenConversation(p.conversationId)}
									className="border-t border-neutral-200 dark:border-neutral-800 hover:bg-white dark:hover:bg-neutral-900 cursor-pointer"
								>
									<td className="px-3 py-2 whitespace-nowrap text-neutral-500">
										{formatListTime(p.createdAt)}
									</td>
									<td className="px-3 py-2 whitespace-nowrap text-neutral-900 dark:text-neutral-100">
										{p.displayName ?? p.conversationId}
									</td>
									<td className="px-3 py-2 text-neutral-700 dark:text-neutral-300">
										<div className="line-clamp-2">
											{p.variables && Object.keys(p.variables).length > 0
												? Object.entries(p.variables)
														.filter(([, v]) => v)
														.slice(0, 3)
														.map(([k, v]) => `${k}：${v}`)
														.join("　")
												: p.question}
										</div>
									</td>
									<td className="px-3 py-2 whitespace-nowrap">
										{p.allowChange && <span className="mr-1 text-[10px] text-neutral-400" title="允許更改，取最後一次">可改</span>}
										{p.status === "answered" ? (
											<span
												className={`px-1.5 py-0.5 rounded font-medium ${
													p.choice === "no"
														? "bg-red-100 text-red-700 dark:bg-red-900/50 dark:text-red-300"
														: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/50 dark:text-emerald-300"
												}`}
											>
												{p.choiceLabel ?? p.choice}
											</span>
										) : (
											<span className="px-1.5 py-0.5 rounded bg-amber-100 text-amber-700 dark:bg-amber-900/50 dark:text-amber-300">
												待回覆
											</span>
										)}
									</td>
									<td className="px-3 py-2 whitespace-nowrap text-neutral-500">
										{p.respondedAt ? formatListTime(p.respondedAt) : ""}
									</td>
								</tr>
							))}
						</tbody>
					</table>
				)}
			</div>
		</div>
	);
}
