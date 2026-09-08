import {
  Fragment,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Link,
  useLocation,
  useNavigate,
  useParams,
  useSearchParams,
} from "react-router-dom";
import {
  ArrowLeft,
  ArrowUpRight,
  ChevronDown,
  ChevronRight,
  Copy,
  Search,
  SlidersHorizontal,
  X,
} from "lucide-react";
import { DateTime } from "luxon";
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  Brush,
} from "recharts";
import type {
  Filter,
  GroupRow,
  Metrics,
  Page,
  ThreadDetail,
  ThreadRow,
  TrendRow,
  TurnRow,
} from "../shared/contracts";
import { bucketRange, bucketTimes } from "../shared/time-range";
import { Workspace, useData, useRange } from "./workspace";
import {
  ErrorBox,
  FilterBar,
  Header,
  Loading,
  Notes,
  Pagination,
  time,
} from "./ui";
import { compact, exact, percent, projectName } from "./api";
import { Choice } from "./Choice";
import {
  CostValue,
  sessionTitle,
  UsageBreakdown,
  UsageCells,
  UsageHeadings,
} from "./Usage";
import { ComparisonSection } from "./Comparison";
import { AgentUsagePanel } from "./AgentUsage";

type Group = "project" | "model" | "effort";
type View = Group | "session" | "turn";
const dimensions: [View, string][] = [
  ["project", "项目"],
  ["model", "模型"],
  ["effort", "推理强度"],
  ["session", "Session"],
  ["turn", "Turn"],
];
const shortId = (id: string) =>
  id.length > 16 ? id.slice(0, 8) + "…" + id.slice(-4) : id;
const turnKey = (row: TurnRow) => JSON.stringify([row.threadId, row.id]);
const offsetOf = (search: URLSearchParams, key: string) =>
  Math.max(0, Number(search.get(key)) || 0);
function useUrlPatch() {
  const [, setSearch] = useSearchParams();
  return (patch: Record<string, string | undefined>) =>
    setSearch((old) => {
      const next = new URLSearchParams(old);
      for (const [key, value] of Object.entries(patch))
        value === undefined ? next.delete(key) : next.set(key, value);
      return next;
    });
}

