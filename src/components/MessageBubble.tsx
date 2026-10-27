import type { Message } from "../../shared/types";
import { api } from "../api";
import { formatBytes, formatTime } from "../format";

interface Props {
	message: Message;
}

export function MessageBubble({ message }: Props) {
	if (message.sender === "system") {
		return (
			<div className="flex justify-center my-2">
				<span className="text-[11px] text-neutral-500 dark:text-neutral-400 bg-neutral-100 dark:bg-neutral-800 rounded-full px-3 py-1">
					{message.text} · {formatTime(message.createdAt)}
				</span>
			</div>
		);
	}

	const mine = message.direction === "outbound";
	const senderName = message.metadata?.senderName as string | undefined;

	return (
		<div className={`flex ${mine ? "justify-end" : "justify-start"} my-1`}>
			<div className={`max-w-[75%] flex flex-col ${mine ? "items-end" : "items-start"}`}>
				{!mine && senderName && (
					<span className="text-[11px] text-neutral-500 mb-0.5 px-1">{senderName}</span>
				)}
				<div
					className={`rounded-2xl px-3.5 py-2 text-sm whitespace-pre-wrap break-words ${
						mine
							? "bg-emerald-600 text-white rounded-br-md"
							: "bg-white dark:bg-neutral-800 text-neutral-900 dark:text-neutral-100 ring-glass rounded-bl-md"
					}`}
				>
					<Content message={message} />
				</div>
				<span className="text-[10px] text-neutral-400 mt-0.5 px-1">
					{formatTime(message.createdAt)}
				</span>
			</div>
		</div>
	);
}

function Content({ message }: { message: Message }) {
	const meta = message.metadata ?? {};
	const mediaSrc = message.mediaKey
		? api.mediaUrl(message.mediaKey)
		: (meta.externalUrl as string | undefined);

	switch (message.type) {
		case "text":
			return <>{message.text}</>;

		case "prompt": {
			const options = (meta.options as { label: string; value: string }[] | undefined) ?? [];
			const answered = meta.status === "answered";
			const bodyText = message.text?.replace(/\n\n[^\n]*$/, "") ?? "";
			const question = (meta.question as string | undefined) ?? "";
			return (
				<div className="space-y-2">
					{bodyText && bodyText !== question && <div>{bodyText}</div>}
					<div className="rounded-xl bg-white/15 ring-1 ring-white/30 overflow-hidden">
						<div className="px-3 py-2 text-sm">{question}</div>
						<div className="grid grid-cols-2 border-t border-white/30 text-xs">
							{options.map((o, i) => {
								const picked = answered && meta.choice === o.value;
								return (
									<div
										key={o.value}
										className={`py-1.5 text-center ${i > 0 ? "border-l border-white/30" : ""} ${
											picked ? "bg-white text-emerald-700 font-semibold" : "opacity-80"
										}`}
									>
										{o.label}
										{picked ? " ✓" : ""}
									</div>
								);
							})}
						</div>
					</div>
					<div className="text-[11px] opacity-80">
						{answered
							? `已回覆：${(meta.choiceLabel as string) ?? (meta.choice as string)}`
							: "待回覆"}
					</div>
				</div>
			);
		}

		case "sticker":
			return meta.imageUrl ? (
				<img
					src={meta.imageUrl as string}
					alt="貼圖"
					className="w-28 h-28 object-contain -m-1"
				/>
			) : (
				<>[貼圖]</>
			);

		case "image":
			return mediaSrc ? (
				<a href={mediaSrc} target="_blank" rel="noreferrer">
					<img
						src={mediaSrc}
						alt="圖片"
						className="max-w-full max-h-72 rounded-lg -mx-1.5 -my-0.5"
					/>
				</a>
			) : (
				<span className="italic opacity-70">圖片下載中…</span>
			);

		case "video":
			return mediaSrc ? (
				<video src={mediaSrc} controls className="max-w-full max-h-72 rounded-lg -mx-1.5 -my-0.5" />
			) : (
				<span className="italic opacity-70">影片下載中…</span>
			);

		case "audio":
			return mediaSrc ? (
				<audio src={mediaSrc} controls className="max-w-full" />
			) : (
				<span className="italic opacity-70">語音下載中…</span>
			);

		case "file": {
			const name = (meta.fileName as string) || message.text || "檔案";
			const size = typeof meta.fileSize === "number" ? formatBytes(meta.fileSize) : null;
			return mediaSrc ? (
				<a href={mediaSrc} download={name} className="underline">
					📎 {name}
					{size && <span className="opacity-70"> ({size})</span>}
				</a>
			) : (
				<span className="italic opacity-70">📎 {name} 下載中…</span>
			);
		}

		case "location": {
			const lat = meta.latitude as number | undefined;
			const lng = meta.longitude as number | undefined;
			const href =
				lat !== undefined && lng !== undefined
					? `https://www.google.com/maps?q=${lat},${lng}`
					: undefined;
			return (
				<a href={href} target="_blank" rel="noreferrer" className="underline">
					📍 {message.text || "位置"}
				</a>
			);
		}

		default:
			return <span className="italic opacity-70">[不支援的訊息類型]</span>;
	}
}
