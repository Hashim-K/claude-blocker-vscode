# Claude Blocker VS Code Extension — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a fully self-contained VS Code extension with an embedded blocker server, pause/suspend/pomodoro controls, sound notifications, stats tracking, and hook management — compatible with both upstream Chrome extensions.

**Architecture:** Worker thread runs an HTTP+WebSocket server implementing the claude-blocker protocol superset. Main thread manages UI (status bar, sidebar tree view), blocker control (pause/suspend via synthetic sessions), pomodoro timer, notifications (sound+toast), stats collection, and Claude Code hook setup. Communication between main and worker thread via `postMessage`.

**Tech Stack:** TypeScript, VS Code Extension API, Node.js `worker_threads`, `http`, `ws` (WebSocket), esbuild (bundler)

**Spec:** `docs/superpowers/specs/2026-03-20-claude-blocker-vscode-design.md`

---

## Task 1: Project Setup — Build System & Package Configuration

Reconfigure the scaffolded project for esbuild bundling with two entry points and add runtime dependencies.

**Files:**
- Modify: `package.json`
- Modify: `tsconfig.json`
- Create: `esbuild.mjs`
- Create: `.vscodeignore` (replace existing)

- [ ] **Step 1: Install dependencies**

```bash
npm install ws
npm install -D esbuild @types/ws
```

- [ ] **Step 2: Create esbuild config**

Create `esbuild.mjs`:

```javascript
import * as esbuild from "esbuild";

const production = process.argv.includes("--production");

/** @type {import('esbuild').BuildOptions} */
const shared = {
  bundle: true,
  minify: production,
  sourcemap: !production,
  platform: "node",
  target: "node20",
  logLevel: "info",
};

// Main extension bundle
await esbuild.build({
  ...shared,
  entryPoints: ["src/extension.ts"],
  outfile: "out/extension.js",
  format: "cjs",
  external: ["vscode"],
});

// Server worker bundle (must be self-contained, no externals)
await esbuild.build({
  ...shared,
  entryPoints: ["src/server/worker.ts"],
  outfile: "out/server-worker.js",
  format: "cjs",
});
```

- [ ] **Step 3: Update package.json**

Replace the full `package.json` with the updated version. Key changes:
- Name to `claude-blocker-vscode`
- Add `ws` dependency and `@types/ws` devDep
- Add `esbuild` devDep
- Replace `compile`/`watch` scripts with esbuild versions
- Set `activationEvents` to `["onStartupFinished"]`
- Add all commands in `contributes.commands`
- Add `contributes.configuration` for all settings
- Add `contributes.viewsContainers` and `contributes.views` for sidebar

```json
{
  "name": "claude-blocker-vscode",
  "displayName": "Claude Blocker",
  "description": "Block distracting websites when Claude Code isn't working. Pause, suspend, pomodoro, stats.",
  "version": "0.1.0",
  "engines": { "vscode": "^1.110.0" },
  "categories": ["Other"],
  "activationEvents": ["onStartupFinished"],
  "main": "./out/extension.js",
  "contributes": {
    "commands": [
      { "command": "claude-blocker.startServer", "title": "Claude Blocker: Start Server" },
      { "command": "claude-blocker.stopServer", "title": "Claude Blocker: Stop Server" },
      { "command": "claude-blocker.pause", "title": "Claude Blocker: Pause" },
      { "command": "claude-blocker.resume", "title": "Claude Blocker: Resume" },
      { "command": "claude-blocker.suspend", "title": "Claude Blocker: Suspend for X Minutes..." },
      { "command": "claude-blocker.startPomodoro", "title": "Claude Blocker: Start Pomodoro" },
      { "command": "claude-blocker.stopPomodoro", "title": "Claude Blocker: Stop Pomodoro" },
      { "command": "claude-blocker.togglePomodoro", "title": "Claude Blocker: Toggle Pomodoro" },
      { "command": "claude-blocker.toggleSound", "title": "Claude Blocker: Toggle Sound" },
      { "command": "claude-blocker.showStats", "title": "Claude Blocker: Show Stats" },
      { "command": "claude-blocker.setupHooks", "title": "Claude Blocker: Setup Hooks" },
      { "command": "claude-blocker.removeHooks", "title": "Claude Blocker: Remove Hooks" }
    ],
    "viewsContainers": {
      "activitybar": [
        {
          "id": "claude-blocker",
          "title": "Claude Blocker",
          "icon": "$(shield)"
        }
      ]
    },
    "views": {
      "claude-blocker": [
        { "id": "claude-blocker.status", "name": "Status" },
        { "id": "claude-blocker.controls", "name": "Controls" },
        { "id": "claude-blocker.stats", "name": "Stats" },
        { "id": "claude-blocker.setup", "name": "Setup" }
      ]
    },
    "configuration": {
      "title": "Claude Blocker",
      "properties": {
        "claudeBlocker.port": {
          "type": "number",
          "default": 8765,
          "description": "Server port"
        },
        "claudeBlocker.autoStart": {
          "type": "boolean",
          "default": true,
          "description": "Start server on extension activation"
        },
        "claudeBlocker.pomodoro.activeMinutes": {
          "type": "number",
          "default": 25,
          "description": "Pomodoro active phase duration (minutes)"
        },
        "claudeBlocker.pomodoro.breakMinutes": {
          "type": "number",
          "default": 5,
          "description": "Pomodoro break phase duration (minutes)"
        },
        "claudeBlocker.suspendPresets": {
          "type": "array",
          "items": { "type": "number" },
          "default": [5, 10, 15, 30],
          "description": "Suspend duration presets (minutes)"
        },
        "claudeBlocker.notifications.sound.enabled": {
          "type": "boolean",
          "default": true,
          "description": "Enable sound notifications"
        },
        "claudeBlocker.notifications.sound.volume": {
          "type": "number",
          "default": 70,
          "minimum": 0,
          "maximum": 100,
          "description": "Sound volume (0-100)"
        },
        "claudeBlocker.notifications.sound.onStopWorking": {
          "type": "string",
          "enum": ["none", "subtle", "clear", "alarm"],
          "default": "subtle",
          "description": "Sound when Claude stops working"
        },
        "claudeBlocker.notifications.sound.onWaitingForInput": {
          "type": "string",
          "enum": ["none", "subtle", "clear", "alarm"],
          "default": "subtle",
          "description": "Sound when Claude waits for input"
        },
        "claudeBlocker.notifications.sound.onPomodoroSwitch": {
          "type": "string",
          "enum": ["none", "subtle", "clear", "alarm"],
          "default": "alarm",
          "description": "Sound on pomodoro phase change"
        },
        "claudeBlocker.notifications.sound.onSuspendExpired": {
          "type": "string",
          "enum": ["none", "subtle", "clear", "alarm"],
          "default": "subtle",
          "description": "Sound when suspend timer expires"
        },
        "claudeBlocker.notifications.toast.enabled": {
          "type": "boolean",
          "default": true,
          "description": "Enable toast notifications"
        }
      }
    }
  },
  "scripts": {
    "vscode:prepublish": "node esbuild.mjs --production",
    "compile": "node esbuild.mjs",
    "watch": "node esbuild.mjs --watch",
    "pretest": "npm run compile && npm run lint",
    "lint": "eslint src",
    "test": "vscode-test"
  },
  "dependencies": {
    "ws": "^8.18.0"
  },
  "devDependencies": {
    "@types/vscode": "^1.110.0",
    "@types/mocha": "^10.0.10",
    "@types/node": "22.x",
    "@types/ws": "^8.5.13",
    "esbuild": "^0.25.0",
    "typescript-eslint": "^8.56.1",
    "eslint": "^9.39.3",
    "typescript": "^5.9.3",
    "@vscode/test-cli": "^0.0.12",
    "@vscode/test-electron": "^2.5.2"
  }
}
```

