import type { ServerManager } from "./server.js";

const PAUSE_SESSION_ID = "vscode-pause";
const KEEPALIVE_INTERVAL_MS = 3 * 60 * 1000;

export type BlockerState = "active" | "paused" | "suspended";

export class Blocker {
  private _state: BlockerState = "active";
  private keepaliveTimer: ReturnType<typeof setInterval> | null = null;
  private suspendTimer: ReturnType<typeof setTimeout> | null = null;
  private _suspendEnd = 0;
  private countdownTimer: ReturnType<typeof setInterval> | null = null;
  private listeners = new Set<() => void>();
  private onSuspendExpiredCallback: (() => void) | null = null;
  private server: ServerManager;

  constructor(server: ServerManager) {
    this.server = server;
  }

  get state(): BlockerState { return this._state; }
  get suspendRemaining(): number {
    if (this._state !== "suspended") return 0;
    return Math.max(0, this._suspendEnd - Date.now());
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onSuspendExpired(cb: () => void): void {
    this.onSuspendExpiredCallback = cb;
  }

  private notify(): void { for (const l of this.listeners) l(); }

  pause(): void {
    if (this._state !== "active") return;
    this._state = "paused";
    this.server.send({ type: "inject-session", sessionId: PAUSE_SESSION_ID });
    this.startKeepalive();
    this.notify();
  }

  resume(): void {
    this.clearTimers();
    this._state = "active";
    this.server.send({ type: "remove-session", sessionId: PAUSE_SESSION_ID });
    this.notify();
  }

  suspend(minutes: number): void {
    if (this._state === "suspended") this.clearTimers();
    this._state = "suspended";
    this._suspendEnd = Date.now() + minutes * 60_000;
    this.server.send({ type: "inject-session", sessionId: PAUSE_SESSION_ID });
    this.startKeepalive();

    this.suspendTimer = setTimeout(() => {
      this.resume();
      this.onSuspendExpiredCallback?.();
    }, minutes * 60_000);

    this.countdownTimer = setInterval(() => this.notify(), 1000);
    this.notify();
  }

  private startKeepalive(): void {
    this.keepaliveTimer = setInterval(() => {
      this.server.send({ type: "refresh-session", sessionId: PAUSE_SESSION_ID });
    }, KEEPALIVE_INTERVAL_MS);
  }

  private clearTimers(): void {
    if (this.keepaliveTimer) { clearInterval(this.keepaliveTimer); this.keepaliveTimer = null; }
    if (this.suspendTimer) { clearTimeout(this.suspendTimer); this.suspendTimer = null; }
    if (this.countdownTimer) { clearInterval(this.countdownTimer); this.countdownTimer = null; }
  }

  dispose(): void {
    if (this._state !== "active") {
      this.server.send({ type: "remove-session", sessionId: PAUSE_SESSION_ID });
    }
    this.clearTimers();
    this.listeners.clear();
  }
}
