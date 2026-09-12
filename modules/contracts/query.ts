import { Type, type Static } from "@sinclair/typebox";
import { NullableInteger, Ratio, NullableString } from './primitives.js';
import { CostSchema } from './settings.js';

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

export const AgentUsageSchema = Type.Object({
  self: MetricsSchema,
  subagents: MetricsSchema,
  team: MetricsSchema,
  agents: Type.Array(Type.Object({
    id: Type.String(),
    parentId: NullableString,
    depth: Type.Integer({ minimum: 0 }),
    title: NullableString,
    project: NullableString,
    models: Type.Array(NullableString),
    usage: MetricsSchema,
  })),
});

export type AgentUsage = Static<typeof AgentUsageSchema>;

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
    Type.Object({
      id: Type.String(), project: NullableString,
      relation: Type.Union([
        Type.Literal("subagent"), Type.Literal("subagent_parent"),
        Type.Literal("fork"), Type.Literal("fork_parent"),
        Type.Literal("unknown"),
      ]),
    }),
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