- [ ] **Step 4: Update tsconfig.json**

```json
{
  "compilerOptions": {
    "module": "Node16",
    "target": "ES2022",
    "outDir": "out",
    "lib": ["ES2022"],
    "sourceMap": true,
    "rootDir": "src",
    "strict": true,
    "skipLibCheck": true
  },
  "exclude": ["node_modules", "out"]
}
```

- [ ] **Step 5: Update .vscodeignore**

```
.vscode/**
.vscode-test/**
src/**
node_modules/**
docs/**
*.ts
*.mjs
tsconfig.json
eslint.config.mjs
.vscode-test.mjs
!out/**
!media/**
```

- [ ] **Step 6: Create placeholder source files and media directory**

Create empty placeholder files so the build works:

```
src/server/worker.ts       — export {} (placeholder)
src/server/state.ts        — export {} (placeholder)
src/server/types.ts        — export {} (placeholder)
src/blocker.ts             — export {} (placeholder)
src/pomodoro.ts            — export {} (placeholder)
src/notifications.ts       — export {} (placeholder)
src/stats.ts               — export {} (placeholder)
src/hooks.ts               — export {} (placeholder)
src/ui/statusBar.ts        — export {} (placeholder)
src/ui/sidebarProvider.ts  — export {} (placeholder)
media/sounds/              — empty directory (sounds added later)
```

- [ ] **Step 7: Verify build works**

Run: `npm run compile`
Expected: Two files produced: `out/extension.js` and `out/server-worker.js` with no errors.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat: reconfigure project for esbuild dual-bundle build"
```

---

## Task 2: Shared Types

Define all TypeScript types shared between the main thread and worker thread.

**Files:**
- Create: `src/server/types.ts`

- [ ] **Step 1: Write types**

```typescript
// --- Hook payload from Claude Code ---

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

// --- Session ---

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

// --- WebSocket messages ---

export type ServerMessage =
  | { type: "state"; blocked: boolean; sessions: Session[]; working: number; waitingForInput: number }
  | { type: "pong" };

export type ClientMessage =
  | { type: "ping" }
  | { type: "subscribe" }
  | { type: "subscribe_stats" };

// --- Worker thread messages (main <-> worker) ---

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

// --- Constants ---

export const USER_INPUT_TOOLS = ["AskUserQuestion", "ask_user", "ask_human"];
export const DEFAULT_PORT = 8765;
export const SESSION_TIMEOUT_MS = 5 * 60 * 1000;
export const DEBOUNCE_MS = 500;
export const CLEANUP_INTERVAL_MS = 30_000;
```

- [ ] **Step 2: Verify build**

Run: `npm run compile`
Expected: PASS, no errors.

- [ ] **Step 3: Commit**

```bash
git add src/server/types.ts
git commit -m "feat: add shared types for server protocol and worker messages"
```

---

## Task 3: Session State Manager

Core state logic that tracks Claude Code sessions and computes blocking state.

**Files:**
- Create: `src/server/state.ts`
- Create: `src/server/state.test.ts`

- [ ] **Step 1: Write tests for state manager**

Create `src/server/state.test.ts`. Tests should cover:
1. `SessionStart` creates an idle session
2. `UserPromptSubmit` sets session to working
3. `PreToolUse` with `AskUserQuestion` sets `waiting_for_input`
4. `Stop` sets session to idle
5. `SessionEnd` removes session
6. `blocked` is `true` when no sessions are working
7. `blocked` is `false` when at least one session is working
8. 500ms debounce: `Stop` within 500ms of `waiting_for_input` keeps status
9. Stale session cleanup removes sessions older than 5 minutes
10. `inject-session` adds a synthetic working session
11. `remove-session` removes a synthetic session
12. `PostToolUse` updates token metrics without changing status

Since we can't easily run mocha in this context without the VS Code test runner, write these as a simple Node.js test file that can be run standalone:

```typescript
// src/server/state.test.ts
// Run: npx tsx src/server/state.test.ts
import { SessionState } from "./state.js";
import { HookPayload } from "./types.js";
import assert from "node:assert";

function makePayload(overrides: Partial<HookPayload> & Pick<HookPayload, "session_id" | "hook_event_name">): HookPayload {
  return { ...overrides };
}

// Test 1: SessionStart creates idle session
{
  const state = new SessionState();
  state.handleHook(makePayload({ session_id: "s1", hook_event_name: "SessionStart", cwd: "/project" }));
  const status = state.getStatus();
  assert.strictEqual(status.sessions.length, 1);
  assert.strictEqual(status.sessions[0].status, "idle");
  assert.strictEqual(status.sessions[0].projectName, "project");
  assert.strictEqual(status.blocked, true);
  state.destroy();
  console.log("PASS: SessionStart creates idle session");
}

// Test 2: UserPromptSubmit sets working
{
  const state = new SessionState();
  state.handleHook(makePayload({ session_id: "s1", hook_event_name: "SessionStart", cwd: "/proj" }));
  state.handleHook(makePayload({ session_id: "s1", hook_event_name: "UserPromptSubmit" }));
  const status = state.getStatus();
  assert.strictEqual(status.sessions[0].status, "working");
  assert.strictEqual(status.blocked, false);
  state.destroy();
  console.log("PASS: UserPromptSubmit sets working");
}

