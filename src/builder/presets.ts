import type { BuilderDraft } from "./types";
import { newAction, newId, postbackAction } from "./types";

/**
 * 傻瓜編輯器的範本。要新增只要加一筆。
 */
export interface BuilderPreset {
	key: string;
	name: string;
	build: () => BuilderDraft;
}

const pb = postbackAction;

export const BUILDER_PRESETS: BuilderPreset[] = [
	{
		key: "course-card",
		name: "排課媒合通知（資訊卡）",
		build: () => ({
			messages: [
				{
					id: newId(),
					kind: "card",
					altText: "排課媒合通知：請老師評估是否方便承接",
					headerTitle: "排課媒合通知",
					headerSubtitle: "請老師評估是否方便承接課程",
					headerColor: "#06C755",
					title: "【學生姓名】「科目」",
					subtitle: "",
					rows: [
						{ label: "首課日", value: "" },
						{ label: "連續課程", value: "" },
						{ label: "排課頻率", value: "" },
						{ label: "可排時段", value: "" },
						{ label: "學生狀況", value: "" },
					],
					note: "老師好，這裡是排課小幫手，有收到老師提供的可排課時間，目前媒合到以上學生，再麻煩老師評估看看是否方便承接課程~",
					buttons: [pb("承接", "accept"), pb("不承接", "decline")],
				},
			],
			quickReply: [],
		}),
	},
	{
		key: "text-confirm",
		name: "長文 + 是／否確認",
		build: () => ({
			messages: [
				{
					id: newId(),
					kind: "text",
					text: `老師好，這裡是排課小幫手，有收到老師提供的可排課時間，目前媒合到以下學生，再麻煩老師評估看看是否方便承接課程~

。【學生姓名】「科目」
。首課日是＿＿，連續課程是＿＿～＿＿
。排課頻率為：＿＿

。可排課時間：
＿＿
。學生狀況：＿＿`,
				},
				{
					id: newId(),
					kind: "confirm",
					altText: "請問老師是否方便承接這堂課程？",
					text: "請問老師是否方便承接這堂課程？",
					actions: [pb("是", "yes", "是，我可以承接"), pb("否", "no", "否，這次不方便")],
				},
			],
			quickReply: [],
		}),
	},
	{
		key: "multi-offer",
		name: "多筆媒合（輪播卡）",
		build: () => ({
			messages: [
				{
					id: newId(),
					kind: "carousel",
					altText: "有 2 筆媒合等您回覆",
					columns: [
						{
							title: "王小明｜國中數學",
							text: "首課 11/3\n每週一、三 19:00–20:30",
							imageUrl: "",
							actions: [pb("承接", "accept:offer-1", "承接 王小明"), pb("不承接", "decline:offer-1", "不承接 王小明")],
						},
						{
							title: "李小華｜高中英文",
							text: "首課 11/5\n每週二、四 20:00–21:30",
							imageUrl: "",
							actions: [pb("承接", "accept:offer-2", "承接 李小華"), pb("不承接", "decline:offer-2", "不承接 李小華")],
						},
					],
				},
			],
			quickReply: [],
		}),
	},
	{
		key: "quick-ask",
		name: "短問 + 快速回覆（含選日期）",
		build: () => ({
			messages: [
				{
					id: newId(),
					kind: "text",
					text: "老師好，王小明的國中數學希望 11/3 開始，每週一、三 19:00–20:30，請問方便承接嗎？",
				},
			],
			quickReply: [
				pb("✅ 承接", "accept", "承接"),
				pb("❌ 不承接", "decline", "不承接"),
				{ ...newAction("datetimepicker"), label: "📅 改其他日期", value: "reschedule", mode: "date", min: "", max: "" },
				{ ...newAction("message"), label: "✍️ 我有問題", text: "我想詢問這堂課的細節" },
			],
		}),
	},
	{
		key: "decline-reason",
		name: "追問不承接原因",
		build: () => ({
			messages: [
				{ id: newId(), kind: "text", text: "收到，謝謝老師回覆。方便告訴我們這次不承接的原因嗎？" },
			],
			quickReply: [
				pb("時間衝突", "reason:time"),
				pb("科目不符", "reason:subject"),
				pb("距離太遠", "reason:distance"),
				{ ...pb("其他（我來打字）", "reason:other", "其他"), openKeyboard: true, fillInText: "不承接的原因是：" },
			],
		}),
	},
	{
		key: "blank",
		name: "空白",
		build: () => ({ messages: [], quickReply: [] }),
	},
];
