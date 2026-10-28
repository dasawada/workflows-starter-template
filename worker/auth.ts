/**
 * 客服台的簡易驗證：共用一組 CONSOLE_TOKEN。
 * HTTP 走 Authorization: Bearer，WebSocket 走 ?token= query。
 */
export function isAuthorized(request: Request, env: Env): boolean {
	const expected = env.CONSOLE_TOKEN;
	if (!expected) return false;

	const header = request.headers.get("Authorization");
	let provided: string | null = null;
	if (header?.startsWith("Bearer ")) {
		provided = header.slice("Bearer ".length).trim();
	} else {
		provided = new URL(request.url).searchParams.get("token");
	}
	if (!provided || provided.length !== expected.length) return false;

	let diff = 0;
	for (let i = 0; i < expected.length; i++) {
		diff |= expected.charCodeAt(i) ^ provided.charCodeAt(i);
	}
	return diff === 0;
}

export function unauthorized(): Response {
	return Response.json({ error: "密鑰不正確或已失效。請重新登入。" }, { status: 401 });
}
