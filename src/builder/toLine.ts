import { LIMITS } from "./limits";
import type {
	ActionDraft,
	BuilderDraft,
	ColumnDraft,
	DraftError,
	MessageDraft,
} from "./types";

/**
 * 草稿 → LINE 訊息 JSON，以及送出前的檢查。
 * 轉換時會把超長內容裁到上限，所以輸出一定合法；validate 則把「必填沒填」之類的問題列給使用者。
 */

const cut = (s: string, max: number) => s.trim().slice(0, max);

export function buttonsTextMax(hasTitleOrImage: boolean) {
	return hasTitleOrImage ? LIMITS.buttons.textWithTitleOrImage : LIMITS.buttons.text;
}
export function carouselTextMax(hasTitleOrImage: boolean) {
	return hasTitleOrImage ? LIMITS.carousel.textWithTitleOrImage : LIMITS.carousel.text;
}

function toAction(a: ActionDraft, labelMax: number): Record<string, unknown> {
	const label = cut(a.label, labelMax);
	switch (a.kind) {
		case "postback": {
			const out: Record<string, unknown> = {
				type: "postback",
				label,
				data: cut(a.value || a.label, LIMITS.postbackData),
			};
			if (a.displayText.trim()) out.displayText = cut(a.displayText, LIMITS.displayText);
			if (a.openKeyboard) {
				out.inputOption = "openKeyboard";
				if (a.fillInText.trim()) out.fillInText = cut(a.fillInText, LIMITS.fillInText);
			}
			return out;
		}
		case "message":
			return { type: "message", label, text: cut(a.text || a.label, LIMITS.messageActionText) };
		case "uri":
			return { type: "uri", label, uri: cut(a.uri, LIMITS.uri) };
		case "datetimepicker": {
			const out: Record<string, unknown> = {
				type: "datetimepicker",
				label,
				data: cut(a.value || a.label, LIMITS.postbackData),
				mode: a.mode,
			};
			if (a.min) out.min = a.min;
			if (a.max) out.max = a.max;
			return out;
		}
	}
}

function toColumn(c: ColumnDraft, actionCount: number): Record<string, unknown> {
	const hasTitleOrImage = Boolean(c.title.trim() || c.imageUrl.trim());
	const out: Record<string, unknown> = {
		text: cut(c.text, carouselTextMax(hasTitleOrImage)),
		actions: c.actions.slice(0, actionCount).map((a) => toAction(a, LIMITS.actionLabel)),
	};
	if (c.title.trim()) out.title = cut(c.title, LIMITS.carousel.title);
	if (c.imageUrl.trim()) out.thumbnailImageUrl = cut(c.imageUrl, LIMITS.imageUrl);
	return out;
}

function kv(label: string, value: string) {
	return {
		type: "box",
		layout: "baseline",
		spacing: "sm",
		contents: [
			{ type: "text", text: cut(label, LIMITS.card.rowLabel) || " ", color: "#8C8C8C", size: "sm", flex: 2 },
			{ type: "text", text: cut(value, LIMITS.card.rowValue) || " ", size: "sm", flex: 5, wrap: true },
		],
	};
}

