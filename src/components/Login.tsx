import { useState, type FormEvent } from "react";

interface Props {
	error: string | null;
	busy: boolean;
	initialName: string | null;
	onSubmit: (token: string, agentName: string) => void;
}

export function Login({ error, busy, initialName, onSubmit }: Props) {
	const [token, setToken] = useState("");
	const [name, setName] = useState(initialName ?? "");

	const handleSubmit = (e: FormEvent) => {
		e.preventDefault();
		if (token.trim() && name.trim()) onSubmit(token.trim(), name.trim());
	};

	return (
		<div className="min-h-screen flex items-center justify-center bg-neutral-100 dark:bg-neutral-950 px-4">
			<form
				onSubmit={handleSubmit}
				className="w-full max-w-sm bg-white dark:bg-neutral-900 rounded-2xl shadow-float ring-glass p-6 space-y-4"
			>
				<div>
					<h1 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100">
						客服收發台
					</h1>
					<p className="text-sm text-neutral-500 dark:text-neutral-400 mt-1">
						請輸入客服名稱與客服台存取密鑰（CONSOLE_TOKEN）
					</p>
				</div>
				<input
					type="text"
					autoFocus={!initialName}
					value={name}
					onChange={(e) => setName(e.target.value)}
					maxLength={40}
					placeholder="客服名稱（供同事識別，用於接手與回覆衝突偵測）"
					className="w-full rounded-lg border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-800 px-3 py-2 text-sm text-neutral-900 dark:text-neutral-100 outline-none focus:ring-2 focus:ring-emerald-500"
				/>
				<input
					type="password"
					autoFocus={!!initialName}
					value={token}
					onChange={(e) => setToken(e.target.value)}
					placeholder="存取密鑰"
					className="w-full rounded-lg border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-800 px-3 py-2 text-sm text-neutral-900 dark:text-neutral-100 outline-none focus:ring-2 focus:ring-emerald-500"
				/>
				{error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
				<button
					type="submit"
					disabled={busy || !token.trim() || !name.trim()}
					className="w-full rounded-lg bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white text-sm font-medium py-2 transition-colors"
				>
					{busy ? "驗證中…" : "登入"}
				</button>
			</form>
		</div>
	);
}
