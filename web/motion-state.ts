/** User intent is separate from query timestamps: polling must not replay an old click. */
export type MotionTicket = { id: number; at: number };
const none: MotionTicket = { id: 0, at: 0 };
let sequence = 0;
let navigation = { search: "", ticket: none };
const refresh = { local: none, account: none };
const listeners = new Set<() => void>();
function canonical(search: URLSearchParams) {
  const copy = new URLSearchParams(search);
  for (const key of ["expandedTurn", "trend"]) copy.delete(key);
  copy.sort(); return copy.toString();
}
export function markQueryMotion(search: URLSearchParams, previous?: URLSearchParams) {
  if (previous && canonical(search) === canonical(previous)) return;
  navigation = { search: canonical(search), ticket: { id: ++sequence, at: Date.now() } };
}
export function beginRefreshMotion(source: string) {
  const ticket = { id: ++sequence, at: Date.now() };
  if (source === "all" || source === "local") refresh.local = ticket;
  if (source !== "local") refresh.account = ticket;
  listeners.forEach((notify) => notify());
  return ticket;
}
export function cancelRefreshMotion(ticket: MotionTicket) {
  for (const source of ["local", "account"] as const)
    if (refresh[source].id === ticket.id) refresh[source] = none;
  listeners.forEach((notify) => notify());
}
export function readMotionTicket(search: URLSearchParams, source: "local" | "account") {
  const query = source === "local" && navigation.search === canonical(search) ? navigation.ticket : none;
  return query.id > refresh[source].id ? query : refresh[source];
}
export function subscribeMotion(notify: () => void) {
  listeners.add(notify); return () => { listeners.delete(notify); };
}
export const refreshMotionVersion = () => Math.max(refresh.local.id, refresh.account.id);

export type ResultMotion = { revision: number; animate: boolean; initial: boolean; pending?: boolean };
export type ResultSnapshot = ResultMotion & { data: string | undefined; at: number; used: number };
export function settleResult(previous: ResultSnapshot, data: string, at: number, ticket: MotionTicket): ResultSnapshot {
  const initial = previous.data === undefined;
  // A cached result can predate the click and still be the result the user selected.
  const user = ticket.id > previous.used;
  const changed = previous.data !== data;
  const animate = changed && (initial || user);
  return {
    data, at, used: Math.max(previous.used, ticket.id),
    revision: previous.revision + (animate ? 1 : 0), animate, initial,
  };
}

export type ChartSnapshot = { series: string; buckets: readonly string[]; values: readonly number[]; coordinates: string };
export type PlotSnapshot = { input: string; from?: ChartSnapshot; current: ChartSnapshot; animate: boolean; revision: number };
/** Query metadata cannot cancel an in-flight transition; only a different target changes intent. */
export function settlePlot(previous: PlotSnapshot, input: string, next: ChartSnapshot, change: ResultMotion): PlotSnapshot {
  if (input !== previous.input) return { input, from: previous.current, current: next, animate: change.animate, revision: change.revision };
  if (next.coordinates !== previous.current.coordinates) return { ...previous, current: next };
  return previous;
}
export function chartTransition(previous: ChartSnapshot | undefined, next: ChartSnapshot, user: boolean, reduced: boolean, continuous = false) {
  if (reduced || !user) return "none";
  if (!previous || !previous.values.length || !next.values.length) return "fade";
  if (previous.values.every((value, i) => value === next.values[i]) &&
      previous.buckets.join("|") === next.buckets.join("|") && previous.series === next.series) return "none";
  // Curves may interpolate screen geometry across ranges/granularities. These intermediate
  // shapes are visual transitions only; axes, labels and tooltip values remain real data.
  if (continuous && previous.series === next.series && !!next.coordinates &&
      next.values.every(Number.isFinite) && previous.values.every(Number.isFinite)) return "morph";
  return previous.series === next.series &&
    previous.coordinates === next.coordinates && !!next.coordinates &&
    previous.buckets.length === next.buckets.length &&
    previous.buckets.every((value, i) => value === next.buckets[i]) &&
    next.values.every(Number.isFinite) && previous.values.every(Number.isFinite)
    ? "morph" : "fade";
}
