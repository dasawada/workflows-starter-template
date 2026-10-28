/**
 * Analytics Engine 指標。寫入失敗一律吞掉，不影響主流程。
 * 每個資料點：indexes[0] = 指標名稱（用來抽樣分組），blobs = 標籤，doubles = 數值。
 *
 * 在 Cloudflare dashboard → Analytics Engine 用 SQL 查，例如：
 *   SELECT blob1 AS name, blob2 AS label, count() AS n, avg(double1) AS avg_ms
 *   FROM cs_console_metrics WHERE timestamp > NOW() - INTERVAL '1' DAY GROUP BY name, label
 */
export interface MetricPoint {
	name: string;
	labels?: (string | null | undefined)[];
	values?: number[];
}

export function recordMetric(env: Env, point: MetricPoint): void {
	try {
		env.METRICS?.writeDataPoint({
			indexes: [point.name.slice(0, 96)],
			blobs: [point.name, ...(point.labels ?? []).map((l) => (l ?? "").toString().slice(0, 256))],
			doubles: point.values ?? [],
		});
	} catch {
		// 指標不能影響主流程
	}
}
