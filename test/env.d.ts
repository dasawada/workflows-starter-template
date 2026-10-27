/** 測試專用 binding（vitest.config.ts 的 miniflare.bindings） */
interface __BaseEnv_Env {
	TEST_MIGRATIONS: import("cloudflare:test").D1Migration[];
}
