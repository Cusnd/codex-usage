import { createContext, useContext, useMemo } from "react";
import { useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { DateTime } from "luxon";
import type { Settings, Status, Filter } from "../shared/contracts";
import { dataQuery } from "./data-query";
export const defaultSettings: Settings = {
  localInterval: 60,
  accountInterval: 300,
  timezone: "America/New_York",
  timezoneMode: "manual",
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
  const { settings } = useContext(Workspace);
  const [search] = useSearchParams();
  return useQuery({
    enabled,
    ...dataQuery<T>(route, params, settings.timezone, search.get("range") !== "custom"),
  });
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
      if ("range" in patch || "from" in patch || "to" in patch)
        next.delete("parentRange");
      for (const [k, v] of Object.entries(patch))
        v ? next.set(k, v) : next.delete(k);
      return next;
    });
  return {
    range,
    filters,
    update,
    search,
    setSearch,
    valid: resolved.valid,
    timezone: settings.timezone,
  };
}
