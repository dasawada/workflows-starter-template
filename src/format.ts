const timeFmt = new Intl.DateTimeFormat("zh-TW", {
	hour: "2-digit",
	minute: "2-digit",
	hour12: false,
});
const dateTimeFmt = new Intl.DateTimeFormat("zh-TW", {
	month: "numeric",
	day: "numeric",
	hour: "2-digit",
	minute: "2-digit",
	hour12: false,
});
const dateFmt = new Intl.DateTimeFormat("zh-TW", {
	year: "numeric",
	month: "long",
	day: "numeric",
	weekday: "short",
});

function isSameDay(a: Date, b: Date) {
	return (
		a.getFullYear() === b.getFullYear() &&
		a.getMonth() === b.getMonth() &&
		a.getDate() === b.getDate()
	);
}

/** 清單用：今天顯示時間，否則顯示月/日 時:分 */
export function formatListTime(ts: number | null): string {
	if (!ts) return "";
	const d = new Date(ts);
	return isSameDay(d, new Date()) ? timeFmt.format(d) : dateTimeFmt.format(d);
}

export function formatTime(ts: number): string {
	return timeFmt.format(new Date(ts));
}

export function formatDateHeading(ts: number): string {
	const d = new Date(ts);
	const today = new Date();
	if (isSameDay(d, today)) return "今天";
	const yesterday = new Date(today);
	yesterday.setDate(today.getDate() - 1);
	if (isSameDay(d, yesterday)) return "昨天";
	return dateFmt.format(d);
}

export function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
