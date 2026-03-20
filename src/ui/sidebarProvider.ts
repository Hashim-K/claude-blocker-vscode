import * as vscode from "vscode";
import type { ServerManager } from "../server.js";
import type { Blocker } from "../blocker.js";
import type { Pomodoro } from "../pomodoro.js";
import type { StatsTracker } from "../stats.js";
import { areHooksConfigured } from "../hooks.js";

function fmtMs(ms: number): string {
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  return `${hrs}h ${mins % 60}m`;
}

function fmtTime(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${min}:${String(sec).padStart(2, "0")}`;
}

function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export class SidebarProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | null = null;
  private unsubs: (() => void)[] = [];
  private server: ServerManager;
  private blocker: Blocker;
  private pomodoro: Pomodoro;
  private stats: StatsTracker;
  private port: number;

  constructor(server: ServerManager, blocker: Blocker, pomodoro: Pomodoro, stats: StatsTracker, port: number) {
    this.server = server;
    this.blocker = blocker;
    this.pomodoro = pomodoro;
    this.stats = stats;
    this.port = port;

    const refresh = () => this.update();
    this.unsubs.push(server.onStateChange(refresh));
    this.unsubs.push(blocker.onChange(refresh));
    this.unsubs.push(pomodoro.onChange(refresh));
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = { enableScripts: true };

    webviewView.webview.onDidReceiveMessage((msg: { command: string }) => {
      vscode.commands.executeCommand(msg.command);
    });

    webviewView.onDidDispose(() => { this.view = null; });
    this.update();
  }

  refresh(): void { this.update(); }

  private update(): void {
    if (!this.view) return;
    this.view.webview.html = this.getHtml();
  }

  private getHtml(): string {
    const s = this.server.status;
    const bState = this.blocker.state;
    const pState = this.pomodoro.state;
    const today = this.stats.getToday();
    const all = this.stats.getAllTime();
    const hookStatus = areHooksConfigured(this.port);

    // Status badge
    let statusIcon: string, statusText: string, statusClass: string;
    if (s.state !== "running") {
      statusIcon = "○"; statusText = `Server ${s.state}`; statusClass = "error";
    } else if (pState.running) {
      const label = pState.phase === "active" ? "Focus" : "Break";
      statusIcon = pState.phase === "active" ? "◉" : "◎";
      statusText = `${label} ${fmtTime(pState.remaining)}`;
      statusClass = pState.phase === "active" ? "active" : "break";
    } else if (bState === "suspended") {
      statusIcon = "⏸"; statusText = `Suspended ${fmtTime(this.blocker.suspendRemaining)}`;
      statusClass = "paused";
    } else if (bState === "paused") {
      statusIcon = "⏸"; statusText = "Paused"; statusClass = "paused";
    } else if (s.working > 0) {
      statusIcon = "●"; statusText = `Working (${s.working})`; statusClass = "working";
    } else if (s.waitingForInput > 0) {
      statusIcon = "✎"; statusText = "Waiting for input"; statusClass = "waiting";
    } else {
      statusIcon = "🛡"; statusText = "Blocking"; statusClass = "blocking";
    }

    // Buttons
    const serverBtn = s.state !== "running"
      ? `<button class="btn" onclick="cmd('claude-blocker.startServer')">▶ Start Server</button>`
      : `<button class="btn btn-muted" onclick="cmd('claude-blocker.stopServer')">■ Stop Server</button>`;

    const pauseBtn = bState !== "active"
      ? `<button class="btn btn-success" onclick="cmd('claude-blocker.resume')">▶ Resume</button>`
      : `<button class="btn" onclick="cmd('claude-blocker.pause')">⏸ Pause</button>`;

    const suspendBtn = `<button class="btn" onclick="cmd('claude-blocker.suspend')">⏱ Suspend...</button>`;

    const pomBtn = pState.running
      ? `<button class="btn btn-muted" onclick="cmd('claude-blocker.stopPomodoro')">■ Stop Pomodoro</button>`
      : `<button class="btn" onclick="cmd('claude-blocker.startPomodoro')">🍅 Start Pomodoro</button>`;

    // Hook status
    let hookHtml: string;
    if (hookStatus === "installed") {
      hookHtml = `<span class="tag tag-ok">✓ Hooks installed</span>`;
    } else if (hookStatus === "wrong-port") {
      hookHtml = `<span class="tag tag-warn clickable" onclick="cmd('claude-blocker.setupHooks')">⚠ Wrong port — click to fix</span>`;
    } else {
      hookHtml = `<span class="tag tag-err clickable" onclick="cmd('claude-blocker.setupHooks')">✗ Hooks not installed — click to setup</span>`;
    }

    return /* html */ `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-foreground);
    padding: 12px;
  }

  .status-banner {
    text-align: center;
    padding: 14px 10px;
    border-radius: 6px;
    margin-bottom: 14px;
    font-weight: 600;
    font-size: 1.1em;
  }
  .status-banner .icon { font-size: 1.4em; margin-right: 6px; }
  .status-banner.blocking { background: var(--vscode-inputValidation-errorBackground, rgba(255,80,80,0.15)); }
  .status-banner.working { background: var(--vscode-inputValidation-infoBackground, rgba(80,160,255,0.15)); }
  .status-banner.waiting { background: var(--vscode-inputValidation-warningBackground, rgba(255,200,50,0.15)); }
  .status-banner.paused { background: var(--vscode-inputValidation-warningBackground, rgba(255,200,50,0.15)); }
  .status-banner.active { background: var(--vscode-inputValidation-infoBackground, rgba(80,160,255,0.15)); }
  .status-banner.break { background: var(--vscode-inputValidation-warningBackground, rgba(255,200,50,0.15)); }
  .status-banner.error { background: var(--vscode-inputValidation-errorBackground, rgba(255,80,80,0.15)); }

  .session-info {
    text-align: center;
    margin-bottom: 14px;
    opacity: 0.8;
    font-size: 0.9em;
  }

  .section-label {
    font-size: 0.75em;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    opacity: 0.6;
    margin-bottom: 6px;
    margin-top: 16px;
  }
  .section-label:first-of-type { margin-top: 0; }

  .btn-group { display: flex; flex-direction: column; gap: 4px; }
  .btn {
    display: block;
    width: 100%;
    padding: 7px 10px;
    border: none;
    border-radius: 4px;
    cursor: pointer;
    font-size: 0.92em;
    font-family: inherit;
    text-align: left;
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
  }
  .btn:hover { background: var(--vscode-button-secondaryHoverBackground); }
  .btn-success { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  .btn-success:hover { background: var(--vscode-button-hoverBackground); }
  .btn-muted { opacity: 0.7; }

  .stats-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 6px;
  }
  .stat-card {
    background: var(--vscode-editor-background);
    border-radius: 4px;
    padding: 8px 10px;
    text-align: center;
  }
  .stat-value { font-size: 1.15em; font-weight: 600; }
  .stat-label { font-size: 0.75em; opacity: 0.6; margin-top: 2px; }

  .tag {
    display: inline-block;
    padding: 3px 8px;
    border-radius: 3px;
    font-size: 0.85em;
  }
  .tag-ok { background: rgba(80,200,120,0.15); }
  .tag-warn { background: rgba(255,200,50,0.15); }
  .tag-err { background: rgba(255,80,80,0.15); }
  .clickable { cursor: pointer; }
  .clickable:hover { opacity: 0.8; }

  .footer {
    margin-top: 12px;
    font-size: 0.8em;
    opacity: 0.5;
    text-align: center;
  }
