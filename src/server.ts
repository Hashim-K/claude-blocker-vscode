import { Worker } from "node:worker_threads";
import { join } from "node:path";
import type { MainToWorkerMessage, WorkerToMainMessage, Session } from "./server/types.js";

export type ServerState = "stopped" | "starting" | "running" | "error";

export interface ServerStatus {
  state: ServerState;
  port: number;
  blocked: boolean;
  sessions: Session[];
  working: number;
  waitingForInput: number;
  error?: string;
}

type StateChangeListener = (status: ServerStatus) => void;

export class ServerManager {
  private worker: Worker | null = null;
  private _state: ServerState = "stopped";
  private _port: number;
  private _blocked = true;
  private _sessions: Session[] = [];
  private _working = 0;
  private _waitingForInput = 0;
  private _error?: string;
  private listeners = new Set<StateChangeListener>();
  private extensionPath: string;

  constructor(extensionPath: string, port: number) {
    this.extensionPath = extensionPath;
    this._port = port;
  }

  get status(): ServerStatus {
    return {
      state: this._state, port: this._port, blocked: this._blocked,
      sessions: this._sessions, working: this._working,
      waitingForInput: this._waitingForInput, error: this._error,
    };
  }

  onStateChange(listener: StateChangeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    const s = this.status;
    for (const l of this.listeners) l(s);
  }

  start(): void {
    if (this.worker) return;
    this._state = "starting";
    this._error = undefined;
    this.notify();

    const workerPath = join(this.extensionPath, "out", "server-worker.js");
    this.worker = new Worker(workerPath);

    this.worker.on("message", (msg: WorkerToMainMessage) => {
      switch (msg.type) {
        case "started":
          this._state = "running";
          this._port = msg.port;
          this.notify();
          break;
        case "error":
          this._state = "error";
          this._error = msg.message;
          this.notify();
          break;
        case "state-change":
          this._blocked = msg.blocked;
          this._sessions = msg.sessions;
          this._working = msg.working;
          this._waitingForInput = msg.waitingForInput;
          this.notify();
          break;
        case "status":
          this._blocked = msg.blocked;
          this._sessions = msg.sessions;
          this.notify();
          break;
      }
    });

    this.worker.on("error", (err) => {
      this._state = "error";
      this._error = err.message;
      this.worker = null;
      this.notify();
    });

    this.worker.on("exit", (code) => {
      if (this._state === "running") {
        this._state = "stopped";
        this._error = `Worker exited with code ${code}`;
      }
      this.worker = null;
      this.notify();
    });
  }

  stop(): void {
    if (!this.worker) return;
    this.send({ type: "shutdown" });
    this.worker.terminate();
    this.worker = null;
    this._state = "stopped";
    this._blocked = true;
    this._sessions = [];
    this._working = 0;
    this._waitingForInput = 0;
    this.notify();
  }

  send(message: MainToWorkerMessage): void {
    this.worker?.postMessage(message);
  }

  dispose(): void {
    this.stop();
    this.listeners.clear();
  }
}
