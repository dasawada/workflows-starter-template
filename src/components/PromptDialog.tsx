import { useMemo, useState } from "react";
import type { PromptOption, SendPromptInput } from "../../shared/types";
import {
	PROMPT_TEMPLATES,
	extractVariables,
	renderTemplate,
} from "../templates";

interface Props {
	onClose: () => void;
	onSend: (input: SendPromptInput) => Promise<void>;
}

const QUESTION_MAX = 240;

export function PromptDialog({ onClose, onSend }: Props) {
	const [templateKey, setTemplateKey] = useState(PROMPT_TEMPLATES[1]?.key ?? "blank");
	const template = useMemo(
		() => PROMPT_TEMPLATES.find((t) => t.key === templateKey) ?? PROMPT_TEMPLATES[0],
		[templateKey],
	);
	const [body, setBody] = useState(template.body);
	const [question, setQuestion] = useState(template.question);
	const [options, setOptions] = useState<PromptOption[]>(template.options);
	const [values, setValues] = useState<Record<string, string>>({});
	const [sending, setSending] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const variables = useMemo(() => extractVariables(body), [body]);
	const rendered = useMemo(() => renderTemplate(body, values), [body, values]);
	const missing = variables.filter((v) => !values[v]?.trim());

	const pickTemplate = (key: string) => {
		const t = PROMPT_TEMPLATES.find((x) => x.key === key);
		if (!t) return;
		setTemplateKey(key);
		setBody(t.body);
		setQuestion(t.question);
		setOptions(t.options);
		setValues({});
	};

	const updateOption = (index: number, label: string) => {
		setOptions((prev) =>
			prev.map((o, i) => (i === index ? { label, value: o.value } : o)),
		);
	};

	const submit = async () => {
		if (sending) return;
		setError(null);
		if (!question.trim()) return setError("請填寫問句");
		if (options.some((o) => !o.label.trim())) return setError("按鈕文字不可空白");
		if (missing.length > 0 && !confirm(`尚有變數未填：${missing.join("、")}。仍要送出嗎？`)) return;
		setSending(true);
		try {
			await onSend({
				body: rendered,
				question: question.trim(),
				options: options.map((o) => ({ label: o.label.trim(), value: o.value })),
				templateKey,
				variables: values,
			});
			onClose();
		} catch (err) {
			setError(err instanceof Error ? err.message : "送出失敗");
		} finally {
			setSending(false);
		}
	};

	const field =
		"w-full rounded-lg border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-800 px-3 py-2 text-sm text-neutral-900 dark:text-neutral-100 outline-none focus:ring-2 focus:ring-emerald-500";
	const label = "block text-xs font-medium text-neutral-600 dark:text-neutral-400 mb-1";

	return (
		<div
			className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4"
			onClick={onClose}
		>
			<div
				className="w-full max-w-3xl max-h-[90vh] overflow-y-auto bg-white dark:bg-neutral-900 rounded-2xl shadow-float ring-glass"
				onClick={(e) => e.stopPropagation()}
			>
				<div className="flex items-center justify-between px-5 py-3 border-b border-neutral-200 dark:border-neutral-800">
					<h2 className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">
						發送可追蹤的選擇題
					</h2>
					<button
						onClick={onClose}
						className="text-neutral-500 hover:text-neutral-900 dark:hover:text-neutral-100 text-xl leading-none"
						aria-label="關閉"
					>
						×
					</button>
				</div>

				<div className="grid grid-cols-1 md:grid-cols-2 gap-4 p-5">
					<div className="space-y-3">
						<div>
							<label className={label}>範本</label>
							<select
								value={templateKey}
								onChange={(e) => pickTemplate(e.target.value)}
								className={field}
							>
								{PROMPT_TEMPLATES.map((t) => (
									<option key={t.key} value={t.key}>
										{t.name}
									</option>
								))}
							</select>
						</div>

						{variables.length > 0 && (
							<div className="space-y-2 rounded-lg bg-neutral-50 dark:bg-neutral-800/60 p-3">
								<div className="text-xs font-medium text-neutral-600 dark:text-neutral-400">
									填入變數
								</div>
								{variables.map((name) => (
									<div key={name}>
										<label className={label}>{name}</label>
										{name.includes("時段") || name.includes("狀況") ? (
											<textarea
												rows={2}
												value={values[name] ?? ""}
												onChange={(e) => setValues((v) => ({ ...v, [name]: e.target.value }))}
												className={field}
											/>
										) : (
											<input
												value={values[name] ?? ""}
												onChange={(e) => setValues((v) => ({ ...v, [name]: e.target.value }))}
												className={field}
											/>
										)}
									</div>
								))}
							</div>
						)}

						<div>
							<label className={label}>正文（可直接修改，{"{{變數}}"} 會變成上方欄位）</label>
							<textarea
								rows={8}
								value={body}
								onChange={(e) => setBody(e.target.value)}
								className={`${field} font-mono text-xs`}
							/>
						</div>
					</div>

					<div className="space-y-3">
						<div>
							<label className={label}>
								按鈕上方的問句（{question.length}/{QUESTION_MAX}）
							</label>
							<input
								value={question}
								maxLength={QUESTION_MAX}
								onChange={(e) => setQuestion(e.target.value)}
								className={field}
							/>
						</div>

						<div>
							<label className={label}>按鈕文字（最多兩顆，各 20 字）</label>
							<div className="flex gap-2">
								{options.map((o, i) => (
									<input
										key={o.value}
										value={o.label}
										maxLength={20}
										onChange={(e) => updateOption(i, e.target.value)}
										className={field}
									/>
								))}
							</div>
						</div>

						<div>
							<label className={label}>預覽（使用者會收到）</label>
							<div className="rounded-xl bg-neutral-100 dark:bg-neutral-800 p-3 space-y-2">
								{rendered.trim() && (
									<div className="rounded-2xl rounded-bl-md bg-white dark:bg-neutral-700 px-3 py-2 text-xs whitespace-pre-wrap text-neutral-900 dark:text-neutral-100">
										{rendered}
									</div>
								)}
								<div className="rounded-2xl rounded-bl-md bg-white dark:bg-neutral-700 overflow-hidden text-xs">
									<div className="px-3 py-3 text-neutral-900 dark:text-neutral-100 whitespace-pre-wrap">
										{question || "（問句）"}
									</div>
									<div className="grid grid-cols-2 border-t border-neutral-200 dark:border-neutral-600">
										{options.map((o, i) => (
											<div
												key={o.value}
												className={`py-2 text-center text-sky-600 dark:text-sky-300 font-medium ${
													i > 0 ? "border-l border-neutral-200 dark:border-neutral-600" : ""
												}`}
											>
												{o.label || "（按鈕）"}
											</div>
										))}
									</div>
								</div>
							</div>
							{missing.length > 0 && (
								<p className="text-[11px] text-amber-600 mt-1">
									未填：{missing.join("、")}
								</p>
							)}
						</div>
					</div>
				</div>

				<div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-neutral-200 dark:border-neutral-800">
					{error && <span className="text-xs text-red-600 mr-auto">{error}</span>}
					<button
						onClick={onClose}
						className="text-sm px-4 py-2 rounded-lg text-neutral-600 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-800"
					>
						取消
					</button>
					<button
						onClick={() => void submit()}
						disabled={sending}
						className="text-sm font-medium px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white"
					>
						{sending ? "送出中…" : "送出"}
					</button>
				</div>
			</div>
		</div>
	);
}
