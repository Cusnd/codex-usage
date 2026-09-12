import type { EstimatedCost, ModelPrice, PricingInfo, Settings, SubscriptionPrice } from '../contracts/settings.js';

export const pricingSource = "https://developers.openai.com/api/docs/pricing";
export const subscriptionPricingSource = pricingSource;
export const speedPricingSource = "https://learn.chatgpt.com/docs/agent-configuration/speed";
export const pricingCheckedAt = "2026-09-12";
// Standard API text-token reference prices, USD / 1M tokens. Fast is a separate API rate.
export const officialPrices: ModelPrice[] = [
  ["gpt-6-astra", "10", "1", "12.5", "50", "20", "2", "25", "75"],
  ["gpt-5.6-sol", "4", "0.4", "5", "20", "8", "0.8", "10", "30"],
  ["gpt-5.6-terra", "2", "0.2", "2.5", "12", "4", "0.4", "5", "18"],
  ["gpt-5.6-luna", "0.2", "0.02", "0.25", "1.2", "0.4", "0.04", "0.5", "1.8"],
].map(
  ([model, input, cachedInput, cacheWrite, output, longInput, longCachedInput, longCacheWrite, longOutput]) => ({
    model, input, cachedInput, cacheWrite, output,
    longContextThreshold: 272000,
    longInput, longCachedInput, longCacheWrite, longOutput,
    fastMultiplier: "2",
  }),
);

// Subscription-mode USD reference: standard API dollar prices with subscription
// Fast multipliers. This is a token-based comparison, not a subscription invoice.
// No unpublished subscription cache-write premiums or long-context bands are added.
export const officialSubscriptionPrices: SubscriptionPrice[] = [
  ["gpt-6-astra", "10", "1", "50", "2.5"],
  ["gpt-5.6-sol", "4", "0.4", "20", "2.5"],
  ["gpt-5.6-terra", "2", "0.2", "12", "2.5"],
  ["gpt-5.6-luna", "0.2", "0.02", "1.2", "2.5"],
].map(([model, input, cachedInput, output, fastMultiplier]) => ({model, input, cachedInput, output, fastMultiplier}));

const subscriptionCatalog: ModelPrice[] = officialSubscriptionPrices.map(p => ({
  ...p, cacheWrite: null, longContextThreshold: null,
  longInput: null, longCachedInput: null, longCacheWrite: null, longOutput: null,
}));

/** Existing custom modelPrices always remain API prices, even while subscription mode is selected. */
export function pricingCatalog(settings: Settings): ModelPrice[] {
  return settings.officialApiPricing === true ? settings.modelPrices ?? officialPrices : subscriptionCatalog;
}

export function pricingInfo(): PricingInfo {
  return {
    prices: officialPrices, source: pricingSource, checkedAt: pricingCheckedAt,
    currency: "USD", tier: "Standard API reference", speedSource: speedPricingSource,
    subscription: {
      prices: officialSubscriptionPrices, source: subscriptionPricingSource, checkedAt: pricingCheckedAt,
      currency: "USD", tier: "Subscription mode USD reference",
    },
  };
}

const rate = (value: string) => {
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, "0"));
};
// Rate and multiplier each retain six decimal places. Keep twelve display
// decimals for existing consumers, extending only when the exact result needs it.
const scale = 1_000_000_000_000_000_000n;
const decimal = (value: bigint) => {
  const sign = value < 0n ? "-" : "", n = value < 0n ? -value : value;
  return sign + n / scale + "." + (n % scale).toString().padStart(18, "0").replace(/0{1,6}$/, "");
};
function tokens(value: unknown): bigint | null {
  if (typeof value === "bigint") return value >= 0n ? value : null;
  if (typeof value === "string" && /^\d+$/.test(value)) return BigInt(value);
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? BigInt(value) : null;
}
type Tier = "standard" | "fast" | "unknown";
type TierTotal = { eventCount: number; total: bigint; totalKnown: boolean; value: bigint; known: boolean };