function toCard(m: Extract<MessageDraft, { kind: "card" }>): Record<string, unknown> {
	const bubble: Record<string, unknown> = { type: "bubble" };
	if (m.headerTitle.trim()) {
		bubble.header = {
			type: "box",
			layout: "vertical",
			backgroundColor: /^#[0-9a-fA-F]{6}$/.test(m.headerColor) ? m.headerColor : "#06C755",
			paddingAll: "14px",
			contents: [
				{ type: "text", text: cut(m.headerTitle, LIMITS.card.headerTitle), color: "#FFFFFF", weight: "bold", size: "lg", wrap: true },
				...(m.headerSubtitle.trim()
					? [{ type: "text", text: cut(m.headerSubtitle, LIMITS.card.headerSubtitle), color: "#FFFFFFCC", size: "xs", margin: "sm", wrap: true }]
					: []),
			],
		};
	}
	const body: Record<string, unknown>[] = [];
	if (m.title.trim()) body.push({ type: "text", text: cut(m.title, LIMITS.card.title), weight: "bold", size: "lg", wrap: true });
	if (m.subtitle.trim()) body.push({ type: "text", text: cut(m.subtitle, LIMITS.card.subtitle), size: "sm", color: "#6B7280", wrap: true });
	const rows = m.rows.filter((r) => r.label.trim() || r.value.trim()).slice(0, LIMITS.card.rowsMax);
	if (rows.length) {
		if (body.length) body.push({ type: "separator", margin: "md" });
		body.push({ type: "box", layout: "vertical", spacing: "sm", margin: "md", contents: rows.map((r) => kv(r.label, r.value)) });
	}
	if (m.note.trim()) {
		if (body.length) body.push({ type: "separator", margin: "md" });
		body.push({ type: "text", text: cut(m.note, LIMITS.card.note), size: "sm", color: "#4B5563", wrap: true, margin: "md" });
	}
	bubble.body = { type: "box", layout: "vertical", spacing: "sm", contents: body.length ? body : [{ type: "text", text: " " }] };

	const buttons = m.buttons.slice(0, LIMITS.card.buttonsMax);
	if (buttons.length) {
		bubble.footer = {
			type: "box",
			layout: buttons.length === 2 ? "horizontal" : "vertical",
			spacing: "sm",
			contents: buttons.map((b, i) => ({
				type: "button",
				style: i === 0 ? "primary" : "secondary",
				...(i === 0 ? { color: "#06C755" } : {}),
				height: "sm",
				action: toAction(b, LIMITS.flexButtonLabel),
			})),
		};
	}
	return bubble;
}

export function toLineMessage(m: MessageDraft): Record<string, unknown> {
	switch (m.kind) {
		case "text":
			return { type: "text", text: cut(m.text, LIMITS.text) };
		case "confirm":
			return {
				type: "template",
				altText: cut(m.altText || m.text, LIMITS.altText),
				template: {
					type: "confirm",
					text: cut(m.text, LIMITS.confirm.text),
					actions: m.actions.slice(0, 2).map((a) => toAction(a, LIMITS.actionLabel)),
				},
			};
		case "buttons": {
			const hasTitleOrImage = Boolean(m.title.trim() || m.imageUrl.trim());
			const template: Record<string, unknown> = {
				type: "buttons",
				text: cut(m.text, buttonsTextMax(hasTitleOrImage)),
				actions: m.actions.slice(0, LIMITS.buttons.actionsMax).map((a) => toAction(a, LIMITS.actionLabel)),
			};
			if (m.title.trim()) template.title = cut(m.title, LIMITS.buttons.title);
			if (m.imageUrl.trim()) template.thumbnailImageUrl = cut(m.imageUrl, LIMITS.imageUrl);
			return { type: "template", altText: cut(m.altText || m.title || m.text, LIMITS.altText), template };
		}
		case "carousel": {
			const columns = m.columns.slice(0, LIMITS.carousel.columnsMax);
			const actionCount = Math.max(1, Math.min(LIMITS.carousel.actionsMax, ...columns.map((c) => c.actions.length)));
			return {
				type: "template",
				altText: cut(m.altText || columns[0]?.title || columns[0]?.text || "", LIMITS.altText),
				template: { type: "carousel", columns: columns.map((c) => toColumn(c, actionCount)) },
			};
		}
		case "card":
			return {
				type: "flex",
				altText: cut(m.altText || m.headerTitle || m.title, LIMITS.altText),
				contents: toCard(m),
			};
	}
}

export function toLineMessages(draft: BuilderDraft): unknown[] {
	const messages = draft.messages.slice(0, LIMITS.messagesPerPush).map(toLineMessage);
	const items = draft.quickReply.slice(0, LIMITS.quickReplyItems);
	if (items.length && messages.length) {
		messages[messages.length - 1].quickReply = {
			items: items.map((a) => ({ type: "action", action: toAction(a, LIMITS.actionLabel) })),
		};
	}
	return messages;
}

// ---------- 檢查 ----------

function validateAction(a: ActionDraft, where: string, push: (msg: string) => void) {
	if (!a.label.trim()) push(`${where}：按鈕文字必填`);
	switch (a.kind) {
		case "postback":
			if (!a.value.trim()) push(`${where}：選項值必填（例如 accept）`);
			break;
		case "message":
			if (!a.text.trim()) push(`${where}：代使用者送出的文字必填`);
			break;
		case "uri":
			if (!/^(https?|line|tel):/.test(a.uri.trim())) push(`${where}：網址需以 https://、line:// 或 tel: 開頭`);
			break;
		case "datetimepicker":
			if (!a.value.trim()) push(`${where}：選項值必填`);
			if (a.min && a.max && a.min > a.max) push(`${where}：最早日期晚於最晚日期`);
			break;
	}
}

