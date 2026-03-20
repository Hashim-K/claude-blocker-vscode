# Claude Blocker VS Code Extension — Design Spec

## Overview

A VS Code extension that embeds the [claude-blocker](https://github.com/T3-Content/claude-blocker) server in-process, providing a complete UI for controlling website blocking, pause/suspend/pomodoro modes, stats tracking, and Claude Code hook management. The existing Chrome extension connects to it unmodified.

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
│  │  claude-blocker server (in-process)    │ │
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

### Key Decision: No Modifications to Upstream

The extension depends on the `claude-blocker` npm package and calls `startServer()` directly. Pause/suspend/pomodoro are implemented by sending fake HTTP hook events to the local server with a synthetic session ID (`"vscode-pause"`), making the server report a "working" session so the Chrome extension unblocks. This avoids any changes to the claude-blocker server or Chrome extension.

## Modules

### 1. Server Manager

Responsible for starting and stopping the claude-blocker server.

- Imports `startServer` from the `claude-blocker` npm package
- Runs the server in-process on the configured port (default `8765`)
- Starts automatically on extension activation if `claudeBlocker.autoStart` is `true`
- Gracefully shuts down on extension deactivation
- Exposes server running state to other modules

### 2. Blocker Control

Manages pause, suspend, and resume via fake hook events.

- **Pause**: POSTs `UserPromptSubmit` hook with session ID `"vscode-pause"` to `http://localhost:{port}/hook`. Resends every ~4 minutes to prevent the server's 5-minute session timeout. Sites become unblocked.
- **Resume**: POSTs `Stop` hook with the same session ID. Blocking resumes.
- **Suspend for X minutes**: Same as pause but with a timer. Auto-resumes when the timer expires. Presets: 5, 10, 15, 30 minutes (configurable) plus custom input. Countdown displayed in the status bar.

### 3. Pomodoro Timer

Alternates between active (blocking) and break (unblocked) phases.

- **Active phase** (default 25 min): Blocking works normally. Real Claude sessions still unblock as usual.
- **Break phase** (default 5 min): Uses the fake hook trick (same as pause) to force unblock.
- Status bar shows current phase and countdown (e.g., `$(clock) Pomodoro 18:22`).
- Notification when phase switches.
- Edge case: if Claude is genuinely working during a break, sites are already unblocked — no conflict. When break ends, the fake pause session is removed and real sessions control blocking normally.

### 4. Stats Tracker

Collects usage statistics by polling the server's `/status` endpoint every ~5 seconds.

**Data collected (daily aggregates keyed by date string):**
- Blocking time: total time sites were blocked
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

- On first activation: checks if hooks are configured using `areHooksConfigured()` from the `claude-blocker` package
- If not configured: shows VS Code notification with "Set up now" button
- Install/remove hooks from sidebar UI or command palette
- Uses `setupHooks()` and `removeHooks()` from the `claude-blocker` package directly
- If user changes the port setting, prompts to reinstall hooks (since hooks contain the port in the curl URL)

## UI

### Status Bar Item

Bottom bar item showing current state. Click opens a quick pick menu.

**States:**
- `$(shield) Blocking` — server running, Claude idle, sites blocked
- `$(play) Working` — Claude actively working, sites unblocked
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

- **Status** — server state, connected sessions, working/idle counts
- **Controls** — pause, resume, suspend, pomodoro start/stop
- **Stats** — today and all-time statistics
- **Setup** — hook status (installed/not), install/remove hooks button

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
- **On activate**: start server (if autoStart), check hooks, initialize stats tracker, create UI elements
- **On deactivate**: stop server, clear all timers (pomodoro, suspend, keepalive, stats polling), save stats

## Dependencies

- `claude-blocker` — the server package (bundles `ws` for WebSocket support)
- No other runtime dependencies

## File Structure

```
src/
  extension.ts          — activation/deactivation, wires everything together
  server.ts             — server manager (start/stop, wraps claude-blocker)
  blocker.ts            — pause/resume/suspend control via fake hooks
  pomodoro.ts           — pomodoro timer logic
  stats.ts              — stats collection and storage
  hooks.ts              — hook management (wraps claude-blocker setup functions)
  ui/
    statusBar.ts        — status bar item and quick pick menu
    sidebarProvider.ts  — tree view data provider for sidebar panel
```
