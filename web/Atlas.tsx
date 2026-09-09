import { ArrowLeft, ChevronDown } from "lucide-react";
import { useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import { GroupWorkspace, SessionList } from "./AtlasDirectory";
import { SessionPanel, TurnTable } from "./AtlasSession";
import {
  ActiveScope,
  RangeControls,
  View,
  dimensions,
  useUrlPatch,
} from "./AtlasShared";
import { TrendWorkspace } from "./AtlasTrend";
import { ComparisonSection } from "./Comparison";
import { useActiveRule } from "./motion";
import { Header } from "./ui";
import { useRange } from "./workspace";

export function AtlasAnalysis() {
  const r = useRange();
  const patch = useUrlPatch();
  const candidate = r.search.get("view") || r.search.get("group") || "project";
  const view: View = dimensions.some(([id]) => id === candidate)
    ? (candidate as View)
    : "project";
  const session = r.search.get("session") || undefined;
  const [compare, setCompare] = useState(false);
  const tabMotion = useActiveRule<HTMLDivElement>(view);
  return (
    <div className="atlas-page">
      <div className="atlas-page-heading">
        <Header title="消耗分析" description="从时间，到任务，再到每一轮。" />
        <RangeControls />
      </div>
      <ActiveScope />
      <TrendWorkspace />
      <div
        className="atlas-tabs motion-rule"
        ref={tabMotion}
        role="group"
        aria-label="分析入口"
      >
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
                <h2>选择任务查看轮次</h2>
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
