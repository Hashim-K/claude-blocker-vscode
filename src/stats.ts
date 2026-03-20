import type * as vscode from "vscode";
import type { ServerManager } from "./server.js";

export interface DailyStats {
  blockingMs: number;
  unblockedMs: number;
  sessionCount: number;
  pomodoroCount: number;
  pauseCount: number;
}

function dateKey(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export class StatsTracker {
  private globalState: vscode.Memento;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastBlocked = true;
  private lastTick = Date.now();
  private listeners = new Set<() => void>();
  private unsub: (() => void) | null = null;

  constructor(globalState: vscode.Memento, server: ServerManager) {
    this.globalState = globalState;
    this.unsub = server.onStateChange((status) => {
      this.lastBlocked = status.blocked && status.state === "running";
    });
    this.timer = setInterval(() => this.tick(), 1000);
  }

  private tick(): void {
    const now = Date.now();
    const elapsed = now - this.lastTick;
    this.lastTick = now;
    const key = dateKey();
    const stats = this.getDay(key);
    if (this.lastBlocked) stats.blockingMs += elapsed;
    else stats.unblockedMs += elapsed;
    this.globalState.update(`stats.${key}`, stats);

    const keys = this.globalState.get<string[]>("stats.__keys__", []);
    if (!keys.includes(key)) {
      keys.push(key);
      this.globalState.update("stats.__keys__", keys);
    }
  }

  getDay(key?: string): DailyStats {
    return this.globalState.get<DailyStats>(`stats.${key || dateKey()}`, {
      blockingMs: 0, unblockedMs: 0, sessionCount: 0, pomodoroCount: 0, pauseCount: 0,
    });
  }

  getToday(): DailyStats { return this.getDay(); }

  getAllTime(): { blockingMs: number; unblockedMs: number; sessionCount: number; pomodoroCount: number; days: number } {
    const keys = this.globalState.get<string[]>("stats.__keys__", []);
    let blockingMs = 0, unblockedMs = 0, sessionCount = 0, pomodoroCount = 0;
    for (const key of keys) {
      const d = this.getDay(key);
      blockingMs += d.blockingMs; unblockedMs += d.unblockedMs;
      sessionCount += d.sessionCount; pomodoroCount += d.pomodoroCount;
    }
    return { blockingMs, unblockedMs, sessionCount, pomodoroCount, days: keys.length };
  }

  recordSession(): void {
    const key = dateKey(); const stats = this.getDay(key);
    stats.sessionCount++; this.globalState.update(`stats.${key}`, stats);
  }
  recordPomodoro(): void {
    const key = dateKey(); const stats = this.getDay(key);
    stats.pomodoroCount++; this.globalState.update(`stats.${key}`, stats);
  }
  recordPause(): void {
    const key = dateKey(); const stats = this.getDay(key);
    stats.pauseCount++; this.globalState.update(`stats.${key}`, stats);
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.unsub) this.unsub();
    this.listeners.clear();
  }
}
