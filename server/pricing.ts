import type {
  EstimatedCost,
  ModelPrice,
  Settings,
} from "../shared/contracts.js";

export const pricingSource = "https://developers.openai.com/api/docs/pricing";
export const pricingCheckedAt = "2026-09-08";
// Standard API text-token reference prices, USD / 1M tokens. Not subscription billing.
export const officialPrices: ModelPrice[] = [
  ["gpt-6-astra", "10", "1", "12.5", "50", "20", "2", "25", "75"],
  ["gpt-5.6-sol", "4", "0.4", "5", "20", "8", "0.8", "10", "30"],
  ["gpt-5.6-terra", "2", "0.2", "2.5", "12", "4", "0.4", "5", "18"],
  ["gpt-5.6-luna", "0.2", "0.02", "0.25", "1.2", "0.4", "0.04", "0.5", "1.8"],
].map(
  ([
    model,
    input,
    cachedInput,
    cacheWrite,
    output,
    longInput,
    longCachedInput,
    longCacheWrite,
    longOutput,
  ]) => ({
    model,
    input,
    cachedInput,
    cacheWrite,
    output,
    longContextThreshold: 272000,
    longInput,
    longCachedInput,
    longCacheWrite,
    longOutput,
  }),
);

const rate = (value: string) => {
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, "0"));
};
const decimal = (value: bigint) => {
  const sign = value < 0n ? "-" : "";
  const n = value < 0n ? -value : value;
  return (
    sign +
    n / 1_000_000_000_000n +
    "." +
    (n % 1_000_000_000_000n).toString().padStart(12, "0")
  );
};

export function estimateCost(
  rows: Record<string, any>[],
  settings: Settings,
): EstimatedCost | null {
  if (!settings.costEnabled) return null;
  const prices = new Map(
    (settings.modelPrices ?? officialPrices).map((p) => [p.model, p]),
  );
  const notes = new Set<string>();
  let value = 0n,
    known = rows.length === 0;
  for (const row of rows) {
    const p = prices.get(row.model);
    if (!p) {
      notes.add(`未配置价格：${row.model || "未知模型"}`);
      continue;
    }
    const long = Number(row.long_context) === 1;
    const input = long ? p.longInput : p.input;
    const cached = long ? p.longCachedInput : p.cachedInput;
    const write = long ? p.longCacheWrite : p.cacheWrite;
    const output = long ? p.longOutput : p.output;
    const add = (tokens: bigint | null, unit: string | null, name: string) => {
      if (tokens === 0n) {
        known = true;
        return;
      }
      if (tokens == null || unit == null) {
        notes.add(`${row.model}：${name}用量或单价缺失`);
        return;
      }
      value += tokens * rate(unit);
      known = true;
    };
    add(row.uncached_input, input, "非缓存输入");
    add(row.cached_input_tokens, cached, "缓存读取");
    add(row.output_tokens, output, "输出");
    // Uncached input already includes writes. Add only the price difference.
    if (
      row.uncached_input != null &&
      Number(row.invalid_usage) === 0 &&
      row.cache_write_input_tokens != null &&
      row.cache_write_input_tokens !== 0n
    ) {
      if (write != null && input != null) {
        value += row.cache_write_input_tokens * (rate(write) - rate(input));
        known = true;
      } else notes.add(`${row.model}：缓存写入单价缺失`);
    }
    if (Number(row.missing_write) > 0)
      notes.add("缓存写入未完整提供，参考额未含未知写入差价");
    if (Number(row.missing_usage) > 0)
      notes.add("部分输入、缓存读取或输出用量缺失");
    if (Number(row.invalid_usage) > 0)
      notes.add("部分缓存分项超过输入，无法完整估算");
    if (Number(row.compat_events) > 0)
      notes.add("旧格式增量无法完整确认单请求长上下文档位");
  }
  return {
    amount: known ? decimal(value) : null,
    complete: notes.size === 0,
    currency: "USD",
    notes: [...notes],
  };
}
