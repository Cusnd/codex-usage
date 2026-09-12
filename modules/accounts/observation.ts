import type { AccountStatus } from "../contracts/status.js";
import type { AccountLimits } from "../contracts/accounts.js";

export type LimitObservation = {
  stableIdentity?: string | null;
  identityKey: string | null; identityKnown: boolean; data: AccountLimits | null;
  provider: AccountStatus['provider']; collectedAt: string | null; attemptedAt: string;
  errorCode: string | null; refreshInterval: number;
};
