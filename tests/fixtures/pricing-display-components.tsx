import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { EstimatedCost, Metrics, Settings } from '../../shared/contracts';
import { PriceSettings } from '../../web/PriceSettings';
import { SettingsPage } from '../../web/SettingsPage';
import { CostValue, UsageBreakdown, UsageHeadings, formatCostAmount } from '../../web/Usage';
import { useData } from '../../web/workspace';
import { pricingInfo } from '../../shared/pricing';
import { hooks } from './pricing-display-hooks';

export { hooks, pricingInfo, formatCostAmount };
export function settingsTree() {hooks.active='settings';hooks.cursor=0;return SettingsPage();}
export function pricingTree(props: {draft:Settings;setDraft:(s:Settings)=>void}) {hooks.active='pricing';hooks.cursor=0;return PriceSettings(props);}
export function costMarkup(cost: EstimatedCost) {return renderToStaticMarkup(<CostValue cost={cost}/>);}
export function usageMarkup(data: Metrics) {return renderToStaticMarkup(<UsageBreakdown data={data}/>);}
export function headingsMarkup(cost?: EstimatedCost) {return renderToStaticMarkup(<table><thead><tr><UsageHeadings cost={cost}/></tr></thead></table>);}
export function queryOptions(settings: Settings) {hooks.settings=settings;useData('local/summary');return hooks.query;}
