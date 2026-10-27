import path from "node:path";
import {
	cloudflareTest,
	readD1Migrations,
} from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => {
	const migrations = await readD1Migrations(
		path.join(import.meta.dirname, "migrations"),
	);
	return {
		plugins: [
			cloudflareTest({
				wrangler: { configPath: "./wrangler.jsonc" },
				miniflare: {
					bindings: {
						TEST_MIGRATIONS: migrations,
						LINE_CHANNEL_SECRET: "test-channel-secret",
						LINE_CHANNEL_ACCESS_TOKEN: "test-access-token",
						CONSOLE_TOKEN: "test-console-token",
						REPLY_SLA_MINUTES: "1",
						WELCOME_MESSAGE: "歡迎！",
						// 測試用同步模式；queue 消費者另以 createMessageBatch 直接測
						WEBHOOK_MODE: "inline",
					},
				},
			}),
		],
		test: {
			setupFiles: ["./test/apply-migrations.ts"],
		},
	};
});
