import type { Blocker } from "./blocker.js";

export type PomodoroPhase = "active" | "break";
export type PomodoroState = { running: false } | { running: true; phase: PomodoroPhase; remaining: number };

export class Pomodoro {
  private _running = false;
  private _phase: PomodoroPhase = "active";
  private phaseEnd = 0;
  private phaseTimer: ReturnType<typeof setTimeout> | null = null;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private listeners = new Set<() => void>();
  private phaseChangeListeners = new Set<(phase: PomodoroPhase) => void>();
  private blocker: Blocker;
  private activeMs: number;
  private breakMs: number;

  constructor(blocker: Blocker, activeMinutes: number, breakMinutes: number) {
    this.blocker = blocker;
    this.activeMs = activeMinutes * 60_000;
    this.breakMs = breakMinutes * 60_000;
  }

  get state(): PomodoroState {
    if (!this._running) return { running: false };
    return { running: true, phase: this._phase, remaining: Math.max(0, this.phaseEnd - Date.now()) };
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onPhaseChange(listener: (phase: PomodoroPhase) => void): () => void {
    this.phaseChangeListeners.add(listener);
    return () => this.phaseChangeListeners.delete(listener);
  }

  private notify(): void { for (const l of this.listeners) l(); }

  start(): void {
    if (this._running) return;
    this._running = true;
    this.startPhase("active");
  }

  stop(): void {
    if (!this._running) return;
    this.clearTimers();
    if (this._phase === "break") this.blocker.resume();
    this._running = false;
    this.notify();
  }

  toggle(): void { if (this._running) this.stop(); else this.start(); }

  updateSettings(activeMinutes: number, breakMinutes: number): void {
    this.activeMs = activeMinutes * 60_000;
    this.breakMs = breakMinutes * 60_000;
  }

  private startPhase(phase: PomodoroPhase): void {
    this.clearTimers();
    this._phase = phase;
    const duration = phase === "active" ? this.activeMs : this.breakMs;
    this.phaseEnd = Date.now() + duration;

    if (phase === "break") this.blocker.pause();
    else this.blocker.resume();

    for (const l of this.phaseChangeListeners) l(phase);

    this.phaseTimer = setTimeout(() => {
      this.startPhase(phase === "active" ? "break" : "active");
    }, duration);
    this.tickTimer = setInterval(() => this.notify(), 1000);
    this.notify();
  }

  private clearTimers(): void {
    if (this.phaseTimer) { clearTimeout(this.phaseTimer); this.phaseTimer = null; }
    if (this.tickTimer) { clearInterval(this.tickTimer); this.tickTimer = null; }
  }

  dispose(): void {
    this.stop();
    this.listeners.clear();
    this.phaseChangeListeners.clear();
  }
}
