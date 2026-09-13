import { AtlasAnalysis, AtlasDetail, AtlasThreads } from '../features/analysis/Atlas.js';
import { SettingsPage } from '../features/settings/SettingsPage.js';
import type { AppPages } from './App.js';

// Cloud pages stay available when the user goes offline before visiting a route.
export const eagerPages: AppPages = {
  Analysis: AtlasAnalysis, Threads: AtlasThreads, Detail: AtlasDetail, Settings: SettingsPage,
};
