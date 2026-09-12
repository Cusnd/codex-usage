import { Type, type Static } from "@sinclair/typebox";
import { NullableString } from './primitives.js';

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
