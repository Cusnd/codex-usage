import { Component, lazy, Suspense, type ComponentType, type ReactNode } from 'react';
import { Loading } from '../widgets/ui.js';
import type { AppPages } from './App.js';

const loadAtlas = () => import('../features/analysis/Atlas.js');
const loadSettings = () => import('../features/settings/SettingsPage.js');

class PageBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    if (this.state.failed) return <div role="alert" className="notice error">
      <p>页面未能加载。请检查连接后重试。</p>
      <button onClick={() => window.location.reload()}>重新加载页面</button>
    </div>;
    return this.props.children;
  }
}

function deferred(load: () => Promise<{ default: ComponentType }>): ComponentType {
  const Page = lazy(load);
  return function DeferredPage() {
    return <PageBoundary><Suspense fallback={<Loading isLoading />}><Page /></Suspense></PageBoundary>;
  };
}

// Keep overview queries on the initial path; other pages load on navigation intent.
// The cloud entry injects eager pages separately to preserve offline first navigation.
export const deferredPages: AppPages = {
  Analysis: deferred(() => loadAtlas().then(module => ({ default: module.AtlasAnalysis }))),
  Threads: deferred(() => loadAtlas().then(module => ({ default: module.AtlasThreads }))),
  Detail: deferred(() => loadAtlas().then(module => ({ default: module.AtlasDetail }))),
  Settings: deferred(() => loadSettings().then(module => ({ default: module.SettingsPage }))),
  preload(path) {
    const load = path === '/settings' ? loadSettings : path === '/analysis' || path === '/threads' ? loadAtlas : undefined;
    // Speculative failures must not cause an unhandled rejection.
    void load?.().catch(() => {});
  },
};
