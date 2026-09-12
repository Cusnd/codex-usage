import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { EstimatedCost, Settings } from '../../modules/contracts/settings.js';
import type { Metrics } from '../../modules/contracts/query.js';
import { PriceSettings } from '../../modules/web/features/settings/PriceSettings.js';
import { SettingsPage } from '../../modules/web/features/settings/SettingsPage.js';
import { CostValue, UsageBreakdown, UsageHeadings, formatCostAmount } from '../../modules/web/widgets/Usage.js';
import { useData } from '../../modules/web/data/workspace.js';
import { pricingInfo } from '../../modules/settings/pricing.js';
import { hooks } from './pricing-display-hooks';

export { hooks, pricingInfo, formatCostAmount };
export function settingsTree() {hooks.active='settings';hooks.cursor=0;return SettingsPage();}
export function pricingTree(props: {draft:Settings;setDraft:(s:Settings)=>void}) {hooks.active='pricing';hooks.cursor=0;return PriceSettings(props);}
export function costMarkup(cost: EstimatedCost) {return renderToStaticMarkup(<CostValue cost={cost}/>);}
export function usageMarkup(data: Metrics) {return renderToStaticMarkup(<UsageBreakdown data={data}/>);}
export function headingsMarkup(cost?: EstimatedCost) {return renderToStaticMarkup(<table><thead><tr><UsageHeadings cost={cost}/></tr></thead></table>);}
export function queryOptions(settings: Settings) {hooks.settings=settings;useData('local/summary');return hooks.query;}
