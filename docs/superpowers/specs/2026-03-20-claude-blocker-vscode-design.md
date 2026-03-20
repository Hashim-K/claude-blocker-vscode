# Claude Blocker VS Code Extension — Design Spec

## Overview

A fully self-contained VS Code extension that runs an embedded blocker server (as a worker thread), providing a complete UI for controlling website blocking, pause/suspend/pomodoro modes, stats tracking, and Claude Code hook management. Compatible with both the [original Chrome extension](https://github.com/T3-Content/claude-blocker) and the [advanced fork](https://github.com/genesiscz/claude-blocker-advanced) — no modifications to either.

## Architecture

```text
┌──────────────────────────────────────────────────┐
│  VS Code Extension (single install, zero deps)   │
│                                                  │
│  ┌──────────┐  ┌──────────┐  ┌───────────┐      │
│  │ Server   │  │ Blocker  │  │ Pomodoro  │      │
│  │ Manager  │  │ Control  │  │ Timer     │      │
│  └────┬─────┘  └────┬─────┘  └─────┬─────┘      │
│       │              │              │            │
│  ┌────▼──────────────▼──────────────▼──────────┐ │
│  │  Embedded server (Worker Thread)            │ │
│  │  HTTP :8765 + WebSocket /ws                 │ │
│  │  Own implementation of claude-blocker       │ │
│  │  protocol (superset of both versions)       │ │
│  └─────────────────────────────────────────────┘ │
│                                                  │
│  ┌──────────┐  ┌──────────┐  ┌───────────┐      │
│  │ Status   │  │ Sidebar  │  │ Stats     │      │
│  │ Bar Item │  │ TreeView │  │ Tracker   │      │
│  └──────────┘  └──────────┘  └───────────┘      │
└──────────────────────────────────────────────────┘
         ▲                    │
    POST /hook            WebSocket
         │                    ▼
   Claude Code       Chrome Extension
   (via hooks)       (original OR advanced)
```

### Key Decisions

**Embedded worker thread, not child process or in-process:** The server runs as a Node.js `worker_threads` Worker inside VS Code's own runtime. `process.exit()` in a worker only kills the worker, not the extension host. `worker.terminate()` provides clean shutdown. No external Node.js, npx, or npm packages required. Zero user-facing dependencies.

**Own server implementation:** Rather than importing from either upstream package (which brings ESM/CJS issues, hardcoded ports, `process.exit` handlers, and coupling to one version), we implement our own server that speaks the **superset** of both protocols. This means either Chrome extension works out of the box.

**Protocol compatibility (superset):** Both Chrome extensions connect via the same WebSocket and expect `{ type: "state", blocked, ... }` messages. Our server sends:
- For the original extension: `sessions` as a count, `working`, `waitingForInput`
- For the advanced extension: `sessions` as a full `Session[]` array, `working`, `waitingForInput`, plus stats endpoints (`GET /stats`, `GET /history`, etc.)

Both extensions ignore fields they don't recognize, so a superset response works for both.

**Pause via fake hooks (internal):** Since we own the server, the blocker control module calls the server's state manager directly via `parentPort` messages (no HTTP round-trip needed). But the mechanism is the same: inject/remove a synthetic "working" session.

**Custom hook management:** The extension implements its own hook setup with configurable port templating.

## Server Protocol

### Endpoints (HTTP)

| Method | Path | Purpose | Compat |
| --- | --- | --- | --- |
| `GET` | `/status` | Health check, returns `{ blocked, sessions[] }` | Both |
| `POST` | `/hook` | Receives Claude Code hook payloads | Both |
| `GET` | `/history` | Session history (ended sessions) | Advanced |
| `GET` | `/stats` | Daily stats, project breakdown, totals | Advanced |
| `GET` | `/stats/:date` | Stats for a specific date | Advanced |
| `GET` | `/stats/range?dates=...` | Stats for date range | Advanced |

### WebSocket Messages (server → client)

**State broadcast** (sent on every state change):

```typescript
{
  type: "state",
  blocked: boolean,           // true when working === 0
  sessions: Session[],        // full session objects (advanced needs this)
  working: number,            // count of working sessions
  waitingForInput: number,    // count of waiting sessions
}
```

The original Chrome extension reads `sessions` as a number (it uses `.sessions` which evaluates to the array length in its comparisons) or ignores extra fields — both are safe.

**Pong** (response to ping):

```typescript
{ type: "pong" }
```

### WebSocket Messages (client → server)

```typescript
{ type: "ping" }
{ type: "subscribe" }
{ type: "subscribe_stats" }  // advanced only
```

### Hook Payload (POST /hook)

```typescript
interface HookPayload {
  session_id: string;
  hook_event_name:
    | "UserPromptSubmit" | "PreToolUse" | "PostToolUse"
    | "Stop" | "SessionStart" | "SessionEnd"
    | "SubagentStart" | "SubagentStop";
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  cwd?: string;
  transcript_path?: string;
  // Advanced fields (token/cost tracking)
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  cost_usd?: number;
  // Subagent fields
  agent_id?: string;
  agent_type?: string;
  agent_transcript_path?: string;
}
```

### Session Object

```typescript
interface Session {
  id: string;
  status: "idle" | "working" | "waiting_for_input";
  projectName: string;
  cwd?: string;
  startTime: string;       // ISO string
  lastActivity: string;    // ISO string
  lastTool?: string;
  toolCount: number;
  recentTools: ToolCall[];
  // Token tracking (populated when available)
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number;
}
```

### State Logic

Session status transitions (same as upstream):
- `SessionStart` → create session, status `"idle"`
- `UserPromptSubmit` → status `"working"`
- `PreToolUse` → status `"working"` (or `"waiting_for_input"` if tool is in `USER_INPUT_TOOLS`)
- `Stop` → status `"idle"`
- `SessionEnd` → remove session

Blocking: `blocked = (working === 0)` — broadcast on every state change.

Stale session cleanup: every 30 seconds, remove sessions with no activity for 5 minutes.

## Modules

### 1. Server Manager

Manages the embedded worker thread server.

- Spawns a `Worker` from `worker_threads` running the bundled server script
- Communicates with the worker via `parentPort`/`postMessage` for direct state access (pause/resume, stats queries)
- Starts automatically on extension activation if `claudeBlocker.autoStart` is `true`
- Detects port conflicts: if port is already in use, shows an error with option to change port
- Monitors worker health — restarts on unexpected exit
- Gracefully shuts down on extension deactivation via `worker.terminate()`
- Exposes server running state to other modules

### 2. Blocker Control

Manages pause, suspend, and resume.

- **Pause**: Sends a message to the worker thread to inject a synthetic session with ID `"vscode-pause"` in `"working"` status. The server broadcasts the updated state, Chrome extension sees `working > 0` and unblocks. The server's stale session cleanup would remove it after 5 minutes, so the worker refreshes `lastActivity` on the synthetic session every ~3 minutes.
- **Resume**: Sends a message to the worker to remove the synthetic session. Blocking resumes.
- **Suspend for X minutes**: Same as pause but with a timer. Auto-resumes when the timer expires. Presets: 5, 10, 15, 30 minutes (configurable) plus custom input. Countdown displayed in the status bar.

### 3. Pomodoro Timer

Alternates between active (blocking) and break (unblocked) phases.

- **Active phase** (default 25 min): Blocking works normally. Real Claude sessions still unblock as usual.
- **Break phase** (default 5 min): Uses the same synthetic session injection as pause to force unblock.
- Status bar shows current phase and countdown (e.g., `$(clock) Pomodoro 18:22`).
- Notification when phase switches.
- Edge case: if Claude is genuinely working during a break, sites are already unblocked — no conflict. When break ends, the synthetic session is removed and real sessions control blocking normally.

### 4. Stats Tracker

Collects usage statistics via direct communication with the worker thread (no HTTP/WebSocket overhead since they're in the same process).

The worker thread sends state change events to the main thread via `postMessage`. A 1-second interval timer in the main thread computes running time counters based on the last known state.

**Data collected (daily aggregates keyed by date string):**

- Blocking time: total time sites were blocked (server running, `working === 0`, not paused)
- Unblocked time: time spent unblocked
- Session count: number of Claude Code sessions observed
- Session durations: for computing average session length
- Pomodoro count: completed pomodoro cycles
- Pause count: manual pauses/suspends

**Storage:** `ExtensionContext.globalState` — persists across restarts, no external DB.

**Display (sidebar section):**

- Today: blocking time, sessions, pomodoros completed
- All Time: total blocking hours, total sessions, average session length, longest streak (consecutive days with activity)

### 5. Hook Manager

Manages Claude Code hook configuration in `~/.claude/settings.json`.

- On first activation: checks if hooks are configured by reading `~/.claude/settings.json` and looking for claude-blocker curl hooks
- If not configured: shows VS Code notification with "Set up now" button
- Install/remove hooks from sidebar UI or command palette
- Implements its own hook setup with configurable port — templates the port into the curl command: `curl -s -X POST http://localhost:{port}/hook -H 'Content-Type: application/json' -d "$(cat)" > /dev/null 2>&1 &`
- Configures hooks for: `SessionStart`, `SessionEnd`, `UserPromptSubmit`, `PreToolUse`, `Stop`
- If user changes the port setting, prompts to reinstall hooks

## UI

### Status Bar Item

Bottom bar item showing current state. Click opens a quick pick menu.

**States:**

- `$(shield) Blocking` — server running, Claude idle, sites blocked
- `$(play) Working` — Claude actively working, sites unblocked
- `$(edit) Waiting` — Claude waiting for user input, sites blocked (server treats `waiting_for_input` sessions as not "working")
- `$(debug-pause) Paused` — manually paused
- `$(clock) Paused (4:32)` — suspended with countdown
- `$(clock) Pomodoro 18:22` — pomodoro active with countdown
- `$(error) Stopped` — server not running

**Quick pick menu on click:**

- Pause / Resume
- Suspend for X minutes...
- Start Pomodoro / Stop Pomodoro
- Open Stats

### Sidebar Tree View

Panel in the activity bar with sections:

- **Status** — server state, connected sessions, working/idle/waiting counts
- **Controls** — pause, resume, suspend, pomodoro start/stop
- **Stats** — today and all-time statistics
- **Setup** — hook status (installed/not installed/wrong port), install/remove hooks button, port display

Error states shown inline: "Failed to start server", "Port 8765 in use", "Hooks configured for wrong port"

### Command Palette

All actions registered as commands:

| Command | ID |
| --- | --- |
| Start Server | `claude-blocker.startServer` |
| Stop Server | `claude-blocker.stopServer` |
| Pause | `claude-blocker.pause` |
| Resume | `claude-blocker.resume` |
| Suspend for X Minutes... | `claude-blocker.suspend` |
| Start Pomodoro | `claude-blocker.startPomodoro` |
| Stop Pomodoro | `claude-blocker.stopPomodoro` |
| Toggle Pomodoro | `claude-blocker.togglePomodoro` |
| Show Stats | `claude-blocker.showStats` |
| Setup Hooks | `claude-blocker.setupHooks` |
| Remove Hooks | `claude-blocker.removeHooks` |

## Configuration

VS Code settings under `claudeBlocker`:

| Setting | Type | Default | Description |
| --- | --- | --- | --- |
| `claudeBlocker.port` | number | `8765` | Server port |
| `claudeBlocker.autoStart` | boolean | `true` | Start server on activation |
| `claudeBlocker.pomodoro.activeMinutes` | number | `25` | Pomodoro active phase (minutes) |
| `claudeBlocker.pomodoro.breakMinutes` | number | `5` | Pomodoro break phase (minutes) |
| `claudeBlocker.suspendPresets` | number[] | `[5, 10, 15, 30]` | Suspend duration presets (minutes) |

## Extension Lifecycle

- **Activation event**: `onStartupFinished` — activates after VS Code is ready since the extension runs a background server
- **On activate**: spawn worker thread server (if autoStart), check hooks, initialize stats tracker, create UI elements
- **On deactivate**: terminate worker thread, clear all timers (pomodoro, suspend, keepalive, stats), save stats

## Bundling

Use **esbuild** to produce two bundles:

1. `out/extension.js` — the main extension entry point (CommonJS, for VS Code)
2. `out/server-worker.js` — the embedded server (runs in worker thread)

Both bundles are self-contained with all dependencies inlined. The only runtime dependency is the `ws` npm package (WebSocket server), which is bundled into `server-worker.js`. No external packages need to be installed at runtime.

The extension package (`.vsix`) contains both bundles. Users install the extension and everything works — no Node.js on PATH, no npx, no npm.

## File Structure

```text
src/
  extension.ts              — activation/deactivation, wires everything together
  server/
    worker.ts               — worker thread entry point (creates HTTP + WS server)
    state.ts                — session state management and broadcast logic
    types.ts                — shared types (HookPayload, Session, ServerMessage, etc.)
  blocker.ts                — pause/resume/suspend control via worker messages
  pomodoro.ts               — pomodoro timer logic
  stats.ts                  — stats collection and storage
  hooks.ts                  — hook management (custom implementation with port templating)
  ui/
    statusBar.ts            — status bar item and quick pick menu
    sidebarProvider.ts      — tree view data provider for sidebar panel
```
