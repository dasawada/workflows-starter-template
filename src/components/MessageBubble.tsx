import { useState } from "react";
import type { Message, MessageQuote } from "../../shared/types";
import { api } from "../api";
import { formatBytes, formatTime } from "../format";
import { LinePreview } from "./LinePreview";

interface Props {
	message: Message;
	/** 送出失敗／不明的客服訊息可重推 */
	onRetry?: (messageId: string) => void;
	/** 客服覺得這則有問題：按驚嘆號回報，不必說明原因 */
	onReport?: (messageId: string, note?: string) => Promise<void>;
}

export function MessageBubble({ message, onRetry, onReport }: Props) {
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
	const imported = message.source === "manager_csv";
	const reported = typeof message.metadata?.reportedAt === "number";
	const report = onReport ? <ReportButton messageId={message.id} reported={reported} onReport={onReport} /> : null;

	// 結構固定：客服訊息靠右（驚嘆號在左側）、使用者訊息靠左（驚嘆號在右側）。不用 flex-row-reverse，避免對齊方向被反轉。
	return (
		<div className={`group flex items-end gap-1 ${mine ? "justify-end" : "justify-start"} my-1`}>
			{mine && report}
			<div className={`max-w-[75%] flex flex-col ${mine ? "items-end" : "items-start"}`}>
				{!mine && senderName && (
					<span className="text-[11px] text-neutral-500 mb-0.5 px-1">{senderName}</span>
				)}
				{mine && message.agentName && (
					<span className="text-[11px] text-neutral-500 mb-0.5 px-1">{message.agentName}</span>
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
				<span className="text-[10px] text-neutral-400 mt-0.5 px-1 flex items-center gap-1">
					{formatTime(message.createdAt)}
					{imageSet && ` · 第 ${imageSet.index}/${imageSet.total} 張`}
					{message.editedAt && !message.unsentAt && " · 已編輯"}
					{imported && (
						<span title="此紀錄來自官方後台 CSV 匯入，而非即時接收的事件" className="px-1 rounded bg-neutral-200 text-neutral-600 dark:bg-neutral-700 dark:text-neutral-300">
							匯入紀錄
						</span>
					)}
					{mine && <DeliveryBadge message={message} onRetry={onRetry} />}
				</span>
			</div>
			{!mine && report}
		</div>
	);
}

/**
 * 驚嘆號：客服覺得這則訊息有問題，按一下即回報，不開任何浮層、不要求說明。
 * 回報後改顯示「已回報」。上下文由伺服器收齊，工程端每天用 npm run reports 讀取。
 */
function ReportButton({
	messageId,
	reported,
	onReport,
}: {
	messageId: string;
	reported: boolean;
	onReport: (messageId: string, note?: string) => Promise<void>;
}) {
	const [busy, setBusy] = useState(false);
	if (reported) {
		return (
			<span className="shrink-0 mb-4 text-[10px] text-amber-600 dark:text-amber-400" title="已回報，工程端會處理">
				已回報
			</span>
		);
	}
	return (
		<button
			type="button"
			disabled={busy}
			onClick={async () => {
				setBusy(true);
				try {
					await onReport(messageId);
				} finally {
					setBusy(false);
				}
			}}
			title="這則訊息有問題？按一下回報"
			aria-label="回報此訊息"
			className="shrink-0 mb-4 w-6 h-6 rounded-full text-xs font-semibold leading-none opacity-0 group-hover:opacity-100 focus-visible:opacity-100 bg-neutral-200 text-neutral-600 dark:bg-neutral-700 dark:text-neutral-300 hover:bg-amber-500 hover:text-white disabled:opacity-50 transition-opacity"
		>
			!
		</button>
	);
}

/**
 * 送達狀態：只顯示有證據的狀態。sent = LINE 已接受（不等於使用者已讀，LINE 沒有這個 API）。
 */
function DeliveryBadge({ message, onRetry }: { message: Message; onRetry?: (id: string) => void }) {
	switch (message.deliveryStatus) {
		case "sent":
			return <span title="LINE 已接受此訊息；無法得知使用者是否已讀">· 已發送</span>;
		case "pending":
			return <span className="text-amber-600 dark:text-amber-400" title="尚未收到 LINE 的確認，系統將自動重試">· 發送中</span>;
		case "failed":
			return (
				<span className="text-red-600 dark:text-red-400" title={String(message.metadata?.deliveryError ?? "")}>
					· 發送失敗
					{onRetry && (
						<button onClick={() => onRetry(message.id)} className="ml-1 underline">
							重新發送
						</button>
					)}
				</span>
			);
		case "unknown":
			return (
				<span className="text-red-600 dark:text-red-400" title="超過 24 小時仍無法確認 LINE 是否已發送，請向使用者確認">
					· 結果不明
					{onRetry && (
						<button onClick={() => onRetry(message.id)} className="ml-1 underline">
							重新發送
						</button>
					)}
				</span>
			);
		default:
			return null;
	}
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
								: "[訊息內容已無法取得]");
	return (
		<div className={`border-l-2 pl-2 mb-1.5 text-xs ${tone}`}>
			<div className="font-medium">引用{who}訊息</div>
			<div className="line-clamp-3 opacity-90">{preview}</div>
		</div>
	);
}

/** 附件尚未取得或已無法取得時，明確標示屬於哪一種情況 */
function MediaPending({ message, label }: { message: Message; label: string }) {
	if (message.mediaStatus === "expired") {
		return <span className="italic opacity-70">{label}已逾 LINE 平台保留期限，無法取得</span>;
	}
	if (message.mediaStatus === "failed") {
		return <span className="italic opacity-70">{label}下載失敗，系統將再次嘗試</span>;
	}
	return <span className="italic opacity-70">{label}下載中…</span>;
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
								? `已回覆：${(meta.choiceLabel as string) ?? (meta.choice as string)}`
								: "待回覆"}
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
				<MediaPending message={message} label="圖片" />
			);

		case "video":
			return mediaSrc ? (
				<video src={mediaSrc} controls className="max-w-full max-h-72 rounded-lg -mx-1.5 -my-0.5" />
			) : (
				<MediaPending message={message} label="影片" />
			);

		case "audio":
			return mediaSrc ? (
				<audio src={mediaSrc} controls className="max-w-full" />
			) : (
				<MediaPending message={message} label="語音" />
			);

		case "file": {
			const name = (meta.fileName as string) || message.text || "檔案";
			const size = typeof meta.fileSize === "number" ? formatBytes(meta.fileSize) : null;
			return mediaSrc ? (
				<a href={mediaSrc} download={name} className="underline">
					附件：{name}
					{size && <span className="opacity-70"> ({size})</span>}
				</a>
			) : (
				<MediaPending message={message} label={`附件 ${name} `} />
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
					位置：{message.text || "未提供地址"}
				</a>
			);
		}

		default:
			return <span className="italic opacity-70">[不支援的訊息類型]</span>;
	}
}
