import { createContext, useContext, useMemo, useSyncExternalStore } from "react";
import { useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { DateTime } from "luxon";
import type { Settings } from '../../contracts/settings.js';
import type { Status } from '../../contracts/status.js';
import type { Filter } from '../../contracts/query.js';
import { dataQuery } from "./data-query.js";
import { resolveTrendBucket } from "../../foundation/time-range.js";
import { USAGE_QUERY_REVISION } from "../../analytics/revision.js";
import { markQueryMotion } from "../motion/motion-state.js";
import { useResultMotion } from "../motion/motion-data.js";
import { useWebRuntime } from '../runtime/context.js';
export const defaultSettings: Settings = {
  localInterval: 60,
  accountInterval: 300,
  timezone: "America/New_York",
  timezoneMode: "manual",
  costEnabled: false,
  officialApiPricing: false,
};
export const Workspace = createContext({
  settings: defaultSettings,
  now: Date.now(),
  status: undefined as Status | undefined,
});
export function useData<T>(
  route: string,
  params: Record<string, unknown> = {},
  enabled = true,
) {
  const runtime = useWebRuntime(), adapter = runtime.source;
  useSyncExternalStore(adapter.subscribe ?? idleSubscribe, () => adapter.revision(), () => adapter.revision());
  const fixed = runtime.capabilities.deviceScope;
  const { settings } = useContext(Workspace);
  const [search] = useSearchParams();
  const options = dataQuery<T>(
      route,
      fixed ? {...params,deviceIds:search.getAll('deviceIds')} : params,
      settings.timezone,
      search.get("range") !== "custom",
      adapter, runtime.clock,
    );
  const pricingKey = !fixed && route.startsWith("local/")
    ? JSON.stringify([USAGE_QUERY_REVISION, Boolean(settings.costEnabled), Boolean(settings.officialApiPricing), settings.officialApiPricing ? settings.modelPrices : null])
    : null;
  const query = useQuery({
    enabled,
    ...options,
    queryKey: pricingKey == null ? options.queryKey : [...options.queryKey, pricingKey],
    placeholderData: fixed ? undefined : (previous, previousQuery) =>
      previousQuery?.queryKey[1] === route && (pricingKey == null || previousQuery.queryKey.at(-1) === pricingKey) ? previous : undefined,
  });
  const change = useResultMotion(query, search, route.startsWith("account") ? "account" : "local");
  return { ...query, motion: change };
}
export function useRange() {
  const [search, setSearch] = useSearchParams();
  const { settings, now } = useContext(Workspace);
  const range = search.get("range") || "7";
  const resolved = useMemo(() => {
    const end = DateTime.fromMillis(now, { zone: settings.timezone });
    const from =
      range === "custom"
        ? DateTime.fromISO(search.get("from") || "", {
            zone: settings.timezone,
          })
        : end
            .startOf("day")
            .minus({ days: range === "today" ? 0 : Number(range) - 1 });
    const to =
      range === "custom"
        ? DateTime.fromISO(search.get("to") || "", { zone: settings.timezone })
        : end;
    const valid = from.isValid && to.isValid && from < to;
    return {
      from: valid ? from.toUTC().toISO()! : end.startOf("day").toUTC().toISO()!,
      to: valid ? to.toUTC().toISO()! : end.toUTC().toISO()!,
      valid,
    };
  }, [range, search.toString(), settings.timezone, now]);
  const filters: Filter = {
    from: resolved.from,
    to: resolved.to,
    project: search.get("project") || undefined,
    model: search.get("model") || undefined,
    effort: search.get("effort") || undefined,
    unknown: (search.get("unknown") as Filter["unknown"]) || undefined,
  };
  const update = (patch: Record<string, string | undefined>) =>
    setSearch((previous) => {
      const next = new URLSearchParams(previous);
      next.delete("offset");
      next.delete("compareOffset");
      for (const key of [
        "groupOffset",
        "sessionOffset",
        "turnOffset",
        "globalTurnOffset",
      ])
        next.delete(key);
      next.delete("expandedTurn");
      if ("range" in patch || "from" in patch || "to" in patch) {
        next.delete("parentRange");
        if (!("bucket" in patch)) next.delete("bucket");
      }
      for (const [k, v] of Object.entries(patch))
        v ? next.set(k, v) : next.delete(k);
      markQueryMotion(next, previous);
      return next;
    });
  return {
    range,
    bucket: resolveTrendBucket(
      search.get("bucket"),
      range,
      resolved.from,
      resolved.to,
      settings.timezone,
    ),
    filters,
    update,
    search,
    setSearch,
    valid: resolved.valid,
    timezone: settings.timezone,
  };
}

const idleSubscribe = () => () => {};
