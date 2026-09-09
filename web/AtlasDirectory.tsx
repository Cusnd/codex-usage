import { ArrowLeft, ChevronRight } from "lucide-react";
import { useContext } from "react";
import { useSearchParams } from "react-router-dom";
import type {
  Filter,
  GroupRow,
  Metrics,
  Page,
  ThreadRow,
} from "../shared/contracts";
import { compact, percent, projectName } from "./api";
import { SessionPanel } from "./AtlasSession";
import {
  Group,
  SearchField,
  SortChoice,
  dimensions,
  offsetOf,
  shortId,
  useUrlPatch,
} from "./AtlasShared";
import { ErrorBox, Loading, Pagination, time } from "./ui";
import {
  CostValue,
  UsageBreakdown,
  UsageCells,
  UsageHeadings,
  sessionTitle,
} from "./Usage";
import { Workspace, useData, useRange } from "./workspace";

export function SessionList({
  filters,
  selected,
  onSelect,
  directory = false,
}: {
  filters: Filter;
  selected?: string;
  onSelect: (id: string) => void;
  directory?: boolean;
}) {
  const [search] = useSearchParams();
  const patch = useUrlPatch();
  const { settings } = useContext(Workspace);
  const q = useData<Page<ThreadRow>>("local/threads", {
    ...filters,
    q: search.get("q"),
    sort: search.get("sort") || "tokens",
    cacheBelow: search.get("lowCache") === "1" ? 0.2 : undefined,
    offset: offsetOf(search, "sessionOffset"),
    limit: 20,
  });
  return (
    <section className={directory ? "session-directory" : "session-ledger"}>
      <div className="session-tools">
        {directory && (
          <div className="atlas-section-bar">
            <h2>Sessions</h2>
          </div>
        )}
        <SearchField />
        <label className="checkbox low-cache">
          <input
            type="checkbox"
            checked={search.get("lowCache") === "1"}
            onChange={(e) =>
              patch({
                lowCache: e.target.checked ? "1" : undefined,
                sessionOffset: undefined,
              })
            }
          />
          缓存读取占比低于 20%
        </label>
        <SortChoice />
      </div>
      <ErrorBox error={q.error} />
      <Loading
        isLoading={q.isPending}
        empty={!q.isPending && q.data?.data.total === 0}
        emptyMessage={
          search.get("q") || search.get("lowCache") === "1"
            ? "没有匹配的任务。请修改搜索内容或取消缓存占比筛选。"
            : undefined
        }
      />
      {directory ? (
        <div className="atlas-directory-list">
          {q.data?.data.items.map((row, index) => (
            <button
              className={
                "atlas-directory-row " +
                (selected === row.id ? "is-selected" : "")
              }
              key={row.id}
              aria-pressed={selected === row.id}
              onClick={() => onSelect(row.id)}
            >
              <span className="index-number">
                {String(index + 1 + offsetOf(search, "sessionOffset")).padStart(
                  2,
                  "0",
                )}
              </span>
              <span className="directory-copy">
                <b>{sessionTitle(row)}</b>
                <small title={row.project || "未知项目"}>
                  {projectName(row.project)} · {shortId(row.id)}
                </small>
                <small>
                  非缓存 {compact(row.uncachedInputTokens)} · 缓存{" "}
                  {compact(row.cachedInputTokens)}
                </small>
              </span>
              <span className="directory-value">
                <b>{compact(row.totalTokens)}</b>
                <small>Token</small>
                {row.cost && <CostValue cost={row.cost} />}
              </span>
            </button>
          ))}
        </div>
      ) : (
        <div
          className="table-scroll"
          tabIndex={0}
          role="region"
          aria-label="任务用量明细表，可横向滚动"
        >
          <table className="atlas-table session-table">
            <thead>
              <tr>
                <th>Session / 项目</th>
                <th className="detail-column">最近活动</th>
                <UsageHeadings />
                <th />
              </tr>
            </thead>
            <tbody>
              {q.data?.data.items.map((row) => (
                <tr
                  key={row.id}
                  className={selected === row.id ? "is-selected" : ""}
                >
                  <td>
                    <button
                      className="text-button session-name"
                      title={sessionTitle(row)}
                      onClick={() => onSelect(row.id)}
                    >
                      {sessionTitle(row)}
                    </button>
                    <small className="block">
                      {projectName(row.project)} · {shortId(row.id)}
                    </small>
                  </td>
                  <td className="detail-column">
                    {time(row.lastAt, settings.timezone)}
                  </td>
                  <UsageCells data={row} />
                  <td>
                    <button
                      className="icon-button"
                      aria-label={`查看 ${sessionTitle(row)} 的轮次`}
                      onClick={() => onSelect(row.id)}
                    >
                      <ChevronRight size={16} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Pagination
        total={q.data?.data.total || 0}
        limit={20}
        param="sessionOffset"
      />
    </section>
  );
}

export function GroupWorkspace({ view }: { view: Group }) {
  const r = useRange();
  const patch = useUrlPatch();
  const selected = r.search.get("groupKey");
  let key: string | null | undefined;
  try {
    const value = JSON.parse(selected || "undefined");
    if (value === null || typeof value === "string") key = value;
  } catch {}
  const groups = useData<Page<GroupRow>>("local/breakdown", {
    ...r.filters,
    groupBy: view,
    limit: 20,
    offset: offsetOf(r.search, "groupOffset"),
  });
  const selectedFilters: Filter = {
    ...r.filters,
    ...(key === undefined
      ? {}
      : key === null
        ? {
            [view]: undefined,
            unknown: undefined,
            unknowns: [
              ...new Set([
                ...(r.filters.unknown ? [r.filters.unknown] : []),
                view,
              ]),
            ],
          }
        : {
            [view]: key,
            unknown: r.filters.unknown === view ? undefined : r.filters.unknown,
          }),
  };
  const conflict =
    key !== undefined &&
    ((r.filters[view] !== undefined && r.filters[view] !== key) ||
      (r.filters.unknown === view && key !== null));
  const summary = useData<Metrics>(
    "local/summary",
    selectedFilters,
    key !== undefined && !conflict,
  );
  const session = r.search.get("session") || undefined;
  const label = dimensions.find(([id]) => id === view)![1];
  return (
    <div
      className={
        "atlas-master-detail " + (key !== undefined ? "has-selection" : "")
      }
    >
      <section className="atlas-directory">
        <div className="atlas-section-bar">
          <h2>{label}索引</h2>
          <small>按消耗排序</small>
        </div>
        <ErrorBox error={groups.error} />
        <Loading
          isLoading={groups.isPending}
          empty={groups.data?.data.total === 0}
        />
        <div className="atlas-directory-list">
          {groups.data?.data.items.map((row, index) => (
            <button
              key={JSON.stringify(row.key)}
              className={
                "atlas-directory-row " + (key === row.key ? "is-selected" : "")
              }
              aria-pressed={key === row.key}
              onClick={() =>
                patch({
                  groupKey: JSON.stringify(row.key),
                  session: undefined,
                  sessionOffset: undefined,
                  turnOffset: undefined,
                  expandedTurn: undefined,
                  q: undefined,
                })
              }
            >
              <span className="index-number">
                {String(index + 1 + offsetOf(r.search, "groupOffset")).padStart(
                  2,
                  "0",
                )}
              </span>
              <span className="directory-copy">
                <b title={row.key || "未知"}>{row.label}</b>
                <small>
                  {row.threadCount} Sessions · {percent(row.share)}
                </small>
                <small>
                  非缓存 {compact(row.uncachedInputTokens)} · 缓存{" "}
                  {compact(row.cachedInputTokens)}
                </small>
              </span>
              <span className="directory-value">
                <b>{compact(row.totalTokens)}</b>
                <small>Token</small>
                {row.cost && <CostValue cost={row.cost} />}
              </span>
            </button>
          ))}
        </div>
        <Pagination
          total={groups.data?.data.total || 0}
          param="groupOffset"
          limit={20}
        />
      </section>
      <div className="atlas-detail">
        {key === undefined ? (
          <div className="atlas-empty">
            <span>从一个{label}开始</span>
            <h2>选择{label}查看任务</h2>
            <p>查看所选{label}的用量细分，再进入任务查看每一轮。</p>
          </div>
        ) : conflict ? (
          <div className="atlas-empty">
            选中分组不再匹配当前筛选。
            <button
              className="text-button"
              onClick={() => patch({ groupKey: undefined, session: undefined })}
            >
              返回目录
            </button>
          </div>
        ) : session ? (
          <SessionPanel
            id={session}
            filters={selectedFilters}
            onBack={() =>
              patch({
                session: undefined,
                turnOffset: undefined,
                expandedTurn: undefined,
              })
            }
          />
        ) : (
          <>
            <button
              className="text-button back-to-directory"
              onClick={() => patch({ groupKey: undefined })}
            >
              <ArrowLeft size={15} />
              返回{label}目录
            </button>
            <div className="detail-breadcrumb">选中{label} · 当前时间范围</div>
            <div className="atlas-detail-heading">
              <h2 title={key || "未知"}>
                {key === null
                  ? "未知"
                  : view === "project"
                    ? projectName(key)
                    : key}
              </h2>
              <div className="detail-total">
                <strong>{compact(summary.data?.data.totalTokens)}</strong>
                <span>Token</span>
              </div>
            </div>
            <ErrorBox error={summary.error} />
            <UsageBreakdown data={summary.data?.data} />
            {summary.data?.data.eventCount === 0 ? (
              <div className="atlas-empty">
                选中{label}不再匹配当前筛选。
                <button
                  className="text-button"
                  onClick={() => patch({ groupKey: undefined })}
                >
                  返回目录
                </button>
              </div>
            ) : (
              <SessionList
                filters={selectedFilters}
                onSelect={(id) =>
                  patch({
                    session: id,
                    turnOffset: undefined,
                    expandedTurn: undefined,
                  })
                }
              />
            )}
          </>
        )}
      </div>
    </div>
  );
}
