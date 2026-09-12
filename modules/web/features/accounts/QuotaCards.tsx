import type { ReactNode } from "react";
import type { CloudBucket } from "../../../contracts/cloud.js";
type Progress = { identity: string; value: number; label: string };
export function QuotaCards({
  buckets,
  formatTime,
  now,
  progress,
}: {
  buckets: CloudBucket[];
  formatTime: (at: string) => string;
  now?: number;
  progress?: (props: Progress) => ReactNode;
}) {
  return (
    <div className="limits-grid">
      {buckets.map((b) => (
        <section className="panel limit-panel" key={b.id}>
          <h2>{b.name}</h2>
          {(
            [
              ["主窗口", b.primary],
              ["次窗口", b.secondary],
            ] as const
          ).map(([name, w]) =>
            w ? (
              <div className="limit-window" key={name}>
                <div>
                  <span>
                    {w.windowDurationMins
                      ? `${w.windowDurationMins >= 1440 ? w.windowDurationMins / 1440 + " 天" : w.windowDurationMins >= 60 ? w.windowDurationMins / 60 + " 小时" : w.windowDurationMins + " 分钟"}窗口`
                      : name}
                  </span>
                  <strong>
                    {w.remainingPercent === null
                      ? "未知"
                      : w.remainingPercent.toFixed(0)}
                    <small>{w.remainingPercent === null ? "" : "% 剩余"}</small>
                  </strong>
                </div>
                {w.remainingPercent !== null &&
                  (progress ? (
                    progress({
                      identity: `${b.id}/${name}/${w.resetsAt}`,
                      value: w.remainingPercent,
                      label: `${b.name} ${name}剩余额度`,
                    })
                  ) : (
                    <div
                      className="cloud-quota-bar"
                      role="progressbar"
                      aria-label={`${b.name} ${name}剩余额度`}
                      aria-valuenow={w.remainingPercent}
                      aria-valuemin={0}
                      aria-valuemax={100}
                    >
                      <span
                        style={{
                          width: `${w.remainingPercent}%`,
                          background:
                            w.remainingPercent < 15
                              ? "var(--danger)"
                              : undefined,
                        }}
                      />
                    </div>
                  ))}
                <small>
                  已用{" "}
                  {w.usedPercent === null
                    ? "未知"
                    : w.usedPercent.toFixed(1) + "%"}{" "}
                  ·{" "}
                  {w.resetsAt
                    ? formatTime(w.resetsAt) + " 重置"
                    : "重置时间未知"}
                </small>
                {now !== undefined &&
                  w.resetsAt &&
                  Date.parse(w.resetsAt) <= now && (
                    <p className="cloud-reset-pending">
                      重置时间已过 · 等待更新确认
                    </p>
                  )}
              </div>
            ) : null,
          )}
          {!b.primary && !b.secondary && (
            <p className="footnote">此额度桶未返回窗口信息。</p>
          )}
        </section>
      ))}
    </div>
  );
}
