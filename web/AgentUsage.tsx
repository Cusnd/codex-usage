import { useContext } from "react";
import { Link, useLocation } from "react-router-dom";
import type { AgentUsage, Filter } from "../shared/contracts";
import { Workspace, useData } from "./workspace";
import { compact, exact } from "./api";
import { CostValue, sessionTitle } from "./Usage";
import { MotionDetails } from "./MotionPrimitives";
import { ErrorBox, Loading } from "./ui";

export function AgentUsagePanel({ id, filters }: { id: string; filters: Filter }) {
  const result = useData<AgentUsage>(`local/threads/${encodeURIComponent(id)}/agents`, filters);
  const { settings } = useContext(Workspace);
  const location = useLocation();
  const data = result.data?.data;
  return (
    <section className="agent-usage" aria-label="Agent 用量">
      <h3>Agent 用量</h3>
      <p className="agent-hint">团队合计包含嵌套 subagent；每行仅统计该 agent 自身。仅覆盖本机已保留、可识别的记录。</p>
      <ErrorBox error={result.error} />
      <Loading isLoading={result.isPending} />
      {data && <>
        <div className="agent-totals">
          {([
            ["当前 agent", data.self],
            ["Subagent 合计", data.subagents],
            ["团队合计", data.team],
          ] as const).map(([label, usage]) => (
            <div key={label}>
              <span>{label}</span>
              <strong title={exact(usage.totalTokens)}>{compact(usage.totalTokens)} <small>Token</small></strong>
              {settings.costEnabled && <CostValue cost={usage.cost} />}
              {usage.incompleteEvents > 0 && <small>含 {usage.incompleteEvents} 条不完整记录</small>}
            </div>
          ))}
        </div>
        {data.agents.length === 1 && <p className="agent-hint">未发现可识别的 subagent。</p>}
        <MotionDetails className="agent-details" defaultOpen duration={260} summary={<>Agent 明细 · {data.agents.length} 个（含当前 agent）</>}>
          <div className="agent-table-scroll" tabIndex={0} role="region" aria-label="Agent 用量明细表，可横向滚动">
            <table className="atlas-table agent-table">
              <thead><tr>
                <th scope="col">Agent / 层级</th><th scope="col">模型</th>
                <th scope="col" className="numeric">输入</th>
                <th scope="col" className="numeric">缓存命中</th>
                <th scope="col" className="numeric">输出</th>
                <th scope="col" className="numeric">总 Token</th>
                {settings.costEnabled && <th scope="col" className="numeric">参考成本 · USD</th>}
              </tr></thead>
              <tbody>{data.agents.map((agent) => <tr key={agent.id}>
                <td>
                  <div className="agent-name" style={{ paddingInlineStart: Math.min(agent.depth, 5) * 14 }}>
                    <small>{agent.depth ? `子 agent · 第 ${agent.depth} 层` : "当前 agent"}</small>
                    <Link to={`/threads/${encodeURIComponent(agent.id)}`} state={{ from: location.pathname + location.search }} title={agent.id}>
                      {sessionTitle(agent)}
                    </Link>
                    {agent.usage.eventCount === 0 && <small>暂无用量记录（当前范围）</small>}
                    {agent.usage.incompleteEvents > 0 && <small>含不完整记录</small>}
                  </div>
                </td>
                <td className="agent-models">{agent.models.map((model) => model || "未知模型").join(" / ") || "—"}</td>
                {[agent.usage.inputTokens, agent.usage.cachedInputTokens, agent.usage.outputTokens, agent.usage.totalTokens].map((value, index) => (
                  <td key={index} className="numeric" title={exact(value)}>{agent.usage.eventCount ? compact(value) : "—"}</td>
                ))}
                {settings.costEnabled && <td className="numeric"><CostValue cost={agent.usage.cost} /></td>}
              </tr>)}</tbody>
            </table>
          </div>
        </MotionDetails>
      </>}
    </section>
  );
}
