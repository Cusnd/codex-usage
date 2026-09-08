import { Type, type Static, type TSchema } from "@sinclair/typebox";

export const NullableString = Type.Union([Type.String(), Type.Null()]);
export const IntegerText = Type.String({ pattern: "^-?[0-9]+$" });
export const NullableInteger = Type.Union([IntegerText, Type.Null()]);
const Ratio = Type.Union([Type.Number(), Type.Null()]);
const Price = Type.Union([
  Type.String({ pattern: "^[0-9]{1,8}(\\.[0-9]{1,6})?$" }),
  Type.Null(),
]);
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
});
export type ModelPrice = Static<typeof ModelPriceSchema>;
export const CostSchema = Type.Object({
  amount: Type.Union([Type.String(), Type.Null()]),
  complete: Type.Boolean(),
  currency: Type.Literal("USD"),
  notes: Type.Array(Type.String()),
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
    modelPrices: Type.Optional(Type.Array(ModelPriceSchema, { maxItems: 100 })),
  },
  { additionalProperties: false },
);
export type Settings = Static<typeof SettingsSchema>;
export const FilterSchema = Type.Object({
  from: Type.Optional(Type.String({ format: "date-time" })),
  to: Type.Optional(Type.String({ format: "date-time" })),
  project: Type.Optional(Type.String()),
  model: Type.Optional(Type.String()),
  effort: Type.Optional(Type.String()),
  threadId: Type.Optional(Type.String()),
  unknowns: Type.Optional(
    Type.Array(
      Type.Union([
        Type.Literal("project"),
        Type.Literal("model"),
        Type.Literal("effort"),
      ]),
      { maxItems: 3 },
    ),
  ),
  unknown: Type.Optional(
    Type.Union([
      Type.Literal("project"),
      Type.Literal("model"),
      Type.Literal("effort"),
    ]),
  ),
});
export type Filter = Static<typeof FilterSchema>;
export const Pagination = {
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200, default: 50 })),
  offset: Type.Optional(Type.Integer({ minimum: 0, default: 0 })),
};
export const GroupSchema = Type.Union([
  Type.Literal("project"),
  Type.Literal("model"),
  Type.Literal("effort"),
]);
export const TokensSchema = Type.Object({
  inputTokens: NullableInteger,
  cachedInputTokens: NullableInteger,
  cacheWriteInputTokens: NullableInteger,
  outputTokens: NullableInteger,
  reasoningOutputTokens: NullableInteger,
  totalTokens: NullableInteger,
});
export const MetricsSchema = Type.Object({
  ...TokensSchema.properties,
  uncachedInputTokens: NullableInteger,
  ordinaryInputTokens: NullableInteger,
  cacheWriteMissingEvents: Type.Integer(),
  cost: Type.Union([CostSchema, Type.Null()]),
  eventCount: Type.Integer(),
  threadCount: Type.Integer(),
  turnCount: Type.Integer(),
  cacheRatio: Ratio,
  incompleteEvents: Type.Integer(),
});
export type Metrics = Static<typeof MetricsSchema>;
export const GroupRowSchema = Type.Object({
  key: NullableString,
  label: Type.String(),
  share: Ratio,
  ...MetricsSchema.properties,
});
export type GroupRow = Static<typeof GroupRowSchema>;
export const ThreadRowSchema = Type.Object({
  id: Type.String(),
  title: NullableString,
  project: NullableString,
  firstAt: NullableString,
  lastAt: NullableString,
  ...MetricsSchema.properties,
});
export type ThreadRow = Static<typeof ThreadRowSchema>;
export const TurnRowSchema = Type.Object({
  id: NullableString,
  threadId: Type.String(),
  title: NullableString,
  project: NullableString,
  composition: Type.Array(
    Type.Object({
      model: NullableString,
      effort: NullableString,
      ...TokensSchema.properties,
    }),
  ),
  firstAt: NullableString,
  lastAt: NullableString,
  ...MetricsSchema.properties,
});
export type TurnRow = Static<typeof TurnRowSchema>;
export const TrendRowSchema = Type.Object({
  time: Type.String(),
  ...MetricsSchema.properties,
});
export type TrendRow = Static<typeof TrendRowSchema>;
export const MetaSchema = Type.Object({
  exampleData: Type.Optional(Type.Boolean()),
  source: Type.String(),
  updatedAt: NullableString,
  timezone: Type.String(),
  warnings: Type.Array(Type.String()),
  provider: Type.Optional(Type.Union([Type.Literal("app-server"), Type.Literal("http"), Type.Null()])),
  accountId: Type.Optional(NullableString),
  identityConfirmed: Type.Optional(Type.Boolean()),
  stale: Type.Optional(Type.Boolean()),
});
export type Meta = Static<typeof MetaSchema>;
export const ResponseSchema = <T extends TSchema>(schema: T) =>
  Type.Object({ data: schema, meta: MetaSchema });
