import test from "node:test";
import assert from "node:assert/strict";
import { Value } from "@sinclair/typebox/value";
import { CostSchema, PricingInfoSchema, SettingsSchema, type ModelPrice, type Settings } from "../shared/contracts.js";
import { estimateCost, officialPrices, pricingCatalog, pricingInfo } from "../shared/pricing.js";

const settings: Settings = {localInterval: 30, accountInterval: 300, timezone: "UTC", timezoneMode: "manual", costEnabled: true};
const api: Settings = {...settings, officialApiPricing: true};
const row = (patch: Record<string, unknown> = {}) => ({
  model: "gpt-6-astra", service_tier: "standard", service_tier_source: "record",
  event_count: 1, long_context: 0, uncached_input: 1_000_000n, cached_input_tokens: 0n,
  cache_write_input_tokens: 0n, output_tokens: 0n, total_tokens: 1_000_000n,
  invalid_usage: 0, missing_usage: 0, missing_write: 0, compat_events: 0, ...patch,
});
const custom = (patch: Partial<ModelPrice> = {}): ModelPrice => ({
  model: "custom", input: "1", cachedInput: "0.5", cacheWrite: "2", output: "3",
  longContextThreshold: null, longInput: null, longCachedInput: null, longCacheWrite: null, longOutput: null,
  ...patch,
});

test("subscription is the default even for old saved API prices, which survive switching modes", () => {
  const modelPrices = [custom({model: "gpt-6-astra", input: "12"})];
  const old = {...settings, modelPrices}, original = JSON.stringify(old);
  assert.equal(estimateCost([row()], old)?.amount, "10.000000000000");
  assert.equal(estimateCost([row()], {...old, officialApiPricing: false})?.currency, "USD");
  assert.equal(estimateCost([row()], old)?.billingBasis, "subscription");
  assert.equal(estimateCost([row()], {...old, officialApiPricing: true})?.amount, "12.000000000000");
  assert.equal(estimateCost([row()], {...old, officialApiPricing: true})?.currency, "USD");
  assert.equal(estimateCost([row()], {...old, officialApiPricing: true})?.billingBasis, "api");
  assert.equal(JSON.stringify(old), original);
  assert.equal(pricingCatalog({...old, officialApiPricing: true}), modelPrices);
  assert.ok(pricingCatalog(old).every(p => p.longContextThreshold === null));
});

test("subscription reference USD rates price cache reads separately and Fast at 2.5x", () => {
  const input = row({cached_input_tokens: 2_000_000n, output_tokens: 1_000_000n, total_tokens: 4_000_000n});
  const normal = estimateCost([input], settings)!;
  const fast = estimateCost([{...input, service_tier: "fast"}], settings)!;
  assert.equal(normal.amount, "62.000000000000");
  assert.equal(fast.amount, "155.000000000000");
  assert.equal(fast.complete, true);
  assert.deepEqual(fast.serviceTiers, [{tier: "fast", eventCount: 1, totalTokens: "4000000", amount: "155.000000000000"}]);
  for (const [model, expected] of [["gpt-5.6-sol", "10"], ["gpt-5.6-terra", "5"], ["gpt-5.6-luna", "0.5"]])
    assert.equal(Number(estimateCost([row({model, service_tier: "fast"})], settings)?.amount), Number(expected));
});

test("subscription has no API long-context or cache-write premium", () => {
  const source = row({long_context: 1, cache_write_input_tokens: 100_000n});
  assert.equal(estimateCost([source], settings)?.amount, "10.000000000000");
  const missing = estimateCost([row({long_context: 1, cache_write_input_tokens: null, missing_write: 1, compat_events: 1})], settings)!;
  assert.equal(missing.amount, "10.000000000000");
  assert.equal(missing.complete, true);
  assert.deepEqual(missing.notes, []);
});

test("API Fast is 2x and applies after API long-context bands and cache-write difference", () => {
  const source = row({cached_input_tokens: 2_000_000n, output_tokens: 1_000_000n, cache_write_input_tokens: 100_000n, total_tokens: 4_000_000n});
  assert.equal(estimateCost([source], api)?.amount, "62.250000000000");
  assert.equal(estimateCost([{...source, service_tier: "fast"}], api)?.amount, "124.500000000000");
  assert.equal(estimateCost([{...source, service_tier: "fast", long_context: 1}], api)?.amount, "199.000000000000");
  const missing = estimateCost([row({cache_write_input_tokens: null, missing_write: 1})], api)!;
  assert.equal(missing.complete, false);
  assert.ok(missing.notes.some(note => note.includes("写入")));
});

