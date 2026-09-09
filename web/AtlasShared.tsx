import { ChevronDown, Search, SlidersHorizontal, X } from "lucide-react";
import { useContext, useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import type { Filter, Metrics, TurnRow } from "../shared/contracts";
import { projectName } from "./api";
import { Choice } from "./Choice";
import { FilterBar, time } from "./ui";
import { useData, useRange, Workspace } from "./workspace";

export type Group = "project" | "model" | "effort";

export type View = Group | "session" | "turn";

export const dimensions: [View, string][] = [
  ["project", "项目"],
  ["model", "模型"],
  ["effort", "推理强度"],
  ["session", "Session"],
  ["turn", "Turn"],
];

export const shortId = (id: string) =>
  id.length > 16 ? id.slice(0, 8) + "…" + id.slice(-4) : id;

export const turnKey = (row: TurnRow) => JSON.stringify([row.threadId, row.id]);

export const offsetOf = (search: URLSearchParams, key: string) =>
  Math.max(0, Number(search.get(key)) || 0);

export function useUrlPatch() {
  const [, setSearch] = useSearchParams();
  return (patch: Record<string, string | undefined>) =>
    setSearch((old) => {
      const next = new URLSearchParams(old);
      for (const [key, value] of Object.entries(patch))
        value === undefined ? next.delete(key) : next.set(key, value);
      return next;
    });
}

export function SearchField({
  param = "q",
  label = "搜索任务名称、项目或 ID",
  pageParam = "sessionOffset",
}: {
  param?: string;
  label?: string;
  pageParam?: string;
}) {
  const [search] = useSearchParams();
  const patch = useUrlPatch();
  const [value, setValue] = useState(search.get(param) || "");
  useEffect(() => setValue(search.get(param) || ""), [search, param]);
  return (
    <form
      className="atlas-search"
      onSubmit={(e) => {
        e.preventDefault();
        patch({ [param]: value.trim() || undefined, [pageParam]: undefined });
      }}
    >
      <Search size={16} aria-hidden="true" />
      <input
        aria-label={label}
        placeholder={label}
        maxLength={300}
        value={value}
        onChange={(e) => setValue(e.target.value)}
      />
      {value && (
        <button
          type="button"
          aria-label="清除搜索"
          onClick={() => {
            setValue("");
            patch({ [param]: undefined, [pageParam]: undefined });
          }}
        >
          <X size={14} />
        </button>
      )}
      <button type="submit" className="search-submit">
        搜索
      </button>
    </form>
  );
}

export function SortChoice({
  param = "sort",
  pageParam = "sessionOffset",
}: {
  param?: string;
  pageParam?: string;
}) {
  const [search] = useSearchParams();
  const patch = useUrlPatch();
  return (
    <Choice
      label="排序方式"
      value={search.get(param) || "tokens"}
      options={[
        { value: "tokens", label: "按消耗" },
        { value: "recent", label: "最近活动" },
      ]}
      onChange={(v) => patch({ [param]: v, [pageParam]: undefined })}
    />
  );
}

export function ScopeLabel({ filters }: { filters: Filter }) {
  const { settings } = useContext(Workspace);
  return (
    <span className="scope-label">
      {filters.from
        ? `${time(filters.from, settings.timezone)} — ${time(filters.to, settings.timezone)}`
        : "已保留的全部记录"}
    </span>
  );
}

export function ActiveScope() {
  const r = useRange();
  const summary = useData<Metrics>("local/summary", r.filters);
  return (
    <div className="atlas-scope-chips">
      <span>
        {summary.data?.meta.exampleData ? "示例数据" : "本机记录"}
      </span>
      {(["project", "model", "effort"] as const)
        .filter((key) => r.filters[key] || r.filters.unknown === key)
        .map((key) => (
          <button
            key={key}
            title={r.filters[key]}
            onClick={() =>
              r.update({
                [key]: undefined,
                unknown:
                  r.filters.unknown === key ? undefined : r.filters.unknown,
              })
            }
          >
            {dimensions.find(([id]) => id === key)![1]}：
            {r.filters.unknown === key
              ? "未知"
              : key === "project"
                ? projectName(r.filters[key]!)
                : r.filters[key]}
            <X size={12} />
          </button>
        ))}
      <ScopeLabel filters={r.filters} />
    </div>
  );
}

export function RangeControls() {
  const r = useRange();
  return (
    <details
      className="atlas-range-menu"
      onKeyDown={(event) => {
        if (event.key === "Escape" && !event.defaultPrevented) {
          event.currentTarget.open = false;
          event.currentTarget.querySelector("summary")?.focus();
          event.stopPropagation();
        }
      }}
    >
      <summary>
        <SlidersHorizontal size={15} />
        {r.range === "custom"
          ? "自定义时间"
          : r.range === "today"
            ? "今天"
            : `最近 ${r.range} 天`}
        <ChevronDown size={14} />
      </summary>
      <div className="atlas-filter-popover">
        <FilterBar />
      </div>
    </details>
  );
}
