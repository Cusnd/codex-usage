import { navigationSearch } from '../../data/navigation.js';
import { ArrowLeft, ChevronDown } from "lucide-react";
import { useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import { GroupWorkspace, SessionList } from "./AtlasDirectory.js";
import { SessionPanel, TurnTable } from "./AtlasSession.js";
import {
  ActiveScope,
  RangeControls,
  View,
  dimensions,
  useUrlPatch,
} from "./AtlasShared.js";
import { TrendWorkspace } from "./AtlasTrend.js";
import { ComparisonSection } from "./Comparison.js";
import { useActiveRule } from "../../motion/motion.js";
import { Header } from "../../widgets/ui.js";
import { useRange } from "../../data/workspace.js";
import { MotionDetails, useHierarchyMotion } from "../../motion/MotionPrimitives.js";
import { useReveal } from "../../motion/motion.js";

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
  const detailMotion = useHierarchyMotion<HTMLDivElement>(session || "", session ? 1 : 0);
  const directoryMotion = useReveal<HTMLDivElement>(session || "", { direction: -1, ready: !session });
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
          <div className="atlas-directory" ref={directoryMotion}>
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
          <div className="atlas-detail" ref={detailMotion}>
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
      <MotionDetails
        className="atlas-comparison"
        open={compare} onOpenChange={setCompare} duration={260}
        summary={<>
          与上一时段比较 <ChevronDown size={16} />
        </>}
      >
        <ComparisonSection />
      </MotionDetails>
    </div>
  );
}

export function AtlasThreads() {
  const r = useRange();
  const location = useLocation();
  const navigate = useNavigate();
  const listMotion = useHierarchyMotion<HTMLDivElement>(location.pathname, 0);
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
      <div ref={listMotion}>
      <SessionList
        filters={r.filters}
        onSelect={(id) =>
          navigate(
            `/threads/${encodeURIComponent(id)}?${navigationSearch(r.search,{ scope: "filtered", returnTo: location.pathname + location.search })}`,
            { state: { from: location.pathname + location.search } },
          )
        }
      />
      </div>
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
    stored && /^\/(analysis|threads)(\?|$)/.test(stored) ? stored : '/threads?'+navigationSearch(r.search,{},true);
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
