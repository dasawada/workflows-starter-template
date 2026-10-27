/**
 * 客服名稱：只用於協作顯示（接手、在看、衝突偵測、訊息署名），不是身分驗證。
 * 存在 localStorage，隨每個 API 請求以 X-Agent-Name 帶上。
 */
const AGENT_KEY = "cs-console-agent";

export function getAgentName(): string | null {
	try {
		return localStorage.getItem(AGENT_KEY)?.trim() || null;
	} catch {
		return null;
	}
}

export function setAgentName(name: string | null) {
	try {
		if (name?.trim()) localStorage.setItem(AGENT_KEY, name.trim().slice(0, 40));
		else localStorage.removeItem(AGENT_KEY);
	} catch {
		// ignore
	}
}
