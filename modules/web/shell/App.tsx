import { useApi, useWebRuntime, useCapabilities } from '../runtime/context.js';
import { CloudDeviceFilter } from '../features/devices/DeviceSettings.js';
import { CloudBind } from '../features/devices/CloudBind.js';
import { CloudSyncStatus } from '../features/devices/CloudSyncStatus.js';
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowUpRight,
  BookOpen,
  ChartNoAxesCombined,
  CodeXml,
  Globe2,
  LayoutDashboard,
  ListTree,
  RefreshCw,
  Settings2,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, NavLink, Route, Routes, useLocation } from "react-router-dom";
import type { Settings } from '../../contracts/settings.js';
import type { Status } from '../../contracts/status.js';

import { AtlasAnalysis, AtlasDetail, AtlasThreads } from "../features/analysis/Atlas.js";
import { Choice } from "../ui/Choice.js";
import { useActiveRule } from "../motion/motion.js";
import { Overview } from "../features/overview/Overview.js";
import { SettingsPage } from "../features/settings/SettingsPage.js";
import { ErrorBox, Header, time } from "../widgets/ui.js";
import { Workspace, defaultSettings } from "../data/workspace.js";

import { beginRefreshMotion, cancelRefreshMotion } from "../motion/motion-state.js";

export function App() {
  const { api, mutate } = useApi();
  const { clock: currentTime } = useWebRuntime();
  const { deviceScope, demoPreview } = useCapabilities();
  const location = useLocation();
  const navMotion = useActiveRule<HTMLElement>(location.pathname);
  const scopeSearch = useMemo(() => {
    const current = new URLSearchParams(
      location.search ||
        (location.state as { from?: string } | null)?.from?.split("?")[1] ||
        "",
    );
    const scope = new URLSearchParams();
    for (const key of [
      "range",
      "from",
      "to",
      "project",
      "model",
      "effort",
      "unknown",
      "group",
      "compareGroup",
    ])
      if (current.has(key)) scope.set(key, current.get(key)!);
    current.getAll('deviceIds').forEach(id => scope.append('deviceIds', id));
    return scope.size ? "?" + scope.toString() : "";
  }, [location]);
  const client = useQueryClient();
  const settingsQuery = useQuery({
    queryKey: ["settings"],
    queryFn: ({ signal }) => api<Settings>("settings", {}, signal),
    refetchInterval: 60_000,
    refetchOnWindowFocus: "always",
  });
  const settings = settingsQuery.data?.data || defaultSettings;
  const statusQuery = useQuery({
    queryKey: ["status"],
    queryFn: ({ signal }) => api<Status>("status", {}, signal),
    refetchInterval: (q) =>
      q.state.data?.data.local.running || q.state.data?.data.account.running
        ? 2000
        : 15000,
  });
  const status = statusQuery.data?.data;
  const [now, setNow] = useState(currentTime());
  const [refreshError, setRefreshError] = useState("");
  const [refreshMessage, setRefreshMessage] = useState('');
  const [refreshRequested, setRefreshRequested] = useState(false);
  const previous = useRef<Record<string, string>>({});
  useEffect(() => {
    if (!status) return;
    for (const key of ["local", "accountLimits", "accountHistory"] as const) {
      // Progress belongs in the status bar; refresh statistics after the scan settles.
      if (key === "local" && status.local.running) continue;
      const fingerprint = JSON.stringify(
        key === "local"
          ? [status.local.updatedAt, status.local.error, status.local.events]
          : status[key],
      );
      if (fingerprint !== previous.current[key]) {
        previous.current[key] = fingerprint;
        void client.invalidateQueries({
          queryKey: [key === "local" ? "local" : "account"],
        });
        if (key === "local") setNow(currentTime());
      }
    }
  }, [status, client]);
  const refresh = async (source: string) => {
    if (refreshRequested) return;
    setRefreshRequested(true);
    const ticket = beginRefreshMotion(source);
    setRefreshError("");
    setRefreshMessage('');
    try {
      await mutate("refresh", { source, force: true });
      if (deviceScope) await client.invalidateQueries();
      await client.invalidateQueries({ queryKey: ["status"] });
      if (demoPreview) setRefreshMessage('示例数据已刷新。');
    } catch (e) {
      cancelRefreshMotion(ticket);
      setRefreshError((e as Error).message);
    } finally {
      setRefreshRequested(false);
    }
  };
  return (
    <Workspace.Provider value={{ settings, now, status }}>
      <div className="app-shell">
        <aside className="sidebar">
          <Link to={"/" + scopeSearch} className="brand">
            <span className="brand-icon">
              <CodeXml size={26} strokeWidth={1.8} />
            </span>
            <div>
              Codex<small>用量图录</small>
            </div>
          </Link>
          <nav className="motion-rule" ref={navMotion}>
            {[
              { to: "/", icon: LayoutDashboard, text: "总览" },
              { to: "/analysis", icon: ChartNoAxesCombined, text: "消耗分析" },
              { to: "/threads", icon: ListTree, text: "任务明细" },
              { to: "/settings", icon: Settings2, text: "设置" },
            ].map(({ to, icon: Icon, text }) => (
              <NavLink end={to === "/"} key={to} to={to + scopeSearch}>
                <Icon size={20} strokeWidth={1.7} aria-hidden="true" />
                <span>{text}</span>
              </NavLink>
            ))}
          </nav>
          <div className="sidebar-footer">
            <span className="live-dot" />
            {demoPreview ? '合成示例' : deviceScope ? '云端查看' : '本机运行'}<small>{demoPreview ? '查询在浏览器内运行' : deviceScope ? '所有已同步设备的历史' : '用量历史保存在本机'}</small>
            <a href={demoPreview || deviceScope ? 'https://github.com/Cusnd/codex-usage/blob/main/docs/TECHNICAL_REFERENCE.md' : '/docs'} target="_blank" rel="noreferrer">
              <BookOpen size={16} /> API 文档 <ArrowUpRight size={14} />
            </a>
          </div>
        </aside>
        <div className="main-shell">
          <div className="topbar">
            <span className="breadcrumb">
              个人空间 <span>/</span> Codex 用量
            </span>
            <div className="actions">
              <Link
                to={"/settings" + scopeSearch}
                className="timezone-link"
                title="调整时区"
              >
                <Globe2 size={15} aria-hidden="true" />
                {settings.timezone}
                {settings.timezoneMode === "system" ? " · 系统" : ""}
              </Link>
              <span className="sync-status">
                {status?.local.running
                  ? `导入中 · ${status.local.filesScanned} 个文件`
                  : status?.account.running
                    ? "账户更新中"
                    : status?.local.updatedAt
                      ? (deviceScope ? "云端接收 " : "本地更新 ") +
                        time(status.local.updatedAt, settings.timezone)
                      : "等待首次导入"}
              </span>
              <button
                onClick={() => refresh("all")}
                className={
                  refreshRequested || status?.local.running || status?.account.running
                    ? "refresh-running"
                    : undefined
                }
                aria-busy={!!(refreshRequested || status?.local.running || status?.account.running)}
                disabled={refreshRequested || (status?.local.running && status?.account.running)}
              >
                <RefreshCw size={15} aria-hidden="true" /> 刷新全部
              </button>
              {!deviceScope && <Choice
                label="单独刷新来源"
                disabled={refreshRequested}
                value=""
                placeholder="单独刷新"
                options={[
                  { value: "local", label: "刷新本地记录" },
                  { value: "account", label: "刷新全部账户数据" },
                  { value: "accountLimits", label: "仅刷新额度" },
                  { value: "accountHistory", label: "仅刷新每日历史" },
                ]}
                onChange={(value) => void refresh(value)}
              />}
            </div>
          </div>
          <main>
            {demoPreview && refreshMessage && <div className="notice example-refresh" role="status">{refreshMessage}</div>}
            {demoPreview && <div className="notice example-banner" role="note">
              <span><strong>示例模式</strong> · 合成数据 · 参考日期 2026-09-08 · 设置仅影响当前浏览器</span>
              <a href="https://github.com/Cusnd/codex-usage#get-started" target="_blank" rel="noreferrer">安装本地应用 ↗</a>
            </div>}
            {refreshError && (
              <div role="alert" className="notice error">
                {refreshError}
              </div>
            )}
            <ErrorBox error={settingsQuery.error || statusQuery.error} />
            {deviceScope && <CloudDeviceFilter />}
            {deviceScope && <CloudSyncStatus />}
            <Routes>
              {deviceScope && <Route path="/bind" element={<CloudBind />} />}
              <Route path="/" element={<Overview />} />
              <Route path="/analysis" element={<AtlasAnalysis />} />
              <Route path="/threads" element={<AtlasThreads />} />
              <Route path="/threads/:id" element={<AtlasDetail />} />
              <Route path="/settings" element={<SettingsPage />} />
              <Route
                path="*"
                element={
                  <Header
                    title="页面不存在"
                    description="从顶部导航返回用量图录。"
                  />
                }
              />
            </Routes>
          </main>
          <footer>
            Codex 用量图录 <span>{deviceScope ? "账户与设备记录分别统计 · 私有云端空间" : "账户与本机数据分别统计 · 仅个人使用"}</span>
          </footer>
        </div>
      </div>
    </Workspace.Provider>
  );
}