export function estimateCost(rows: Record<string, any>[], settings: Settings): EstimatedCost | null {
  if (!settings.costEnabled) return null;
  const api = settings.officialApiPricing === true;
  const prices = new Map(pricingCatalog(settings).map(p => [p.model, p]));
  const notes = new Set<string>(), tiers = new Map<Tier, TierTotal>();
  let value = 0n, known = rows.length === 0;
  for (const row of rows) {
    const tier: Tier = row.service_tier === "standard" || row.service_tier === "fast" ? row.service_tier : "unknown";
    let subtotal = tiers.get(tier);
    if (!subtotal) { subtotal = {eventCount: 0, total: 0n, totalKnown: true, value: 0n, known: false}; tiers.set(tier, subtotal); }
    const count = Number(row.event_count ?? 0), total = tokens(row.total_tokens);
    subtotal.eventCount += Number.isSafeInteger(count) && count >= 0 ? count : 0;
    if (total === null) subtotal.totalKnown = false; else subtotal.total += total;
    if (tier === "unknown") {
      notes.add("部分记录的 Standard / Fast 模式无法确认，未计入其估算值");
      continue;
    }
    const p = prices.get(row.model);
    if (!p) { notes.add(`未配置价格：${row.model || "未知模型"}`); continue; }
    const fast = p.fastMultiplier;
    if (tier === "fast" && fast == null) { notes.add(`${row.model}：Fast 费率未配置，未计入其估算值`); continue; }
    const multiplier = tier === "fast" ? rate(fast!) : 1_000_000n;
    const long = api && Number(row.long_context) === 1;
    const input = long ? p.longInput : p.input, cached = long ? p.longCachedInput : p.cachedInput;
    const write = long ? p.longCacheWrite : p.cacheWrite, output = long ? p.longOutput : p.output;
    const record = (amount: bigint) => { value += amount; subtotal!.value += amount; known = true; subtotal!.known = true; };
    const add = (quantity: bigint | null, unit: string | null, name: string) => {
      if (quantity === 0n) { record(0n); return; }
      if (quantity === null || unit === null) { notes.add(`${row.model}：${name}用量或单价缺失`); return; }
      record(quantity * rate(unit) * multiplier);
    };
    add(tokens(row.uncached_input), input, "非缓存输入");
    add(tokens(row.cached_input_tokens), cached, "缓存读取");
    add(tokens(row.output_tokens), output, "输出");
    if (api) {
      // Uncached input already includes writes. Add only the API price difference.
      const quantity = tokens(row.cache_write_input_tokens);
      if (tokens(row.uncached_input) !== null && Number(row.invalid_usage) === 0 && quantity !== null && quantity !== 0n) {
        if (write !== null && input !== null) record(quantity * (rate(write) - rate(input)) * multiplier);
        else notes.add(`${row.model}：缓存写入单价缺失`);
      }
      if (Number(row.missing_write) > 0 && (write === null || input === null || rate(write) !== rate(input)))
        notes.add("缓存写入未完整提供，参考额未含未知写入差价");
      if (Number(row.compat_events) > 0 && p.longContextThreshold !== null)
        notes.add("旧格式增量无法完整确认单请求长上下文档位");
    }
    if (Number(row.missing_usage) > 0) notes.add("部分输入、缓存读取或输出用量缺失");
    if (Number(row.invalid_usage) > 0) notes.add("部分缓存分项超过输入，无法完整估算");
  }
  return {
    amount: known ? decimal(value) : null,
    complete: notes.size === 0,
    currency: "USD",
    billingBasis: api ? "api" : "subscription",
    notes: [...notes],
    serviceTiers: (["standard", "fast", "unknown"] as Tier[]).flatMap(tier => {
      const sum = tiers.get(tier);
      return sum ? [{tier, eventCount: sum.eventCount, totalTokens: sum.totalKnown ? sum.total.toString() : null, amount: sum.known ? decimal(sum.value) : null}] : [];
    }),
  };
}
