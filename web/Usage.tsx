import { useContext } from "react";
import type { EstimatedCost, Metrics, Settings, ThreadRow } from "../shared/contracts";
import { compact, exact, percent, projectName } from "./api";
import { Workspace } from "./workspace";

export const sessionTitle = (
  row: Pick<ThreadRow, "title" | "project" | "id">,
) => row.title || `${projectName(row.project)} · ${row.id.slice(0, 8)}`;

// Keep the integer portion exact even for amounts beyond Number.MAX_SAFE_INTEGER.
export function formatCostAmount(amount: string) {
  if (!/^\d+(\.\d+)?$/.test(amount)) return amount;
  const [whole, fraction = ""] = amount.split(".");
  const rounded = BigInt(whole) * 10_000n + BigInt(fraction.padEnd(4, "0").slice(0, 4)) +
    (fraction.length > 4 && fraction[4] >= "5" ? 1n : 0n);
  return `${(rounded / 10_000n).toLocaleString("en-US")}.${(rounded % 10_000n).toString().padStart(4, "0")}`;
}

export const costLabel = (settings: Pick<Settings, "officialApiPricing">, cost?: EstimatedCost | null) => {
  if (cost?.currency === "credits") return "参考消耗 · credits";
  const basis = cost ? cost.billingBasis : settings.officialApiPricing ? "api" : "subscription";
  return basis === "subscription" ? "订阅参考 · USD" : basis === "api" ? "API参考 · USD" : "参考成本 · USD";
};
const tierLabel = { standard: "Standard", fast: "Fast", unknown: "未知档位" } as const;
const costTitle = (cost: EstimatedCost) => [
  costLabel({}, cost),
  ...(cost.currency === "USD" && cost.billingBasis === "subscription" ? ["按 Token 美元单价及订阅 Fast 倍率计算参考消耗，不代表实际支出"] : []),
  ...(cost.amount == null ? [] : [`已计价小计：${cost.amount} ${cost.currency}`]),
  ...(cost.serviceTiers ?? []).map((row) => `${tierLabel[row.tier]}：${row.eventCount} 条记录 · ${row.totalTokens == null ? "Token 未提供" : `${exact(row.totalTokens)} Token`} · ${row.amount == null ? "未计价" : `${row.amount} ${cost.currency}`}`),
  ...cost.notes,
].join("\n");

export function CostValue({
  cost,
}: {
  cost: EstimatedCost | null | undefined;
}) {
  const amount = cost?.amount;
  const display = amount == null ? "未计价" : formatCostAmount(amount);
  return (
    <span
      className="cost-value"
      title={
        cost ? costTitle(cost) : "在设置中开启美元参考消耗并选择计价方式"
      }
    >
      {amount != null && cost?.currency === "USD" && <span className="currency">$</span>}
      {display}
      {amount != null && cost?.currency === "credits" && <span className="currency"> credits</span>}
      {cost && !cost.complete && <small>不完整估算</small>}
    </span>
  );
}

export function UsageBreakdown({
  data,
  counts = false,
}: {
  data?: Metrics;
  counts?: boolean;
}) {
  const { settings } = useContext(Workspace);
  const fields = [
    [
      "非缓存输入",
      data?.uncachedInputTokens,
      "输入减去缓存读取，包含已知或尚未识别的缓存写入",
    ],
    ["缓存读取", data?.cachedInputTokens, "命中缓存的输入 Token"],
    ["输出", data?.outputTokens, "包含推理输出，不再次相加"],
  ];
  if (settings.costEnabled)
    fields.push([
      data?.cacheWriteInputTokens != null && data.cacheWriteMissingEvents > 0
        ? "缓存写入（部分）"
        : "缓存写入",
      data?.cacheWriteInputTokens,
      "属于非缓存输入的细分；来源未提供时不视为零",
    ]);
  return (
    <div className="usage-breakdown">
      {fields.map(([label, value, hint]) => (
        <div
          key={label}
          title={hint || ""}
          data-kind={
            label === "缓存读取"
              ? "cache"
              : label === "输出"
                ? "output"
                : label === "非缓存输入"
                  ? "input"
                  : undefined
          }
        >
          <span>{label}</span>
          <strong title={exact(value)}>
            {!data ? "—" : value == null ? "未提供" : compact(value)}
          </strong>
        </div>
      ))}
      <div>
        <span>缓存读取占比</span>
        <strong>{percent(data?.cacheRatio)}</strong>
      </div>
      {counts && (
        <div>
          <span>Session / Turn</span>
          <strong>
            {data?.threadCount ?? "—"} / {data?.turnCount ?? "—"}
          </strong>
        </div>
      )}
      {settings.costEnabled && (
        <div>
          <span>{costLabel(settings, data?.cost)}</span>
          <strong>
            <CostValue cost={data?.cost} />
          </strong>
        </div>
      )}
      {settings.costEnabled && data?.cost?.serviceTiers?.filter((row) => row.tier !== "standard" && row.eventCount > 0).map((row) => (
        <div key={row.tier} title={`${row.eventCount} 条记录；${row.tier === "unknown" ? "档位来源不明，未按 Standard 或 Fast 计价" : "按每条记录的 Fast 标记计价"}`}>
          <span>{tierLabel[row.tier]} Token</span>
          <strong title={exact(row.totalTokens)}>{row.totalTokens == null ? "未提供" : compact(row.totalTokens)}</strong>
        </div>
      ))}
    </div>
  );
}

export function UsageHeadings({ cost }: { cost?: EstimatedCost | null } = {}) {
  const { settings } = useContext(Workspace);
  return (
    <>
      <th className="numeric usage-column">非缓存输入</th>
      <th className="numeric usage-column">缓存读取</th>
      <th className="numeric usage-column">输出</th>
      {settings.costEnabled && (
        <>
          <th className="numeric usage-column">缓存写入</th>
          <th className="numeric">
            {costLabel(settings, cost)}
          </th>
        </>
      )}
      <th className="numeric">总 Token</th>
    </>
  );
}

export function UsageCells({ data }: { data: Metrics }) {
  const { settings } = useContext(Workspace);
  return (
    <>
      <td
        className="numeric usage-column"
        title={exact(data.uncachedInputTokens)}
      >
        {compact(data.uncachedInputTokens)}
      </td>
      <td
        className="numeric usage-column"
        title={exact(data.cachedInputTokens)}
      >
        {compact(data.cachedInputTokens)}
      </td>
      <td className="numeric usage-column" title={exact(data.outputTokens)}>
        {compact(data.outputTokens)}
      </td>
      {settings.costEnabled && (
        <>
          <td
            className="numeric usage-column"
            title={
              data.cacheWriteMissingEvents
                ? `${data.cacheWriteMissingEvents} 条记录未提供写入量；已知小计不代表完整用量`
                : "来源提供的缓存写入量"
            }
          >
            {data.cacheWriteInputTokens == null
              ? "未提供"
              : compact(data.cacheWriteInputTokens) +
                (data.cacheWriteMissingEvents > 0 ? "*" : "")}
          </td>
          <td className="numeric">
            <CostValue cost={data.cost} />
          </td>
        </>
      )}
      <td className="numeric total-cell" title={exact(data.totalTokens)}>
        {compact(data.totalTokens)}
      </td>
    </>
  );
}