// Test 3: PreToolUse with AskUserQuestion sets waiting_for_input
{
  const state = new SessionState();
  state.handleHook(makePayload({ session_id: "s1", hook_event_name: "SessionStart" }));
  state.handleHook(makePayload({ session_id: "s1", hook_event_name: "UserPromptSubmit" }));
  state.handleHook(makePayload({ session_id: "s1", hook_event_name: "PreToolUse", tool_name: "AskUserQuestion" }));
  assert.strictEqual(state.getStatus().sessions[0].status, "waiting_for_input");
  state.destroy();
  console.log("PASS: PreToolUse with AskUserQuestion sets waiting_for_input");
}

// Test 4: Stop sets idle
{
  const state = new SessionState();
  state.handleHook(makePayload({ session_id: "s1", hook_event_name: "SessionStart" }));
  state.handleHook(makePayload({ session_id: "s1", hook_event_name: "UserPromptSubmit" }));
  state.handleHook(makePayload({ session_id: "s1", hook_event_name: "Stop" }));
  assert.strictEqual(state.getStatus().sessions[0].status, "idle");
  assert.strictEqual(state.getStatus().blocked, true);
  state.destroy();
  console.log("PASS: Stop sets idle");
}

// Test 5: SessionEnd removes session
{
  const state = new SessionState();
  state.handleHook(makePayload({ session_id: "s1", hook_event_name: "SessionStart" }));
  state.handleHook(makePayload({ session_id: "s1", hook_event_name: "SessionEnd" }));
  assert.strictEqual(state.getStatus().sessions.length, 0);
  state.destroy();
  console.log("PASS: SessionEnd removes session");
}

// Test 6: blocked is true when no working sessions
{
  const state = new SessionState();
  state.handleHook(makePayload({ session_id: "s1", hook_event_name: "SessionStart" }));
  state.handleHook(makePayload({ session_id: "s2", hook_event_name: "SessionStart" }));
  assert.strictEqual(state.getStatus().blocked, true);
  state.destroy();
  console.log("PASS: blocked when no working sessions");
}

// Test 7: blocked is false when at least one working
{
  const state = new SessionState();
  state.handleHook(makePayload({ session_id: "s1", hook_event_name: "SessionStart" }));
  state.handleHook(makePayload({ session_id: "s2", hook_event_name: "SessionStart" }));
  state.handleHook(makePayload({ session_id: "s1", hook_event_name: "UserPromptSubmit" }));
  assert.strictEqual(state.getStatus().blocked, false);
  state.destroy();
  console.log("PASS: not blocked when one session working");
}

// Test 8: Debounce - Stop within 500ms of waiting_for_input keeps status
{
  const state = new SessionState();
  state.handleHook(makePayload({ session_id: "s1", hook_event_name: "SessionStart" }));
  state.handleHook(makePayload({ session_id: "s1", hook_event_name: "UserPromptSubmit" }));
  state.handleHook(makePayload({ session_id: "s1", hook_event_name: "PreToolUse", tool_name: "AskUserQuestion" }));
  // Immediately Stop (< 500ms)
  state.handleHook(makePayload({ session_id: "s1", hook_event_name: "Stop" }));
  assert.strictEqual(state.getStatus().sessions[0].status, "waiting_for_input");
  state.destroy();
  console.log("PASS: debounce prevents flicker on immediate Stop");
}

// Test 9: inject-session / remove-session
{
  const state = new SessionState();
  state.injectSession("vscode-pause");
  assert.strictEqual(state.getStatus().blocked, false);
  assert.strictEqual(state.getStatus().sessions[0].status, "working");
  state.removeSession("vscode-pause");
  assert.strictEqual(state.getStatus().sessions.length, 0);
  assert.strictEqual(state.getStatus().blocked, true);
  state.destroy();
  console.log("PASS: inject and remove synthetic session");
}

// Test 10: PostToolUse updates tokens without status change
{
  const state = new SessionState();
  state.handleHook(makePayload({ session_id: "s1", hook_event_name: "SessionStart" }));
  state.handleHook(makePayload({ session_id: "s1", hook_event_name: "UserPromptSubmit" }));
  state.handleHook(makePayload({ session_id: "s1", hook_event_name: "PostToolUse", input_tokens: 100, output_tokens: 50, cost_usd: 0.01 }));
  const s = state.getStatus().sessions[0];
  assert.strictEqual(s.status, "working");
  assert.strictEqual(s.inputTokens, 100);
  assert.strictEqual(s.outputTokens, 50);
  assert.strictEqual(s.costUsd, 0.01);
  state.destroy();
  console.log("PASS: PostToolUse updates tokens without status change");
}

// Test 11: Auto-creates session on hook if not started
{
  const state = new SessionState();
  state.handleHook(makePayload({ session_id: "s1", hook_event_name: "UserPromptSubmit", cwd: "/foo" }));
  assert.strictEqual(state.getStatus().sessions.length, 1);
  assert.strictEqual(state.getStatus().sessions[0].status, "working");
  state.destroy();
  console.log("PASS: auto-creates session on hook if not started");
}

