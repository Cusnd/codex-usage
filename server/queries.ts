import type { SQLInputValue } from "node:sqlite";
import type {
  Filter,
  Metrics,
  GroupRow,
  ThreadRow,
  Comparison,
  Page,
  TurnRow,
  TrendRow,
  Filters,
  ThreadDetail,
  AgentUsage,
} from "../shared/contracts.js";
import type { Store } from "./db.js";
import { label, ratio, tokenFields } from "../shared/query-values.js";
import { estimateCost } from "./pricing.js";

const camel = [
  "inputTokens",
  "cachedInputTokens",
  "cacheWriteInputTokens",
  "outputTokens",
  "reasoningOutputTokens",
  "totalTokens",
] as const;
const metricsSql = `${tokenFields.map((k) => `SUM(${k}) AS ${k}`).join(",")},COUNT(*) AS event_count,
  CASE WHEN COUNT(*)=COUNT(CASE WHEN input_tokens>=cached_input_tokens AND cached_input_tokens>=0 THEN 1 END) THEN SUM(input_tokens-cached_input_tokens) END uncached_input,
  CASE WHEN COUNT(*)=COUNT(CASE WHEN input_tokens>=cached_input_tokens+cache_write_input_tokens AND cached_input_tokens>=0 AND cache_write_input_tokens>=0 THEN 1 END) THEN SUM(input_tokens-cached_input_tokens-cache_write_input_tokens) END ordinary_input,
  SUM(CASE WHEN cache_write_input_tokens IS NULL THEN 1 ELSE 0 END) write_missing,
  COUNT(DISTINCT thread_id) AS thread_count,COUNT(DISTINCT CASE WHEN turn_id IS NOT NULL THEN thread_id||':'||turn_id END) AS turn_count,
  COALESCE(SUM(incomplete),0) AS incomplete_events,
  SUM(CASE WHEN cached_input_tokens IS NOT NULL AND input_tokens IS NOT NULL AND cached_input_tokens<=input_tokens THEN cached_input_tokens END) AS paired_cached,
  SUM(CASE WHEN cached_input_tokens IS NOT NULL AND input_tokens IS NOT NULL AND cached_input_tokens<=input_tokens THEN input_tokens END) AS paired_input`;