</style>
</head>
<body>
  <div class="status-banner ${escHtml(statusClass)}">
    <span class="icon">${statusIcon}</span>${escHtml(statusText)}
  </div>

  ${s.state === "running" ? `
  <div class="session-info">
    ${s.sessions.length} session${s.sessions.length !== 1 ? "s" : ""} · ${s.working} working · ${s.waitingForInput} waiting
  </div>` : (s.error ? `<div class="session-info">${escHtml(s.error)}</div>` : "")}

  <div class="section-label">Controls</div>
  <div class="btn-group">
    ${serverBtn}
    ${pauseBtn}
    ${suspendBtn}
    ${pomBtn}
  </div>

  <div class="section-label">Today</div>
  <div class="stats-grid">
    <div class="stat-card"><div class="stat-value">${escHtml(fmtMs(today.blockingMs))}</div><div class="stat-label">Blocked</div></div>
    <div class="stat-card"><div class="stat-value">${escHtml(fmtMs(today.unblockedMs))}</div><div class="stat-label">Unblocked</div></div>
    <div class="stat-card"><div class="stat-value">${today.sessionCount}</div><div class="stat-label">Sessions</div></div>
    <div class="stat-card"><div class="stat-value">${today.pomodoroCount}</div><div class="stat-label">Pomodoros</div></div>
  </div>

  <div class="section-label">All Time</div>
  <div class="stats-grid">
    <div class="stat-card"><div class="stat-value">${escHtml(fmtMs(all.blockingMs))}</div><div class="stat-label">Blocked</div></div>
    <div class="stat-card"><div class="stat-value">${all.sessionCount}</div><div class="stat-label">Sessions</div></div>
    <div class="stat-card"><div class="stat-value">${all.pomodoroCount}</div><div class="stat-label">Pomodoros</div></div>
    <div class="stat-card"><div class="stat-value">${all.days}</div><div class="stat-label">Days</div></div>
  </div>

  <div class="section-label">Setup</div>
  ${hookHtml}
  <div class="footer">Port ${this.port}</div>

  <script>
    const vscode = acquireVsCodeApi();
    function cmd(command) { vscode.postMessage({ command }); }
  </script>
</body>
</html>`;
  }

  dispose(): void {
    for (const u of this.unsubs) u();
  }
}
