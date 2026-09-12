import { useCapabilities, useProjectLabels } from '../runtime/context.js';

import { ChevronLeft, ChevronRight, Cloud, Database, X } from "lucide-react";
import { DateTime } from "luxon";
import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import type { ApiResponse } from '../../contracts/responses.js';
import type { Filters, Metrics } from '../../contracts/query.js';
import { compact } from '../ui/format.js';
import { Choice } from "../ui/Choice.js";
import { UsageBreakdown } from "./Usage.js";
import { useData, useRange } from "../data/workspace.js";
import { Collapse, MotionDetails, PresenceList, Segmented } from "../motion/MotionPrimitives.js";
import { markQueryMotion } from "../motion/motion-state.js";
export function time(at: string | null | undefined, zone = "America/New_York") {
  return at
    ? DateTime.fromISO(at).setZone(zone).toFormat("MM-dd HH:mm:ss")
    : "尚未更新";
}
export function SourceBadge({ account = false }: { account?: boolean }) {
  const { deviceScope } = useCapabilities();
  return (
    <span className={"source-badge " + (account ? "account" : "local")}>
      {account ? <Cloud size={15} /> : <Database size={15} />}
      {account ? "账户官方统计" : deviceScope ? "设备记录分析" : "本机记录分析"}
    </span>
  );
}
export function Header({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children?: ReactNode;
}) {
  return (
    <header className="page-header">
      <div>
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      {children}
    </header>
  );
}
export function ErrorBox({ error }: { error: Error | null | undefined }) {
  return error ? (
    <div className="notice error" role="alert">
      {error.message}
    </div>
  ) : null;
}
export function Loading({
  isLoading,
  empty = false,
  emptyMessage,
}: {
  isLoading: boolean;
  empty?: boolean;
  emptyMessage?: string;
}) {
  const { deviceScope } = useCapabilities();
  const message = emptyMessage ?? (deviceScope ? "这个范围内还没有已同步的统计记录。可以调整时间或设备范围，并查看设备同步进度。" : "这个范围内还没有可统计记录。可以调整时间范围或刷新本地记录。");
  return isLoading ? (
    <div className="empty loading-state" role="status">
      正在读取用量…
    </div>
  ) : empty ? (
    <div className="empty" role="status">
      {message}
    </div>
  ) : null;
}
export function Notes({
  response,
}: {
  response: ApiResponse<unknown> | undefined;
}) {
  return (
    <>
      {response?.meta.devices?.length ? <p className="footnote">设备来源：{response.meta.devices.map(d=>d.name).join('、')}</p> : null}
      {response?.meta.warnings.map((w, i) => (
        <p className="footnote" key={i}>
          {w}
        </p>
      ))}
    </>
  );
}