const fieldMap = {
  project: "project",
  model: "model",
  effort: "effort",
  thread: "thread_id",
} as const;
type QueryFilter = Filter & {
  threadIds?: string[];
  q?: string;
  turnId?: string | null;
  searchTurns?: boolean;
};
export function where(f: QueryFilter) {
  const conditions: string[] = [];
  const params: SQLInputValue[] = [];
  if (f.threadIds !== undefined) {
    conditions.push("thread_id IN (SELECT value FROM json_each(?))");
    params.push(JSON.stringify(f.threadIds));
  }
  for (const [field, value] of [
    ["at >=", f.from],
    ["at <", f.to],
    ["project =", f.project],
    ["model =", f.model],
    ["effort =", f.effort],
    ["thread_id =", f.threadId],
  ] as const) {
    if (value !== undefined) {
      conditions.push(`${field} ?`);
      params.push(
        field.startsWith("at") ? new Date(value).toISOString() : value,
      );
    }
  }
  for (const field of new Set([
    ...(f.unknown ? [f.unknown] : []),
    ...(f.unknowns || []),
  ]))
    conditions.push(`${fieldMap[field]} IS NULL`);
  if (f.turnId !== undefined) {
    conditions.push("turn_id IS ?");
    params.push(f.turnId);
  }
  if (f.q?.trim()) {
    const needle = f.q.trim();
    conditions.push(
      `(instr(lower(thread_id),lower(?))>0 OR instr(lower(COALESCE(project,'')),lower(?))>0 OR thread_id IN (SELECT id FROM threads WHERE instr(lower(COALESCE(title,'')),lower(?))>0)${f.searchTurns ? " OR instr(lower(COALESCE(turn_id,'')),lower(?))>0" : ""})`,
    );
    params.push(needle, needle, needle);
    if (f.searchTurns) params.push(needle);
  }
  return {
    sql: conditions.length ? "WHERE " + conditions.join(" AND ") : "",
    params,
  };
}
function metrics(r: Record<string, any>): Metrics {
  const n = Number(r.event_count || 0n);
  const result: any = {
    eventCount: n,
    threadCount: Number(r.thread_count || 0n),
    turnCount: Number(r.turn_count || 0n),
    cacheRatio: ratio(r.paired_cached ?? null, r.paired_input ?? null),
    uncachedInputTokens: r.uncached_input?.toString() ?? (n === 0 ? "0" : null),
    ordinaryInputTokens: r.ordinary_input?.toString() ?? (n === 0 ? "0" : null),
    cacheWriteMissingEvents: Number(r.write_missing || 0n),
    cost: null,
    incompleteEvents: Number(r.incomplete_events || 0n),
  };
  tokenFields.forEach(
    (k, i) =>
      (result[camel[i]] =
        r[k] === null || r[k] === undefined
          ? n === 0
            ? "0"
            : null
          : r[k].toString()),
  );
  return result;
}
export class Queries {
  constructor(private store: Pick<Store, "all" | "one" | "settings">) {}
  private costs(
    f: QueryFilter,
    expressions: string[] = [],
    extraParams: SQLInputValue[] = [],
  ) {
    const settings = this.store.settings();
    const result = new Map<string, ReturnType<typeof estimateCost>>();
    if (!settings.costEnabled) return result;
    const w = where(f);
    const thresholds = (settings.modelPrices || []).filter(
      (p) => p.longContextThreshold !== null,
    );
    const longExpr = thresholds.length
      ? `CASE ${thresholds.map(() => "WHEN model=? AND input_tokens>? THEN 1").join(" ")} ELSE 0 END`
      : "0";
    const keys = expressions.map((expr, i) => `${expr} k${i}`);
    const rows = this.store.all(
      `SELECT ${keys.length ? keys.join(",") + "," : ""} model,${longExpr} long_context,${metricsSql},
      SUM(CASE WHEN cache_write_input_tokens IS NULL THEN 1 ELSE 0 END) missing_write,
      SUM(CASE WHEN input_tokens IS NULL OR cached_input_tokens IS NULL OR output_tokens IS NULL THEN 1 ELSE 0 END) missing_usage,
      SUM(CASE WHEN input_tokens<cached_input_tokens+COALESCE(cache_write_input_tokens,0) THEN 1 ELSE 0 END) invalid_usage,
      SUM(CASE WHEN kind<>'record' THEN 1 ELSE 0 END) compat_events
      FROM effective_events ${w.sql} GROUP BY ${keys.length ? keys.map((_, i) => `k${i}`).join(",") + "," : ""}model,long_context`,
      [
        ...extraParams,
        ...thresholds.flatMap((p) => [p.model, p.longContextThreshold!]),
        ...w.params,
      ],
    );
    const groups = new Map<string, Record<string, any>[]>();
    for (const row of rows) {
      const key = JSON.stringify(expressions.map((_, i) => row[`k${i}`]));
      groups.set(key, [...(groups.get(key) || []), row]);
    }
    if (!expressions.length && !groups.size) groups.set("[]", []);
    for (const [key, group] of groups)
      result.set(key, estimateCost(group, settings));
    return result;
  }
  summary(f: QueryFilter = {}): Metrics {
    const w = where(f);
    const value = metrics(
      this.store.one(
        `SELECT ${metricsSql} FROM effective_events ${w.sql}`,
        w.params,
      )!,
    );
    value.cost = this.costs(f).get("[]") ?? null;
    return value;
  }
  trend(f: Filter, bucket: "hour" | "day"): TrendRow[] {
    const w = where(f);
    const costs = this.costs(
      f,
      ["local_bucket(at,?,?)"],
      [this.store.settings().timezone, bucket],
    );
    return this.store
      .all(
        `SELECT local_bucket(at,?,?) time,${metricsSql} FROM effective_events ${w.sql} GROUP BY time ORDER BY time`,
        [this.store.settings().timezone, bucket, ...w.params],
      )
      .map((r) => ({
        time: r.time,
        ...metrics(r),
        cost: costs.get(JSON.stringify([r.time])) ?? null,
      }));
  }
  groups(f: QueryFilter, by: keyof typeof fieldMap): GroupRow[] {
    const w = where(f);
    const rows = this.store.all(
      `SELECT ${fieldMap[by]} AS key,${metricsSql} FROM effective_events ${w.sql} GROUP BY ${fieldMap[by]} ORDER BY total_tokens DESC,key`,
      w.params,
    );
    const sum = rows.reduce((a, r) => a + (r.total_tokens || 0n), 0n);
    const costs = this.costs(f, [fieldMap[by]]);
    return rows.map((r) => ({
      key: r.key,
      label: by === "project" ? label(r.key) : r.key || "未知",
      share: ratio(r.total_tokens, sum),
      ...metrics(r),
      cost: costs.get(JSON.stringify([r.key])) ?? null,
    }));
  }
  breakdown(
    f: Filter,
    by: "project" | "model" | "effort",
    limit: number,
    offset: number,
  ): Page<GroupRow> {
    const rows = this.groups(f, by);
    return {
      items: rows.slice(offset, offset + limit),
      total: rows.length,
      limit,
      offset,
    };
  }
  threads(
    f: QueryFilter,
    limit: number,
    offset: number,
    sort = "tokens",
    cacheBelow?: number,
    q?: string,
  ): Page<ThreadRow> {
    const w = where({ ...f, q });
    const having =
      cacheBelow === undefined
        ? ""
        : `HAVING paired_input > 0 AND CAST(paired_cached AS REAL)/paired_input < ?`;
    const params = [
      ...w.params,
      ...(cacheBelow === undefined ? [] : [cacheBelow]),
    ];
    const base = `SELECT thread_id id,(SELECT title FROM threads WHERE id=thread_id) title,MIN(project) project,MIN(at) first_at,MAX(at) last_at,${metricsSql} FROM effective_events ${w.sql} GROUP BY thread_id ${having}`;
    const total = Number(
      this.store.one(`SELECT COUNT(*) n FROM (${base})`, params)!.n,
    );
    const rows = this.store.all(
      `${base} ORDER BY ${sort === "recent" ? "last_at" : "total_tokens"} DESC,id ASC LIMIT ? OFFSET ?`,
      [...params, limit, offset],
    );
    const costs = this.costs({ ...f, q }, ["thread_id"]);
    return {
      items: rows.map((r) => ({
        id: r.id,
        title: r.title ?? null,
        project: r.project,
        firstAt: r.first_at,
        lastAt: r.last_at,
        ...metrics(r),
        cost: costs.get(JSON.stringify([r.id])) ?? null,
      })),
      total,
      limit,
      offset,
    };
  }
  detail(id: string): ThreadDetail | null {
    const info = this.store.one("SELECT * FROM threads WHERE id=?", [id]);
    let row = this.threads({ threadId: id }, 1, 0).items[0];
    if (!row && !info) return null;
    row ??= {
      id, title: info!.title ?? null, project: info!.project ?? null,
      firstAt: null, lastAt: null, ...this.summary({ threadId: id }),
    };
    const related = this.store.all(
      `SELECT id,project,subagent_parent_id,forked_from_id FROM threads
       WHERE id<>? AND (parent_id=? OR subagent_parent_id=? OR forked_from_id=? OR id IN (?,?,?)) ORDER BY id`,
      [id, id, id, id, info?.parent_id || "", info?.subagent_parent_id || "", info?.forked_from_id || ""],
    );
    return {
      thread: row,
      source: info?.source || null,
      parentId: info?.parent_id || null,
      related: related.flatMap((r) => {
        const relations: ThreadDetail["related"][number]["relation"][] = [];
        if (r.subagent_parent_id === id) relations.push("subagent");
        if (r.forked_from_id === id) relations.push("fork");
        if (info?.subagent_parent_id === r.id) relations.push("subagent_parent");
        if (info?.forked_from_id === r.id) relations.push("fork_parent");
        if (!relations.length) relations.push("unknown");
        return relations.map((relation) => ({ id: r.id, project: r.project, relation }));
      }),
      models: this.groups({ threadId: id }, "model"),
    };
  }
  agents(id: string, f: Filter = {}): AgentUsage | null {
    const root = this.store.one("SELECT * FROM threads WHERE id=?", [id]);
    if (!root) return null;
    // UNION deduplicates IDs before traversal, including malformed cycles.
    const nodes = this.store.all(`WITH RECURSIVE family(id) AS (
      SELECT id FROM threads WHERE id=? UNION
      SELECT t.id FROM threads t JOIN family f ON t.subagent_parent_id=f.id
    ) SELECT t.* FROM threads t JOIN family f ON t.id=f.id ORDER BY t.id`, [id]);
    const children = new Map<string, typeof nodes>();
    for (const node of nodes) {
      const siblings = children.get(node.subagent_parent_id) || [];
      siblings.push(node);
      children.set(node.subagent_parent_id, siblings);
    }
    const ids = nodes.map((n) => n.id as string);
    // The route identifies the root. A caller's threadId must not hide descendants.
    const filter: QueryFilter = { ...f, threadId: undefined, threadIds: ids };
    const values = new Map(this.groups(filter, "thread").map(({ key, label: _label, share: _share, ...usage }) => [key, usage]));
    const w = where(filter);
    const modelRows = this.store.all(`SELECT DISTINCT thread_id,model FROM effective_events ${w.sql} ORDER BY thread_id,model`, w.params);
    const models = new Map<string, (string | null)[]>();
    for (const row of modelRows) {
      const list = models.get(row.thread_id) || [];
      list.push(row.model);
      models.set(row.thread_id, list);
    }
    const empty = this.summary({ threadIds: [] });
    const agents: AgentUsage["agents"] = [];
    const seen = new Set<string>();
    const pending = [{ node: root, depth: 0 }];
    while (pending.length) {
      const { node, depth } = pending.pop()!;
      if (seen.has(node.id)) continue;
      seen.add(node.id);
      agents.push({
        id: node.id, parentId: node.subagent_parent_id ?? null, depth,
        title: node.title ?? null, project: node.project ?? null,
        models: models.get(node.id) || [], usage: values.get(node.id) || empty,
      });
      for (const child of [...(children.get(node.id) || [])].reverse())
        pending.push({ node: child, depth: depth + 1 });
    }
    return {
      self: agents[0].usage,
      subagents: this.summary({ ...filter, threadIds: ids.filter((key) => key !== id) }),
      team: this.summary(filter),
      agents,
    };
  }
  turns(
    id: string,
    f: Filter,
    limit: number,
    offset: number,
    sort = "oldest",
  ): Page<TurnRow> {
    return this.allTurns({ ...f, threadId: id }, limit, offset, sort);
  }
  allTurns(
    f: QueryFilter,
    limit: number,
    offset: number,
    sort = "tokens",
    q?: string,
  ): Page<TurnRow> {
    const w = where({ ...f, q, searchTurns: true });
    const total = Number(
      this.store.one(
        `SELECT COUNT(*) n FROM (SELECT thread_id,turn_id FROM effective_events ${w.sql} GROUP BY thread_id,turn_id)`,
        w.params,
      )!.n,
    );
    const rows = this.store.all(
      `SELECT turn_id id,thread_id,(SELECT title FROM threads WHERE id=thread_id) title,MIN(project) project,MIN(at) first_at,MAX(at) last_at,${metricsSql} FROM effective_events ${w.sql} GROUP BY thread_id,turn_id ORDER BY ${sort === "recent" ? "last_at DESC" : sort === "oldest" ? "first_at ASC" : "total_tokens DESC"},thread_id,id LIMIT ? OFFSET ?`,
      [...w.params, limit, offset],
    );
    // One batched composition query for the current page, not one query per turn.
    const parts = rows.length
      ? this.store.all(
          `SELECT thread_id,turn_id,model,effort,${metricsSql} FROM effective_events ${w.sql || "WHERE 1=1"} AND (${rows.map(() => "(thread_id=? AND turn_id IS ?)").join(" OR ")}) GROUP BY thread_id,turn_id,model,effort ORDER BY total_tokens DESC,model,effort`,
          [...w.params, ...rows.flatMap((r) => [r.thread_id, r.id])],
        )
      : [];
    const costs = this.costs({ ...f, q, searchTurns: true }, [
      "thread_id",
      "turn_id",
    ]);
    return {
      items: rows.map((r) => ({
        id: r.id,
        threadId: r.thread_id,
        title: r.title ?? null,
        project: r.project ?? null,
        firstAt: r.first_at,
        lastAt: r.last_at,
        ...metrics(r),
        cost: costs.get(JSON.stringify([r.thread_id, r.id])) ?? null,
        composition: parts
          .filter((p) => p.thread_id === r.thread_id && p.turn_id === r.id)
          .map((p) => ({ model: p.model, effort: p.effort, ...metrics(p) })),
      })),
      total,
      limit,
      offset,
    };
  }
  filters(f: Filter): Filters {
    const w = where(f);
    const get = (column: string) =>
      this.store
        .all(
          `SELECT DISTINCT ${column} value FROM effective_events ${w.sql} ORDER BY value`,
          w.params,
        )
        .map((r) => r.value as string | null);
    return {
      projects: get("project"),
      models: get("model"),
      efforts: get("effort"),
    };
  }
  compare(
    f: Filter,
    by: keyof typeof fieldMap,
    baselineFrom?: string,
    baselineTo?: string,
  ): Comparison {
    const to = f.to || new Date().toISOString(),
      from = f.from || new Date(Date.parse(to) - 7 * 86400000).toISOString();
    const bf =
      baselineFrom ||
      new Date(
        Date.parse(from) - (Date.parse(to) - Date.parse(from)),
      ).toISOString();
    const bt = baselineTo || from;
    const current = this.summary({ ...f, from, to }),
      previous = this.summary({ ...f, from: bf, to: bt });
    const a = this.groups({ ...f, from, to }, by),
      b = this.groups({ ...f, from: bf, to: bt }, by);
    const am = new Map(a.map((x) => [x.key, x])),
      bm = new Map(b.map((x) => [x.key, x]));
    const items = [...new Set([...am.keys(), ...bm.keys()])]
      .map((key) => {
        const av = am.get(key)?.totalTokens ?? "0",
          bv = bm.get(key)?.totalTokens ?? "0";
        const delta = BigInt(av) - BigInt(bv);
        return {
          key,
          label: am.get(key)?.label || bm.get(key)!.label,
          current: av,
          previous: bv,
          delta: delta.toString(),
          changeRatio: ratio(delta, BigInt(bv)),
        };
      })
      .sort((a, b) =>
        BigInt(a.delta) > BigInt(b.delta)
          ? -1
          : BigInt(a.delta) < BigInt(b.delta)
            ? 1
            : (a.key || "").localeCompare(b.key || ""),
      );
    return {
      current,
      previous,
      from,
      to,
      baselineFrom: bf,
      baselineTo: bt,
      items,
    };
  }
}