export type ApiResponse<T> = { data: T; meta: Meta };
export const PageSchema = <T extends TSchema>(item: T) =>
  Type.Object({
    items: Type.Array(item),
    total: Type.Integer(),
    limit: Type.Integer(),
    offset: Type.Integer(),
  });
export type Page<T> = {
  items: T[];
  total: number;
  limit: number;
  offset: number;
};
export const SourceStatusSchema = Type.Object({
  running: Type.Boolean(),
  startedAt: NullableString,
  updatedAt: NullableString,
  error: NullableString,
  filesScanned: Type.Integer(),
  filesChanged: Type.Integer(),
  events: Type.Integer(),
  issues: Type.Integer(),
});
export type SourceStatus = Static<typeof SourceStatusSchema>;
export const AccountStatusSchema = Type.Object({
  ...SourceStatusSchema.properties,
  provider: Type.Union([Type.Literal("app-server"), Type.Literal("http"), Type.Null()]),
  fallbackReason: NullableString,
  errorCode: NullableString,
  accountId: NullableString,
  identityKey: NullableString,
  identityConfirmed: Type.Boolean(),
  available: Type.Boolean(),
  stale: Type.Boolean(),
});
export type AccountStatus = Static<typeof AccountStatusSchema>;
export const StatusSchema = Type.Object({
  local: SourceStatusSchema,
  account: SourceStatusSchema,
  accountLimits: AccountStatusSchema,
  accountHistory: AccountStatusSchema,
});
export type Status = Static<typeof StatusSchema>;
export type RefreshSource = "local" | "account" | "all" | "accountLimits" | "accountHistory";
export const AccountUsageSchema = Type.Object({
  accountId: NullableString,
  summary: Type.Object({
    lifetimeTokens: NullableInteger,
    peakDailyTokens: NullableInteger,
    longestRunningTurnSec: NullableInteger,
    currentStreakDays: NullableInteger,
    longestStreakDays: NullableInteger,
  }),
  dailyUsageBuckets: Type.Union([
    Type.Array(Type.Object({ startDate: Type.String(), tokens: IntegerText })),
    Type.Null(),
  ]),
});
export type AccountUsage = Static<typeof AccountUsageSchema>;
export const LimitWindowSchema = Type.Object({
  usedPercent: Type.Union([Type.Number(), Type.Null()]),
  remainingPercent: Type.Union([Type.Number(), Type.Null()]),
  windowDurationMins: Type.Union([Type.Number(), Type.Null()]),
  resetsAt: NullableString,
});
export const AccountLimitsSchema = Type.Object({
  accountId: NullableString,
  buckets: Type.Array(
    Type.Object({
      id: Type.String(),
      name: Type.String(),
      primary: Type.Union([LimitWindowSchema, Type.Null()]),
      secondary: Type.Union([LimitWindowSchema, Type.Null()]),
    }),
  ),
});
export type AccountLimits = Static<typeof AccountLimitsSchema>;
export const FiltersSchema = Type.Object({
  projects: Type.Array(NullableString),
  models: Type.Array(NullableString),
  efforts: Type.Array(NullableString),
});
export type Filters = Static<typeof FiltersSchema>;
export const ThreadDetailSchema = Type.Object({
  thread: ThreadRowSchema,
  source: NullableString,
  parentId: NullableString,
  related: Type.Array(
    Type.Object({ id: Type.String(), project: NullableString }),
  ),
  models: Type.Array(GroupRowSchema),
});
export type ThreadDetail = Static<typeof ThreadDetailSchema>;
export const CompareRowSchema = Type.Object({
  key: NullableString,
  label: Type.String(),
  current: NullableInteger,
  previous: NullableInteger,
  delta: NullableInteger,
  changeRatio: Ratio,
});
export const CompareSchema = Type.Object({
  current: MetricsSchema,
  previous: MetricsSchema,
  from: Type.String(),
  to: Type.String(),
  baselineFrom: Type.String(),
  baselineTo: Type.String(),
  items: Type.Array(CompareRowSchema),
});
export type Comparison = Static<typeof CompareSchema>;
export const ErrorSchema = Type.Object({
  error: Type.Object({ code: Type.String(), message: Type.String() }),
});