export function FilterBar({ local = true }: { local?: boolean }) {
  const { projectName, projectDescription } = useProjectLabels();
  const r = useRange();
  const options = useData<Filters>("local/filters", {
    from: r.filters.from,
    to: r.filters.to,
  });
  const [customOpen, setCustomOpen] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const advanced = useRef<HTMLDetailsElement>(null);
  const customTrigger = useRef<HTMLButtonElement>(null);
  const [draftFrom, setDraftFrom] = useState(""),
    [draftTo, setDraftTo] = useState(""),
    [error, setError] = useState("");
  const beginCustom = () => {
    setError("");
    setDraftFrom(
      DateTime.fromISO(r.filters.from!)
        .setZone(r.timezone)
        .toFormat("yyyy-MM-dd HH:mm"),
    );
    setDraftTo(
      DateTime.fromISO(r.filters.to!)
        .setZone(r.timezone)
        .toFormat("yyyy-MM-dd HH:mm"),
    );
    setCustomOpen(true);
  };
  const applyCustom = (e: React.FormEvent) => {
    e.preventDefault();
    const from = DateTime.fromISO(draftFrom.trim().replace(" ", "T"), {
        zone: r.timezone,
      }),
      to = DateTime.fromISO(draftTo.trim().replace(" ", "T"), {
        zone: r.timezone,
      });
    if (!from.isValid || !to.isValid || from >= to) {
      setError("请输入有效时间，且开始时间早于结束时间。");
      return;
    }
    setError("");
    r.update({
      range: "custom",
      from: from.toFormat("yyyy-MM-dd'T'HH:mm"),
      to: to.toFormat("yyyy-MM-dd'T'HH:mm"),
    });
    setCustomOpen(false);
    customTrigger.current?.focus();
  };
  const change = (key: "project" | "model" | "effort", value: string) =>
    r.update(
      value === "unknown"
        ? { [key]: undefined, unknown: key }
        : {
            [key]: value ? value.slice(2) : undefined,
            unknown: r.filters.unknown === key ? undefined : r.filters.unknown,
          },
    );
  const active =
    local &&
    (["project", "model", "effort"] as const).some(
      (k) => r.filters[k] || r.filters.unknown === k,
    );
  return (
    <div className="filter-surface compact-filters">
      <div className="filter-bar">
        <div className="field range-field">
          <Segmented value={r.range} label="时间范围">
            {[
              ["today", "今天"],
              ["7", "最近 7 天"],
              ["30", "最近 30 天"],
            ].map(([value, label]) => (
              <button
                key={value}
                aria-pressed={r.range === value}
                className={r.range === value ? "selected" : ""}
                onClick={() => {
                  setCustomOpen(false);
                  r.update({ range: value, from: undefined, to: undefined });
                }}
              >
                {label}
              </button>
            ))}
            <button
              ref={customTrigger}
              aria-expanded={customOpen}
              aria-pressed={r.range === "custom"}
              className={r.range === "custom" ? "selected" : ""}
              onClick={beginCustom}
            >
              自定义
            </button>
          </Segmented>
        </div>
        {local && (
          <MotionDetails
            className="advanced-filters"
            detailsRef={advanced}
            open={advancedOpen}
            onOpenChange={setAdvancedOpen}
            popup contentClassName="advanced-filter-panel"
            summary={<>
              筛选
              {active
                ? ` · ${(["project", "model", "effort"] as const).filter((k) => r.filters[k] || r.filters.unknown === k).length}`
                : ""}
            </>}
          >
              <div className="advanced-filter-heading">
                <strong>限定统计范围</strong>
                <button
                  type="button"
                  aria-label="关闭筛选"
                  onClick={() => {
                    if (advanced.current) {
                      setAdvancedOpen(false);
                      advanced.current.querySelector("summary")?.focus();
                    }
                  }}
                >
                  <X size={16} />
                </button>
              </div>
              {(["project", "model", "effort"] as const).map((key, index) => {
                const name = ["项目", "模型", "推理强度"][index];
                const values =
                  options.data?.data[
                    (["projects", "models", "efforts"] as const)[index]
                  ] || [];
                return (
                  <div className="field" key={key}>
                    <span className="field-label">{name}</span>
                    <Choice
                      label={name}
                      value={
                        r.filters.unknown === key
                          ? "unknown"
                          : r.filters[key]
                            ? "v:" + r.filters[key]
                            : ""
                      }
                      searchable={key !== "effort"}
                      options={[
                        { value: "", label: "全部" + name },
                        ...values.map((v) => ({
                          value: v === null ? "unknown" : "v:" + v,
                          label:
                            v === null
                              ? "未知"
                              : key === "project"
                                ? projectName(v)
                                : v,
                          description: key === "project" && v ? projectDescription(v) : undefined,
                        })),
                      ]}
                      onChange={(v) => change(key, v)}
                    />
                  </div>
                );
              })}
          </MotionDetails>
        )}
        <MotionDetails className="range-summary" popup contentClassName="range-description" summary={<>
            {DateTime.fromISO(r.filters.from!)
              .setZone(r.timezone)
              .toFormat("MM-dd")}{" "}
            —{" "}
            {DateTime.fromISO(r.filters.to!)
              .setZone(r.timezone)
              .toFormat("MM-dd")}
          </>}>
            {DateTime.fromISO(r.filters.from!)
              .setZone(r.timezone)
              .toFormat("yyyy-MM-dd HH:mm")}{" "}
            至{" "}
            {DateTime.fromISO(r.filters.to!)
              .setZone(r.timezone)
              .toFormat("yyyy-MM-dd HH:mm")}
            <br />
            {r.timezone} · 以此时区重新统计
        </MotionDetails>
      </div>
      <Collapse open={customOpen}>
        <form className="custom-range-form" onSubmit={applyCustom}>
          <label>
            开始时间
            <input
              aria-label="开始时间"
              placeholder="2026-09-01 00:00"
              value={draftFrom}
              onChange={(e) => setDraftFrom(e.target.value)}
            />
          </label>
          <label>
            结束时间
            <input
              aria-label="结束时间"
              placeholder="2026-09-08 00:00"
              value={draftTo}
              onChange={(e) => setDraftTo(e.target.value)}
            />
          </label>
          <button className="primary-button">应用时间范围</button>
          <button type="button" onClick={() => { setCustomOpen(false); customTrigger.current?.focus(); }}>
            取消
          </button>
          {error && (
            <span role="alert" className="error-text">
              {error}
            </span>
          )}
        </form>
      </Collapse>
      <Collapse open={!!active} duration={160}>
        <div className="active-filters">
          <span>正在筛选</span>
          <PresenceList compact className="scope-chip-list" items={(["project", "model", "effort"] as const)
            .filter((k) => r.filters[k] || r.filters.unknown === k)
            .map((key) => ({ key, value: r.filters[key], unknown: r.filters.unknown === key }))} itemKey={(item) => item.key}>
            {({ key: k, value, unknown }) => (
              <button
                key={k}
                title={value || "未知"}
                onClick={() =>
                  r.update({
                    [k]: undefined,
                    unknown:
                      r.filters.unknown === k ? undefined : r.filters.unknown,
                  })
                }
              >
                {k === "project" ? "项目" : k === "model" ? "模型" : "推理强度"}
                ：
                {unknown
                  ? "未知"
                  : k === "project"
                    ? projectName(value!)
                    : value}{" "}
                <X size={13} aria-hidden="true" />
              </button>
            )}
          </PresenceList>
          <button
            className="clear-filters"
            onClick={() =>
              r.update({
                project: undefined,
                model: undefined,
                effort: undefined,
                unknown: undefined,
              })
            }
          >
            清除全部筛选
          </button>
        </div>
      </Collapse>
    </div>
  );
}
export function MetricsCards({ data }: { data: Metrics | undefined }) {
  return (
    <section className="metrics-summary">
      <div className="metrics-total">
        <span>总 Token</span>
        <strong>{compact(data?.totalTokens)}</strong>
      </div>
      <UsageBreakdown data={data} counts />
    </section>
  );
}
export function Pagination({
  total,
  limit = 50,
  param = "offset",
}: {
  total: number;
  limit?: number;
  param?: string;
}) {
  const [search, setSearch] = useSearchParams();
  const offset = Math.max(0, Number(search.get(param) || 0));
  useEffect(() => {
    if (total > 0 && offset >= total)
      setSearch(
        (old) => {
          const next = new URLSearchParams(old);
          next.set(param, String(Math.floor((total - 1) / limit) * limit));
          return next;
        },
        { replace: true },
      );
  }, [total, offset, limit, setSearch, param]);
  const move = (value: number) =>
    setSearch((old) => {
      const next = new URLSearchParams(old);
      next.set(param, String(value));
      markQueryMotion(next, old);
      return next;
    });
  return (
    <div className="pagination">
      <span>
        共 {total.toLocaleString()} 条
        {total > 0 ? ` · ${offset + 1}–${Math.min(offset + limit, total)}` : ""}
      </span>
      <div>
        <button
          disabled={offset === 0}
          onClick={() => move(Math.max(0, offset - limit))}
        >
          <ChevronLeft size={15} aria-hidden="true" /> 上一页
        </button>
        <button
          disabled={offset + limit >= total}
          onClick={() => move(offset + limit)}
        >
          下一页 <ChevronRight size={15} aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
