import { useContext } from "react";
import type { EstimatedCost, Metrics, ThreadRow } from "../shared/contracts";
import { Workspace } from "./workspace";
import { compact, exact, percent, projectName } from "./api";

export const sessionTitle = (
  row: Pick<ThreadRow, "title" | "project" | "id">,
) => row.title || `${projectName(row.project)} · ${row.id.slice(0, 8)}`;

export function CostValue({
  cost,
}: {
  cost: EstimatedCost | null | undefined;
}) {
  const amount = cost?.amount;
  const display =
    amount == null
      ? "未配置"
      : Number(amount).toLocaleString("en-US", {
          minimumFractionDigits: 4,
          maximumFractionDigits: 4,
        });
  return (
    <span
      className="cost-value"
      title={
        cost
          ? ["USD · Standard API 参考估算，不代表订阅费用", ...cost.notes].join(
              "\n",
            )
          : "在设置中开启并配置模型单价"
      }
    >
      {amount != null && <span className="currency">$</span>}
      {display}
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
        <div key={label} title={hint || ""}>
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
          <span>参考成本 · USD</span>
          <strong>
            <CostValue cost={data?.cost} />
          </strong>
        </div>
      )}
    </div>
  );
}

export function UsageHeadings() {
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
            参考成本 <small>USD</small>
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
