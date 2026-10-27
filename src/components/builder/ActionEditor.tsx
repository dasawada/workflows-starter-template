import { LIMITS } from "../../builder/limits";
import type { ActionDraft } from "../../builder/types";
import { newAction } from "../../builder/types";
import { SelectField, SmallButton, TextField, Toggle } from "./fields";

const KINDS: { value: ActionDraft["kind"]; label: string }[] = [
	{ value: "postback", label: "選項（記錄至資料庫）" },
	{ value: "datetimepicker", label: "選擇日期／時間（記錄至資料庫）" },
	{ value: "message", label: "代使用者發送文字" },
	{ value: "uri", label: "開啟網址" },
];

interface Props {
	action: ActionDraft;
	index: number;
	labelMax?: number;
	onChange: (a: ActionDraft) => void;
	onRemove?: () => void;
	onMove?: (dir: -1 | 1) => void;
}

export function ActionEditor({ action, index, labelMax = LIMITS.actionLabel, onChange, onRemove, onMove }: Props) {
	const setKind = (kind: ActionDraft["kind"]) => {
		if (kind === action.kind) return;
		const next = newAction(kind);
		next.label = action.label;
		onChange(next);
	};

	return (
		<div className="rounded-md bg-neutral-50 dark:bg-neutral-800/60 p-2.5 space-y-2">
			<div className="flex items-center gap-1">
				<span className="text-[11px] font-medium text-neutral-500">按鈕 {index + 1}</span>
				<span className="ml-auto flex gap-1">
					{onMove && <SmallButton onClick={() => onMove(-1)} title="上移">↑</SmallButton>}
					{onMove && <SmallButton onClick={() => onMove(1)} title="下移">↓</SmallButton>}
					{onRemove && <SmallButton onClick={onRemove} danger>移除</SmallButton>}
				</span>
			</div>
			<div className="grid grid-cols-2 gap-2">
				<TextField label="按鈕文字" value={action.label} onChange={(v) => onChange({ ...action, label: v })} max={labelMax} required />
				<SelectField label="動作" value={action.kind} onChange={setKind} options={KINDS} />
			</div>

			{action.kind === "postback" && (
				<>
					<div className="grid grid-cols-2 gap-2">
						<TextField
							label="選項值"
							value={action.value}
							onChange={(v) => onChange({ ...action, value: v })}
							max={50}
							required
							placeholder="accept"
							hint="記錄至資料庫的代碼，建議使用英文或短字串"
						/>
						<TextField
							label="聊天室顯示文字"
							value={action.displayText}
							onChange={(v) => onChange({ ...action, displayText: v })}
							max={LIMITS.displayText}
							placeholder="承接"
							hint="留空則不顯示"
						/>
					</div>
					<Toggle
						label="按下後開啟鍵盤，供使用者補充文字"
						checked={action.openKeyboard}
						onChange={(v) => onChange({ ...action, openKeyboard: v })}
					/>
					{action.openKeyboard && (
						<TextField
							label="預填文字"
							value={action.fillInText}
							onChange={(v) => onChange({ ...action, fillInText: v })}
							max={LIMITS.fillInText}
							multiline
							rows={2}
							placeholder="不承接的原因是："
						/>
					)}
				</>
			)}

			{action.kind === "message" && (
				<TextField
					label="發送的文字"
					value={action.text}
					onChange={(v) => onChange({ ...action, text: v })}
					max={LIMITS.messageActionText}
					required
					placeholder="我想詢問這堂課的細節"
				/>
			)}

			{action.kind === "uri" && (
				<TextField
					label="網址"
					value={action.uri}
					onChange={(v) => onChange({ ...action, uri: v })}
					max={LIMITS.uri}
					type="url"
					required
					placeholder="https://"
				/>
			)}

			{action.kind === "datetimepicker" && (
				<div className="grid grid-cols-2 gap-2">
					<TextField label="選項值" value={action.value} onChange={(v) => onChange({ ...action, value: v })} max={50} required placeholder="reschedule" />
					<SelectField
						label="選擇類型"
						value={action.mode}
						onChange={(v) => onChange({ ...action, mode: v })}
						options={[
							{ value: "date", label: "日期" },
							{ value: "time", label: "時間" },
							{ value: "datetime", label: "日期＋時間" },
						]}
					/>
					<TextField
						label="最早可選"
						value={action.min}
						onChange={(v) => onChange({ ...action, min: v })}
						max={20}
						type={action.mode === "date" ? "date" : action.mode === "time" ? "time" : "datetime-local"}
					/>
					<TextField
						label="最晚可選"
						value={action.max}
						onChange={(v) => onChange({ ...action, max: v })}
						max={20}
						type={action.mode === "date" ? "date" : action.mode === "time" ? "time" : "datetime-local"}
					/>
				</div>
			)}
		</div>
	);
}

interface ListProps {
	actions: ActionDraft[];
	min: number;
	max: number;
	labelMax?: number;
	title?: string;
	onChange: (actions: ActionDraft[]) => void;
}

export function ActionList({ actions, min, max, labelMax, title = "按鈕", onChange }: ListProps) {
	const update = (i: number, a: ActionDraft) => onChange(actions.map((x, j) => (j === i ? a : x)));
	const remove = (i: number) => onChange(actions.filter((_, j) => j !== i));
	const move = (i: number, dir: -1 | 1) => {
		const j = i + dir;
		if (j < 0 || j >= actions.length) return;
		const next = actions.slice();
		[next[i], next[j]] = [next[j], next[i]];
		onChange(next);
	};
	return (
		<div className="space-y-2">
			<div className="flex items-center">
				<span className="text-xs font-medium text-neutral-600 dark:text-neutral-400">
					{title}（{actions.length}/{max}）
				</span>
				<span className="ml-auto">
					<SmallButton onClick={() => onChange([...actions, newAction("postback")])} disabled={actions.length >= max}>
						＋ 新增
					</SmallButton>
				</span>
			</div>
			{actions.map((a, i) => (
				<ActionEditor
					key={i}
					action={a}
					index={i}
					labelMax={labelMax}
					onChange={(x) => update(i, x)}
					onRemove={actions.length > min ? () => remove(i) : undefined}
					onMove={actions.length > 1 ? (d) => move(i, d) : undefined}
				/>
			))}
		</div>
	);
}
