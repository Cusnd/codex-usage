import type { AccountUsage } from './contracts.js';
import type { CloudSnapshot } from './cloud.js';
export const ACCOUNT_BODY_BYTES=262144;
export type UsageCapabilities = { mode:'local'|'cloud'|'showcase';deviceFilter:boolean;localControl:boolean;refresh:'collect'|'read'|'example' };
export type CloudAccountSnapshot = {
  schemaVersion: 3; quota: CloudSnapshot;
  history: Omit<AccountUsage, 'accountId'> | null;
  historyCollectedAt: string | null;
};
export type CloudSource = {
  id: string; name: string; boundAt: string; protocol: number; paused: boolean; revoked: boolean; historyDeleted: boolean;
  collectedAt: string | null; receivedAt: string | null; coverageFrom: string | null; coverageTo: string | null;
  // V3 syncedThreads counts sessions whose latest source generation is complete and available;
  // totalThreads is the latest collector report. These are not a progress ratio.
  syncedThreads: number; totalThreads: number | null; initialComplete: boolean; error: string | null;
  // V3 retained cloud sessions, including unavailable sources and protected old generations.
  retainedThreads?: number;
  appliedAt?: string | null;
  historyDeleting?: boolean;
  deletionStatus?: 'retained' | 'deleting' | 'deleted' | 'failed';
  sourceCounts?: { known: number; complete: number; unavailable: number; pendingBatches: number };
};
export type CloudAccountView = {
  accountRef: string; deviceId: string; deviceName: string; receivedAt: string; stale: boolean;
  quota: CloudSnapshot; history: Omit<AccountUsage, 'accountId'> | null; historyCollectedAt: string | null;
  historyMeta?: {
    summarySource: CloudHistorySource;
    dailySources: (CloudHistorySource & { dates: string[] })[];
  };
};
export type CloudHistorySource = {
  deviceId: string; deviceName: string; collectedAt: string | null; receivedAt: string; stale: boolean;
};
