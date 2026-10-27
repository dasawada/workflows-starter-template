import { useCallback, useEffect, useState } from "react";
import type { Conversation, ImportBatch, ImportColumn, ImportMapping, ImportPreview, ImportRowGroup } from "../../shared/types";
import { api } from "../api";
import { formatListTime } from "../format";

interface Props {
	onOpenConversation: (id: string) => void;
	onClose: () => void;
}

const COLUMN_LABEL: Record<ImportColumn, string> = {
	timestamp: "時間（含日期）",
	date: "日期",
	time: "時間",
	chat: "聊天室／使用者名稱",
	sender: "發送者",
	text: "訊息內容",
	type: "類型",
};

/**
 * 歷史匯入：LINE 官方帳號管理後台匯出的聊天紀錄 CSV。
 * 流程：貼上或選檔 → 預覽（欄位偵測、名稱配對）→ 執行 → 報告 → 指派配不到的名稱。
 */
export function ImportPanel({ onOpenConversation, onClose }: Props) {
	const [csv, setCsv] = useState("");
	const [fileName, setFileName] = useState<string | undefined>(undefined);
	const [preview, setPreview] = useState<ImportPreview | null>(null);
	const [mapping, setMapping] = useState<ImportMapping>({});
	const [accountName, setAccountName] = useState("");
	const [assignments, setAssignments] = useState<Record<string, string>>({});
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [result, setResult] = useState<ImportBatch | null>(null);
	const [batches, setBatches] = useState<ImportBatch[]>([]);
	const [selectedBatch, setSelectedBatch] = useState<ImportBatch | null>(null);
	const [groups, setGroups] = useState<ImportRowGroup[]>([]);

	const loadBatches = useCallback(async () => {
		try {
			setBatches((await api.listImports()).batches);
		} catch {
			// ignore
		}
	}, []);

	useEffect(() => {
		void loadBatches();
	}, [loadBatches]);

	const openBatch = async (batch: ImportBatch) => {
		setSelectedBatch(batch);
		try {
			const { groups } = await api.importRows(batch.id);
			setGroups(groups);
		} catch (err) {
			setError(err instanceof Error ? err.message : "載入失敗");
		}
	};

	const onFile = async (file: File | undefined) => {
		if (!file) return;
		setFileName(file.name);
		setCsv(await file.text());
		setPreview(null);
		setResult(null);
	};

	const doPreview = async (override?: ImportMapping) => {
		setBusy(true);
		setError(null);
		try {
			const p = await api.previewImport(csv, override ?? (Object.keys(mapping).length ? mapping : undefined));
			setPreview(p);
			setMapping(p.mapping);
			if (!accountName && p.accountName) setAccountName(p.accountName);
		} catch (err) {
			setError(err instanceof Error ? err.message : "預覽失敗");
		} finally {
			setBusy(false);
		}
	};

	const doImport = async () => {
		setBusy(true);
		setError(null);
		try {
			const { batch } = await api.runImport({ csv, fileName, mapping, accountName: accountName || undefined, assignments });
			setResult(batch);
			setPreview(null);
			setCsv("");
			await loadBatches();
			await openBatch(batch);
		} catch (err) {
			setError(err instanceof Error ? err.message : "匯入失敗");
		} finally {
			setBusy(false);
		}
	};

	const assign = async (group: ImportRowGroup, conversationId: string) => {
		if (!selectedBatch) return;
		try {
			const { batch } = await api.assignImportRows(selectedBatch.id, group.chatName, conversationId);
			await openBatch(batch);
			await loadBatches();
		} catch (err) {
			setError(err instanceof Error ? err.message : "指派失敗");
		}
	};

	const skip = async (group: ImportRowGroup) => {
		if (!selectedBatch) return;
		try {
			const { batch } = await api.skipImportRows(selectedBatch.id, group.chatName);
			await openBatch(batch);
			await loadBatches();
		} catch (err) {
			setError(err instanceof Error ? err.message : "更新失敗");
		}
	};

	return (
		<div className="flex flex-col h-full">
			<header className="flex items-center gap-2 px-4 py-3 border-b border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900">
				<h2 className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">歷史紀錄匯入</h2>
				<span className="text-[11px] text-neutral-500">LINE 官方帳號管理後台 → 聊天 → 匯出的 CSV；只有文字，沒有附件與 userId</span>
				<button onClick={onClose} className="ml-auto text-xs px-3 py-1.5 rounded-md text-neutral-600 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-800">
					關閉
				</button>
			</header>

			<div className="flex-1 overflow-auto bg-neutral-50 dark:bg-neutral-950 p-4 space-y-5 text-xs">
				{error && <p className="text-red-600 dark:text-red-400">{error}</p>}

				<section className="rounded-lg bg-white dark:bg-neutral-900 ring-glass p-3 space-y-2">
					<div className="flex items-center gap-2">
						<label className="px-2.5 py-1 rounded-md border border-neutral-300 dark:border-neutral-700 cursor-pointer hover:bg-neutral-100 dark:hover:bg-neutral-800">
							選擇 CSV 檔
							<input type="file" accept=".csv,text/csv,text/plain" className="hidden" onChange={(e) => void onFile(e.target.files?.[0])} />
						</label>
						{fileName && <span className="text-neutral-500">{fileName}</span>}
						<span className="text-neutral-400">或直接貼上內容：</span>
					</div>
					<textarea
						value={csv}
						onChange={(e) => {
							setCsv(e.target.value);
							setPreview(null);
						}}
						rows={5}
						placeholder={"聊天室名稱,日期,時間,發送者,訊息內容\n王小美,2026/09/01,09:00,王小美,請問有貨嗎"}
						className="w-full font-mono rounded-md border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-800 px-2.5 py-1.5 outline-none focus:ring-2 focus:ring-emerald-500"
					/>
					<div className="flex items-center gap-2">
						<label className="text-neutral-500">
							官方帳號在 CSV 裡的發送者名稱
							<input
								value={accountName}
								onChange={(e) => setAccountName(e.target.value)}
								placeholder="例：商店"
								className="ml-2 rounded-md border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-800 px-2 py-1"
							/>
						</label>
						<button
							onClick={() => void doPreview()}
							disabled={busy || !csv.trim()}
							className="ml-auto px-3 py-1.5 rounded-md bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900 disabled:opacity-50"
						>
							{busy ? "處理中…" : "預覽與配對"}
						</button>
					</div>
				</section>

				{preview && (
					<section className="rounded-lg bg-white dark:bg-neutral-900 ring-glass p-3 space-y-3">
						<div className="flex flex-wrap gap-x-4 gap-y-1 text-neutral-600 dark:text-neutral-300">
							<span>共 {preview.totalRows} 列</span>
							<span>無法解析時間 {preview.invalidRows} 列（會略過）</span>
							{preview.rangeStart && (
								<span>
									期間 {formatListTime(preview.rangeStart)} – {formatListTime(preview.rangeEnd)}
								</span>
							)}
						</div>

						<div>
							<div className="font-medium mb-1">欄位對應{preview.missing.length > 0 && <span className="text-red-600 dark:text-red-400 ml-2">缺少：{preview.missing.map((m) => COLUMN_LABEL[m]).join("、")}</span>}</div>
							<div className="grid grid-cols-2 md:grid-cols-4 gap-2">
								{(Object.keys(COLUMN_LABEL) as ImportColumn[]).map((col) => (
									<label key={col} className="flex flex-col gap-0.5 text-neutral-500">
										{COLUMN_LABEL[col]}
										<select
											value={mapping[col] ?? ""}
											onChange={(e) => {
												const next = { ...mapping };
												if (e.target.value === "") delete next[col];
												else next[col] = Number(e.target.value);
												setMapping(next);
												void doPreview(next);
											}}
											className="rounded-md border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-800 px-2 py-1 text-neutral-900 dark:text-neutral-100"
										>
											<option value="">—</option>
											{preview.headers.map((h, i) => (
												<option key={i} value={i}>
													{h || `欄 ${i + 1}`}
												</option>
											))}
										</select>
									</label>
								))}
							</div>
						</div>

						{preview.sample.length > 0 && (
							<table className="w-full">
								<thead className="text-neutral-500">
									<tr>
										<th className="text-left py-1 font-medium">時間</th>
										<th className="text-left py-1 font-medium">聊天室</th>
										<th className="text-left py-1 font-medium">發送者</th>
										<th className="text-left py-1 font-medium">內容</th>
									</tr>
								</thead>
								<tbody>
									{preview.sample.map((r, i) => (
										<tr key={i} className="border-t border-neutral-100 dark:border-neutral-800">
											<td className="py-1 whitespace-nowrap">{r.sentAt ? formatListTime(r.sentAt) : <span className="text-red-500">無法解析</span>}</td>
											<td className="py-1">{r.chat}</td>
											<td className="py-1">{r.sender}</td>
											<td className="py-1 truncate max-w-xs">{r.text}</td>
										</tr>
									))}
								</tbody>
							</table>
						)}

						<div>
							<div className="font-medium mb-1">名稱配對（{preview.chats.length} 個）</div>
							<ul className="space-y-1">
								{preview.chats.map((c) => (
									<li key={c.name} className="flex items-center gap-2">
										<span className="w-40 truncate">{c.name || "（無名稱）"}</span>
										<span className="text-neutral-500 w-14">{c.rows} 列</span>
										<ChatAssign
											value={assignments[c.name] ?? c.conversationId ?? ""}
											candidates={c.candidates}
											onChange={(id) => setAssignments((prev) => ({ ...prev, [c.name]: id }))}
										/>
										{!c.conversationId && !assignments[c.name] && (
											<span className="text-amber-600 dark:text-amber-400">{c.candidates.length > 1 ? "多筆同名，請指定" : "找不到，匯入後可再指派"}</span>
										)}
									</li>
								))}
							</ul>
						</div>

						<div className="flex justify-end">
							<button
								onClick={() => void doImport()}
								disabled={busy || preview.missing.length > 0}
								className="px-3 py-1.5 rounded-md bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50"
							>
								{busy ? "匯入中…" : "執行匯入"}
							</button>
						</div>
					</section>
				)}

				{result && (
					<section className="rounded-lg bg-emerald-50 dark:bg-emerald-950/40 ring-1 ring-emerald-200 dark:ring-emerald-900 p-3">
						匯入完成：寫入 {result.inserted} 則、重複略過 {result.duplicates} 則、待指派 {result.unmatched} 列、無法解析 {result.skipped} 列。
						{result.unmatched > 0 && "下方可以把找不到對話的名稱指派到正確的對話。"}
					</section>
				)}

				{selectedBatch && groups.length > 0 && (
					<section className="rounded-lg bg-white dark:bg-neutral-900 ring-glass p-3 space-y-2">
						<div className="font-medium">待指派（批次 {formatListTime(selectedBatch.createdAt)}）</div>
						{groups.map((g) => (
							<div key={g.chatName} className="flex items-center gap-2 border-t border-neutral-100 dark:border-neutral-800 pt-2">
								<div className="w-48">
									<div className="truncate">{g.chatName || "（無名稱）"}</div>
									<div className="text-neutral-500 truncate">
										{g.rows} 列 · {formatListTime(g.firstAt)} – {formatListTime(g.lastAt)}
									</div>
									<div className="text-neutral-400 truncate">「{g.sample}」</div>
								</div>
								<ConversationPicker onPick={(id) => void assign(g, id)} />
								<button onClick={() => void skip(g)} className="text-neutral-500 underline">
									略過
								</button>
							</div>
						))}
					</section>
				)}

				<section>
					<div className="font-medium mb-1 text-neutral-700 dark:text-neutral-300">匯入歷史</div>
					{batches.length === 0 ? (
						<p className="text-neutral-500">還沒有匯入過</p>
					) : (
						<table className="w-full bg-white dark:bg-neutral-900 ring-glass rounded-lg">
							<thead className="text-neutral-500">
								<tr>
									<th className="text-left px-3 py-2 font-medium">時間</th>
									<th className="text-left px-3 py-2 font-medium">檔案</th>
									<th className="text-left px-3 py-2 font-medium">寫入</th>
									<th className="text-left px-3 py-2 font-medium">重複</th>
									<th className="text-left px-3 py-2 font-medium">待指派</th>
									<th className="text-left px-3 py-2 font-medium">略過</th>
									<th className="text-left px-3 py-2 font-medium">執行者</th>
								</tr>
							</thead>
							<tbody>
								{batches.map((b) => (
									<tr
										key={b.id}
										onClick={() => void openBatch(b)}
										className={`border-t border-neutral-100 dark:border-neutral-800 cursor-pointer hover:bg-neutral-50 dark:hover:bg-neutral-800/60 ${selectedBatch?.id === b.id ? "bg-emerald-50 dark:bg-emerald-950/30" : ""}`}
									>
										<td className="px-3 py-2 whitespace-nowrap">{formatListTime(b.createdAt)}</td>
										<td className="px-3 py-2 truncate max-w-40">{b.fileName ?? "（貼上）"}</td>
										<td className="px-3 py-2">{b.inserted}</td>
										<td className="px-3 py-2">{b.duplicates}</td>
										<td className={`px-3 py-2 ${b.unmatched > 0 ? "text-amber-600 dark:text-amber-400 font-medium" : ""}`}>{b.unmatched}</td>
										<td className="px-3 py-2">{b.skipped}</td>
										<td className="px-3 py-2">{b.createdBy ?? ""}</td>
									</tr>
								))}
							</tbody>
						</table>
					)}
					{selectedBatch?.report && (
						<ul className="mt-2 space-y-0.5 text-neutral-500">
							{selectedBatch.report.chats.map((c) => (
								<li key={c.name} className="flex gap-2">
									<span className="w-40 truncate">{c.name || "（無名稱）"}</span>
									<span>{c.rows} 列</span>
									{c.conversationId ? (
										<button onClick={() => onOpenConversation(c.conversationId!)} className="underline">
											寫入 {c.inserted}、重複 {c.duplicates}
										</button>
									) : (
										<span>未配對</span>
									)}
								</li>
							))}
						</ul>
					)}
				</section>
			</div>
		</div>
	);
}

