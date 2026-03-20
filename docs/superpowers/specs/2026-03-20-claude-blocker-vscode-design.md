# Claude Blocker VS Code Extension — Design Spec

## Overview

A VS Code extension that runs the [claude-blocker](https://github.com/T3-Content/claude-blocker) server as a managed child process, providing a complete UI for controlling website blocking, pause/suspend/pomodoro modes, stats tracking, and Claude Code hook management. The existing Chrome extension connects to it unmodified.

## Architecture

```
┌─────────────────────────────────────────────┐
│  VS Code Extension                          │
│                                             │
│  ┌──────────┐  ┌──────────┐  ┌───────────┐ │
│  │ Server   │  │ Blocker  │  │ Pomodoro  │ │
│  │ Manager  │  │ Control  │  │ Timer     │ │
│  └────┬─────┘  └────┬─────┘  └─────┬─────┘ │
│       │              │              │       │
│       │         POST /hook     uses control │
│       │              │              │       │
│  ┌────▼──────────────▼──────────────▼─────┐ │
│  │  claude-blocker server (child process) │ │
│  │  HTTP :8765 + WebSocket /ws            │ │
│  └────────────────────────────────────────┘ │
│                                             │
│  ┌──────────┐  ┌──────────┐  ┌───────────┐ │
│  │ Status   │  │ Sidebar  │  │ Stats     │ │
│  │ Bar Item │  │ TreeView │  │ Tracker   │ │
│  └──────────┘  └──────────┘  └───────────┘ │
└─────────────────────────────────────────────┘
         ▲                    │
    POST /hook            WebSocket
         │                    ▼
   Claude Code          Chrome Extension
   (via hooks)          (unmodified)
```

### Key Decisions

**Child process, not in-process:** The upstream `startServer()` returns `void` (no shutdown handle) and installs a `process.exit(0)` SIGINT handler — embedding it in the VS Code extension host process is unsafe. Running as a child process via `npx claude-blocker --port N` gives clean start/stop via process signals, avoids ESM/CJS conflicts, and isolates the server completely.

**No modifications to upstream:** Pause/suspend/pomodoro are implemented by sending fake HTTP hook events to the local server with a synthetic session ID (`"vscode-pause"`), making the server report a "working" session so the Chrome extension unblocks. This avoids any changes to the claude-blocker server or Chrome extension.

**Custom hook management:** The upstream `setupHooks()` hardcodes the default port (8765) into the curl commands. The extension implements its own hook setup that templates the configured port, so non-default ports work correctly.

## Modules

### 1. Server Manager

Responsible for starting and stopping the claude-blocker server as a child process.

- The extension always installs hooks (if needed) **before** spawning the child process, to prevent the upstream interactive prompt from writing hardcoded-port hooks. The child process stdin is piped with `"n\n"` as a safety measure to skip the upstream setup prompt if it somehow triggers.
- Spawns `npx claude-blocker --port {port}` as a child process
- Starts automatically on extension activation if `claudeBlocker.autoStart` is `true`
- Detects port conflicts: if port is already in use, shows an error with option to change port
- Monitors child process health — restarts on unexpected exit
- Gracefully shuts down on extension deactivation via `SIGTERM`
- Exposes server running state to other modules

### 2. Blocker Control

Manages pause, suspend, and resume via fake hook events.

- **Pause**: POSTs a `SessionStart` hook followed by a `UserPromptSubmit` hook, both with session ID `"vscode-pause"`, to `http://localhost:{port}/hook`. The server marks this session as "working", and the Chrome extension sees `working > 0` and unblocks. Resends `UserPromptSubmit` every ~3 minutes to prevent the server's 5-minute session timeout. Retries on POST failure.
- **Resume**: POSTs a `SessionEnd` hook with the same session ID. This fully removes the fake session from the server's session map (unlike `Stop` which would leave a phantom idle session). Blocking resumes.
- **Suspend for X minutes**: Same as pause but with a timer. Auto-resumes when the timer expires. Presets: 5, 10, 15, 30 minutes (configurable) plus custom input. Countdown displayed in the status bar.

### 3. Pomodoro Timer

Alternates between active (blocking) and break (unblocked) phases.

- **Active phase** (default 25 min): Blocking works normally. Real Claude sessions still unblock as usual.
- **Break phase** (default 5 min): Uses the fake hook trick (same as pause) to force unblock.
- Status bar shows current phase and countdown (e.g., `$(clock) Pomodoro 18:22`).
- Notification when phase switches.
- Edge case: if Claude is genuinely working during a break, sites are already unblocked — no conflict. When break ends, the fake pause session is removed via `SessionEnd` and real sessions control blocking normally.

### 4. Stats Tracker

Collects usage statistics by connecting to the server's WebSocket at `ws://localhost:{port}/ws`. Receives real-time `state` messages containing `{ blocked, sessions, working, waitingForInput }`. Uses `GET /status` as a fallback for session details (e.g., session list with CWDs). A 1-second interval timer computes running time counters based on the last known state.

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
- Implements its own hook setup (not using upstream `setupHooks()`) to support configurable ports — templates the port into the curl command: `curl -s -X POST http://localhost:{port}/hook -H 'Content-Type: application/json' -d "$(cat)" > /dev/null 2>&1 &`
- Configures hooks for: `SessionStart`, `SessionEnd`, `UserPromptSubmit`, `PreToolUse`, `Stop`
- If user changes the port setting, prompts to reinstall hooks

## UI

### Status Bar Item

Bottom bar item showing current state. Click opens a quick pick menu.

**States:**
- `$(shield) Blocking` — server running, Claude idle, sites blocked
- `$(play) Working` — Claude actively working, sites unblocked
- `$(edit) Waiting` — Claude waiting for user input, sites blocked (upstream server treats `waiting_for_input` sessions as not "working")
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
|---|---|
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
|---|---|---|---|
| `claudeBlocker.port` | number | `8765` | Server port |
| `claudeBlocker.autoStart` | boolean | `true` | Start server on activation |
| `claudeBlocker.pomodoro.activeMinutes` | number | `25` | Pomodoro active phase (minutes) |
| `claudeBlocker.pomodoro.breakMinutes` | number | `5` | Pomodoro break phase (minutes) |
| `claudeBlocker.suspendPresets` | number[] | `[5, 10, 15, 30]` | Suspend duration presets (minutes) |

## Extension Lifecycle

- **Activation event**: `onStartupFinished` — activates after VS Code is ready since the extension runs a background server
- **On activate**: start server child process (if autoStart), check hooks, initialize stats tracker, create UI elements
- **On deactivate**: send SIGTERM to child process, clear all timers (pomodoro, suspend, keepalive, stats polling), save stats

## Bundling

Use **esbuild** to bundle the extension into a single file. The extension itself has no heavy runtime dependencies — it only needs Node.js built-ins (`http`, `child_process`, `fs`, `path`, `os`) and the `vscode` API. The `claude-blocker` server runs as a separate child process, so it does not need to be bundled.

The user must have `npx` available (i.e., Node.js installed). On first activation, if `npx` is not found, show a notification directing the user to install Node.js.

## File Structure

```
src/
  extension.ts          — activation/deactivation, wires everything together
  server.ts             — server manager (child process lifecycle)
  blocker.ts            — pause/resume/suspend control via fake hooks
  pomodoro.ts           — pomodoro timer logic
  stats.ts              — stats collection and storage
  hooks.ts              — hook management (custom implementation with port templating)
  ui/
    statusBar.ts        — status bar item and quick pick menu
    sidebarProvider.ts  — tree view data provider for sidebar panel
```
