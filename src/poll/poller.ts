import type { Server, Tool, Report } from "../types.js";
import type { Snapshot, Diff } from "./differ.js";
import { diffSnapshots, formatDiff } from "./differ.js";

export interface PollerConfig {
  intervalSec: number;
  discover: () => Promise<{ servers: Server[]; tools: Tool[] }>;
  analyze: (tools: Tool[], servers: Server[]) => Report;
  onSnapshot: (snapshot: Snapshot, diff: Diff | null) => void;
  onError: (error: Error) => void;
}

export class Poller {
  private config: PollerConfig;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private stopped = false;
  private lastSnapshot: Snapshot | null = null;
  private lastTickStartTime: number | null = null; // Track when last tick started
  private runAgainAfterCurrentTick = false;

  constructor(config: PollerConfig) {
    this.config = config;
  }

  async start(): Promise<void> {
    if (this.running) {
      throw new Error("Poller already running");
    }
    this.stopped = false;
    await this.tick();
    this.scheduleNext();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  setInterval(intervalSec: number): void {
    validateWatchInterval(intervalSec);
    this.config.intervalSec = intervalSec;
    // Cancel current timer and reschedule with new interval
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (!this.stopped && !this.running) {
      this.scheduleNext();
    }
  }

  getInterval(): number {
    return this.config.intervalSec;
  }

  /** Run one discovery cycle immediately (e.g. config file changed on disk). */
  async runNow(): Promise<void> {
    this.runAgainAfterCurrentTick = true;
    if (!this.running) {
      await this.drainPendingRuns();
    }
  }

  private async drainPendingRuns(): Promise<void> {
    while (this.runAgainAfterCurrentTick && !this.stopped) {
      this.runAgainAfterCurrentTick = false;
      await this.tick();
    }
  }

  private scheduleNext(): void {
    if (this.stopped) return;
    
    // Schedule from the START time of the last tick
    const now = Date.now();
    const intervalMs = this.config.intervalSec * 1000;
    let delay = intervalMs;
    
    if (this.lastTickStartTime !== null) {
      const elapsed = now - this.lastTickStartTime;
      delay = Math.max(0, intervalMs - elapsed);
    }
    
    this.timer = setTimeout(() => {
      this.tick().catch((err) => {
        this.config.onError(err);
        this.scheduleNext();
      });
    }, delay);
  }

  private async tick(): Promise<void> {
    // If previous tick is still running, skip this tick
    if (this.running) {
      return;
    }

    this.running = true;
    this.lastTickStartTime = Date.now(); // Record start time
    
    try {
      const { servers, tools } = await this.config.discover();
      const report = this.config.analyze(tools, servers);
      const snapshot: Snapshot = {
        timestamp: new Date().toISOString(),
        servers,
        tools,
        report,
      };

      const diff = diffSnapshots(this.lastSnapshot, snapshot);
      this.lastSnapshot = snapshot;
      this.config.onSnapshot(snapshot, diff);
    } catch (err) {
      this.config.onError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      this.running = false;
      if (this.runAgainAfterCurrentTick && !this.stopped) {
        void this.drainPendingRuns();
      } else if (!this.stopped) {
        this.scheduleNext();
      }
    }
  }
}

export function validateWatchInterval(intervalSec: number): void {
  if (!Number.isFinite(intervalSec) || intervalSec < 10) {
    throw new Error("--watch-interval must be >= 10 seconds");
  }
}