console.log("\nAll tests passed!");
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx tsx src/server/state.test.ts`
Expected: FAIL (SessionState doesn't exist yet)

- [ ] **Step 3: Implement SessionState**

Create `src/server/state.ts`:

```typescript
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
    const { blocked, sessions, working, waitingForInput } = this.getStateMessage();
    for (const listener of this.listeners) {
      listener({ type: "state-change", blocked, sessions, working, waitingForInput });
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
        // Acknowledged but no state change needed in v1
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
      id,
      status: "idle",
      projectName: cwd ? basename(cwd) : id.substring(0, 8),
      cwd,
      startTime: new Date(),
      lastActivity: new Date(),
      toolCount: 0,
      recentTools: [],
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      costUsd: 0,
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
      id: s.id,
      status: s.status,
      projectName: s.projectName,
      cwd: s.cwd,
      startTime: s.startTime.toISOString(),
      lastActivity: s.lastActivity.toISOString(),
      lastTool: s.lastTool,
      toolCount: s.toolCount,
      recentTools: s.recentTools,
      waitingForInputSince: s.waitingForInputSince?.toISOString(),
      inputTokens: s.inputTokens,
      outputTokens: s.outputTokens,
      totalTokens: s.totalTokens,
      costUsd: s.costUsd,
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx tsx src/server/state.test.ts`
Expected: All 11 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/server/state.ts src/server/state.test.ts
git commit -m "feat: implement SessionState with debounce, inject/remove, token tracking"
```

---

## Task 4: Server Worker Thread

HTTP + WebSocket server running inside a worker thread.

**Files:**
- Create: `src/server/worker.ts`

- [ ] **Step 1: Implement worker thread**

```typescript
import { parentPort } from "node:worker_threads";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { SessionState } from "./state.js";
import type { HookPayload, ClientMessage, MainToWorkerMessage } from "./types.js";
import { DEFAULT_PORT } from "./types.js";

if (!parentPort) throw new Error("Must run as worker thread");

const state = new SessionState();
let port = DEFAULT_PORT;

function parseBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk: Buffer) => (body += chunk));
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

// HTTP server
const server = createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  const url = new URL(req.url || "/", `http://localhost:${port}`);

  if (req.method === "GET" && url.pathname === "/status") {
    sendJson(res, state.getStatus());
    return;
  }

  if (req.method === "GET" && url.pathname === "/history") {
    sendJson(res, { history: [] }); // v1: empty history
    return;
  }

  if (req.method === "POST" && url.pathname === "/hook") {
    try {
      const body = await parseBody(req);
      const payload = JSON.parse(body) as HookPayload;
      if (!payload.session_id || !payload.hook_event_name) {
        sendJson(res, { error: "Invalid payload" }, 400);
        return;
      }
      state.handleHook(payload);
      sendJson(res, { ok: true });
    } catch {
      sendJson(res, { error: "Invalid JSON" }, 400);
    }
    return;
  }

  if (req.method === "GET" && url.pathname === "/stats") {
    sendJson(res, { daily: {}, projects: [], totals: { tokens: {}, cost: 0, sessions: 0 } });
    return;
  }

  sendJson(res, { error: "Not found" }, 404);
});

// WebSocket server
const wss = new WebSocketServer({ server, path: "/ws" });

wss.on("connection", (ws: WebSocket) => {
  // Send current state immediately
  const { blocked, sessions } = state.getStatus();
  const working = sessions.filter(s => s.status === "working").length;
  const waitingForInput = sessions.filter(s => s.status === "waiting_for_input").length;
  ws.send(JSON.stringify({ type: "state", blocked, sessions, working, waitingForInput }));

  // Subscribe to state changes
  const unsubscribe = state.subscribe((message) => {
    if (message.type === "state-change" && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: "state",
        blocked: message.blocked,
        sessions: message.sessions,
        working: message.working,
        waitingForInput: message.waitingForInput,
      }));
    }
  });

  ws.on("message", (data) => {
    try {
      const message = JSON.parse(data.toString()) as ClientMessage;
      if (message.type === "ping") {
        ws.send(JSON.stringify({ type: "pong" }));
      }
    } catch { /* ignore */ }
  });

  ws.on("close", () => unsubscribe());
  ws.on("error", () => unsubscribe());
});

// Forward state changes to main thread
state.subscribe((message) => {
  parentPort!.postMessage(message);
});

// Handle messages from main thread
parentPort.on("message", (message: MainToWorkerMessage) => {
  switch (message.type) {
    case "inject-session":
      state.injectSession(message.sessionId);
      break;
    case "remove-session":
      state.removeSession(message.sessionId);
      break;
    case "refresh-session":
      state.refreshSession(message.sessionId);
      break;
    case "get-status":
      parentPort!.postMessage({ type: "status", ...state.getStatus() });
      break;
    case "shutdown":
      state.destroy();
      wss.close();
      server.close();
      break;
  }
});

// Start listening
server.listen(port, () => {
  parentPort!.postMessage({ type: "started", port });
});

server.on("error", (err: NodeJS.ErrnoException) => {
  parentPort!.postMessage({ type: "error", message: err.message, code: err.code });
});
```

- [ ] **Step 2: Verify build**

Run: `npm run compile`
Expected: Both bundles build successfully.

- [ ] **Step 3: Commit**

```bash
git add src/server/worker.ts
git commit -m "feat: implement server worker thread with HTTP + WebSocket"
```

---

## Task 5: Server Manager

Main-thread module that spawns and manages the worker thread.

**Files:**
- Create: `src/server.ts`

- [ ] **Step 1: Implement ServerManager**

```typescript
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
      state: this._state,
      port: this._port,
      blocked: this._blocked,
      sessions: this._sessions,
      working: this._working,
      waitingForInput: this._waitingForInput,
      error: this._error,
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
```

- [ ] **Step 2: Verify build**

Run: `npm run compile`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/server.ts
git commit -m "feat: implement ServerManager for worker thread lifecycle"
```

---

## Task 6: Hook Manager

Read/write Claude Code hooks in `~/.claude/settings.json`.

**Files:**
- Create: `src/hooks.ts`

- [ ] **Step 1: Implement hooks module**

```typescript
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

interface ClaudeSettings {
  hooks?: Record<string, unknown[]>;
  [key: string]: unknown;
}

const HOOK_EVENTS = [
  "SessionStart", "SessionEnd", "UserPromptSubmit",
  "PreToolUse", "PostToolUse", "Stop",
];

function getSettingsPath(): string {
  return join(homedir(), ".claude", "settings.json");
}

function makeHookCommand(port: number): string {
  return `curl -s -X POST http://localhost:${port}/hook -H 'Content-Type: application/json' -d "$(cat)" > /dev/null 2>&1 &`;
}

function buildHooksConfig(port: number): Record<string, unknown[]> {
  const command = makeHookCommand(port);
  const config: Record<string, unknown[]> = {};

  for (const event of HOOK_EVENTS) {
    if (event === "PreToolUse" || event === "PostToolUse") {
      config[event] = [{ matcher: "*", hooks: [{ type: "command", command }] }];
    } else {
      config[event] = [{ hooks: [{ type: "command", command }] }];
    }
  }
  return config;
}

export function areHooksConfigured(port: number): "installed" | "wrong-port" | "not-installed" {
  const settingsPath = getSettingsPath();
  if (!existsSync(settingsPath)) return "not-installed";

  try {
    const content = readFileSync(settingsPath, "utf-8");
    const settings: ClaudeSettings = JSON.parse(content);
    if (!settings.hooks) return "not-installed";

    const hasAny = HOOK_EVENTS.some(e => e in settings.hooks!);
    if (!hasAny) return "not-installed";

    // Check if port matches
    const hookStr = JSON.stringify(settings.hooks);
    if (hookStr.includes(`localhost:${port}/hook`)) return "installed";
    return "wrong-port";
  } catch {
    return "not-installed";
  }
}