function SearchField({
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

function SortChoice({
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

function ScopeLabel({ filters }: { filters: Filter }) {
  const { settings } = useContext(Workspace);
  return (
    <span className="scope-label">
      {filters.from
        ? `${time(filters.from, settings.timezone)} — ${time(filters.to, settings.timezone)}`
        : "已保留的全部记录"}
    </span>
  );
}

function ActiveScope() {
  const r = useRange();
  const summary = useData<Metrics>("local/summary", r.filters);
  return (
    <div className="atlas-scope-chips">
      <span>
        {summary.data?.meta.exampleData ? "概念设计 · 示例数据" : "本机记录"}
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

function RangeControls() {
  const r = useRange();
  return (
    <details className="atlas-range-menu">
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

function TrendWorkspace() {
  const r = useRange();
  const patch = useUrlPatch();
  const bucket = r.search.get("bucket") === "hour" ? "hour" : "day";
  const collapsed = r.search.get("trend") === "collapsed";
  const trend = useData<TrendRow[]>(
    "local/trend",
    { ...r.filters, bucket },
    !collapsed,
  );
  const summary = useData<Metrics>("local/summary", r.filters);
  const brush = useRef<{ startIndex?: number; endIndex?: number } | null>(null);
  const points = useMemo(() => {
    const rows = new Map(
      (trend.data?.data || []).map((row) => [
        DateTime.fromISO(row.time, { zone: r.timezone }).toMillis(),
        row,
      ]),
    );
    const continuous = bucketTimes(
      r.filters.from!,
      r.filters.to!,
      r.timezone,
      bucket,
    );
    return (
      continuous.length
        ? continuous
        : (trend.data?.data || []).map((row) => row.time)
    ).map((at) => {
      const row = rows.get(
        DateTime.fromISO(at, { zone: r.timezone }).toMillis(),
      );
      return {
        time: at,
        value:
          row?.totalTokens == null ? 0 : Number(row.totalTokens) / 1_000_000,
        row,
        hasRecords: Boolean(row),
      };
    });
  }, [trend.data, r.filters.from, r.filters.to, r.timezone, bucket]);
  const selectRange = (from: string, to: string, hourly: boolean) => {
    const parent =
      r.search.get("parentRange") ||
      JSON.stringify({
        range: r.range,
        from: r.filters.from,
        to: r.filters.to,
        bucket,
      });
    r.update({
      range: "custom",
      from,
      to,
      bucket: hourly ? "hour" : bucket,
      parentRange: parent,
    });
  };
  const drillDay = (at: string) => {
    if (bucket !== "day") return;
    const next = bucketRange(
      at,
      "day",
      r.timezone,
      r.filters.from!,
      r.filters.to!,
    );
    if (next) selectRange(next.from, next.to, true);
  };
  const commitBrush = (
    range: { startIndex?: number; endIndex?: number } | null,
  ) => {
    if (!range || !points.length) return;
    const first = range.startIndex ?? 0,
      last = range.endIndex ?? points.length - 1;
    if (first === 0 && last === points.length - 1) return;
    const left = bucketRange(
      points[first]?.time,
      bucket,
      r.timezone,
      r.filters.from!,
      r.filters.to!,
    );
    const right = bucketRange(
      points[last]?.time,
      bucket,
      r.timezone,
      r.filters.from!,
      r.filters.to!,
    );
    if (left && right) selectRange(left.from, right.to, false);
  };
  const restore = () => {
    try {
      const old = JSON.parse(r.search.get("parentRange")!);
      r.update({
        range: "custom",
        from: old.from,
        to: old.to,
        bucket: old.bucket,
        parentRange: undefined,
      });
    } catch {
      patch({ parentRange: undefined });
    }
  };
  return (
    <section className="atlas-time">
      <div className="atlas-section-bar">
        <h2>
          {collapsed
            ? "范围内统计"
            : bucket === "day"
              ? "每日消耗"
              : "每小时消耗"}
        </h2>
        <div className="actions">
          {r.search.has("parentRange") && (
            <button className="text-button" onClick={restore}>
              <ArrowLeft size={14} />
              返回原时间范围
            </button>
          )}
          <button
            className="text-button"
            aria-expanded={!collapsed}
            onClick={() =>
              patch({ trend: collapsed ? undefined : "collapsed" })
            }
          >
            {collapsed ? "展开趋势" : "收起趋势"}
            <ChevronDown size={14} />
          </button>
        </div>
      </div>
      <ErrorBox error={summary.error || trend.error} />
      <div className={"atlas-trend-grid " + (collapsed ? "is-collapsed" : "")}>
        {!collapsed && (
          <div className="atlas-chart-panel">
            <div className="chart-toolbar">
              {bucket === "day" ? (
                <Choice
                  label="选择一天查看小时趋势"
                  value=""
                  placeholder="百万 Token · 选择日期下钻"
                  options={points.map((p) => ({
                    value: p.time,
                    label: p.time,
                  }))}
                  onChange={drillDay}
                />
              ) : (
                <small>单位：百万 Token · {r.timezone}</small>
              )}
              <div className="segmented">
                {(["day", "hour"] as const).map((value) => (
                  <button
                    key={value}
                    aria-pressed={bucket === value}
                    className={bucket === value ? "selected" : ""}
                    onClick={() => patch({ bucket: value })}
                  >
                    {value === "day" ? "按日" : "按小时"}
                  </button>
                ))}
              </div>
            </div>
            <Loading isLoading={trend.isPending} />
            {!trend.isPending && !trend.error && (
              <div
                className="atlas-chart"
                onKeyUp={() => {
                  commitBrush(brush.current);
                  brush.current = null;
                }}
              >
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart
                    key={`${r.filters.from}/${r.filters.to}/${bucket}`}
                    data={points}
                    margin={{ left: 0, right: 12, top: 8, bottom: 5 }}
                    onClick={(event) => {
                      if (event?.activeLabel != null)
                        drillDay(String(event.activeLabel));
                    }}
                  >
                    <CartesianGrid vertical={false} stroke="#dfe1e4" />
                    <XAxis
                      dataKey="time"
                      axisLine={false}
                      tickLine={false}
                      minTickGap={24}
                      tickFormatter={(at) =>
                        DateTime.fromISO(at, { zone: r.timezone }).toFormat(
                          bucket === "day" ? "MM.dd" : "HH:mm",
                        )
                      }
                    />
                    <YAxis
                      tickLine={false}
                      axisLine={false}
                      width={48}
                      tickFormatter={(n) => `${n}M`}
                    />
                    <Tooltip
                      cursor={{ fill: "#e9edfc" }}
                      content={({ active, payload }) => {
                        const point = payload?.[0]?.payload as
                          | (typeof points)[number]
                          | undefined;
                        return active && point ? (
                          <div className="atlas-tooltip">
                            <b>
                              {time(
                                DateTime.fromISO(point.time, {
                                  zone: r.timezone,
                                }).toISO(),
                                r.timezone,
                              )}
                            </b>
                            <strong>
                              {point.row ? exact(point.row.totalTokens) : "0"}{" "}
                              Token
                            </strong>
                            {point.row && (
                              <>
                                <span>
                                  非缓存输入{" "}
                                  {exact(point.row.uncachedInputTokens)}
                                </span>
                                <span>
                                  缓存读取 {exact(point.row.cachedInputTokens)}
                                </span>
                                <span>
                                  输出 {exact(point.row.outputTokens)}
                                </span>
                              </>
                            )}
                            <small>
                              {point.hasRecords
                                ? "本机记录"
                                : "该时段无本地记录"}
                            </small>
                          </div>
                        ) : null;
                      }}
                    />
                    <Bar
                      dataKey="value"
                      fill="#2944be"
                      maxBarSize={64}
                      isAnimationActive={false}
                    />
                    {points.length > 1 && (
                      <Brush
                        dataKey="time"
                        height={18}
                        travellerWidth={8}
                        stroke="#2944be"
                        fill="#eef0f8"
                        ariaLabel="选择分析时间范围"
                        tickFormatter={(at) =>
                          DateTime.fromISO(String(at), {
                            zone: r.timezone,
                          }).toFormat(bucket === "day" ? "MM.dd" : "HH:mm")
                        }
                        onChange={(range) => {
                          brush.current = range;
                        }}
                        onDragEnd={(range) => {
                          commitBrush(range);
                          brush.current = null;
                        }}
                      />
                    )}
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}
          </div>
        )}
        <div className="atlas-total">
          <span>范围内 Token</span>
          <strong title={exact(summary.data?.data.totalTokens)}>
            {compact(summary.data?.data.totalTokens)}
          </strong>
          <dl>
            <dt>Sessions</dt>
            <dd>{summary.data?.data.threadCount ?? "—"}</dd>
            <dt>Turns</dt>
            <dd>{summary.data?.data.turnCount ?? "—"}</dd>
          </dl>
          <small>{r.timezone} · 本机记录</small>
        </div>
      </div>
      <UsageBreakdown data={summary.data?.data} />
    </section>
  );
}

function SessionList({
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
      <div className="atlas-section-bar">
        <h2>Sessions</h2>
        <SortChoice />
      </div>
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
      <ErrorBox error={q.error} />
      <Loading
        isLoading={q.isPending}
        empty={!q.isPending && q.data?.data.total === 0}
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
        <div className="table-scroll">
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

export function TurnTable({
  filters,
  threadId,
  global = false,
}: {
  filters: Filter;
  threadId?: string;
  global?: boolean;
}) {
  const [search] = useSearchParams();
  const patch = useUrlPatch();
  const location = useLocation();
  const pageParam = global ? "globalTurnOffset" : "turnOffset";
  const sortParam = global ? "globalTurnSort" : "turnSort";
  const expanded = search.get("expandedTurn");
  const { settings } = useContext(Workspace);
  const q = useData<Page<TurnRow>>(
    global
      ? "local/turns"
      : `local/threads/${encodeURIComponent(threadId!)}/turns`,
    {
      ...filters,
      sort: search.get(sortParam) || "tokens",
      q: global ? search.get("turnQ") : undefined,
      offset: offsetOf(search, pageParam),
      limit: 20,
    },
  );
  const visibleExpanded = q.data?.data.items.some(
    (row) => turnKey(row) === expanded,
  );
  let identity: [string, string | null] | null = null;
  try {
    const parsed = JSON.parse(expanded || "null");
    if (
      Array.isArray(parsed) &&
      typeof parsed[0] === "string" &&
      (parsed[1] === null || typeof parsed[1] === "string")
    )
      identity = parsed as [string, string | null];
  } catch {}
  const hidden = useData<Page<TurnRow>>(
    "local/turns",
    {
      ...filters,
      threadId: identity?.[0],
      turnId: identity?.[1] ?? undefined,
      missingTurn: identity?.[1] === null ? true : undefined,
      limit: 1,
    },
    !!identity && !q.isPending && !visibleExpanded,
  );
  const expand = (row: TurnRow) =>
    patch({
      expandedTurn: expanded === turnKey(row) ? undefined : turnKey(row),
    });
  const colspan = (global ? 4 : 3) + 4 + (settings.costEnabled ? 2 : 0);
  return (
    <section className="turn-section">
      <div className="atlas-section-bar">
        <div>
          <h2>{global ? "全部 Session 的 Turn" : "Turn 明细"}</h2>
          <small>
            {global
              ? "跨任务观察每一轮投入"
              : filters.from
                ? "当前 Session · 当前筛选范围"
                : "完整 Session · 全部保留记录"}
          </small>
        </div>
        <SortChoice param={sortParam} pageParam={pageParam} />
      </div>
      {global && (
        <SearchField
          param="turnQ"
          pageParam={pageParam}
          label="搜索任务、项目或轮次 ID"
        />
      )}
      <ErrorBox error={q.error || hidden.error} />
      <Loading
        isLoading={q.isPending}
        empty={!q.isPending && q.data?.data.total === 0}
      />
      {!!expanded && !q.isPending && !visibleExpanded && (
        <div className="notice">
          <span>
            {hidden.isFetching
              ? "正在核对选中轮次…"
              : hidden.data?.data.total
                ? "选中轮次不在当前页。"
                : "选中轮次不再匹配当前筛选。"}
          </span>
          <button
            className="text-button"
            onClick={() => patch({ expandedTurn: undefined })}
          >
            返回轮次列表
          </button>
        </div>
      )}
      <div className="table-scroll">
        <table className="atlas-table turn-table">
          <thead>
            <tr>
              {global && <th>所属 Session</th>}
              <th>轮次 / 时间</th>
              <th className="detail-column">模型 · 推理强度</th>
              <UsageHeadings />
              <th />
            </tr>
          </thead>
          <tbody>
            {q.data?.data.items.map((row) => (
              <Fragment key={turnKey(row)}>
                <tr className={expanded === turnKey(row) ? "is-selected" : ""}>
                  {global && (
                    <td>
                      <Link
                        className="session-name"
                        to={`/threads/${encodeURIComponent(row.threadId)}?${new URLSearchParams({ ...Object.fromEntries(search), scope: "filtered", returnTo: location.pathname + location.search })}`}
                        state={{ from: location.pathname + location.search }}
                      >
                        {sessionTitle({ ...row, id: row.threadId })}
                      </Link>
                      <small className="block">
                        {projectName(row.project)} · {shortId(row.threadId)}
                      </small>
                    </td>
                  )}
                  <td>
                    <button
                      className="text-button"
                      onClick={() => expand(row)}
                      title={row.id || "轮次身份未提供"}
                    >
                      {row.id ? shortId(row.id) : "未识别轮次的记录"}
                    </button>
                    <small className="block">
                      {time(row.firstAt, settings.timezone)}
                    </small>
                  </td>
                  <td className="detail-column">
                    {row.composition.length === 1 ? (
                      <>
                        {row.composition[0].model || "未知模型"}
                        <small className="block">
                          {row.composition[0].effort || "未知强度"}
                        </small>
                      </>
                    ) : (
                      <button
                        className="text-button"
                        onClick={() => expand(row)}
                      >
                        多模型 / 强度 · {row.composition.length}
                      </button>
                    )}
                  </td>
                  <UsageCells data={row} />
                  <td>
                    <button
                      className="icon-button"
                      aria-label={`${expanded === turnKey(row) ? "收起" : "展开"}轮次 ${row.id || "身份缺失"}`}
                      aria-expanded={expanded === turnKey(row)}
                      onClick={() => expand(row)}
                    >
                      {expanded === turnKey(row) ? (
                        <ChevronDown size={16} />
                      ) : (
                        <ChevronRight size={16} />
                      )}
                    </button>
                  </td>
                </tr>
                {expanded === turnKey(row) && (
                  <tr className="turn-expansion">
                    <td colSpan={colspan}>
                      <div className="turn-detail">
                        <UsageBreakdown data={row} />
                        <div className="turn-detail-bottom">
                          <div>
                            <h3>输入与输出口径</h3>
                            <p>
                              输入合计 {exact(row.inputTokens)} · 普通输入{" "}
                              {exact(row.ordinaryInputTokens)}
                            </p>
                            <p>
                              推理输出 {exact(row.reasoningOutputTokens)}
                              （包含在输出中）
                            </p>
                            <p>
                              缓存写入{" "}
                              {row.cacheWriteInputTokens == null
                                ? "来源未提供"
                                : exact(row.cacheWriteInputTokens)}
                              （包含在非缓存输入中）
                            </p>
                          </div>
                          <div>
                            <h3>模型与推理强度构成</h3>
                            {row.composition.map((part) => (
                              <p
                                key={JSON.stringify([part.model, part.effort])}
                              >
                                <b>{part.model || "未知模型"}</b> ·{" "}
                                {part.effort || "未知强度"}
                                <strong>{compact(part.totalTokens)}</strong>
                              </p>
                            ))}
                          </div>
                        </div>
                        {row.cost?.notes.map((note) => (
                          <p className="footnote" key={note}>
                            {note}
                          </p>
                        ))}
                      </div>
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
      <Pagination
        total={q.data?.data.total || 0}
        limit={20}
        param={pageParam}
      />
      <p className="footnote">
        输入包含缓存读取与写入；推理输出包含在输出中。分项不重复计入总量。未识别轮次按所属
        Session 单列。
      </p>
    </section>
  );
}

function SessionPanel({
  id,
  filters,
  full = false,
  onBack,
}: {
  id: string;
  filters: Filter;
  full?: boolean;
  onBack?: () => void;
}) {
  const detail = useData<ThreadDetail>(
    `local/threads/${encodeURIComponent(id)}`,
  );
  const summary = useData<Metrics>("local/summary", {
    ...filters,
    threadId: id,
  });
  const location = useLocation();
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState("");
  useEffect(() => {
    setCopied(false);
    setCopyError("");
  }, [id]);
  const data = full ? detail.data?.data.thread : summary.data?.data;
  const title = detail.data?.data.thread
    ? sessionTitle(detail.data.data.thread)
    : shortId(id);
  return (
    <div className="session-panel">
      {onBack && (
        <button className="text-button back-to-directory" onClick={onBack}>
          <ArrowLeft size={15} />
          返回目录
        </button>
      )}
      <div className="detail-breadcrumb">Session / {title}</div>
      <div className="atlas-detail-heading">
        <div>
          <h2>{title}</h2>
          <p title={detail.data?.data.thread.project || "未知项目"}>
            {projectName(detail.data?.data.thread.project || null)} ·{" "}
            <span className="mono">{shortId(id)}</span>
            <button
              className="icon-button"
              aria-label="复制 Session ID"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(id);
                  setCopied(true);
                } catch {
                  setCopyError("复制失败，请手动复制任务 ID。");
                }
              }}
            >
              <Copy size={14} />
            </button>
            {copied && <small role="status">已复制</small>}
          </p>
        </div>
        <div className="detail-total">
          <strong>{compact(data?.totalTokens)}</strong>
          <span>当前 agent · Token · {data?.turnCount ?? "—"} Turns</span>
        </div>
      </div>
      {copyError && <p role="status">{copyError}</p>}
      <div className="detail-scope">
        <span>{full ? "完整 Session" : "当前 Session · 范围内统计"}</span>
        <ScopeLabel filters={filters} />
        {!full && (
          <Link
            to={`/threads/${encodeURIComponent(id)}?${new URLSearchParams({ returnTo: location.pathname + location.search })}`}
            state={{ from: location.pathname + location.search }}
          >
            查看完整 Session <ArrowUpRight size={14} />
          </Link>
        )}
      </div>
      <ErrorBox error={detail.error || summary.error} />
      <Loading isLoading={detail.isPending || summary.isPending} />
      {data && data.eventCount === 0 ? (
        <div className="atlas-empty">
          {full
            ? "当前 agent 暂无可统计用量记录，已识别的子 agent 用量见下方。"
            : "当前 agent 在筛选范围内暂无用量记录。下方仍会展示其子 agent 的范围内用量。"}
        </div>
      ) : (
        <>
          <UsageBreakdown data={data} />
          <TurnTable filters={filters} threadId={id} />
        </>
      )}
      <AgentUsagePanel id={id} filters={full ? {} : filters} />
      {!!detail.data?.data.related.length && (
        <details className="related-tasks">
          <summary>关联任务 · {detail.data.data.related.length}</summary>
          {detail.data.data.related.map((row) => (
            <Link
              key={`${row.id}:${row.relation}`}
              to={`/threads/${encodeURIComponent(row.id)}`}
              state={{ from: location.pathname + location.search }}
            >
              {{ subagent: "子 agent", subagent_parent: "父 agent", fork: "Fork 任务", fork_parent: "Fork 来源", unknown: "关系待识别" }[row.relation]} · {projectName(row.project)} · {shortId(row.id)}
            </Link>
          ))}
        </details>
      )}
      <Notes response={full ? detail.data : summary.data} />
    </div>
  );
}

function GroupWorkspace({ view }: { view: Group }) {
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
            <h2>选择左侧目录，展开每一次投入。</h2>
            <p>上方保留整体节奏，这里呈现所选{label}的任务与轮次。</p>
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

export function AtlasAnalysis() {
  const r = useRange();
  const patch = useUrlPatch();
  const candidate = r.search.get("view") || r.search.get("group") || "project";
  const view: View = dimensions.some(([id]) => id === candidate)
    ? (candidate as View)
    : "project";
  const session = r.search.get("session") || undefined;
  const [compare, setCompare] = useState(false);
  return (
    <div className="atlas-page">
      <div className="atlas-page-heading">
        <Header title="消耗分析" description="从时间，到任务，再到每一轮。" />
        <RangeControls />
      </div>
      <ActiveScope />
      <TrendWorkspace />
      <div className="atlas-tabs" role="group" aria-label="分析入口">
        {dimensions.map(([value, label]) => (
          <button
            key={value}
            className={view === value ? "selected" : ""}
            aria-pressed={view === value}
            onClick={() =>
              patch({
                view: value,
                group: undefined,
                groupKey: undefined,
                session: undefined,
                groupOffset: undefined,
                sessionOffset: undefined,
                turnOffset: undefined,
                globalTurnOffset: undefined,
                expandedTurn: undefined,
              })
            }
          >
            {label}
          </button>
        ))}
      </div>
      {view === "turn" ? (
        <div className="atlas-global-turns">
          <TurnTable filters={r.filters} global />
        </div>
      ) : view === "session" ? (
        <div
          className={"atlas-master-detail " + (session ? "has-selection" : "")}
        >
          <div className="atlas-directory">
            <SessionList
              filters={r.filters}
              selected={session}
              directory
              onSelect={(id) =>
                patch({
                  session: id,
                  turnOffset: undefined,
                  expandedTurn: undefined,
                })
              }
            />
          </div>
          <div className="atlas-detail">
            {session ? (
              <SessionPanel
                id={session}
                filters={r.filters}
                onBack={() =>
                  patch({ session: undefined, expandedTurn: undefined })
                }
              />
            ) : (
              <div className="atlas-empty">
                <span>Session / 任务</span>
                <h2>沿着任务，读懂每一轮消耗。</h2>
                <p>选择一个 Session，查看范围内的轮次与用量细分。</p>
              </div>
            )}
          </div>
        </div>
      ) : (
        <GroupWorkspace key={view} view={view} />
      )}
      <details
        className="atlas-comparison"
        onToggle={(e) => setCompare(e.currentTarget.open)}
      >
        <summary>
          与上一时段比较 <ChevronDown size={16} />
        </summary>
        {compare && <ComparisonSection />}
      </details>
    </div>
  );
}

export function AtlasThreads() {
  const r = useRange();
  const location = useLocation();
  const navigate = useNavigate();
  return (
    <div className="atlas-page">
      <div className="atlas-page-heading">
        <Header
          title="任务明细"
          description="找到一项任务，展开它的全部轮次。"
        />
        <RangeControls />
      </div>
      <ActiveScope />
      <SessionList
        filters={r.filters}
        onSelect={(id) =>
          navigate(
            `/threads/${encodeURIComponent(id)}?${new URLSearchParams({ ...Object.fromEntries(r.search), scope: "filtered", returnTo: location.pathname + location.search })}`,
            { state: { from: location.pathname + location.search } },
          )
        }
      />
    </div>
  );
}

export function AtlasDetail() {
  const { id } = useParams();
  const r = useRange();
  const location = useLocation();
  const filtered = r.search.get("scope") === "filtered";
  const stored =
    (location.state as { from?: string } | null)?.from ||
    r.search.get("returnTo");
  const back =
    stored && /^\/(analysis|threads)(\?|$)/.test(stored) ? stored : "/threads";
  return (
    <div className="atlas-page standalone-detail">
      <Link className="back-link" to={back}>
        <ArrowLeft size={15} />
        返回{back.startsWith("/analysis") ? "消耗分析" : "任务列表"}
      </Link>
      <SessionPanel
        id={id!}
        filters={filtered ? r.filters : {}}
        full={!filtered}
      />
    </div>
  );
}
