export interface HookPayload {
  session_id: string;
  hook_event_name:
    | "UserPromptSubmit" | "PreToolUse" | "PostToolUse"
    | "Stop" | "SessionStart" | "SessionEnd"
    | "SubagentStart" | "SubagentStop";
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  cwd?: string;
  transcript_path?: string;
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  cost_usd?: number;
  agent_id?: string;
  agent_type?: string;
  agent_transcript_path?: string;
}

export interface ToolCall {
  name: string;
  timestamp: string;
  input?: { file_path?: string; command?: string; pattern?: string; description?: string };
}

export interface Session {
  id: string;
  status: "idle" | "working" | "waiting_for_input";
  projectName: string;
  cwd?: string;
  startTime: string;
  lastActivity: string;
  lastTool?: string;
  toolCount: number;
  recentTools: ToolCall[];
  waitingForInputSince?: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number;
}

export type ServerMessage =
  | { type: "state"; blocked: boolean; sessions: Session[]; working: number; waitingForInput: number }
  | { type: "pong" };

export type ClientMessage =
  | { type: "ping" }
  | { type: "subscribe" }
  | { type: "subscribe_stats" };

export type MainToWorkerMessage =
  | { type: "inject-session"; sessionId: string }
  | { type: "remove-session"; sessionId: string }
  | { type: "refresh-session"; sessionId: string }
  | { type: "get-status" }
  | { type: "shutdown" };

export type WorkerToMainMessage =
  | { type: "started"; port: number }
  | { type: "error"; message: string; code?: string }
  | { type: "state-change"; blocked: boolean; sessions: Session[]; working: number; waitingForInput: number }
  | { type: "session-event"; event: "start" | "end"; sessionId: string }
  | { type: "status"; blocked: boolean; sessions: Session[] };

export const USER_INPUT_TOOLS = ["AskUserQuestion", "ask_user", "ask_human"];
export const DEFAULT_PORT = 8765;
export const SESSION_TIMEOUT_MS = 5 * 60 * 1000;
export const DEBOUNCE_MS = 500;
export const CLEANUP_INTERVAL_MS = 30_000;
