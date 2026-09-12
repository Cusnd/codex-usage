import { navigationSearch } from './navigation';
import { Link, useLocation } from "react-router-dom";
import type { Comparison, Metrics } from "../shared/contracts";
import { useRange, useData } from "./workspace";
import { Choice } from "./Choice";
import { time, ErrorBox, Pagination, Notes } from "./ui";
import { compact, exact, percent } from "./api";
import { Updating } from "./MotionPrimitives";
import { useReveal } from "./motion";
export function ComparisonSection() {
  const location = useLocation();
  const r = useRange();
  const comparisonGroup = r.search.get("compareGroup") || "project";
  const comparison = useData<Comparison>("local/compare", {
    ...r.filters,
    groupBy: comparisonGroup,
  });
  const summary = useData<Metrics>("local/summary", r.filters);
  const rows = useReveal<HTMLTableSectionElement>(`${comparison.motion.revision}:${r.search.get("compareOffset") || 0}`, { ready: !!comparison.data && !comparison.motion.pending, initial: true });
  return (
    <section className="comparison-body">
      <div className="panel-heading">
        <div>
          <h2>与上一时段比较</h2>
          <p>前一个等长时段 · 按绝对增量排序</p>
        </div>
        <Choice
          label="对比维度"
          value={comparisonGroup}
          options={[
            { value: "project", label: "按项目" },
            { value: "model", label: "按模型" },
            { value: "effort", label: "按推理强度" },
            { value: "thread", label: "按任务" },
          ]}
          onChange={(value) =>
            r.update({ compareGroup: value, compareOffset: undefined })
          }
        />
      </div>
      <ErrorBox error={comparison.error} />
      <Updating pending={comparison.motion.pending} />
      {comparison.data && (
        <>
          <div className="comparison-head">
            <span>
              本期 <b>{compact(comparison.data.data.current.totalTokens)}</b>
            </span>
            <span>
              上期 <b>{compact(comparison.data.data.previous.totalTokens)}</b>
            </span>
            <small>
              {time(comparison.data.data.baselineFrom, r.timezone)} —{" "}
              {time(comparison.data.data.baselineTo, r.timezone)}
            </small>
          </div>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>分组</th>
                  <th className="numeric">本期</th>
                  <th className="numeric">上期</th>
                  <th className="numeric">增减 Token</th>
                  <th className="numeric">变化率</th>
                </tr>
              </thead>
              <tbody ref={rows}>
                {comparison.data.data.items
                  .slice(
                    Number(r.search.get("compareOffset") || 0),
                    Number(r.search.get("compareOffset") || 0) + 20,
                  )
                  .map((row) => (
                    <tr key={row.key ?? "unknown"}>
                      <td title={row.key || "未知"}>
                        {comparisonGroup === "thread" && row.key ? (
                          <Link
                            to={"/threads/" + encodeURIComponent(row.key)+'?'+navigationSearch(r.search,{},true)}
                            state={{
                              from: location.pathname + location.search,
                            }}
                          >
                            {row.label.slice(0, 16)}…
                          </Link>
                        ) : (
                          row.label
                        )}
                      </td>
                      <td className="numeric">{compact(row.current)}</td>
                      <td className="numeric">{compact(row.previous)}</td>
                      <td
                        className={
                          "numeric " +
                          (BigInt(row.delta || 0) > 0 ? "increase" : "decrease")
                        }
                        title={exact(row.delta)}
                      >
                        {BigInt(row.delta || 0) > 0 ? "+" : ""}
                        {compact(row.delta)}
                      </td>
                      <td className="numeric">{percent(row.changeRatio)}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
          <Pagination
            total={comparison.data.data.items.length}
            limit={20}
            param="compareOffset"
          />
        </>
      )}
      <Notes response={summary.data} />
    </section>
  );
}
