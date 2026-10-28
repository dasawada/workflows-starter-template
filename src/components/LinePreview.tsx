import type { CSSProperties, ReactNode } from "react";

/**
 * 近似重現 LINE 聊天室裡的呈現，給編輯時參考；
 * Flex 只實作常用元件（box / text / button / separator / image），細節以 LINE 官方 Flex Message Simulator 為準。
 */

type Json = Record<string, unknown>;
const obj = (v: unknown): Json | null =>
	typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Json) : null;
const str = (v: unknown, fallback = ""): string => (typeof v === "string" ? v : fallback);

interface Props {
	messages: unknown[];
	compact?: boolean;
}

export function LinePreview({ messages, compact = false }: Props) {
	const cls = compact ? "space-y-1.5" : "space-y-2";
	return (
		<div className={cls}>
			{messages.map((raw, i) => {
				const m = obj(raw);
				if (!m) return <Invalid key={i} text="不是物件" />;
				return (
					<div key={i}>
						<MessageView message={m} compact={compact} />
						{obj(m.quickReply) && <QuickReplyView quickReply={obj(m.quickReply)!} />}
					</div>
				);
			})}
		</div>
	);
}

function Invalid({ text }: { text: string }) {
	return <div className="text-[11px] text-red-600">{text}</div>;
}

function Card({ children, compact }: { children: ReactNode; compact?: boolean }) {
	return (
		<div
			className={`rounded-2xl rounded-bl-md bg-white text-neutral-900 overflow-hidden ring-1 ring-black/5 ${
				compact ? "max-w-[260px]" : "max-w-[300px]"
			}`}
		>
			{children}
		</div>
	);
}

function MessageView({ message, compact }: { message: Json; compact: boolean }) {
	switch (message.type) {
		case "text":
			return (
				<Card compact={compact}>
					<div className="px-3 py-2 text-xs whitespace-pre-wrap">{str(message.text)}</div>
				</Card>
			);
		case "sticker":
			return <Card compact={compact}><div className="px-3 py-2 text-xs">貼圖 {str(message.packageId)}/{str(message.stickerId)}</div></Card>;
		case "image":
			return <Card compact={compact}><img src={str(message.previewImageUrl) || str(message.originalContentUrl)} alt="" className="max-w-full" /></Card>;
		case "location":
			return <Card compact={compact}><div className="px-3 py-2 text-xs">位置：{str(message.title)}<br />{str(message.address)}</div></Card>;
		case "template":
			return <TemplateView message={message} compact={compact} />;
		case "flex":
			return <FlexView message={message} compact={compact} />;
		default:
			return <Invalid text={`不支援預覽的類型：${str(message.type, "?")}`} />;
	}
}

// ---------- Template ----------

function ActionButton({ action, divider }: { action: unknown; divider?: boolean }) {
	const a = obj(action);
	const label = str(a?.label, "（按鈕）");
	const kind = str(a?.type);
	// LINE 的按鈕外觀不分類型；類型放在滑過提示，不另加圖示
	const kindLabel =
		kind === "postback" ? "回傳選擇" : kind === "uri" ? "開啟網址" : kind === "datetimepicker" ? "選擇日期時間" : kind === "message" ? "以使用者身分發送文字" : undefined;
	return (
		<div title={kindLabel} className={`py-2 text-center text-xs text-sky-600 font-medium ${divider ? "border-t border-neutral-200" : ""}`}>
			{label}
		</div>
	);
}

