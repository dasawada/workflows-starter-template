/**
 * LINE Messaging API 的格式上限（依 https://developers.line.biz/en/reference/messaging-api/）。
 * 編輯器的所有輸入框都以這裡為準，使用者填不出超限的訊息。
 */
export const LIMITS = {
	messagesPerPush: 5,
	text: 5000,
	altText: 400,
	actionLabel: 20, // template 與 quick reply 的按鈕
	flexButtonLabel: 40, // Flex 按鈕
	postbackData: 300,
	displayText: 300,
	fillInText: 300,
	messageActionText: 300,
	uri: 1000,
	imageUrl: 2000,
	confirm: { text: 240, actions: 2 },
	buttons: { title: 40, text: 160, textWithTitleOrImage: 60, actionsMin: 1, actionsMax: 4 },
	carousel: {
		columnsMin: 1,
		columnsMax: 10,
		title: 40,
		text: 120,
		textWithTitleOrImage: 60,
		actionsMin: 1,
		actionsMax: 3,
	},
	quickReplyItems: 13,
	card: {
		headerTitle: 40,
		headerSubtitle: 60,
		title: 60,
		subtitle: 80,
		rowsMax: 8,
		rowLabel: 10,
		rowValue: 120,
		note: 600,
		buttonsMax: 3,
	},
	flexBubbleBytes: 30 * 1024,
} as const;
