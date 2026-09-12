import type { Settings } from '../contracts/settings.js';
import { officialPrices } from './pricing.js';

export const defaultSettings:Settings={localInterval:30,accountInterval:300,timezone:'America/New_York',timezoneMode:'manual',costEnabled:false,officialApiPricing:false,modelPrices:officialPrices};
