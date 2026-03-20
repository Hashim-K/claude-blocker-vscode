import type { Session } from "./server/types.js";
import type { ServerManager, ServerStatus } from "./server.js";

export interface ActivityEntry {
  sessionId: string;
  projectName: string;
  status: "working" | "waiting_for_input" | "idle" | "ended";
  timestamp: number;
}

const HISTORY_HOURS = 4;
const HISTORY_MS = HISTORY_HOURS * 60 * 60 * 1000;

export class ActivityTracker {
  private entries: ActivityEntry[] = [];
  private prevSessions = new Map<string, Session["status"]>();
  private unsub: (() => void) | null = null;

  constructor(server: ServerManager) {
    this.unsub = server.onStateChange((status) => this.onStateChange(status));
  }

  private onStateChange(status: ServerStatus): void {
    if (status.state !== "running") return;
    const now = Date.now();
    const currentIds = new Set<string>();

    for (const session of status.sessions) {
      currentIds.add(session.id);
      const prev = this.prevSessions.get(session.id);
      if (prev !== session.status) {
        this.entries.push({
          sessionId: session.id,
          projectName: session.projectName,
          status: session.status,
          timestamp: now,
        });
        this.prevSessions.set(session.id, session.status);
      }
    }

    // Track ended sessions
    for (const [id] of this.prevSessions) {
      if (!currentIds.has(id)) {
        this.entries.push({
          sessionId: id,
          projectName: id.substring(0, 8),
          status: "ended",
          timestamp: now,
        });
        this.prevSessions.delete(id);
      }
    }

    this.prune(now);
  }

  private prune(now: number): void {
    const cutoff = now - HISTORY_MS;
    while (this.entries.length > 0 && this.entries[0].timestamp < cutoff) {
      this.entries.shift();
    }
  }

  getHistory(): ActivityEntry[] {
    this.prune(Date.now());
    return [...this.entries];
  }

  getTimelineData(): { sessionId: string; projectName: string; segments: { status: string; start: number; end: number }[] }[] {
    const now = Date.now();
    this.prune(now);
    const windowStart = now - HISTORY_MS;

    // Group entries by session
    const sessionEntries = new Map<string, { projectName: string; entries: ActivityEntry[] }>();
    for (const e of this.entries) {
      if (!sessionEntries.has(e.sessionId)) {
        sessionEntries.set(e.sessionId, { projectName: e.projectName, entries: [] });
      }
      sessionEntries.get(e.sessionId)!.entries.push(e);
    }

    const result: { sessionId: string; projectName: string; segments: { status: string; start: number; end: number }[] }[] = [];

    for (const [sessionId, data] of sessionEntries) {
      const segments: { status: string; start: number; end: number }[] = [];
      const sorted = data.entries.sort((a, b) => a.timestamp - b.timestamp);

      for (let i = 0; i < sorted.length; i++) {
        const entry = sorted[i];
        if (entry.status === "ended") continue;
        const start = entry.timestamp;
        const end = i + 1 < sorted.length ? sorted[i + 1].timestamp : now;
        segments.push({ status: entry.status, start, end });
      }

      if (segments.length > 0) {
        result.push({ sessionId, projectName: data.projectName, segments });
      }
    }

    return result;
  }

  dispose(): void {
    if (this.unsub) this.unsub();
  }
}
