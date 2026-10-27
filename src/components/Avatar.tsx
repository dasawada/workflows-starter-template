interface Props {
	name: string | null;
	url: string | null;
	size?: number;
}

export function Avatar({ name, url, size = 40 }: Props) {
	const initial = (name ?? "?").trim().charAt(0).toUpperCase() || "?";
	const style = { width: size, height: size, fontSize: size * 0.4 };
	if (url) {
		return (
			<img
				src={url}
				alt=""
				style={style}
				className="rounded-full object-cover shrink-0 bg-neutral-200 dark:bg-neutral-700"
				referrerPolicy="no-referrer"
			/>
		);
	}
	return (
		<div
			style={style}
			className="rounded-full shrink-0 bg-emerald-100 dark:bg-emerald-900/50 text-emerald-700 dark:text-emerald-300 flex items-center justify-center font-semibold"
		>
			{initial}
		</div>
	);
}
