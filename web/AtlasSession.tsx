import { ArrowLeft, ArrowUpRight, Check, ChevronRight, Copy } from "lucide-react";
import { Fragment, useContext } from "react";
import { Link, useLocation, useSearchParams } from "react-router-dom";
import type {
  Filter,
  Metrics,
  Page,
  ThreadDetail,
  TurnRow,
} from "../shared/contracts";
import { AgentUsagePanel } from "./AgentUsage";
import { compact, exact, projectName } from "./api";
import {
  offsetOf,
  ScopeLabel,
  SearchField,
  shortId,
  SortChoice,
  turnKey,
  useUrlPatch,
} from "./AtlasShared";
import { ErrorBox, Loading, Notes, Pagination, time } from "./ui";
import {
  sessionTitle,
  UsageBreakdown,
  UsageCells,
  UsageHeadings,
} from "./Usage";
import { useData, Workspace } from "./workspace";
import { ExpandingRow, MotionDetails, ResultRegion, useHierarchyMotion } from "./MotionPrimitives";
import { useCopyFeedback, useReveal } from "./motion";

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
  const rowsMotion = useReveal<HTMLTableSectionElement>(q.motion.revision, { ready: q.motion.animate, initial: true });
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
        emptyMessage={
          global && search.get("turnQ")
            ? "没有匹配的轮次。请修改或清除搜索内容。"
            : undefined
        }
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
      <ResultRegion change={q.motion} pending={q.motion.pending} animate={false}>
      <div
        className="table-scroll"
        tabIndex={0}
        role="region"
        aria-label="轮次用量明细表，可横向滚动"
      >
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
          <tbody ref={rowsMotion}>
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
                      aria-expanded={expanded === turnKey(row)}
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
                        aria-expanded={expanded === turnKey(row)}
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
                      <ChevronRight size={16} />
                    </button>
                  </td>
                </tr>
                <ExpandingRow open={expanded === turnKey(row)} colSpan={colspan}>
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
                </ExpandingRow>
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
      </ResultRegion>
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

export function SessionPanel({
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
  const { copied, error: copyError, copy } = useCopyFeedback(id);
  const panelMotion = useHierarchyMotion<HTMLDivElement>(id, 1, !detail.isPending && !summary.isPlaceholderData);
  const data = full ? detail.data?.data.thread : summary.data?.data;
  const title = detail.data?.data.thread
    ? sessionTitle(detail.data.data.thread)
    : shortId(id);
  return (
    <div className="session-panel" ref={panelMotion}>
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
              aria-label={copied ? "Session ID 已复制" : "复制 Session ID"}
              onClick={() => copy(id)}
            >
              <span className="feedback-icon" key={String(copied)}>{copied ? <Check size={14} /> : <Copy size={14} />}</span>
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
        <MotionDetails className="related-tasks" summary={<>关联任务 · {detail.data.data.related.length}</>}>
          {detail.data.data.related.map((row) => (
            <Link
              key={`${row.id}:${row.relation}`}
              to={`/threads/${encodeURIComponent(row.id)}`}
              state={{ from: location.pathname + location.search }}
            >
              {
                {
                  subagent: "子 agent",
                  subagent_parent: "父 agent",
                  fork: "Fork 任务",
                  fork_parent: "Fork 来源",
                  unknown: "关系待识别",
                }[row.relation]
              }{" "}
              · {projectName(row.project)} · {shortId(row.id)}
            </Link>
          ))}
        </MotionDetails>
      )}
      <Notes response={full ? detail.data : summary.data} />
    </div>
  );
}
