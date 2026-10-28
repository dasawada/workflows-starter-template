import type { Message } from "../shared/types";
import { getConversation, setMediaStatus, updateMessageMedia } from "./db";
import { inboxStub } from "./inbox-do";
import type { LineClient } from "./line";
import { MEDIA_MAX_ATTEMPTS, recordIntegrity, resolveIntegrity } from "./integrity";

/**
 * 把使用者傳來的附件抓到 R2。LINE 只保留一段時間，所以：
 * - 404 / 410：標 expired，記缺口（此內容已永久無法取得）
 * - 其他失敗：標 failed，排程會重試到 MEDIA_MAX_ATTEMPTS，之後記缺口
 * - 成功：標 stored，若先前有缺口紀錄就關閉
 */
export async function storeMedia(env: Env, client: LineClient, message: Message): Promise<void> {
	const lineMessageId = message.externalId;
	if (!lineMessageId) return;
	const attempts = (Number(message.metadata?.mediaAttempts) || 0) + 1;
	const dedupeKey = `media:${message.id}`;

	try {
		const content = await client.getContent(lineMessageId);
		if (content.status === 404 || content.status === 410) {
			await setMediaStatus(env.DB, message.id, "expired", { attempts, error: `LINE ${content.status}` });
			await recordIntegrity(env, {
				kind: "media_expired",
				severity: "error",
				conversationId: message.conversationId,
				messageId: message.id,
				dedupeKey,
				title: "附件已逾 LINE 平台保留期限，無法再取得",
				details: { type: message.type, lineMessageId, status: content.status },
				startedAt: message.createdAt,
			});
			return;
		}
		if (!content.body) {
			throw new Error(`LINE content ${content.status}`);
		}
		const key = `line/${lineMessageId}`;
		await env.MEDIA.put(key, content.body, {
			httpMetadata: { contentType: content.contentType },
			customMetadata: { conversationId: message.conversationId, messageId: message.id },
		});
		const updated = await updateMessageMedia(env.DB, message.id, key, content.contentType);
		if (attempts > 1) await resolveIntegrity(env, dedupeKey, "附件已重新下載。");
		if (updated) {
			const conversation = await getConversation(env.DB, message.conversationId);
			if (conversation) {
				await inboxStub(env).broadcast({ type: "message.new", message: updated, conversation });
			}
		}
	} catch (err) {
		const error = err instanceof Error ? err.message : String(err);
		console.error("store media failed", lineMessageId, attempts, error);
		await setMediaStatus(env.DB, message.id, "failed", { attempts, error });
		if (attempts >= MEDIA_MAX_ATTEMPTS) {
			await recordIntegrity(env, {
				kind: "media_failed",
				severity: "warning",
				conversationId: message.conversationId,
				messageId: message.id,
				dedupeKey,
				title: `附件下載連續失敗 ${attempts} 次，暫時無法顯示`,
				details: { type: message.type, lineMessageId, error },
				startedAt: message.createdAt,
			});
		}
	}
}
