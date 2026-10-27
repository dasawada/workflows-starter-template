/**
 * Secrets 不會出現在 wrangler types 產生的 Env 裡（除非本機 .dev.vars 有值），
 * 這裡補進 __BaseEnv_Env，讓全域 Env 與 Cloudflare.Env（cloudflare:test 用）都看得到。
 */
interface __BaseEnv_Env {
	LINE_CHANNEL_SECRET: string;
	LINE_CHANNEL_ACCESS_TOKEN: string;
	CONSOLE_TOKEN: string;
}
