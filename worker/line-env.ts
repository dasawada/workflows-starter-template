import { LineClient } from "./line";
import { recordMetric } from "./metrics";

/** 以目前環境的 token 建立 LINE client，所有呼叫都記 line.api 指標 */
export function lineClientFor(env: Env): LineClient {
	return new LineClient(env.LINE_CHANNEL_ACCESS_TOKEN, (endpoint, status, ms) =>
		recordMetric(env, { name: "line.api", labels: [endpoint, String(status)], values: [ms] }),
	);
}
