import { getReminderInstanceId, setReminderInstanceId } from "./db";
import { AGENT_REPLIED_EVENT } from "./workflow";

/**
 * 逾時提醒：每個對話同時最多一個 ReplyReminderWorkflow，instance id 記在 conversations.reminder_instance_id。
 * 使用者來訊時 armReminder，客服回覆後 finishReminder；流程自己跑完時由 workflow.ts 清掉指標。
 */

/**
 * 使用者來訊：沒有進行中的提醒才建立一個。
 * currentInstanceId 取自 insertMessage 回讀的對話列，不另外查 D1。
 */
export async function armReminder(
	env: Env,
	conversationId: string,
	currentInstanceId: string | null,
): Promise<void> {
	if (currentInstanceId) {
		try {
			const instance = await env.REPLY_REMINDER.get(currentInstanceId);
			const status = await instance.status();
			if (status.status === "running" || status.status === "waiting" || status.status === "queued") {
				return;
			}
		} catch {
			// 找不到舊 instance 就重新建立
		}
	}
	try {
		const instance = await env.REPLY_REMINDER.create({
			params: { conversationId },
		});
		await setReminderInstanceId(env.DB, conversationId, instance.id);
	} catch (err) {
		console.error("start reminder failed", err);
	}
}

/** 客服已回覆：結束逾時提醒流程 */
export async function finishReminder(env: Env, conversationId: string): Promise<void> {
	const reminderId = await getReminderInstanceId(env.DB, conversationId);
	if (!reminderId) return;
	try {
		const instance = await env.REPLY_REMINDER.get(reminderId);
		await instance.sendEvent({ type: AGENT_REPLIED_EVENT, payload: {} });
	} catch {
		// instance 可能已結束
	}
	await setReminderInstanceId(env.DB, conversationId, null);
}
