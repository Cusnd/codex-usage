export class ExampleAccount {
  constructor(private includeLimits = true) {}
  async selection() {
    return {
      identity: { key: "example", accountId: "example" },
      confirmed: true,
    };
  }
  async readUsage() {
    return {
      data: {
        accountId: "example",
        summary: {
          lifetimeTokens: null,
          peakDailyTokens: null,
          longestRunningTurnSec: null,
          currentStreakDays: null,
          longestStreakDays: null,
        },
        dailyUsageBuckets: null,
      },
      identity: { key: "example", accountId: "example" },
      provider: "app-server" as const,
      fallbackReason: null,
    };
  }
  async readLimits() {
    return {
      data: {
        accountId: "example",
        buckets:
          this.includeLimits
            ? [
                {
                  id: "example-codex",
                  name: "Codex · 示例额度",
                  primary: {
                    usedPercent: 36,
                    remainingPercent: 64,
                    windowDurationMins: 300,
                    resetsAt: "2026-09-09T02:00:00Z",
                  },
                  secondary: {
                    usedPercent: 58,
                    remainingPercent: 42,
                    windowDurationMins: 10080,
                    resetsAt: "2026-09-14T04:00:00Z",
                  },
                },
                {
                  id: "example-secondary",
                  name: "独立窗口 · 示例额度",
                  primary: {
                    usedPercent: 8,
                    remainingPercent: 92,
                    windowDurationMins: 10080,
                    resetsAt: "2026-09-14T04:00:00Z",
                  },
                  secondary: null,
                },
              ]
            : [],
      },
      identity: { key: "example", accountId: "example" },
      provider: "app-server" as const,
      fallbackReason: null,
    };
  }
  close() {}
}
