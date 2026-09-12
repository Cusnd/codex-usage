import type { Settings } from '../../../shared/contracts';
import { officialPrices } from '../../../shared/pricing';

export const defaultSettings:Settings={localInterval:30,accountInterval:300,timezone:'America/New_York',timezoneMode:'manual',costEnabled:false,officialApiPricing:false,modelPrices:officialPrices};