function TemplateView({ message, compact }: { message: Json; compact: boolean }) {
	const t = obj(message.template);
	if (!t) return <Invalid text="template 缺少內容" />;
	const actions = Array.isArray(t.actions) ? t.actions : [];

	if (t.type === "confirm") {
		return (
			<Card compact={compact}>
				<div className="px-3 py-3 text-xs whitespace-pre-wrap">{str(t.text)}</div>
				<div className="grid grid-cols-2 border-t border-neutral-200">
					{actions.slice(0, 2).map((a, i) => (
						<div key={i} className={i > 0 ? "border-l border-neutral-200" : ""}>
							<ActionButton action={a} />
						</div>
					))}
				</div>
			</Card>
		);
	}

	if (t.type === "buttons") {
		return (
			<Card compact={compact}>
				{str(t.thumbnailImageUrl) && <img src={str(t.thumbnailImageUrl)} alt="" className="w-full h-28 object-cover" />}
				<div className="px-3 py-2">
					{str(t.title) && <div className="text-xs font-bold mb-1">{str(t.title)}</div>}
					<div className="text-xs whitespace-pre-wrap text-neutral-700">{str(t.text)}</div>
				</div>
				{actions.map((a, i) => (
					<ActionButton key={i} action={a} divider />
				))}
			</Card>
		);
	}

	if (t.type === "carousel") {
		const columns = Array.isArray(t.columns) ? t.columns : [];
		return (
			<div className="flex gap-2 overflow-x-auto pb-1">
				{columns.map((c, i) => {
					const col = obj(c);
					const colActions = Array.isArray(col?.actions) ? col!.actions : [];
					return (
						<div key={i} className="shrink-0 w-44 rounded-2xl bg-white text-neutral-900 overflow-hidden ring-1 ring-black/5">
							{str(col?.thumbnailImageUrl) && <img src={str(col?.thumbnailImageUrl)} alt="" className="w-full h-24 object-cover" />}
							<div className="px-3 py-2">
								{str(col?.title) && <div className="text-xs font-bold mb-1">{str(col?.title)}</div>}
								<div className="text-xs whitespace-pre-wrap text-neutral-700">{str(col?.text)}</div>
							</div>
							{colActions.map((a, j) => (
								<ActionButton key={j} action={a} divider />
							))}
						</div>
					);
				})}
			</div>
		);
	}

	if (t.type === "image_carousel") {
		const columns = Array.isArray(t.columns) ? t.columns : [];
		return (
			<div className="flex gap-2 overflow-x-auto pb-1">
				{columns.map((c, i) => (
					<div key={i} className="shrink-0 w-32 rounded-2xl overflow-hidden ring-1 ring-black/5 bg-white">
						<img src={str(obj(c)?.imageUrl)} alt="" className="w-full h-32 object-cover" />
						<ActionButton action={obj(c)?.action} divider />
					</div>
				))}
			</div>
		);
	}

	return <Invalid text={`不支援預覽的 template：${str(t.type, "?")}`} />;
}

// ---------- Flex ----------

const SIZE: Record<string, string> = {
	xxs: "9px", xs: "10px", sm: "11px", md: "13px", lg: "15px", xl: "17px", xxl: "20px", "3xl": "24px", "4xl": "28px", "5xl": "34px",
};
const SPACE: Record<string, string> = { none: "0", xs: "2px", sm: "4px", md: "8px", lg: "12px", xl: "16px", xxl: "20px" };
const px = (v: unknown, table: Record<string, string>) => (typeof v === "string" ? (table[v] ?? v) : undefined);

function FlexView({ message, compact }: { message: Json; compact: boolean }) {
	const contents = obj(message.contents);
	if (!contents) return <Invalid text="flex 缺少 contents" />;
	if (contents.type === "carousel") {
		const bubbles = Array.isArray(contents.contents) ? contents.contents : [];
		return (
			<div className="flex gap-2 overflow-x-auto pb-1">
				{bubbles.map((b, i) => (
					<div key={i} className="shrink-0 w-56">
						<Bubble bubble={obj(b) ?? {}} />
					</div>
				))}
			</div>
		);
	}
	return (
		<Card compact={compact}>
			<Bubble bubble={contents} />
		</Card>
	);
}

function Bubble({ bubble }: { bubble: Json }) {
	const styles = obj(bubble.styles);
	const sectionBg = (name: string) => str(obj(styles?.[name])?.backgroundColor) || undefined;
	return (
		<div className="text-neutral-900">
			{obj(bubble.header) && <div style={{ background: sectionBg("header") }}><FlexNode node={obj(bubble.header)!} /></div>}
			{obj(bubble.hero) && <FlexNode node={obj(bubble.hero)!} />}
			{obj(bubble.body) && <div style={{ background: sectionBg("body") }}><FlexNode node={obj(bubble.body)!} /></div>}
			{obj(bubble.footer) && <div style={{ background: sectionBg("footer") }}><FlexNode node={obj(bubble.footer)!} /></div>}
		</div>
	);
}

