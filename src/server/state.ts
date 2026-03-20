import { basename } from "node:path";
import type { HookPayload, Session, ToolCall, WorkerToMainMessage } from "./types.js";
import { USER_INPUT_TOOLS, SESSION_TIMEOUT_MS, DEBOUNCE_MS, CLEANUP_INTERVAL_MS } from "./types.js";

interface InternalSession {
  id: string;
  status: "idle" | "working" | "waiting_for_input";
  projectName: string;
  cwd?: string;
  startTime: Date;
  lastActivity: Date;
  lastTool?: string;
  toolCount: number;
  recentTools: ToolCall[];
  waitingForInputSince?: Date;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number;
}

type StateChangeCallback = (message: WorkerToMainMessage) => void;

export class SessionState {
  private sessions = new Map<string, InternalSession>();
  private listeners = new Set<StateChangeCallback>();
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;

  constructor() {
    this.cleanupInterval = setInterval(() => this.cleanupStaleSessions(), CLEANUP_INTERVAL_MS);
  }

  subscribe(callback: StateChangeCallback): () => void {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  private broadcast(): void {
    const msg = this.getStateMessage();
    for (const listener of this.listeners) {
      listener({ type: "state-change", ...msg });
    }
  }

  private getStateMessage() {
    const sessions = this.serializeSessions();
    const working = sessions.filter(s => s.status === "working").length;
    const waitingForInput = sessions.filter(s => s.status === "waiting_for_input").length;
    return { blocked: working === 0, sessions, working, waitingForInput };
  }

  handleHook(payload: HookPayload): void {
    const { session_id, hook_event_name } = payload;

    switch (hook_event_name) {
      case "SessionStart":
        this.sessions.set(session_id, this.createSession(session_id, payload.cwd));
        break;

      case "SessionEnd":
        this.sessions.delete(session_id);
        break;

      case "UserPromptSubmit": {
        const session = this.ensureSession(session_id, payload.cwd);
        session.status = "working";
        session.waitingForInputSince = undefined;
        session.lastActivity = new Date();
        break;
      }

      case "PreToolUse": {
        const session = this.ensureSession(session_id, payload.cwd);
        if (payload.tool_name && USER_INPUT_TOOLS.includes(payload.tool_name)) {
          session.status = "waiting_for_input";
          session.waitingForInputSince = new Date();
        } else if (session.status === "waiting_for_input") {
          const elapsed = Date.now() - (session.waitingForInputSince?.getTime() ?? 0);
          if (elapsed > DEBOUNCE_MS) {
            session.status = "working";
            session.waitingForInputSince = undefined;
          }
        } else {
          session.status = "working";
        }
        if (payload.tool_name) {
          session.lastTool = payload.tool_name;
          session.toolCount++;
          session.recentTools.push({
            name: payload.tool_name,
            timestamp: new Date().toISOString(),
            input: payload.tool_input as ToolCall["input"],
          });
          if (session.recentTools.length > 5) session.recentTools.shift();
        }
        session.lastActivity = new Date();
        break;
      }

      case "PostToolUse": {
        const session = this.sessions.get(session_id);
        if (session) {
          if (payload.input_tokens) session.inputTokens += payload.input_tokens;
          if (payload.output_tokens) session.outputTokens += payload.output_tokens;
          if (payload.cost_usd) session.costUsd += payload.cost_usd;
          session.totalTokens = session.inputTokens + session.outputTokens;
          session.lastActivity = new Date();
        }
        break;
      }

      case "Stop": {
        const session = this.ensureSession(session_id, payload.cwd);
        if (session.status === "waiting_for_input") {
          const elapsed = Date.now() - (session.waitingForInputSince?.getTime() ?? 0);
          if (elapsed > DEBOUNCE_MS) {
            session.status = "idle";
            session.waitingForInputSince = undefined;
          }
        } else {
          session.status = "idle";
        }
        session.lastActivity = new Date();
        break;
      }

      case "SubagentStart":
      case "SubagentStop":
        break;
    }

    this.broadcast();
  }

  injectSession(sessionId: string): void {
    this.sessions.set(sessionId, {
      ...this.createSession(sessionId, undefined),
      status: "working",
      projectName: "pause",
    });
    this.broadcast();
  }

  removeSession(sessionId: string): void {
    this.sessions.delete(sessionId);
    this.broadcast();
  }

  refreshSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.lastActivity = new Date();
    }
  }

  getStatus(): { blocked: boolean; sessions: Session[] } {
    const sessions = this.serializeSessions();
    const working = sessions.filter(s => s.status === "working").length;
    return { blocked: working === 0, sessions };
  }

  private createSession(id: string, cwd?: string): InternalSession {
    return {
      id, status: "idle",
      projectName: cwd ? basename(cwd) : id.substring(0, 8),
      cwd, startTime: new Date(), lastActivity: new Date(),
      toolCount: 0, recentTools: [],
      inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0,
    };
  }

  private ensureSession(sessionId: string, cwd?: string): InternalSession {
    if (!this.sessions.has(sessionId)) {
      this.sessions.set(sessionId, this.createSession(sessionId, cwd));
    }
    return this.sessions.get(sessionId)!;
  }

  private serializeSessions(): Session[] {
    return Array.from(this.sessions.values()).map(s => ({
      id: s.id, status: s.status, projectName: s.projectName, cwd: s.cwd,
      startTime: s.startTime.toISOString(), lastActivity: s.lastActivity.toISOString(),
      lastTool: s.lastTool, toolCount: s.toolCount, recentTools: s.recentTools,
      waitingForInputSince: s.waitingForInputSince?.toISOString(),
      inputTokens: s.inputTokens, outputTokens: s.outputTokens,
      totalTokens: s.totalTokens, costUsd: s.costUsd,
    }));
  }

  private cleanupStaleSessions(): void {
    const now = Date.now();
    let removed = false;
    for (const [id, session] of this.sessions) {
      if (now - session.lastActivity.getTime() > SESSION_TIMEOUT_MS) {
        this.sessions.delete(id);
        removed = true;
      }
    }
    if (removed) this.broadcast();
  }

  destroy(): void {
    if (this.cleanupInterval) clearInterval(this.cleanupInterval);
    this.sessions.clear();
    this.listeners.clear();
  }
}
