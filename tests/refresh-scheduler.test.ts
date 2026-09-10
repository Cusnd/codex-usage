import test from "node:test";
import assert from "node:assert/strict";
import { RefreshScheduler } from "../server/refresh-scheduler.js";
import type { Refresh } from "../server/refresh.js";
import type { Settings } from "../shared/contracts.js";
test("backend scheduler respects independent intervals, changes, disablement and wake without catch-up", () => {
  let now = Date.now();
  const settings = { localInterval: 60, accountInterval: 300 } as Settings;
  const startedAt = new Date(now).toISOString();
  const calls: string[] = [];
  const refresh = {
    status: {
      local: { startedAt },
      accountLimits: { startedAt },
      accountHistory: { startedAt },
    },
    trigger(key: "local" | "accountLimits" | "accountHistory") {
      calls.push(key);
      this.status[key].startedAt = new Date(now).toISOString();
    },
  };
  const scheduler = new RefreshScheduler(
    refresh as unknown as Refresh,
    () => settings,
  );
  now += 60000;
  scheduler.runDue(now);
  assert.deepEqual(calls, ["local"]);
  settings.localInterval = 0;
  settings.accountInterval = 60;
  scheduler.reschedule();
  scheduler.runDue(now);
  assert.deepEqual(calls, ["local", "accountLimits", "accountHistory"]);
  now += 86400000;
  scheduler.runDue(now);
  scheduler.runDue(now);
  assert.deepEqual(calls, [
    "local",
    "accountLimits",
    "accountHistory",
    "accountLimits",
    "accountHistory",
  ]);
  settings.accountInterval = 0;
  now += 86400000;
  scheduler.runDue(now);
  assert.equal(calls.length, 5);
  scheduler.close();
  settings.accountInterval = 60;
  scheduler.runDue(now);
  assert.equal(calls.length, 5);
});
