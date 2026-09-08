#!/usr/bin/env node
const args = process.argv.slice(2);
const command = args.shift();
const params = {};
for (let i = 0; i < args.length; i += 2) {
  if (!args[i].startsWith("--") || args[i + 1] === undefined)
    throw new Error("Options use --name value");
  params[args[i].slice(2)] = args[i + 1];
}
const base = process.env.CODEX_USAGE_URL || "http://127.0.0.1:8765";
const routes = {
  status: "status",
  summary: "local/summary",
  breakdown: "local/breakdown",
  compare: "local/compare",
  threads: "local/threads",
  trend: "local/trend",
  limits: "account/limits",
  usage: "account/usage",
  thread: "local/threads/" + encodeURIComponent(params.id || ""),
  turns: "local/threads/" + encodeURIComponent(params.id || "") + "/turns",
};
if (!(command in routes)) {
  console.error(
    "Usage: node query.mjs status|summary|breakdown|compare|threads|thread|turns|trend|limits|usage [--days 7] [--id ID] [--groupBy project]",
  );
  process.exit(1);
}
if (["thread", "turns"].includes(command) && !params.id) {
  console.error("--id is required");
  process.exit(1);
}
delete params.id;
try {
  if (params.days) {
    if (command === "usage")
      throw new Error(
        "Account daily records cannot be rebucketed by timezone. Use summary/trend for local-time statistics, or usage --from YYYY-MM-DD --to YYYY-MM-DD for raw account dates.",
      );
    const days = Number(params.days);
    if (!Number.isInteger(days) || days < 1 || days > 3660)
      throw new Error("--days must be an integer between 1 and 3660");
    const settings = await fetch(base + "/api/settings", {
      signal: AbortSignal.timeout(15000),
    }).then((r) => r.json());
    const zone = settings.data.timezone;
    // Resolve midnight using Intl, so the installed skill does not depend on application packages.
    const formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone: zone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
    const parts = (at) =>
      Object.fromEntries(
        formatter
          .formatToParts(new Date(at))
          .filter((x) => x.type !== "literal")
          .map((x) => [x.type, Number(x.value)]),
      );
    const now = Date.now(),
      p = parts(now),
      wall = Date.UTC(p.year, p.month - 1, p.day - (days - 1));
    let guess = wall;
    for (let i = 0; i < 4; i++) {
      const q = parts(guess);
      guess +=
        wall - Date.UTC(q.year, q.month - 1, q.day, q.hour, q.minute, q.second);
    }
    params.from ??= new Date(guess).toISOString();
    params.to ??= new Date(now).toISOString();
    delete params.days;
  }
  if (command === "breakdown") params.groupBy ??= "project";
  const url =
    base + "/api/" + routes[command] + "?" + new URLSearchParams(params);
  const response = await fetch(url, { signal: AbortSignal.timeout(60000) });
  const body = await response.json();
  if (!response.ok)
    throw new Error(body.error?.message || `HTTP ${response.status}`);
  console.log(JSON.stringify({ query: params, ...body }, null, 2));
} catch (error) {
  console.error(
    "Usage query failed: " +
      error.message +
      "\nIf the workbench is stopped, run npm start in its repository.",
  );
  process.exitCode = 1;
}
