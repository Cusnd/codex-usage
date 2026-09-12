import { IANAZone } from 'luxon';
import type { Settings } from '../../../shared/contracts';
import { fail } from '../http';
import { defaultSettings } from './defaults';

/** The browser's zone is query context; the lease still pins the saved preference and cut. */
export function resolveReadSettings(payload:string|null,url:URL):Settings {
  const zones=url.searchParams.getAll('timezone');
  if(zones.length>1||zones.length===1&&(!zones[0]||zones[0].length>128||zones[0].trim()!==zones[0]||!IANAZone.isValidZone(zones[0])))fail(400,'INVALID_TIMEZONE','显示时区必须是有效的 IANA 时区。');
  const saved:Settings={...defaultSettings,...(payload?JSON.parse(payload):{})};
  return saved.timezoneMode==='system'&&zones.length?{...saved,timezone:zones[0]}:saved;
}
