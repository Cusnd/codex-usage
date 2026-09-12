import type { Settings } from '../contracts/settings.js';
import type { Refresh } from "./refresh.js";

type Job = "local" | "accountLimits" | "accountHistory";
// One backend owns scheduling, regardless of how many browser tabs are open.
export class RefreshScheduler {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private closed = false;
  private active = false;
  constructor(
    private refresh: Refresh,
    private settings: () => Settings,
  ) {}
  start() {
    if (!this.active && !this.closed) {
      this.active = true;
      this.reschedule();
    }
  }
  reschedule() {
    if (this.timer) clearTimeout(this.timer);
    if (this.closed || !this.active) return;
    const now = Date.now(),
      settings = this.settings();
    const delays: number[] = [];
    for (const key of ["local", "accountLimits", "accountHistory"] as const) {
      const seconds =
        settings[key === "local" ? "localInterval" : "accountInterval"];
      if (!seconds) continue;
      const started = this.refresh.status[key].startedAt;
      delays.push(
        Math.max(
          250,
          (started ? Date.parse(started) : now) + seconds * 1000 - now,
        ),
      );
    }
    if (!delays.length) return;
    this.timer = setTimeout(
      () => {
        this.runDue();
        this.reschedule();
      },
      Math.min(...delays),
    );
    this.timer.unref();
  }
  runDue(now = Date.now()) {
    if (this.closed) return;
    const settings = this.settings();
    for (const key of ["local", "accountLimits", "accountHistory"] as Job[]) {
      const interval =
        settings[key === "local" ? "localInterval" : "accountInterval"];
      const started = this.refresh.status[key].startedAt;
      if (
        interval &&
        (!started || now - Date.parse(started) >= interval * 1000)
      )
        this.refresh.trigger(key);
    }
  }
  close() {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
  }
}
