import { DateTime } from 'luxon';
import { Value } from '@sinclair/typebox/value';
import { SettingsSchema, type Settings, type Filter, type ApiResponse, type Status } from '../shared/contracts.js';
import { Queries } from '../server/queries.js';
import { officialPrices, pricingSource, pricingCheckedAt } from '../server/pricing.js';
import { ExampleStore } from './store.js';
import { ExampleAccount } from './account.js';
import { EXAMPLE_NOW } from './fixture.js';

export interface SettingsStorage { getItem(key: string): string | null; setItem(key: string, value: string): void; }
const KEY = 'codex-usage-example-settings-v1';
function validateSettings(value: unknown): asserts value is Settings {
  if (!Value.Check(SettingsSchema, value)) throw new Error('设置格式无效。');
  if ((value.localInterval !== 0 && value.localInterval < 10) ||
    (value.accountInterval !== 0 && value.accountInterval < 60) || !DateTime.fromISO(EXAMPLE_NOW).setZone(value.timezone).isValid)
    throw new Error('本地刷新至少 10 秒，账户至少 60 秒；0 关闭自动刷新。请使用有效的 IANA 时区。');
  if (value.modelPrices && new Set(value.modelPrices.map(p => p.model)).size !== value.modelPrices.length)
    throw new Error('同一模型只能配置一组价格。');
}
export function createExampleAdapter(store: ExampleStore, storage?: SettingsStorage) {
  try { const saved = storage?.getItem(KEY); if (saved) { const value: unknown = JSON.parse(saved); validateSettings(value); store.saveSettings(value); } } catch { /* Invalid/blocked browser storage falls back to defaults. */ }
  const queries = new Queries(store);
  const account = new ExampleAccount();
  let revision = 0;
  const status = (): Status => {
    const base = { running: false, startedAt: EXAMPLE_NOW, updatedAt: new Date(Date.parse(EXAMPLE_NOW) + revision).toISOString(),
      error: null, filesScanned: 0, filesChanged: 0, events: 0, issues: 0 };
    const source = { ...base, provider: 'app-server' as const, fallbackReason: null, errorCode: null,
      accountId: 'example', identityKey: 'example', identityConfirmed: true, available: true, stale: false };
    return { local: { ...base, events: queries.summary().eventCount }, account: base, accountLimits: source, accountHistory: source };
  };
  const wrap = <T>(data: T, source: 'local' | 'account' | 'settings' = 'local'): ApiResponse<T> => ({data,
    meta: {exampleData: true, source, updatedAt: source === 'settings' ? null : status().local.updatedAt,
      timezone: store.settings().timezone, warnings: ['合成示例数据；设置仅影响当前浏览器。'],
      ...(source === 'account' ? {provider: 'app-server', accountId: 'example', identityConfirmed: true, stale: false} : {})}});
  async function request(route: string, params: Record<string, unknown> = {}, method = 'GET', body?: unknown): Promise<ApiResponse<unknown>> {
    const p = Object.fromEntries(Object.entries(params).filter(([,v]) => v !== undefined && v !== null && v !== ''));
    const f: Filter = Object.fromEntries(['from','to','project','model','effort','threadId','unknown','unknowns'].filter(k => p[k] !== undefined).map(k => [k,p[k]]));
    for (const date of [f.from, f.to]) if (date && !Number.isFinite(Date.parse(date))) throw new Error('日期格式无效。');
    if (f.from && f.to && Date.parse(f.from) >= Date.parse(f.to)) throw new Error('开始时间必须早于结束时间。');
    if ([...(f.unknown ? [f.unknown] : []), ...(f.unknowns || [])].some(k => p[k] !== undefined)) throw new Error('同一维度不能同时选择具体值和未知。');
    const limit = Number(p.limit ?? 50), offset = Number(p.offset ?? 0);
    if (!Number.isInteger(limit) || limit < 1 || limit > 200 || !Number.isInteger(offset) || offset < 0) throw new Error('分页参数无效。');
    const sort = p.sort as string | undefined;
    if (route === 'settings') {
      if (method === 'PATCH') {
        const next = {...store.settings(), ...(body as Partial<Settings>)};
        validateSettings(next);
        // A failed write is shown to the visitor; don't claim persistent saving succeeded.
        storage?.setItem(KEY, JSON.stringify(next)); store.saveSettings(next);
      } else if (method !== 'GET') throw new Error('不支持此操作。');
      return wrap(store.settings(), 'settings');
    }
    if (route === 'refresh' && method === 'POST') { revision++; return wrap(status()); }
    if (method !== 'GET') throw new Error('此操作需要安装本地应用。');
    if (route === 'status') return wrap(status());
    if (route === 'system/autostart') return wrap({supported: false, enabled: false}, 'settings');
    if (route === 'pricing') return wrap({prices: officialPrices, source: pricingSource, checkedAt: pricingCheckedAt, currency: 'USD', tier: 'Standard API reference'}, 'settings');
    if (route === 'account/limits') return wrap((await account.readLimits()).data, 'account');
    if (route === 'account/usage') return wrap((await account.readUsage()).data, 'account');
    if (route === 'local/summary') return wrap(queries.summary(f));
    if (route === 'local/filters') return wrap(queries.filters(f));
    if (route === 'local/trend') return wrap(queries.trend(f, p.bucket === 'hour' ? 'hour' : 'day'));
    if (route === 'local/breakdown') {
      if (!['project','model','effort'].includes(String(p.groupBy))) throw new Error('分组维度无效。');
      return wrap(queries.breakdown(f, p.groupBy as 'project'|'model'|'effort', limit, offset));
    }
    if (route === 'local/threads') return wrap(queries.threads(f, limit, offset, sort, p.cacheBelow === undefined ? undefined : Number(p.cacheBelow), p.q as string));
    if (route === 'local/turns') return wrap(queries.allTurns({...f, turnId: p.missingTurn === true || p.missingTurn === 'true' ? null : p.turnId as string}, limit, offset, sort, p.q as string));
    if (route === 'local/compare') {
      const group = String(p.groupBy || 'project');
      if (!['project','model','effort','thread'].includes(group)) throw new Error('分组维度无效。');
      if (!!p.baselineFrom !== !!p.baselineTo) throw new Error('基准开始与结束时间需要同时提供。');
      if (p.baselineFrom && p.baselineTo && !(Date.parse(String(p.baselineFrom)) < Date.parse(String(p.baselineTo)))) throw new Error('开始时间必须早于结束时间。');
      return wrap(queries.compare({...f, to: f.to || EXAMPLE_NOW}, group as 'project'|'model'|'effort'|'thread', p.baselineFrom as string, p.baselineTo as string));
    }
    const match = /^local\/threads\/([^/]+)(?:\/(agents|turns))?$/.exec(route);
    if (match) {
      const id = decodeURIComponent(match[1]);
      const data = match[2] === 'agents' ? queries.agents(id, f) : match[2] === 'turns'
        ? queries.turns(id, f, limit, offset, sort) : queries.detail(id);
      if (!data) throw new Error('没有找到该任务。');
      return wrap(data);
    }
    throw new Error('接口不存在。');
  }
  return { request, queries, store };
}