function ChatAssign({
	value,
	candidates,
	onChange,
}: {
	value: string;
	candidates: { id: string; displayName: string | null; externalId: string }[];
	onChange: (id: string) => void;
}) {
	if (candidates.length === 0) return <ConversationPicker onPick={onChange} compact picked={value || null} />;
	return (
		<select
			value={value}
			onChange={(e) => onChange(e.target.value)}
			className="rounded-md border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-800 px-2 py-1"
		>
			<option value="">— 不匯入 —</option>
			{candidates.map((c) => (
				<option key={c.id} value={c.id}>
					{c.displayName ?? c.externalId}（{c.externalId.slice(0, 8)}…）
				</option>
			))}
		</select>
	);
}

/** 以名稱搜尋對話並挑一筆 */
function ConversationPicker({ onPick, compact, picked }: { onPick: (id: string) => void; compact?: boolean; picked?: string | null }) {
	const [q, setQ] = useState("");
	const [results, setResults] = useState<Conversation[]>([]);
	useEffect(() => {
		const t = window.setTimeout(() => {
			if (!q.trim()) {
				setResults([]);
				return;
			}
			api
				.listConversations({ status: "all", q, limit: 8 })
				.then((r) => setResults(r.conversations))
				.catch(() => setResults([]));
		}, 250);
		return () => window.clearTimeout(t);
	}, [q]);
	return (
		<div className="relative">
			<input
				value={q}
				onChange={(e) => setQ(e.target.value)}
				placeholder={picked ? `已選 ${picked}` : "搜尋對話名稱或 ID…"}
				className={`rounded-md border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-800 px-2 py-1 ${compact ? "w-44" : "w-56"}`}
			/>
			{results.length > 0 && (
				<ul className="absolute z-10 mt-1 w-64 max-h-48 overflow-auto rounded-md bg-white dark:bg-neutral-800 shadow-float ring-glass">
					{results.map((c) => (
						<li key={c.id}>
							<button
								onClick={() => {
									onPick(c.id);
									setQ("");
									setResults([]);
								}}
								className="w-full text-left px-2 py-1 hover:bg-neutral-100 dark:hover:bg-neutral-700"
							>
								{c.displayName ?? c.externalId}
								<span className="text-neutral-400 ml-1">{c.externalId.slice(0, 10)}…</span>
							</button>
						</li>
					))}
				</ul>
			)}
		</div>
	);
}
