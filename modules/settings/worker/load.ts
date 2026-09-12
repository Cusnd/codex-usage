import { type Settings } from "../../contracts/settings.js";
import { defaultSettings } from "../defaults.js";

export async function loadSettings(db:D1Database,user:string):Promise<Settings> {
  const row=await db.prepare('SELECT payload FROM v3_settings WHERE user_id=?').bind(user).first<{payload:string|null}>();
  const value={...defaultSettings,...(row?.payload?JSON.parse(row.payload):{})};return value;
}