export function setupHooks(port: number): void {
  const claudeDir = join(homedir(), ".claude");
  const settingsPath = join(claudeDir, "settings.json");

  if (!existsSync(claudeDir)) {
    mkdirSync(claudeDir, { recursive: true });
  }

  let settings: ClaudeSettings = {};
  if (existsSync(settingsPath)) {
    try {
      settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
    } catch { /* start fresh */ }
  }

  settings.hooks = { ...settings.hooks, ...buildHooksConfig(port) };
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
}

export function removeHooks(): void {
  const settingsPath = getSettingsPath();
  if (!existsSync(settingsPath)) return;

  try {
    const settings: ClaudeSettings = JSON.parse(readFileSync(settingsPath, "utf-8"));
    if (!settings.hooks) return;

    for (const event of HOOK_EVENTS) {
      delete settings.hooks[event];
    }
    if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  } catch { /* ignore */ }
}
```

- [ ] **Step 2: Verify build**

Run: `npm run compile`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/hooks.ts
git commit -m "feat: implement hook manager with configurable port templating"
```

---

## Task 7: Blocker Control (Pause/Resume/Suspend)

**Files:**
- Create: `src/blocker.ts`

- [ ] **Step 1: Implement Blocker**

```typescript
import type { ServerManager } from "./server.js";

const PAUSE_SESSION_ID = "vscode-pause";
const KEEPALIVE_INTERVAL_MS = 3 * 60 * 1000; // 3 minutes

export type BlockerState = "active" | "paused" | "suspended";

export class Blocker {
  private _state: BlockerState = "active";
  private keepaliveTimer: ReturnType<typeof setInterval> | null = null;
  private suspendTimer: ReturnType<typeof setTimeout> | null = null;
  private _suspendRemaining = 0;
  private _suspendEnd = 0;
  private countdownTimer: ReturnType<typeof setInterval> | null = null;
  private listeners = new Set<() => void>();
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

  private notify(): void {
    for (const l of this.listeners) l();
  }

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
```

- [ ] **Step 2: Verify build**

