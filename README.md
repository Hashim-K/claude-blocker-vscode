# Claude Blocker for VS Code

Block distracting websites while Claude Code is working. Automatically unblock when Claude needs your input. Includes pause, suspend, pomodoro timer, and session stats.

Compatible with both [Claude Blocker](https://github.com/T3-Content/claude-blocker) and [Claude Blocker Advanced](https://github.com/genesiscz/claude-blocker-advanced) Chrome extensions.

## How It Works

1. The extension runs a WebSocket server that the Chrome extension connects to
2. Claude Code hooks report session activity (working, waiting for input, idle) to the server
3. The Chrome extension blocks/unblocks sites based on Claude's status

When Claude is **working** → sites are unblocked so you can browse freely.
When Claude **stops** → sites are blocked to keep you focused.

## Features

- **Auto-blocking** — sites blocked when Claude isn't working, unblocked when it is
- **Pause / Resume** — manually unblock sites
- **Suspend** — unblock for a set duration (5, 10, 15, 30 min or custom)
- **Pomodoro timer** — configurable active/break cycles that auto-pause/resume blocking
- **Active Sessions** — see all running Claude Code instances with status, tool count, elapsed time
- **Activity Timeline** — visual history of session activity over the last 4 hours
- **Stats** — daily and all-time tracking of blocking time, sessions, pomodoros
- **Sound notifications** — per-event configurable sounds with individual volume control and custom sound support
- **Toast notifications** — VS Code info messages on state changes
- **Status bar** — click for quick actions
- **Sidebar panel** — full dashboard in the activity bar

## Setup

1. Install this extension
2. Install the [Claude Blocker](https://github.com/T3-Content/claude-blocker) or [Claude Blocker Advanced](https://github.com/genesiscz/claude-blocker-advanced) Chrome extension
3. Install Claude Code hooks (see below)
4. The server starts automatically on port 8765

### Installing Hooks

Claude Code hooks tell the server about session activity. You can install them automatically or manually.

**Automatic:** On first launch, the extension prompts to install hooks — click **Set up now**. You can also run `Claude Blocker: Setup Hooks` from the command palette, or click the hooks status badge in the sidebar Setup section.

**Manual:** Add the following to `~/.claude/settings.json` under `"hooks"`:

```json
{
  "hooks": {
    "SessionStart": [
      { "hooks": [{ "type": "command", "command": "curl -s -X POST http://localhost:8765/hook -H 'Content-Type: application/json' -d \"$(cat)\" > /dev/null 2>&1 &" }] }
    ],
    "SessionEnd": [
      { "hooks": [{ "type": "command", "command": "curl -s -X POST http://localhost:8765/hook -H 'Content-Type: application/json' -d \"$(cat)\" > /dev/null 2>&1 &" }] }
    ],
    "UserPromptSubmit": [
      { "hooks": [{ "type": "command", "command": "curl -s -X POST http://localhost:8765/hook -H 'Content-Type: application/json' -d \"$(cat)\" > /dev/null 2>&1 &" }] }
    ],
    "PreToolUse": [
      { "matcher": "*", "hooks": [{ "type": "command", "command": "curl -s -X POST http://localhost:8765/hook -H 'Content-Type: application/json' -d \"$(cat)\" > /dev/null 2>&1 &" }] }
    ],
    "PostToolUse": [
      { "matcher": "*", "hooks": [{ "type": "command", "command": "curl -s -X POST http://localhost:8765/hook -H 'Content-Type: application/json' -d \"$(cat)\" > /dev/null 2>&1 &" }] }
    ],
    "Stop": [
      { "hooks": [{ "type": "command", "command": "curl -s -X POST http://localhost:8765/hook -H 'Content-Type: application/json' -d \"$(cat)\" > /dev/null 2>&1 &" }] }
    ]
  }
}
```

If you already have hooks configured, add the claude-blocker entries alongside your existing ones — each event supports an array of hook entries.

The required events are: `SessionStart`, `SessionEnd`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Stop`.

## Commands

All commands are available via the Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`):

| Command | Description |
|---------|-------------|
| Claude Blocker: Start Server | Start the WebSocket server |
| Claude Blocker: Stop Server | Stop the server |
| Claude Blocker: Pause | Pause blocking (sites unblocked) |
| Claude Blocker: Resume | Resume blocking |
| Claude Blocker: Suspend for X Minutes... | Unblock for a set duration |
| Claude Blocker: Start Pomodoro | Start pomodoro timer |
| Claude Blocker: Stop Pomodoro | Stop pomodoro timer |
| Claude Blocker: Toggle Pomodoro | Toggle pomodoro on/off |
| Claude Blocker: Toggle Sound | Enable/disable sound notifications |
| Claude Blocker: Show Stats | Show blocking stats |
| Claude Blocker: Setup Hooks | Install Claude Code hooks |
| Claude Blocker: Remove Hooks | Remove Claude Code hooks |

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `claudeBlocker.port` | `8765` | Server port |
| `claudeBlocker.autoStart` | `true` | Start server on activation |
| `claudeBlocker.pomodoro.activeMinutes` | `25` | Pomodoro active phase (minutes) |
| `claudeBlocker.pomodoro.breakMinutes` | `5` | Pomodoro break phase (minutes) |
| `claudeBlocker.suspendPresets` | `[5, 10, 15, 30]` | Suspend duration presets (minutes) |

### Sound Settings

Each notification event has its own sound, volume, and optional custom file path:

| Event | Setting prefix | Default sound |
|-------|---------------|---------------|
| Claude stops working | `claudeBlocker.notifications.sound.onStopWorking` | `notification-unctuous` |
| Waiting for input | `claudeBlocker.notifications.sound.onWaitingForInput` | `notification-unctuous` |
| Pomodoro phase change | `claudeBlocker.notifications.sound.onPomodoroSwitch` | `marimba-ascending` |
| Suspend expired | `claudeBlocker.notifications.sound.onSuspendExpired` | `notification-unctuous` |

Each event has `.sound`, `.volume` (0-100), and `.customPath` sub-settings. Set sound to `custom` and provide a `customPath` to use your own audio file.

**Bundled sounds:** `notification-unctuous`, `bright-bell`, `marimba-ascending`, `dry-bongos`, `message-notification`, `notification-sound`

Sounds sourced from [Freesound](https://freesound.org).

## Architecture

- **Worker thread server** — runs inside VS Code's Node.js runtime (no external dependencies)
- **WebSocket + HTTP** — Chrome extensions connect via WebSocket, hooks POST to `/hook`
- **Fake session injection** — pause/suspend works by injecting a synthetic "working" session so the Chrome extension thinks Claude is active
- **esbuild** — dual-bundle build: `out/extension.js` (main) + `out/server-worker.js` (worker with `ws` bundled)

## Development

```bash
npm install
npm run compile    # build with esbuild
```

Press F5 to launch the Extension Development Host.

## License

MIT
