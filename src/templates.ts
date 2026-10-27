import type { PromptOption } from "../shared/types";

/**
 * 可追蹤訊息範本。正文裡的 {{變數}} 會自動變成表單欄位。
 * 新增範本只要加一筆到 PROMPT_TEMPLATES。
 */
export interface PromptTemplate {
	key: string;
	name: string;
	body: string;
	question: string;
	options: PromptOption[];
}

export const YES_NO: PromptOption[] = [
	{ label: "是", value: "yes" },
	{ label: "否", value: "no" },
];

export const PROMPT_TEMPLATES: PromptTemplate[] = [
	{
		key: "blank",
		name: "空白",
		body: "",
		question: "請問是否同意？",
		options: YES_NO,
	},
	{
		key: "course-offer",
		name: "排課媒合通知",
		body: `老師好，這裡是排課小幫手，有收到老師提供的可排課時間，目前媒合到以下學生，再麻煩老師評估看看是否方便承接課程~

。【{{學生姓名}}】「{{科目}}」
。首課日是{{首課日}}，連續課程是{{開始日}}～{{結束日}}
。排課頻率為：{{排課頻率}}

。可排課時間：
{{上課時段}}
。{{學生狀況}}`,
		question: "請問老師是否方便承接這堂課程？",
		options: YES_NO,
	},
];

const VAR_RE = /\{\{\s*([^{}]+?)\s*\}\}/g;

/** 取出範本中的變數名稱（去重、保持出現順序） */
export function extractVariables(body: string): string[] {
	const names: string[] = [];
	for (const match of body.matchAll(VAR_RE)) {
		const name = match[1].trim();
		if (!names.includes(name)) names.push(name);
	}
	return names;
}

/** 以變數值代入範本；沒填的變數保留原樣，方便在預覽裡看出來 */
export function renderTemplate(body: string, values: Record<string, string>): string {
	return body.replace(VAR_RE, (whole, name: string) => {
		const value = values[name.trim()];
		return value && value.trim() ? value : whole;
	});
}