Run: `npm run compile`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/blocker.ts
git commit -m "feat: implement blocker with pause, resume, and timed suspend"
```

---

## Task 8: Pomodoro Timer

**Files:**
- Create: `src/pomodoro.ts`

- [ ] **Step 1: Implement Pomodoro**

```typescript
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

  private notify(): void {
    for (const l of this.listeners) l();
  }

  start(): void {
    if (this._running) return;
    this._running = true;
    this.startPhase("active");
  }

  stop(): void {
    if (!this._running) return;
    this.clearTimers();
    if (this._phase === "break") {
      this.blocker.resume();
    }
    this._running = false;
    this.notify();
  }

  toggle(): void {
    if (this._running) this.stop(); else this.start();
  }

  updateSettings(activeMinutes: number, breakMinutes: number): void {
    this.activeMs = activeMinutes * 60_000;
    this.breakMs = breakMinutes * 60_000;
  }

  private startPhase(phase: PomodoroPhase): void {
    this.clearTimers();
    this._phase = phase;
    const duration = phase === "active" ? this.activeMs : this.breakMs;
    this.phaseEnd = Date.now() + duration;

    if (phase === "break") {
      this.blocker.pause();
    } else {
      this.blocker.resume();
    }

    for (const l of this.phaseChangeListeners) l(phase);

    this.phaseTimer = setTimeout(() => {
      const next = phase === "active" ? "break" : "active";
      this.startPhase(next);
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
```

- [ ] **Step 2: Verify build**

Run: `npm run compile`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/pomodoro.ts
git commit -m "feat: implement pomodoro timer with configurable splits"
```

---

## Task 9: Notification Manager (Sound + Toast)

**Files:**
- Create: `src/notifications.ts`
- Create: `media/sounds/` (placeholder directory — actual `.mp3` files to be sourced)

- [ ] **Step 1: Implement NotificationManager**

```typescript
import * as vscode from "vscode";
import { execFile } from "node:child_process";
import { join } from "node:path";
import { platform } from "node:os";

export type SoundStyle = "none" | "subtle" | "clear" | "alarm";

export class NotificationManager {
  private extensionPath: string;
  private _soundEnabled = true;

  constructor(extensionPath: string) {
    this.extensionPath = extensionPath;
    this._soundEnabled = vscode.workspace.getConfiguration("claudeBlocker.notifications.sound").get("enabled", true);
  }

  get soundEnabled(): boolean { return this._soundEnabled; }

  toggleSound(): void {
    this._soundEnabled = !this._soundEnabled;
    vscode.workspace.getConfiguration("claudeBlocker.notifications.sound").update("enabled", this._soundEnabled, true);
  }

  private getSoundSetting(key: string): SoundStyle {
    return vscode.workspace.getConfiguration("claudeBlocker.notifications.sound").get(key, "none") as SoundStyle;
  }

  private getToastEnabled(): boolean {
    return vscode.workspace.getConfiguration("claudeBlocker.notifications.toast").get("enabled", true);
  }

  private getVolume(): number {
    return vscode.workspace.getConfiguration("claudeBlocker.notifications.sound").get("volume", 70);
  }

  async onStopWorking(): Promise<void> {
    await this.playSound(this.getSoundSetting("onStopWorking"));
    if (this.getToastEnabled()) {
      vscode.window.showInformationMessage("Claude finished — sites are now blocked", "Pause for 5 min").then(action => {
        if (action === "Pause for 5 min") {
          vscode.commands.executeCommand("claude-blocker.suspend");
        }
      });
    }
  }

  async onWaitingForInput(): Promise<void> {
    await this.playSound(this.getSoundSetting("onWaitingForInput"));
    if (this.getToastEnabled()) {
      vscode.window.showInformationMessage("Claude is waiting for your input");
    }
  }

  async onPomodoroSwitch(phase: "active" | "break"): Promise<void> {
    await this.playSound(this.getSoundSetting("onPomodoroSwitch"));
    if (this.getToastEnabled()) {
      const msg = phase === "break" ? "Pomodoro break — take a rest!" : "Break over — back to work!";
      vscode.window.showInformationMessage(msg);
    }
  }

  async onSuspendExpired(): Promise<void> {
    await this.playSound(this.getSoundSetting("onSuspendExpired"));
    if (this.getToastEnabled()) {
      vscode.window.showInformationMessage("Suspend expired — sites are now blocked");
    }
  }

  async onServerStopped(): Promise<void> {
    if (this.getToastEnabled()) {
      vscode.window.showWarningMessage("Claude Blocker server stopped unexpectedly", "Restart").then(action => {
        if (action === "Restart") {
          vscode.commands.executeCommand("claude-blocker.startServer");
        }
      });
    }
  }

  private async playSound(style: SoundStyle): Promise<void> {
    if (!this._soundEnabled || style === "none") return;

    const soundFile = join(this.extensionPath, "media", "sounds", `${style}.mp3`);
    const volume = this.getVolume();

    try {
      const os = platform();
      if (os === "darwin") {
        execFile("afplay", ["-v", String(volume / 100), soundFile]);
      } else if (os === "linux") {
        // Try paplay first (PulseAudio), fall back to aplay
        execFile("paplay", [soundFile], (err) => {
          if (err) execFile("aplay", [soundFile]);
        });
      } else if (os === "win32") {
        execFile("powershell", [
          "-c",
          `(New-Object Media.SoundPlayer '${soundFile}').PlaySync()`,
        ]);
      }
    } catch {
      // Sound playback is best-effort
    }
  }

  dispose(): void {}
}
```

- [ ] **Step 2: Create media/sounds directory with placeholder**

Create `media/sounds/.gitkeep` (actual sound files need to be sourced — use royalty-free chime/alarm sounds, keep each under 50KB).

Note for implementer: Source 3 short `.mp3` files:
- `subtle.mp3` — soft chime (~1s)
- `clear.mp3` — distinct tone (~1s)
- `alarm.mp3` — attention-grabbing (~2s)

Free sources: freesound.org (CC0), pixabay.com/sound-effects (free license). Download and place in `media/sounds/`.

- [ ] **Step 3: Verify build**

Run: `npm run compile`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/notifications.ts media/
git commit -m "feat: implement notification manager with cross-platform sound playback"
```

---

## Task 10: Stats Tracker

**Files:**
- Create: `src/stats.ts`

- [ ] **Step 1: Implement StatsTracker**

```typescript
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
      const wasBlocked = this.lastBlocked;
      this.lastBlocked = status.blocked && status.state === "running";

      // Count new sessions
      if (status.state === "running" && !status.blocked && wasBlocked) {
        // Transition from blocked to unblocked means a session started working
      }
    });

    this.timer = setInterval(() => this.tick(), 1000);
  }

  private tick(): void {
    const now = Date.now();
    const elapsed = now - this.lastTick;
    this.lastTick = now;

    const key = dateKey();
    const stats = this.getDay(key);

    if (this.lastBlocked) {
      stats.blockingMs += elapsed;
    } else {
      stats.unblockedMs += elapsed;
    }

    this.globalState.update(`stats.${key}`, stats);
    for (const l of this.listeners) l();
  }

  getDay(key?: string): DailyStats {
    const k = key || dateKey();
    return this.globalState.get<DailyStats>(`stats.${k}`, {
      blockingMs: 0, unblockedMs: 0, sessionCount: 0, pomodoroCount: 0, pauseCount: 0,
    });
  }

  getToday(): DailyStats { return this.getDay(); }

  getAllTimeKeys(): string[] {
    // globalState doesn't support listing keys, so we track them
    const keys = this.globalState.get<string[]>("stats.__keys__", []);
    const today = dateKey();
    if (!keys.includes(today)) {
      keys.push(today);
      this.globalState.update("stats.__keys__", keys);
    }
    return keys;
  }

  getAllTime(): { blockingMs: number; unblockedMs: number; sessionCount: number; pomodoroCount: number; days: number } {
    const keys = this.getAllTimeKeys();
    let blockingMs = 0, unblockedMs = 0, sessionCount = 0, pomodoroCount = 0;
    for (const key of keys) {
      const d = this.getDay(key);
      blockingMs += d.blockingMs;
      unblockedMs += d.unblockedMs;
      sessionCount += d.sessionCount;
      pomodoroCount += d.pomodoroCount;
    }
    return { blockingMs, unblockedMs, sessionCount, pomodoroCount, days: keys.length };
  }

  recordSession(): void {
    const key = dateKey();
    const stats = this.getDay(key);
    stats.sessionCount++;
    this.globalState.update(`stats.${key}`, stats);
  }

  recordPomodoro(): void {
    const key = dateKey();
    const stats = this.getDay(key);
    stats.pomodoroCount++;
    this.globalState.update(`stats.${key}`, stats);
  }

  recordPause(): void {
    const key = dateKey();
    const stats = this.getDay(key);
    stats.pauseCount++;
    this.globalState.update(`stats.${key}`, stats);
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
```

- [ ] **Step 2: Verify build**

Run: `npm run compile`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/stats.ts
git commit -m "feat: implement stats tracker with daily aggregates and persistence"
```

---

## Task 11: Status Bar UI

**Files:**
- Create: `src/ui/statusBar.ts`

- [ ] **Step 1: Implement StatusBar**

```typescript
import * as vscode from "vscode";
import type { ServerManager } from "../server.js";
import type { Blocker } from "../blocker.js";
import type { Pomodoro } from "../pomodoro.js";

function formatTime(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${min}:${String(sec).padStart(2, "0")}`;
}

export class StatusBar {
  private item: vscode.StatusBarItem;
  private unsubs: (() => void)[] = [];

  constructor(server: ServerManager, blocker: Blocker, pomodoro: Pomodoro) {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    this.item.command = "claude-blocker.quickPick";
    this.item.show();

    const update = () => this.update(server, blocker, pomodoro);
    this.unsubs.push(server.onStateChange(update));
    this.unsubs.push(blocker.onChange(update));
    this.unsubs.push(pomodoro.onChange(update));
    update();
  }

  private update(server: ServerManager, blocker: Blocker, pomodoro: Pomodoro): void {
    const s = server.status;

    if (s.state !== "running") {
      this.item.text = "$(error) Stopped";
      this.item.tooltip = s.error || "Server not running";
      this.item.backgroundColor = new vscode.ThemeColor("statusBarItem.errorBackground");
      return;
    }

    this.item.backgroundColor = undefined;

    const pomState = pomodoro.state;
    if (pomState.running) {
      const label = pomState.phase === "active" ? "Focus" : "Break";
      this.item.text = `$(clock) ${label} ${formatTime(pomState.remaining)}`;
      this.item.tooltip = `Pomodoro: ${label} phase`;
      return;
    }

    if (blocker.state === "suspended") {
      this.item.text = `$(clock) Paused (${formatTime(blocker.suspendRemaining)})`;
      this.item.tooltip = "Suspended — sites unblocked";
      return;
    }

    if (blocker.state === "paused") {
      this.item.text = "$(debug-pause) Paused";
      this.item.tooltip = "Paused — sites unblocked";
      return;
    }

    if (s.working > 0) {
      this.item.text = `$(play) Working (${s.working})`;
      this.item.tooltip = `${s.working} session(s) working — sites unblocked`;
      return;
    }

    if (s.waitingForInput > 0) {
      this.item.text = "$(edit) Waiting";
      this.item.tooltip = "Claude waiting for input — sites blocked";
      return;
    }

    this.item.text = "$(shield) Blocking";
    this.item.tooltip = `${s.sessions.length} session(s) idle — sites blocked`;
  }

