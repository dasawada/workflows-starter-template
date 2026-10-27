import type { ReactNode } from "react";

export const inputCls =
	"w-full rounded-lg border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-800 px-3 py-1.5 text-sm text-neutral-900 dark:text-neutral-100 outline-none focus:ring-2 focus:ring-emerald-500 disabled:opacity-60";

interface TextFieldProps {
	label: string;
	value: string;
	onChange: (v: string) => void;
	max: number;
	multiline?: boolean;
	rows?: number;
	placeholder?: string;
	hint?: string;
	required?: boolean;
	type?: "text" | "url" | "date" | "datetime-local" | "time" | "color";
}

/** 有字數計數、超過上限自動裁掉的輸入框 */
export function TextField({
	label,
	value,
	onChange,
	max,
	multiline,
	rows = 3,
	placeholder,
	hint,
	required,
	type = "text",
}: TextFieldProps) {
	const len = [...value].length;
	const near = len >= max * 0.9;
	const handle = (v: string) => onChange([...v].slice(0, max).join(""));
	return (
		<label className="block">
			<span className="flex items-baseline text-xs font-medium text-neutral-600 dark:text-neutral-400 mb-1">
				{label}
				{required && <span className="text-red-500 ml-0.5">*</span>}
				<span className={`ml-auto font-normal tabular-nums ${near ? "text-amber-600" : "text-neutral-400"}`}>
					{len}/{max}
				</span>
			</span>
			{multiline ? (
				<textarea
					value={value}
					rows={rows}
					placeholder={placeholder}
					onChange={(e) => handle(e.target.value)}
					className={`${inputCls} resize-y`}
				/>
			) : (
				<input
					type={type}
					value={value}
					placeholder={placeholder}
					onChange={(e) => handle(e.target.value)}
					className={inputCls}
				/>
			)}
			{hint && <span className="block text-[11px] text-neutral-400 mt-1">{hint}</span>}
		</label>
	);
}

interface SelectFieldProps<T extends string> {
	label: string;
	value: T;
	onChange: (v: T) => void;
	options: { value: T; label: string }[];
}

export function SelectField<T extends string>({ label, value, onChange, options }: SelectFieldProps<T>) {
	return (
		<label className="block">
			<span className="block text-xs font-medium text-neutral-600 dark:text-neutral-400 mb-1">{label}</span>
			<select value={value} onChange={(e) => onChange(e.target.value as T)} className={inputCls}>
				{options.map((o) => (
					<option key={o.value} value={o.value}>
						{o.label}
					</option>
				))}
			</select>
		</label>
	);
}

export function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
	return (
		<label className="flex items-center gap-2 text-xs text-neutral-700 dark:text-neutral-300">
			<input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="accent-emerald-600" />
			{label}
		</label>
	);
}

export function SmallButton({
	children,
	onClick,
	disabled,
	danger,
	title,
}: {
	children: ReactNode;
	onClick: () => void;
	disabled?: boolean;
	danger?: boolean;
	title?: string;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			disabled={disabled}
			title={title}
			className={`text-[11px] px-2 py-1 rounded-md border disabled:opacity-40 ${
				danger
					? "border-red-200 text-red-600 hover:bg-red-50 dark:border-red-900 dark:hover:bg-red-950/40"
					: "border-neutral-300 dark:border-neutral-700 text-neutral-700 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-800"
			}`}
		>
			{children}
		</button>
	);
}

export function Group({ title, children, right }: { title: string; children: ReactNode; right?: ReactNode }) {
	return (
		<div className="rounded-lg border border-neutral-200 dark:border-neutral-800 p-3 space-y-2 bg-white dark:bg-neutral-900">
			<div className="flex items-center">
				<span className="text-xs font-semibold text-neutral-700 dark:text-neutral-300">{title}</span>
				<span className="ml-auto flex gap-1">{right}</span>
			</div>
			{children}
		</div>
	);
}
