import { Value } from "@sinclair/typebox/value";
import { DateTime } from "luxon";
import { SettingsSchema, type Settings } from "../contracts/settings.js";

export function validSettings(value:unknown):value is Settings {
  return Value.Check(SettingsSchema,value)&&DateTime.now().setZone(value.timezone).isValid&&new Set(value.modelPrices?.map(p=>p.model)).size===(value.modelPrices?.length||0);
}