  dispose(): void {
    for (const u of this.unsubs) u();
    this.item.dispose();
  }
}
```

- [ ] **Step 2: Verify build**

Run: `npm run compile`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/ui/statusBar.ts
git commit -m "feat: implement status bar with live state display"
```

---

## Task 12: Sidebar Tree View

**Files:**
- Create: `src/ui/sidebarProvider.ts`

- [ ] **Step 1: Implement SidebarProvider**

Create a `TreeDataProvider` that renders four sections (Status, Controls, Stats, Setup) as top-level items with children. Each leaf item can have a command attached.

Key implementation details:
- Uses `vscode.TreeItem` with `collapsibleState` for sections
- Control items use inline commands (e.g., clicking "Pause" runs `claude-blocker.pause`)
- Stats items display formatted time/counts
- Setup section shows hook status with install/remove actions
- Listens to server, blocker, pomodoro, and stats state changes to refresh the tree

This is the largest UI file. Implement a `SidebarProvider` class that implements `vscode.TreeDataProvider<SidebarItem>`. Use an `EventEmitter` to fire `onDidChangeTreeData` when any state changes.

- [ ] **Step 2: Verify build**

Run: `npm run compile`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/ui/sidebarProvider.ts
git commit -m "feat: implement sidebar tree view with status, controls, stats, setup"
```

---

## Task 13: Extension Entry Point — Wire Everything Together

**Files:**
- Modify: `src/extension.ts`

- [ ] **Step 1: Rewrite extension.ts**

Wire all modules together in `activate()`:

```typescript
import * as vscode from "vscode";
import { ServerManager } from "./server.js";
import { Blocker } from "./blocker.js";
import { Pomodoro } from "./pomodoro.js";
import { NotificationManager } from "./notifications.js";
import { StatsTracker } from "./stats.js";
import { StatusBar } from "./ui/statusBar.js";
import { SidebarProvider } from "./ui/sidebarProvider.js";
import { areHooksConfigured, setupHooks, removeHooks } from "./hooks.js";

export function activate(context: vscode.ExtensionContext) {
  const config = vscode.workspace.getConfiguration("claudeBlocker");
  const port = config.get<number>("port", 8765);
  const autoStart = config.get<boolean>("autoStart", true);
  const activeMin = config.get<number>("pomodoro.activeMinutes", 25);
  const breakMin = config.get<number>("pomodoro.breakMinutes", 5);

  const server = new ServerManager(context.extensionPath, port);
  const blocker = new Blocker(server);
  const pomodoro = new Pomodoro(blocker, activeMin, breakMin);
  const notifications = new NotificationManager(context.extensionPath);
  const stats = new StatsTracker(context.globalState, server);
  const statusBar = new StatusBar(server, blocker, pomodoro);
  const sidebar = new SidebarProvider(server, blocker, pomodoro, stats, port);

  // Register tree views
  vscode.window.registerTreeDataProvider("claude-blocker.status", sidebar);
  vscode.window.registerTreeDataProvider("claude-blocker.controls", sidebar);
  vscode.window.registerTreeDataProvider("claude-blocker.stats", sidebar);
  vscode.window.registerTreeDataProvider("claude-blocker.setup", sidebar);

  // Track previous state for notification triggers
  let prevWorking = 0;
  let prevWaiting = 0;
  server.onStateChange((status) => {
    if (status.state !== "running") return;
    // Went from working to not working
    if (prevWorking > 0 && status.working === 0 && blocker.state === "active") {
      notifications.onStopWorking();
    }
    // Went from not waiting to waiting
    if (prevWaiting === 0 && status.waitingForInput > 0) {
      notifications.onWaitingForInput();
    }
    prevWorking = status.working;
    prevWaiting = status.waitingForInput;
  });

  // Pomodoro notifications
  pomodoro.onPhaseChange((phase) => {
    notifications.onPomodoroSwitch(phase);
    if (phase === "active") stats.recordPomodoro();
  });

  // Register commands
  const commands: [string, () => void][] = [
    ["claude-blocker.startServer", () => server.start()],
    ["claude-blocker.stopServer", () => server.stop()],
    ["claude-blocker.pause", () => { blocker.pause(); stats.recordPause(); }],
    ["claude-blocker.resume", () => blocker.resume()],
    ["claude-blocker.suspend", async () => {
      const presets = config.get<number[]>("suspendPresets", [5, 10, 15, 30]);
      const items = [...presets.map(m => ({ label: `${m} minutes`, value: m })), { label: "Custom...", value: -1 }];
      const picked = await vscode.window.showQuickPick(items, { placeHolder: "Suspend for how long?" });
      if (!picked) return;
      let minutes = picked.value;
      if (minutes === -1) {
        const input = await vscode.window.showInputBox({ prompt: "Minutes", validateInput: v => isNaN(Number(v)) ? "Enter a number" : null });
        if (!input) return;
        minutes = Number(input);
      }
      blocker.suspend(minutes);
      stats.recordPause();
    }],
    ["claude-blocker.startPomodoro", () => pomodoro.start()],
    ["claude-blocker.stopPomodoro", () => pomodoro.stop()],
    ["claude-blocker.togglePomodoro", () => pomodoro.toggle()],
    ["claude-blocker.toggleSound", () => {
      notifications.toggleSound();
      vscode.window.showInformationMessage(`Sound ${notifications.soundEnabled ? "enabled" : "disabled"}`);
    }],
    ["claude-blocker.showStats", () => {
      const today = stats.getToday();
      const all = stats.getAllTime();
      const fmt = (ms: number) => `${Math.floor(ms / 60000)}m`;
      vscode.window.showInformationMessage(
        `Today: ${fmt(today.blockingMs)} blocked, ${today.sessionCount} sessions, ${today.pomodoroCount} pomodoros | ` +
        `All time: ${fmt(all.blockingMs)} blocked, ${all.sessionCount} sessions over ${all.days} days`
      );
    }],
    ["claude-blocker.setupHooks", () => {
      setupHooks(port);
      vscode.window.showInformationMessage("Claude Blocker hooks installed");
      sidebar.refresh();
    }],
    ["claude-blocker.removeHooks", () => {
      removeHooks();
      vscode.window.showInformationMessage("Claude Blocker hooks removed");
      sidebar.refresh();
    }],
    ["claude-blocker.quickPick", async () => {
      const isPaused = blocker.state !== "active";
      const isPom = pomodoro.state.running;
      const items = [
        isPaused ? { label: "$(play) Resume", cmd: "claude-blocker.resume" }
                 : { label: "$(debug-pause) Pause", cmd: "claude-blocker.pause" },
        { label: "$(clock) Suspend for X minutes...", cmd: "claude-blocker.suspend" },
        isPom ? { label: "$(primitive-square) Stop Pomodoro", cmd: "claude-blocker.stopPomodoro" }
              : { label: "$(clock) Start Pomodoro", cmd: "claude-blocker.startPomodoro" },
        { label: "$(graph) Show Stats", cmd: "claude-blocker.showStats" },
      ];
      const picked = await vscode.window.showQuickPick(items, { placeHolder: "Claude Blocker" });
      if (picked) vscode.commands.executeCommand(picked.cmd);
    }],
  ];

  for (const [id, handler] of commands) {
    context.subscriptions.push(vscode.commands.registerCommand(id, handler));
  }

  // Listen for config changes
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(e => {
    if (e.affectsConfiguration("claudeBlocker.pomodoro")) {
      pomodoro.updateSettings(
        config.get<number>("pomodoro.activeMinutes", 25),
        config.get<number>("pomodoro.breakMinutes", 5),
      );
    }
  }));

  // Auto-start
  if (autoStart) server.start();

  // Check hooks on startup
  const hookStatus = areHooksConfigured(port);
  if (hookStatus === "not-installed") {
    vscode.window.showInformationMessage(
      "Claude Blocker needs to configure Claude Code hooks.",
      "Set up now"
    ).then(action => {
      if (action === "Set up now") {
        setupHooks(port);
        vscode.window.showInformationMessage("Hooks installed!");
        sidebar.refresh();
      }
    });
  } else if (hookStatus === "wrong-port") {
    vscode.window.showWarningMessage(
      `Claude Blocker hooks are configured for a different port. Update to port ${port}?`,
      "Update"
    ).then(action => {
      if (action === "Update") {
        setupHooks(port);
        sidebar.refresh();
      }
    });
  }

  // Disposables
  context.subscriptions.push({ dispose: () => {
    statusBar.dispose();
    pomodoro.dispose();
    blocker.dispose();
    stats.dispose();
    notifications.dispose();
    server.dispose();
  }});
}

