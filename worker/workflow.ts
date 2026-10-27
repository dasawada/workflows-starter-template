import { WorkflowEntrypoint, WorkflowStep } from "cloudflare:workers";
import type { WorkflowEvent } from "cloudflare:workers";
import { markNeedsAttentionIfUnanswered, setReminderInstanceId } from "./db";
import { inboxStub } from "./inbox-do";

export interface ReplyReminderParams {
	conversationId: string;
}

export const AGENT_REPLIED_EVENT = "agent-replied";

/**
 * ReplyReminderWorkflow：使用者傳訊息後啟動，等待客服回覆。
 * - 客服在 SLA 內回覆：Worker 會送 agent-replied 事件，流程直接結束。
 * - 逾時：把對話標成「待處理」並推播給所有在線客服。
 */
export class ReplyReminderWorkflow extends WorkflowEntrypoint<
	Env,
	ReplyReminderParams
> {
	async run(event: WorkflowEvent<ReplyReminderParams>, step: WorkflowStep) {
		const { conversationId } = event.payload;
		const minutes = Math.max(1, Number(this.env.REPLY_SLA_MINUTES) || 10);

		let replied = false;
		try {
			await step.waitForEvent("wait for agent reply", {
				type: AGENT_REPLIED_EVENT,
				timeout: `${minutes} minutes`,
			});
			replied = true;
		} catch {
			replied = false;
		}

		if (!replied) {
			await step.do("mark needs attention", async () => {
				const conversation = await markNeedsAttentionIfUnanswered(
					this.env.DB,
					conversationId,
				);
				if (conversation) {
					await inboxStub(this.env).broadcast({
						type: "conversation.updated",
						conversation,
					});
				}
				return { flagged: conversation !== null };
			});
		}

		await step.do("clear reminder pointer", async () => {
			await setReminderInstanceId(this.env.DB, conversationId, null);
		});

		return { conversationId, replied };
	}
}
