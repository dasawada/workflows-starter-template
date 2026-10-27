/**
 * 傻瓜編輯器的草稿結構。只描述「人看得懂的欄位」，由 toLine.ts 轉成 LINE JSON。
 */

export type ActionDraft =
	| {
			kind: "postback";
			label: string;
			/** 回到資料庫的選項值（例如 accept / decline） */
			value: string;
			/** 使用者點了之後，聊天室顯示的那句話 */
			displayText: string;
			/** 點了之後開鍵盤並預填文字 */
			openKeyboard: boolean;
			fillInText: string;
	  }
	| { kind: "message"; label: string; text: string }
	| { kind: "uri"; label: string; uri: string }
	| {
			kind: "datetimepicker";
			label: string;
			value: string;
			mode: "date" | "time" | "datetime";
			min: string;
			max: string;
	  };

export interface ColumnDraft {
	title: string;
	text: string;
	imageUrl: string;
	actions: ActionDraft[];
}

export interface CardRow {
	label: string;
	value: string;
}

export type MessageDraft =
	| { id: string; kind: "text"; text: string }
	| { id: string; kind: "confirm"; altText: string; text: string; actions: ActionDraft[] }
	| {
			id: string;
			kind: "buttons";
			altText: string;
			title: string;
			text: string;
			imageUrl: string;
			actions: ActionDraft[];
	  }
	| { id: string; kind: "carousel"; altText: string; columns: ColumnDraft[] }
	| {
			id: string;
			kind: "card";
			altText: string;
			headerTitle: string;
			headerSubtitle: string;
			headerColor: string;
			title: string;
			subtitle: string;
			rows: CardRow[];
			note: string;
			buttons: ActionDraft[];
	  };

export type MessageKind = MessageDraft["kind"];

export interface BuilderDraft {
	messages: MessageDraft[];
	/** 小圓鈕，掛在最後一則訊息 */
	quickReply: ActionDraft[];
}

export interface DraftError {
	/** 哪一則訊息（0 起算），-1 表示整體或快速回覆 */
	messageIndex: number;
	message: string;
}

let seq = 0;
export const newId = () => `m${Date.now().toString(36)}${(seq++).toString(36)}`;

type ActionOf<K extends ActionDraft["kind"]> = Extract<ActionDraft, { kind: K }>;

export function newAction<K extends ActionDraft["kind"]>(kind: K): ActionOf<K> {
	const blank: { [P in ActionDraft["kind"]]: ActionOf<P> } = {
		postback: { kind: "postback", label: "", value: "", displayText: "", openKeyboard: false, fillInText: "" },
		message: { kind: "message", label: "", text: "" },
		uri: { kind: "uri", label: "", uri: "https://" },
		datetimepicker: { kind: "datetimepicker", label: "", value: "", mode: "date", min: "", max: "" },
	};
	return { ...blank[kind] };
}

export function postbackAction(label: string, value: string, displayText = label): ActionOf<"postback"> {
	return { ...newAction("postback"), label, value, displayText };
}

export function newMessage<K extends MessageKind>(kind: K): Extract<MessageDraft, { kind: K }> {
	return buildMessage(kind) as Extract<MessageDraft, { kind: K }>;
}

function buildMessage(kind: MessageKind): MessageDraft {
	const id = newId();
	switch (kind) {
		case "text":
			return { id, kind, text: "" };
		case "confirm":
			return {
				id,
				kind,
				altText: "",
				text: "",
				actions: [
					{ ...newAction("postback"), label: "是", value: "yes", displayText: "是" },
					{ ...newAction("postback"), label: "否", value: "no", displayText: "否" },
				],
			};
		case "buttons":
			return {
				id,
				kind,
				altText: "",
				title: "",
				text: "",
				imageUrl: "",
				actions: [{ ...newAction("postback"), label: "承接", value: "accept", displayText: "承接" }],
			};
		case "carousel":
			return {
				id,
				kind,
				altText: "",
				columns: [
					{
						title: "",
						text: "",
						imageUrl: "",
						actions: [{ ...newAction("postback"), label: "承接", value: "accept", displayText: "承接" }],
					},
				],
			};
		case "card":
			return {
				id,
				kind,
				altText: "",
				headerTitle: "",
				headerSubtitle: "",
				headerColor: "#06C755",
				title: "",
				subtitle: "",
				rows: [{ label: "", value: "" }],
				note: "",
				buttons: [
					{ ...newAction("postback"), label: "承接", value: "accept", displayText: "承接" },
					{ ...newAction("postback"), label: "不承接", value: "decline", displayText: "不承接" },
				],
			};
	}
}

export const KIND_LABELS: Record<MessageKind, { name: string; description: string }> = {
	text: { name: "文字", description: "純文字，最長 5000 字" },
	confirm: { name: "是／否確認", description: "一句問話 + 兩顆按鈕" },
	buttons: { name: "按鈕卡", description: "標題、短文、最多 4 顆按鈕，可放圖" },
	carousel: { name: "輪播卡", description: "多張卡片左右滑，每張最多 3 顆按鈕" },
	card: { name: "資訊卡（Flex）", description: "色帶標題、欄位表、長文備註、最多 3 顆按鈕" },
};
