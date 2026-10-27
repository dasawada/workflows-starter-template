import type { Message, MessageQuote } from "../../shared/types";
import { api } from "../api";
import { formatBytes, formatTime } from "../format";
import { LinePreview } from "./LinePreview";

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
	const senderName =
		(message.metadata?.senderName as string | undefined) ??
		(message.metadata?.senderUserId as string | undefined);
	const quote = message.unsentAt ? null : (message.metadata?.quote as MessageQuote | undefined);
	const imageSet = message.metadata?.imageSet as { index: number; total: number } | undefined;

	return (
		<div className={`flex ${mine ? "justify-end" : "justify-start"} my-1`}>
			<div className={`max-w-[75%] flex flex-col ${mine ? "items-end" : "items-start"}`}>
				{!mine && senderName && (
					<span className="text-[11px] text-neutral-500 mb-0.5 px-1">{senderName}</span>
				)}
				<div
					className={`rounded-2xl px-3.5 py-2 text-sm whitespace-pre-wrap break-words ${
						message.unsentAt
							? "bg-neutral-100 dark:bg-neutral-800/60 text-neutral-400 italic rounded-bl-md"
							: mine
								? "bg-emerald-600 text-white rounded-br-md"
								: "bg-white dark:bg-neutral-800 text-neutral-900 dark:text-neutral-100 ring-glass rounded-bl-md"
					}`}
				>
					{quote && <QuoteBlock quote={quote} mine={mine} />}
					{message.unsentAt ? <>此訊息已被使用者撤回</> : <Content message={message} />}
				</div>
				<span className="text-[10px] text-neutral-400 mt-0.5 px-1">
					{formatTime(message.createdAt)}
					{imageSet && ` · 第 ${imageSet.index}/${imageSet.total} 張`}
					{message.editedAt && !message.unsentAt && " · 已編輯"}
				</span>
			</div>
		</div>
	);
}

/**
 * 引用區塊：本地找得到原文就顯示，找不到一定要明講，客服才知道這句話是在回某則我們沒有的訊息。
 */
function QuoteBlock({ quote, mine }: { quote: MessageQuote; mine: boolean }) {
	const tone = mine ? "border-white/60 text-white/85" : "border-emerald-500 text-neutral-500 dark:text-neutral-400";
	if (!quote.messageId) {
		return (
			<div className={`border-l-2 pl-2 mb-1.5 text-xs ${tone}`}>
				<div className="font-medium">引用的原始訊息無法取得</div>
				<div className="opacity-80">可能發送於串接之前，或來自未同步的訊息來源</div>
			</div>
		);
	}
	const who = quote.sender === "user" ? "使用者" : quote.sender === "agent" ? "客服" : "系統";
	const preview =
		quote.text ??
		(quote.type === "image"
			? "[圖片]"
			: quote.type === "video"
				? "[影片]"
				: quote.type === "audio"
					? "[語音]"
					: quote.type === "file"
						? "[檔案]"
						: quote.type === "sticker"
							? "[貼圖]"
							: quote.type === "location"
								? "[位置]"
								: "[訊息內容已不可用]");
	return (
		<div className={`border-l-2 pl-2 mb-1.5 text-xs ${tone}`}>
			<div className="font-medium">引用{who}訊息</div>
			<div className="line-clamp-3 opacity-90">{preview}</div>
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

		case "prompt":
		case "rich": {
			const payload = Array.isArray(meta.payload) ? (meta.payload as unknown[]) : null;
			const answered = meta.status === "answered";
			return (
				<div className="space-y-2 -mx-1.5">
					{payload ? (
						<LinePreview messages={payload} compact />
					) : (
						<div className="px-1.5 whitespace-pre-wrap">{message.text}</div>
					)}
					{message.type === "prompt" && (
						<div className="text-[11px] opacity-90 px-1.5">
							{answered
								? `✓ 已回覆：${(meta.choiceLabel as string) ?? (meta.choice as string)}`
								: "⏳ 待回覆"}
						</div>
					)}
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
