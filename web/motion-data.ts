import { useMemo, useState, useSyncExternalStore } from "react";
import type { ApiResponse } from "../shared/contracts";
import { readMotionTicket, refreshMotionVersion, settleResult, subscribeMotion, type ResultSnapshot } from "./motion-state";

export function useResultMotion<T>(
  query: { data?: ApiResponse<T>; dataUpdatedAt: number; isPlaceholderData: boolean; isFetching: boolean; isError: boolean },
  search: URLSearchParams,
  source: "local" | "account",
) {
  useSyncExternalStore(subscribeMotion, refreshMotionVersion, () => 0);
  const ticket = readMotionTicket(search, source);
  const data = useMemo(() => query.data ? JSON.stringify(query.data.data) : undefined, [query.data]);
  const [snapshot, setSnapshot] = useState<ResultSnapshot>({ data: undefined, at: 0, used: ticket.id, revision: 0, animate: false, initial: true });
  if (query.isError && ticket.id > snapshot.used) setSnapshot({ ...snapshot, used: ticket.id, animate: false });
  if (!query.isPlaceholderData && data !== undefined && (query.dataUpdatedAt !== snapshot.at || data !== snapshot.data))
    setSnapshot(settleResult(snapshot, data, query.dataUpdatedAt, ticket));
  const pending = query.isPlaceholderData || (query.isFetching && ticket.id > snapshot.used);
  return { ...snapshot, animate: snapshot.animate && !pending && !query.isError, pending };
}
