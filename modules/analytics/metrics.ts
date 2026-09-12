import type { Metrics } from '../contracts/query.js';
import { ratio, tokenFields } from "../foundation/query-values.js";
import { bigintMetrics } from "./exact-query-engine.js";

const camel = [
    "inputTokens",
    "cachedInputTokens",
    "cacheWriteInputTokens",
    "outputTokens",
    "reasoningOutputTokens",
    "totalTokens",
] as const;

export const metricsSql = `${tokenFields.map((k) => `CAST(SUM(${k}) AS TEXT) AS ${k}`).join(",")},COUNT(*) AS event_count,
  CASE WHEN COUNT(*)=COUNT(CASE WHEN input_tokens>=cached_input_tokens AND cached_input_tokens>=0 THEN 1 END) THEN CAST(SUM(input_tokens-cached_input_tokens) AS TEXT) END uncached_input,
  CASE WHEN COUNT(*)=COUNT(CASE WHEN input_tokens>=cached_input_tokens+cache_write_input_tokens AND cached_input_tokens>=0 AND cache_write_input_tokens>=0 THEN 1 END) THEN CAST(SUM(input_tokens-cached_input_tokens-cache_write_input_tokens) AS TEXT) END ordinary_input,
  SUM(CASE WHEN cache_write_input_tokens IS NULL THEN 1 ELSE 0 END) write_missing,
  COUNT(DISTINCT thread_id) AS thread_count,COUNT(DISTINCT CASE WHEN turn_id IS NOT NULL THEN json_array(thread_id,turn_id) END) AS turn_count,
  COALESCE(SUM(incomplete),0) AS incomplete_events,
  CAST(SUM(CASE WHEN cached_input_tokens IS NOT NULL AND input_tokens IS NOT NULL AND cached_input_tokens<=input_tokens THEN cached_input_tokens END) AS TEXT) AS paired_cached,
  CAST(SUM(CASE WHEN cached_input_tokens IS NOT NULL AND input_tokens IS NOT NULL AND cached_input_tokens<=input_tokens THEN input_tokens END) AS TEXT) AS paired_input`;

export function metrics(r: Record<string, any>): Metrics {
    r = bigintMetrics(r);
    const n = Number(r.event_count || 0n);
    const result: any = {
        eventCount: n,
        threadCount: Number(r.thread_count || 0n),
        turnCount: Number(r.turn_count || 0n),
        cacheRatio: ratio(r.paired_cached ?? null, r.paired_input ?? null),
        uncachedInputTokens: r.uncached_input?.toString() ?? (n === 0 ? "0" : null),
        ordinaryInputTokens: r.ordinary_input?.toString() ?? (n === 0 ? "0" : null),
        cacheWriteMissingEvents: Number(r.write_missing || 0n),
        cost: null,
        incompleteEvents: Number(r.incomplete_events || 0n),
    };
    tokenFields.forEach((k, i) => (result[camel[i]] =
        r[k] === null || r[k] === undefined
            ? n === 0
                ? "0"
                : null
            : r[k].toString()));
    return result;
}