export function deactivate() {}
```

- [ ] **Step 2: Verify build**

Run: `npm run compile`
Expected: Both bundles build with no errors.

- [ ] **Step 3: Commit**

```bash
git add src/extension.ts
git commit -m "feat: wire all modules together in extension entry point"
```

---

## Task 14: End-to-End Smoke Test

Manually verify the extension works in VS Code.

- [ ] **Step 1: Build**

Run: `npm run compile`

- [ ] **Step 2: Launch extension host**

Press F5 in VS Code (uses the existing `.vscode/launch.json` which should launch an Extension Development Host).

- [ ] **Step 3: Verify server starts**

Check Output panel and status bar shows "$(shield) Blocking".

- [ ] **Step 4: Test pause/resume**

Run "Claude Blocker: Pause" from command palette. Status bar should show "$(debug-pause) Paused". Run "Claude Blocker: Resume" — should return to "$(shield) Blocking".

- [ ] **Step 5: Test suspend**

Run "Claude Blocker: Suspend for X Minutes...". Pick 1 minute. Status bar should show countdown. Wait for it to expire.

- [ ] **Step 6: Test pomodoro**

Run "Claude Blocker: Start Pomodoro". Status bar should show "Focus" with countdown.

- [ ] **Step 7: Test hook via curl**

```bash
curl -X POST http://localhost:8765/hook \
  -H "Content-Type: application/json" \
  -d '{"session_id":"test-1","hook_event_name":"SessionStart","cwd":"/tmp/project"}'

curl -X POST http://localhost:8765/hook \
  -H "Content-Type: application/json" \
  -d '{"session_id":"test-1","hook_event_name":"UserPromptSubmit"}'
```

Status bar should show "$(play) Working (1)".

```bash
curl -X POST http://localhost:8765/hook \
  -H "Content-Type: application/json" \
  -d '{"session_id":"test-1","hook_event_name":"Stop"}'
```

Should return to "$(shield) Blocking".

- [ ] **Step 8: Test sidebar**

Open the Claude Blocker sidebar panel. Verify Status, Controls, Stats, and Setup sections render.

- [ ] **Step 9: Test hooks setup**

Run "Claude Blocker: Setup Hooks". Verify `~/.claude/settings.json` has the hook entries.

- [ ] **Step 10: Commit any fixes**

```bash
git add -A
git commit -m "fix: address issues found during smoke testing"
```

---

## Task 15: Sound Files & Polish

- [ ] **Step 1: Source and add sound files**

Download 3 short royalty-free sounds (CC0 or equivalent license):
- `media/sounds/subtle.mp3` — soft chime, ~1 second
- `media/sounds/clear.mp3` — distinct notification tone, ~1 second
- `media/sounds/alarm.mp3` — attention-grabbing alert, ~2 seconds

Sources: freesound.org (CC0 filter), pixabay.com/sound-effects

- [ ] **Step 2: Test sound playback**

In the Extension Development Host, run "Claude Blocker: Pause" and verify a sound plays (if `onSuspendExpired` or similar triggers). Test `toggleSound` command.

- [ ] **Step 3: Commit**

```bash
git add media/sounds/
git commit -m "feat: add notification sound files"
```

---

## Task 16: Package & Verify

- [ ] **Step 1: Install vsce**

```bash
npm install -D @vscode/vsce
```

- [ ] **Step 2: Build production bundle**

```bash
npm run vscode:prepublish
```

- [ ] **Step 3: Package as .vsix**

```bash
npx vsce package --no-dependencies
```

Expected: Produces a `.vsix` file.

- [ ] **Step 4: Verify .vsix contents**

```bash
npx vsce ls --no-dependencies
```

Verify it includes: `out/extension.js`, `out/server-worker.js`, `media/sounds/*.mp3`, `package.json`.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "chore: add vsce packaging and production build"
```
