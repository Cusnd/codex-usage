import { Type, type Static } from "@sinclair/typebox";
import { NullableString, NullableInteger, IntegerText } from './primitives.js';

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
