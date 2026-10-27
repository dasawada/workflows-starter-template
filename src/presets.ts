/**
 * 互動訊息範例。每個 preset 是一組可直接送出的 LINE 訊息陣列（最多 5 則）。
 * postback 的 data 只要填「選項值」，送出時後端會自動改寫成 prompt=<id>&choice=<值> 以便追蹤。
 * 新增範例只要加一筆到 MESSAGE_PRESETS。
 */
export interface MessagePreset {
	key: string;
	name: string;
	hint: string;
	messages: unknown[];
}

const COURSE_TEXT = `老師好，這裡是排課小幫手，有收到老師提供的可排課時間，目前媒合到以下學生，再麻煩老師評估看看是否方便承接課程~

。【王小明】「國中數學」
。首課日是 11/3（一），連續課程是 11/3～12/22
。排課頻率為：每週一、三 19:00–20:30

。可排課時間：
週一 19:00–20:30
週三 19:00–20:30
。學生狀況：基礎尚可，需要加強幾何證明`;

export const MESSAGE_PRESETS: MessagePreset[] = [
	{
		key: "text-confirm",
		name: "文字 + Confirm（兩則）",
		hint: "正文一則、問句加兩顆按鈕一則。Confirm 的 text 最多 240 字，按鈕最多 2 顆。",
		messages: [
			{ type: "text", text: COURSE_TEXT },
			{
				type: "template",
				altText: "請問老師是否方便承接這堂課程？",
				template: {
					type: "confirm",
					text: "請問老師是否方便承接這堂課程？",
					actions: [
						{ type: "postback", label: "是", data: "yes", displayText: "是，我可以承接" },
						{ type: "postback", label: "否", data: "no", displayText: "否，這次不方便" },
					],
				},
			},
		],
	},
	{
		key: "buttons",
		name: "Buttons template（一則）",
		hint: "標題 + 文字 + 最多 4 顆按鈕。text 最多 160 字；有 title 或圖片時只剩 60 字。",
		messages: [
			{
				type: "template",
				altText: "排課媒合通知：王小明 國中數學",
				template: {
					type: "buttons",
					title: "排課媒合通知",
					text: "王小明｜國中數學\n首課 11/3，每週一、三 19:00–20:30",
					actions: [
						{ type: "postback", label: "承接", data: "accept", displayText: "承接" },
						{ type: "postback", label: "不承接", data: "decline", displayText: "不承接" },
						{ type: "postback", label: "想再確認時段", data: "ask", displayText: "想再確認時段" },
						{ type: "uri", label: "查看完整資訊", uri: "https://example.com/offer/123" },
					],
				},
			},
		],
	},
	{
		key: "carousel",
		name: "Carousel template（多張卡）",
		hint: "最多 10 張卡，每張最多 3 顆按鈕、text 最多 120 字，所有卡的按鈕數要一致。",
		messages: [
			{
				type: "template",
				altText: "有 2 筆媒合等您回覆",
				template: {
					type: "carousel",
					columns: [
						{
							title: "王小明｜國中數學",
							text: "首課 11/3\n每週一、三 19:00–20:30",
							actions: [
								{ type: "postback", label: "承接", data: "accept:offer-123", displayText: "承接 王小明" },
								{ type: "postback", label: "不承接", data: "decline:offer-123", displayText: "不承接 王小明" },
							],
						},
						{
							title: "李小華｜高中英文",
							text: "首課 11/5\n每週二、四 20:00–21:30",
							actions: [
								{ type: "postback", label: "承接", data: "accept:offer-124", displayText: "承接 李小華" },
								{ type: "postback", label: "不承接", data: "decline:offer-124", displayText: "不承接 李小華" },
							],
						},
					],
				},
			},
		],
	},
	{
		key: "flex-card",
		name: "Flex 單卡（長文 + 欄位 + 按鈕）",
		hint: "一張卡放下所有資訊與按鈕，文字沒有字數上限。可到 LINE Flex Message Simulator 調版面後把 JSON 貼回來。",
		messages: [
			{
				type: "flex",
				altText: "排課媒合通知：王小明 國中數學，請回覆是否承接",
				contents: {
					type: "bubble",
					header: {
						type: "box",
						layout: "vertical",
						backgroundColor: "#06C755",
						paddingAll: "16px",
						contents: [
							{ type: "text", text: "排課媒合通知", color: "#FFFFFF", weight: "bold", size: "lg" },
							{ type: "text", text: "請老師評估是否方便承接", color: "#E6FFEF", size: "xs", margin: "sm" },
						],
					},
					body: {
						type: "box",
						layout: "vertical",
						spacing: "md",
						contents: [
							{ type: "text", text: "王小明｜國中數學", weight: "bold", size: "lg", wrap: true },
							{ type: "separator" },
							{
								type: "box",
								layout: "vertical",
								spacing: "sm",
								contents: [
									{
										type: "box",
										layout: "baseline",
										contents: [
											{ type: "text", text: "首課日", color: "#8C8C8C", size: "sm", flex: 2 },
											{ type: "text", text: "11/3（一）", size: "sm", flex: 5, wrap: true },
										],
									},
									{
										type: "box",
										layout: "baseline",
										contents: [
											{ type: "text", text: "連續課程", color: "#8C8C8C", size: "sm", flex: 2 },
											{ type: "text", text: "11/3～12/22", size: "sm", flex: 5, wrap: true },
										],
									},
									{
										type: "box",
										layout: "baseline",
										contents: [
											{ type: "text", text: "頻率", color: "#8C8C8C", size: "sm", flex: 2 },
											{ type: "text", text: "每週一、三 19:00–20:30", size: "sm", flex: 5, wrap: true },
										],
									},
									{
										type: "box",
										layout: "baseline",
										contents: [
											{ type: "text", text: "學生狀況", color: "#8C8C8C", size: "sm", flex: 2 },
											{ type: "text", text: "基礎尚可，需要加強幾何證明", size: "sm", flex: 5, wrap: true },
										],
									},
								],
							},
						],
					},
					footer: {
						type: "box",
						layout: "horizontal",
						spacing: "sm",
						contents: [
							{
								type: "button",
								style: "primary",
								color: "#06C755",
								action: { type: "postback", label: "承接", data: "accept", displayText: "承接" },
							},
							{
								type: "button",
								style: "secondary",
								action: { type: "postback", label: "不承接", data: "decline", displayText: "不承接" },
							},
						],
					},
				},
			},
		],
	},
	{
		key: "text-quickreply",
		name: "文字 + Quick reply（小圓鈕）",
		hint: "小圓鈕掛在最後一則訊息下方，最多 13 顆，點過或再傳訊息就消失。可混用 postback、日期選擇、開網址。",
		messages: [
			{
				type: "text",
				text: "老師好，王小明的國中數學課程希望 11/3 開始，每週一、三 19:00–20:30，請問方便承接嗎？",
				quickReply: {
					items: [
						{ type: "action", action: { type: "postback", label: "✅ 承接", data: "accept", displayText: "承接" } },
						{ type: "action", action: { type: "postback", label: "❌ 不承接", data: "decline", displayText: "不承接" } },
						{
							type: "action",
							action: {
								type: "datetimepicker",
								label: "📅 改其他日期",
								data: "reschedule",
								mode: "date",
								initial: "2026-11-03",
								min: "2026-11-01",
								max: "2026-12-31",
							},
						},
						{ type: "action", action: { type: "message", label: "✍️ 我有問題", text: "我想詢問這堂課的細節" } },
					],
				},
			},
		],
	},
	{
		key: "decline-reason",
		name: "追問原因（Quick reply 多步驟）",
		hint: "老師回覆「不承接」後再送這則，原因一樣會以 postback 回到資料庫。",
		messages: [
			{
				type: "text",
				text: "收到，謝謝老師回覆。方便告訴我們這次不承接的原因嗎？",
				quickReply: {
					items: [
						{ type: "action", action: { type: "postback", label: "時間衝突", data: "reason:time", displayText: "時間衝突" } },
						{ type: "action", action: { type: "postback", label: "科目不符", data: "reason:subject", displayText: "科目不符" } },
						{ type: "action", action: { type: "postback", label: "距離太遠", data: "reason:distance", displayText: "距離太遠" } },
						{
							type: "action",
							action: {
								type: "postback",
								label: "其他（我來打字）",
								data: "reason:other",
								displayText: "其他",
								inputOption: "openKeyboard",
								fillInText: "不承接的原因是：",
							},
						},
					],
				},
			},
		],
	},
];