test("unknown tiers are excluded, retain raw token totals, and never masquerade as Standard", () => {
  const result = estimateCost([row(), row({service_tier: "fast"}), row({service_tier: "unknown", event_count: 2})], settings)!;
  assert.equal(result.amount, "35.000000000000");
  assert.equal(result.complete, false);
  assert.deepEqual(result.serviceTiers, [
    {tier: "standard", eventCount: 1, totalTokens: "1000000", amount: "10.000000000000"},
    {tier: "fast", eventCount: 1, totalTokens: "1000000", amount: "25.000000000000"},
    {tier: "unknown", eventCount: 2, totalTokens: "1000000", amount: null},
  ]);
  for (const service_tier of [undefined, null, "unknown", "priority", "invalid"])
    assert.equal(estimateCost([row({service_tier})], settings)?.amount, null);
});

test("unknown models and missing custom Fast rates produce incomplete estimates", () => {
  assert.equal(estimateCost([row({model: "unknown"})], settings)?.amount, null);
  const selected = {...api, modelPrices: [custom()]};
  const fast = row({model: "custom", service_tier: "fast"});
  assert.equal(estimateCost([fast], selected)?.amount, null);
  assert.equal(estimateCost([fast], selected)?.complete, false);
  assert.equal(estimateCost([fast], {...selected, modelPrices: [custom({fastMultiplier: "3"})]})?.amount, "3.000000000000");
  assert.equal(estimateCost([fast], {...selected, modelPrices: [custom({fastMultiplier: "0"})]})?.amount, "0.000000000000");
  const older = officialPrices.map(({fastMultiplier: _, ...p}) => p);
  assert.equal(estimateCost([row({service_tier: "fast"})], {...api, modelPrices: older})?.amount, "20.000000000000");
  const explicitlyUnset = older.map(p => ({...p, fastMultiplier: null}));
  assert.equal(estimateCost([row({service_tier: "fast"})], {...api, modelPrices: explicitlyUnset})?.amount, null);
});

test("missing components stay incomplete while known contributions remain exact", () => {
  const result = estimateCost([row({output_tokens: null, total_tokens: null, missing_usage: 1})], settings)!;
  assert.equal(result.amount, "10.000000000000");
  assert.equal(result.complete, false);
  assert.equal(result.serviceTiers?.[0].totalTokens, null);
  const noAmounts = custom({input: null, cachedInput: null, cacheWrite: null, output: null});
  assert.equal(estimateCost([row({model: "custom", cached_input_tokens: 1n, output_tokens: 1n})], {...api, modelPrices: [noAmounts]})?.amount, null);
});

test("token counts beyond Number precision and fractional custom multipliers retain exact decimals", () => {
  const huge = 9_007_199_254_740_993n;
  const result = estimateCost([row({uncached_input: huge, total_tokens: huge})], settings)!;
  assert.equal(result.amount, "90071992547.409930000000");
  assert.equal(result.serviceTiers?.[0].totalTokens, "9007199254740993");
  const tiny = {...api, modelPrices: [custom({input: "0.000001", fastMultiplier: "0.000001"})]};
  assert.equal(estimateCost([row({model: "custom", service_tier: "fast", uncached_input: 1n, total_tokens: 1n})], tiny)?.amount, "0.000000000000000001");
});

test("disabled estimates stay null, empty data is a complete zero, and schema preserves explicit units", () => {
  assert.equal(estimateCost([row()], {...settings, costEnabled: false}), null);
  for (const selected of [settings, api]) {
    const result = estimateCost([], selected)!;
    assert.equal(result.amount, "0.000000000000");
    assert.equal(result.complete, true);
    assert.deepEqual(result.serviceTiers, []);
    assert.equal(Value.Check(CostSchema, result), true);
  }
  assert.equal(Value.Check(SettingsSchema, {...settings, officialApiPricing: true}), true);
  assert.equal(Value.Check(SettingsSchema, {...settings, officialApiPricing: "true"}), false);
  const info = pricingInfo();
  assert.equal(Value.Check(PricingInfoSchema, info), true);
  assert.equal(info.currency, "USD");
  assert.equal(info.subscription.currency, "USD");
  assert.equal(info.prices.length, 4);
  assert.equal(info.subscription.prices.length, 4);
});

test("direct dollar prices use subscription Fast 2.5x or opted-in API Fast 2x without conversion settings", () => {
  const standard = row(), fast = row({service_tier: "fast"});
  assert.equal(estimateCost([standard], settings)?.amount, "10.000000000000");
  assert.equal(estimateCost([standard], api)?.amount, "10.000000000000");
  assert.equal(estimateCost([fast], settings)?.amount, "25.000000000000");
  assert.equal(estimateCost([fast], api)?.amount, "20.000000000000");
  assert.equal(Value.Check(SettingsSchema, {...settings, subscriptionUsdPerCredit: "0.04"}), false);
  assert.equal(Object.hasOwn(estimateCost([fast], settings)!, "creditConversion"), false);
  assert.equal(Object.hasOwn(pricingInfo().subscription, "usdPerCredit"), false);
  assert.equal(Value.Check(CostSchema, {amount: "1.000000000000", complete: true, currency: "credits", notes: []}), true);
});
