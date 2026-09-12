import { Type, type Static } from "@sinclair/typebox";
import { Price, NullableInteger } from './primitives.js';

export const ModelPriceSchema = Type.Object({
  model: Type.String({ minLength: 1, maxLength: 160 }),
  input: Price,
  cachedInput: Price,
  cacheWrite: Price,
  output: Price,
  longContextThreshold: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
  longInput: Price,
  longCachedInput: Price,
  longCacheWrite: Price,
  longOutput: Price,
  fastMultiplier: Type.Optional(Price),
});

export type ModelPrice = Static<typeof ModelPriceSchema>;

export const SubscriptionPriceSchema = Type.Object({
  model: Type.String({ minLength: 1, maxLength: 160 }),
  input: Price,
  cachedInput: Price,
  output: Price,
  fastMultiplier: Price,
});

export type SubscriptionPrice = Static<typeof SubscriptionPriceSchema>;

export const PricingInfoSchema = Type.Object({
  prices: Type.Array(ModelPriceSchema),
  source: Type.String(),
  checkedAt: Type.String(),
  currency: Type.Literal("USD"),
  tier: Type.String(),
  speedSource: Type.String(),
  subscription: Type.Object({
    prices: Type.Array(SubscriptionPriceSchema),
    source: Type.String(),
    checkedAt: Type.String(),
    currency: Type.Literal("USD"),
    tier: Type.String(),
  }),
});

export type PricingInfo = Static<typeof PricingInfoSchema>;

export const CostServiceTierSchema = Type.Object({
  tier: Type.Union([Type.Literal("standard"), Type.Literal("fast"), Type.Literal("unknown")]),
  eventCount: Type.Integer({ minimum: 0 }),
  totalTokens: NullableInteger,
  amount: Type.Union([Type.String(), Type.Null()]),
});

export const CostSchema = Type.Object({
  amount: Type.Union([Type.String(), Type.Null()]),
  complete: Type.Boolean(),
  currency: Type.Union([Type.Literal("USD"), Type.Literal("credits")]),
  billingBasis: Type.Optional(Type.Union([Type.Literal("subscription"), Type.Literal("api")])),
  notes: Type.Array(Type.String()),
  serviceTiers: Type.Optional(Type.Array(CostServiceTierSchema)),
});

export type EstimatedCost = Static<typeof CostSchema>;

export const SettingsSchema = Type.Object(
  {
    localInterval: Type.Integer({
      minimum: 0,
      maximum: 86400,
      description: "Seconds; 0 disables automatic refresh, otherwise >=10",
    }),
    accountInterval: Type.Integer({
      minimum: 0,
      maximum: 86400,
      description: "Seconds; 0 disables automatic refresh, otherwise >=60",
    }),
    timezone: Type.String({ minLength: 1 }),
    timezoneMode: Type.Union([Type.Literal("manual"), Type.Literal("system")]),
    costEnabled: Type.Optional(Type.Boolean()),
    officialApiPricing: Type.Optional(Type.Boolean()),
    modelPrices: Type.Optional(Type.Array(ModelPriceSchema, { maxItems: 100 })),
  },
  { additionalProperties: false },
);

export type Settings = Static<typeof SettingsSchema>;