function FlexNode({ node }: { node: Json }) {
	switch (node.type) {
		case "box": {
			const layout = str(node.layout, "vertical");
			const horizontal = layout === "horizontal" || layout === "baseline";
			const style: CSSProperties = {
				display: "flex",
				flexDirection: horizontal ? "row" : "column",
				alignItems: layout === "baseline" ? "baseline" : undefined,
				gap: px(node.spacing, SPACE),
				padding: px(node.paddingAll, SPACE) ?? (node.paddingAll ? undefined : "10px 12px"),
				paddingTop: px(node.paddingTop, SPACE),
				paddingBottom: px(node.paddingBottom, SPACE),
				marginTop: px(node.margin, SPACE),
				background: str(node.backgroundColor) || undefined,
				borderRadius: px(node.cornerRadius, SPACE),
				flex: typeof node.flex === "number" ? node.flex : undefined,
				justifyContent: node.justifyContent === "center" ? "center" : node.justifyContent === "flex-end" ? "flex-end" : undefined,
				height: str(node.height) || undefined,
				width: str(node.width) || undefined,
				overflow: node.cornerRadius ? "hidden" : undefined,
			};
			const children = Array.isArray(node.contents) ? node.contents : [];
			return (
				<div style={style}>
					{children.map((c, i) => {
						const child = obj(c);
						return child ? <FlexNode key={i} node={child} /> : null;
					})}
				</div>
			);
		}
		case "text": {
			const style: CSSProperties = {
				fontSize: px(node.size, SIZE) ?? "13px",
				color: str(node.color) || undefined,
				fontWeight: node.weight === "bold" ? 700 : undefined,
				textAlign: node.align === "center" ? "center" : node.align === "end" ? "right" : undefined,
				whiteSpace: node.wrap ? "pre-wrap" : "nowrap",
				overflow: node.wrap ? undefined : "hidden",
				textOverflow: node.wrap ? undefined : "ellipsis",
				marginTop: px(node.margin, SPACE),
				flex: typeof node.flex === "number" ? node.flex : undefined,
				textDecoration: node.decoration === "underline" ? "underline" : node.decoration === "line-through" ? "line-through" : undefined,
			};
			return <div style={style}>{str(node.text)}</div>;
		}
		case "button": {
			const action = obj(node.action);
			const primary = node.style === "primary";
			const secondary = node.style === "secondary";
			const color = str(node.color) || (primary ? "#06C755" : secondary ? "#EFEFEF" : undefined);
			const style: CSSProperties = {
				flex: typeof node.flex === "number" ? node.flex : 1,
				marginTop: px(node.margin, SPACE),
				background: primary || secondary ? color : undefined,
				color: primary ? "#fff" : secondary ? "#111" : (color ?? "#0A84FF"),
				borderRadius: "8px",
				padding: node.height === "sm" ? "6px 10px" : "9px 10px",
				textAlign: "center",
				fontSize: "12px",
				fontWeight: 600,
			};
			return <div style={style}>{str(action?.label, "（按鈕）")}</div>;
		}
		case "separator":
			return <div style={{ borderTop: `1px solid ${str(node.color) || "#E5E5E5"}`, marginTop: px(node.margin, SPACE) }} />;
		case "image":
			return (
				<img
					src={str(node.url)}
					alt=""
					style={{ width: "100%", objectFit: "cover", marginTop: px(node.margin, SPACE), aspectRatio: str(node.aspectRatio).replace(":", "/") || undefined }}
				/>
			);
		case "icon":
			return <img src={str(node.url)} alt="" style={{ height: px(node.size, SIZE) ?? "13px" }} />;
		case "spacer":
		case "filler":
			return <div style={{ flex: 1 }} />;
		default:
			return <div className="text-[10px] text-neutral-400">[{str(node.type, "?")}]</div>;
	}
}

// ---------- Quick reply ----------

function QuickReplyView({ quickReply }: { quickReply: Json }) {
	const items = Array.isArray(quickReply.items) ? quickReply.items : [];
	return (
		<div className="flex gap-1.5 flex-wrap mt-1.5">
			{items.map((it, i) => {
				const a = obj(obj(it)?.action);
				return (
					<span key={i} className="text-[11px] px-2.5 py-1 rounded-full bg-white text-neutral-800 ring-1 ring-neutral-300">
						{str(a?.label, "（按鈕）")}
					</span>
				);
			})}
		</div>
	);
}