export function validateDraft(draft: BuilderDraft): DraftError[] {
	const errors: DraftError[] = [];
	const at = (i: number) => (msg: string) => errors.push({ messageIndex: i, message: msg });

	if (draft.messages.length === 0) errors.push({ messageIndex: -1, message: "至少要有一則訊息" });
	if (draft.messages.length > LIMITS.messagesPerPush) errors.push({ messageIndex: -1, message: `一次最多 ${LIMITS.messagesPerPush} 則` });

	draft.messages.forEach((m, i) => {
		const push = at(i);
		switch (m.kind) {
			case "text":
				if (!m.text.trim()) push("文字內容必填");
				break;
			case "confirm":
				if (!m.text.trim()) push("問句必填");
				if (m.actions.length !== 2) push("確認訊息固定兩顆按鈕");
				m.actions.forEach((a, j) => validateAction(a, `按鈕 ${j + 1}`, push));
				break;
			case "buttons":
				if (!m.text.trim()) push("內文必填");
				if (m.actions.length < LIMITS.buttons.actionsMin) push("至少一顆按鈕");
				if (m.imageUrl.trim() && !m.imageUrl.startsWith("https://")) push("圖片網址必須是 https://");
				m.actions.forEach((a, j) => validateAction(a, `按鈕 ${j + 1}`, push));
				break;
			case "carousel": {
				if (m.columns.length < 1) push("至少一張卡");
				const counts = new Set(m.columns.map((c) => c.actions.length));
				if (counts.size > 1) push("每張卡的按鈕數量必須一致");
				const withImage = m.columns.filter((c) => c.imageUrl.trim()).length;
				if (withImage && withImage !== m.columns.length) push("圖片要全部的卡都放，或全部不放");
				const withTitle = m.columns.filter((c) => c.title.trim()).length;
				if (withTitle && withTitle !== m.columns.length) push("標題要全部的卡都有，或全部沒有");
				m.columns.forEach((c, k) => {
					if (!c.text.trim()) push(`卡 ${k + 1}：內文必填`);
					if (c.actions.length < 1) push(`卡 ${k + 1}：至少一顆按鈕`);
					if (c.imageUrl.trim() && !c.imageUrl.startsWith("https://")) push(`卡 ${k + 1}：圖片網址必須是 https://`);
					c.actions.forEach((a, j) => validateAction(a, `卡 ${k + 1} 按鈕 ${j + 1}`, push));
				});
				break;
			}
			case "card": {
				const hasContent =
					m.headerTitle.trim() || m.title.trim() || m.note.trim() || m.rows.some((r) => r.label.trim() || r.value.trim());
				if (!hasContent) push("資訊卡至少要有標題、欄位或備註");
				if (!(m.altText || m.headerTitle || m.title).trim()) push("請填通知列文字（或標題）");
				m.buttons.forEach((a, j) => validateAction(a, `按鈕 ${j + 1}`, push));
				const bytes = new TextEncoder().encode(JSON.stringify(toLineMessage(m))).length;
				if (bytes > LIMITS.flexBubbleBytes) push("資訊卡內容過大，請縮短備註或欄位");
				break;
			}
		}
	});

	if (draft.quickReply.length > LIMITS.quickReplyItems) errors.push({ messageIndex: -1, message: `快速回覆最多 ${LIMITS.quickReplyItems} 顆` });
	draft.quickReply.forEach((a, j) => validateAction(a, `快速回覆 ${j + 1}`, at(-1)));

	return errors;
}

/** 可追蹤按鈕數（postback 與日期選擇都會回到資料庫） */
export function countTrackable(draft: BuilderDraft): number {
	const fromActions = (actions: ActionDraft[]) =>
		actions.filter((a) => a.kind === "postback" || a.kind === "datetimepicker").length;
	let n = fromActions(draft.quickReply);
	for (const m of draft.messages) {
		if (m.kind === "confirm" || m.kind === "buttons") n += fromActions(m.actions);
		else if (m.kind === "card") n += fromActions(m.buttons);
		else if (m.kind === "carousel") n += m.columns.reduce((s, c) => s + fromActions(c.actions), 0);
	}
	return n;
}
