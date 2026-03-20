import * as vscode from "vscode";
import type { ServerManager } from "../server.js";
import type { Blocker } from "../blocker.js";
import type { Pomodoro } from "../pomodoro.js";
import type { StatsTracker } from "../stats.js";
import type { ActivityTracker } from "../activityTracker.js";
import type { Session } from "../server/types.js";
import { areHooksConfigured, getMissingHooks } from "../hooks.js";

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

function fmtDuration(ms: number): string {
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  return `${hr}h ${min % 60}m`;
}

function fmtClockTime(ts: number): string {
  const d = new Date(ts);
  let h = d.getHours();
  const ampm = h >= 12 ? "PM" : "AM";
  h = h % 12 || 12;
  return `${h}:${String(d.getMinutes()).padStart(2, "0")} ${ampm}`;
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export class SidebarProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | null = null;
  private unsubs: (() => void)[] = [];
  private server: ServerManager;
  private blocker: Blocker;
  private pomodoro: Pomodoro;
  private stats: StatsTracker;
  private activity: ActivityTracker;
  private port: number;

  constructor(server: ServerManager, blocker: Blocker, pomodoro: Pomodoro, stats: StatsTracker, activity: ActivityTracker, port: number) {
    this.server = server;
    this.blocker = blocker;
    this.pomodoro = pomodoro;
    this.stats = stats;
    this.activity = activity;
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

  private renderSessionCard(session: Session): string {
    const statusDot = session.status === "working" ? "dot-working"
      : session.status === "waiting_for_input" ? "dot-waiting" : "dot-idle";
    const statusLabel = session.status === "working" ? "Working"
      : session.status === "waiting_for_input" ? "Waiting" : "Idle";
    const elapsed = fmtDuration(Date.now() - new Date(session.startTime).getTime());
    const lastTool = session.lastTool ? esc(session.lastTool) : "—";
    return `<div class="session-card">
      <div class="session-header">
        <span class="dot ${statusDot}"></span>
        <span class="session-name">${esc(session.projectName)}</span>
        <span class="session-elapsed">${elapsed}</span>
      </div>
      <div class="session-detail">${statusLabel} · ${session.toolCount} tools · Last: ${lastTool}</div>
    </div>`;
  }

  private renderTimeline(): string {
    const data = this.activity.getTimelineData();
    if (data.length === 0) {
      return `<div class="empty-state">No activity recorded yet</div>`;
    }

    const now = Date.now();
    const windowMs = 4 * 60 * 60 * 1000;
    const windowStart = now - windowMs;

    // Time axis labels (5 evenly spaced)
    const labels: string[] = [];
    for (let i = 0; i < 5; i++) {
      const t = windowStart + (windowMs * i / 4);
      labels.push(fmtClockTime(t));
    }

    let timeAxisHtml = `<div class="time-axis">`;
    for (const label of labels) {
      timeAxisHtml += `<span>${label}</span>`;
    }
    timeAxisHtml += `</div>`;

    let rowsHtml = "";
    for (const session of data) {
      let segmentsHtml = "";
      for (const seg of session.segments) {
        const startPct = Math.max(0, (seg.start - windowStart) / windowMs * 100);
        const endPct = Math.min(100, (seg.end - windowStart) / windowMs * 100);
        const widthPct = endPct - startPct;
        if (widthPct <= 0) continue;
        const segClass = seg.status === "working" ? "seg-working"
          : seg.status === "waiting_for_input" ? "seg-waiting" : "seg-idle";
        segmentsHtml += `<div class="seg ${segClass}" style="left:${startPct}%;width:${widthPct}%"></div>`;
      }

      const firstSeg = session.segments[0];
      const lastSeg = session.segments[session.segments.length - 1];
      const elapsed = fmtDuration((lastSeg?.end ?? now) - (firstSeg?.start ?? now));
      const shortId = session.sessionId.substring(0, 7);

      rowsHtml += `<div class="timeline-row">
        <div class="timeline-label">
          <span class="tl-name">${esc(session.projectName)}</span>
          <span class="tl-meta"><span class="tl-id">${esc(shortId)}</span> <span class="tl-elapsed">${elapsed}</span></span>
        </div>
        <div class="timeline-bar">${segmentsHtml}</div>
      </div>`;
    }

    return `<div class="timeline-container">${timeAxisHtml}${rowsHtml}</div>`;
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
    if (s.state === "starting") {
      statusIcon = "◌"; statusText = "Starting..."; statusClass = "starting";
    } else if (s.state !== "running") {
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

    // Controls
    const serverBtn = s.state !== "running"
      ? `<button class="btn" onclick="cmd('claude-blocker.startServer')">▶ Start Server</button>`
      : `<button class="btn btn-muted" onclick="cmd('claude-blocker.stopServer')">■ Stop Server</button>`;

    const pauseBtn = bState !== "active"
      ? `<button class="btn btn-success" onclick="cmd('claude-blocker.resume')">▶ Resume</button>`
      : `<button class="btn" onclick="cmd('claude-blocker.pause')">⏸ Pause</button>`;

    const suspendBtn = `<button class="btn" onclick="cmd('claude-blocker.suspend')">⏱ Suspend...</button>`;

    const pomCfg = vscode.workspace.getConfiguration("claudeBlocker");
    const pomActiveMin = pomCfg.get<number>("pomodoro.activeMinutes", 25);
    const pomBreakMin = pomCfg.get<number>("pomodoro.breakMinutes", 5);

    const pomBtn = pState.running
      ? `<button class="btn btn-muted" onclick="cmd('claude-blocker.stopPomodoro')">■ Stop Pomodoro</button>`
      : `<button class="btn" onclick="cmd('claude-blocker.startPomodoro')">🍅 Start Pomodoro</button>`;

    // Active sessions
    const realSessions = s.state === "running"
      ? s.sessions.filter(sess => sess.id !== "vscode-pause")
      : [];
    let sessionsHtml: string;
    if (s.state !== "running") {
      sessionsHtml = `<div class="empty-state">Server not running</div>`;
    } else if (realSessions.length === 0) {
      sessionsHtml = `<div class="empty-state">No active sessions</div>`;
    } else {
      sessionsHtml = realSessions.map(sess => this.renderSessionCard(sess)).join("");
    }

    // Timeline
    const timelineHtml = s.state === "running" ? this.renderTimeline() : `<div class="empty-state">Server not running</div>`;

    // Hook status
    let hookHtml: string;
    if (hookStatus === "installed") {
      hookHtml = `<span class="tag tag-ok">✓ Hooks installed · Port ${this.port}</span>`;
    } else if (hookStatus === "incomplete") {
      const missing = getMissingHooks();
      hookHtml = `<span class="tag tag-warn clickable" onclick="cmd('claude-blocker.setupHooks')">⚠ Missing hooks: ${missing.join(", ")} — click to fix</span>`;
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

  /* Status banner */
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
  .status-banner.starting { background: var(--vscode-inputValidation-warningBackground, rgba(255,200,50,0.1)); opacity: 0.7; }

  /* Accordion sections */
  .accordion {
    margin-top: 10px;
    border-radius: 5px;
    overflow: hidden;
    background: var(--vscode-editor-background);
  }
  .accordion-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 8px 10px;
    cursor: pointer;
    user-select: none;
    font-size: 0.75em;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    opacity: 0.8;
    background: var(--vscode-editor-background);
  }
  .accordion-header:hover { opacity: 1; }
  .accordion-chevron {
    transition: transform 0.15s ease;
    font-size: 0.9em;
  }
  .accordion.collapsed .accordion-chevron { transform: rotate(-90deg); }
  .accordion.collapsed .accordion-body { display: none; }
  .accordion-body { padding: 0 10px 10px; }
  .accordion-badge {
    font-size: 0.85em;
    opacity: 0.5;
    margin-left: 6px;
    font-weight: normal;
    text-transform: none;
    letter-spacing: 0;
  }

  /* Section labels (non-accordion) */
  .section-label {
    font-size: 0.75em;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    opacity: 0.6;
    margin-bottom: 6px;
    margin-top: 16px;
  }

  /* Controls */
  .btn-row { display: flex; gap: 4px; margin-bottom: 4px; }
  .btn-row .btn { flex: 1; text-align: center; }
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

  /* Pomodoro config */
  .pom-config {
    display: flex;
    gap: 6px;
    margin-bottom: 4px;
  }
  .pom-field {
    flex: 1;
    display: flex;
    align-items: center;
    gap: 4px;
    background: var(--vscode-editor-background);
    border-radius: 4px;
    padding: 5px 8px;
    cursor: pointer;
    font-size: 0.85em;
  }
  .pom-field:hover { opacity: 0.8; }
  .pom-value { font-weight: 600; }
  .pom-unit { opacity: 0.6; font-size: 0.85em; }

  /* Active Sessions */
  .session-card {
    background: var(--vscode-editor-background);
    border-radius: 5px;
    padding: 8px 10px;
    margin-bottom: 4px;
  }
  .session-header {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .dot {
    width: 8px; height: 8px;
    border-radius: 50%;
    flex-shrink: 0;
  }
  .dot-working { background: #4ec958; }
  .dot-waiting { background: #e8a838; }
  .dot-idle { background: #888; }
  .session-name {
    font-weight: 600;
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .session-elapsed {
    font-size: 0.85em;
    opacity: 0.6;
    flex-shrink: 0;
  }
  .session-detail {
    font-size: 0.8em;
    opacity: 0.6;
    margin-top: 3px;
    margin-left: 14px;
  }

  .empty-state {
    background: var(--vscode-editor-background);
    border-radius: 5px;
    padding: 16px;
    text-align: center;
    opacity: 0.5;
    font-size: 0.9em;
  }

  /* Activity Timeline */
  .timeline-legend {
    display: flex;
    gap: 12px;
    justify-content: flex-end;
    font-size: 0.75em;
    opacity: 0.7;
    margin-bottom: 6px;
  }
  .legend-item { display: flex; align-items: center; gap: 4px; }
  .legend-dot {
    width: 7px; height: 7px;
    border-radius: 50%;
    display: inline-block;
  }
  .timeline-container {
    background: rgba(0,0,0,0.15);
    border-radius: 6px;
    padding: 10px 12px;
  }
  .time-axis {
    display: flex;
    justify-content: space-between;
    font-size: 0.72em;
    opacity: 0.4;
    margin-bottom: 10px;
    padding: 0 2px;
  }
  .timeline-row {
    margin-bottom: 12px;
  }
  .timeline-row:last-child { margin-bottom: 0; }
  .timeline-label {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    margin-bottom: 4px;
  }
  .tl-name {
    font-size: 0.88em;
    font-weight: 600;
    opacity: 0.9;
  }
  .tl-meta {
    display: flex;
    align-items: baseline;
    gap: 6px;
    flex-shrink: 0;
  }
  .tl-id {
    font-size: 0.75em;
    font-family: var(--vscode-editor-font-family, monospace);
    opacity: 0.4;
  }
  .tl-elapsed {
    font-size: 0.8em;
    opacity: 0.5;
  }
  .timeline-bar {
    position: relative;
    height: 14px;
    background: rgba(255,255,255,0.05);
    border-radius: 4px;
    overflow: hidden;
  }
  .seg {
    position: absolute;
    top: 0;
    height: 100%;
    border-radius: 4px;
  }
  .seg-working { background: #4ec958; }
  .seg-waiting { background: #e8a838; }
  .seg-idle { background: rgba(255,255,255,0.08); }

  /* Stats */
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

  /* Tags */
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
  <div class="status-banner ${esc(statusClass)}">
    <span class="icon">${statusIcon}</span>${esc(statusText)}
  </div>

  <div class="section-label">Controls</div>
  <div class="btn-row">
    ${serverBtn}
    ${pauseBtn}
  </div>
  <div class="btn-row">
    ${suspendBtn}
  </div>

  <div class="accordion" data-id="pomodoro">
    <div class="accordion-header" onclick="toggle('pomodoro')">
      <span>🍅 Pomodoro</span>
      <span class="accordion-chevron">▾</span>
    </div>
    <div class="accordion-body">
      <div class="pom-config">
        <div class="pom-field" onclick="cmd('claude-blocker.setPomodoroActive')">
          <span>🟢</span>
          <span class="pom-value">${pomActiveMin}</span>
          <span class="pom-unit">min active</span>
        </div>
        <div class="pom-field" onclick="cmd('claude-blocker.setPomodoroBreak')">
          <span>☕</span>
          <span class="pom-value">${pomBreakMin}</span>
          <span class="pom-unit">min break</span>
        </div>
      </div>
      ${pomBtn}
    </div>
  </div>

  <div class="accordion" data-id="sessions">
    <div class="accordion-header" onclick="toggle('sessions')">
      <span>Active Sessions<span class="accordion-badge">${realSessions.length}</span></span>
      <span class="accordion-chevron">▾</span>
    </div>
    <div class="accordion-body">
      ${sessionsHtml}
    </div>
  </div>

  <div class="accordion" data-id="timeline">
    <div class="accordion-header" onclick="toggle('timeline')">
      <span>Activity Timeline</span>
      <span style="display:flex;align-items:center;gap:8px;">
        <span class="timeline-legend">
          <span class="legend-item"><span class="legend-dot" style="background:#4ec958"></span> Working</span>
          <span class="legend-item"><span class="legend-dot" style="background:#e8a838"></span> Waiting</span>
          <span class="legend-item"><span class="legend-dot" style="background:#555"></span> Idle</span>
        </span>
        <span class="accordion-chevron">▾</span>
      </span>
    </div>
    <div class="accordion-body">
      ${timelineHtml}
    </div>
  </div>

  <div class="accordion" data-id="today">
    <div class="accordion-header" onclick="toggle('today')">
      <span>Today</span>
      <span class="accordion-chevron">▾</span>
    </div>
    <div class="accordion-body">
      <div class="stats-grid">
        <div class="stat-card"><div class="stat-value">${esc(fmtMs(today.blockingMs))}</div><div class="stat-label">Blocked</div></div>
        <div class="stat-card"><div class="stat-value">${esc(fmtMs(today.unblockedMs))}</div><div class="stat-label">Unblocked</div></div>
        <div class="stat-card"><div class="stat-value">${today.sessionCount}</div><div class="stat-label">Sessions</div></div>
        <div class="stat-card"><div class="stat-value">${today.pomodoroCount}</div><div class="stat-label">Pomodoros</div></div>
      </div>
    </div>
  </div>

  <div class="accordion" data-id="alltime">
    <div class="accordion-header" onclick="toggle('alltime')">
      <span>All Time</span>
      <span class="accordion-chevron">▾</span>
    </div>
    <div class="accordion-body">
      <div class="stats-grid">
        <div class="stat-card"><div class="stat-value">${esc(fmtMs(all.blockingMs))}</div><div class="stat-label">Blocked</div></div>
        <div class="stat-card"><div class="stat-value">${all.sessionCount}</div><div class="stat-label">Sessions</div></div>
        <div class="stat-card"><div class="stat-value">${all.pomodoroCount}</div><div class="stat-label">Pomodoros</div></div>
        <div class="stat-card"><div class="stat-value">${all.days}</div><div class="stat-label">Days</div></div>
      </div>
    </div>
  </div>

  <div class="accordion" data-id="setup">
    <div class="accordion-header" onclick="toggle('setup')">
      <span>Setup</span>
      <span class="accordion-chevron">▾</span>
    </div>
    <div class="accordion-body">
      <div class="btn-row">
        <button class="btn" onclick="cmd('claude-blocker.openSettings')">⚙ Settings</button>
        <button class="btn" onclick="cmd('claude-blocker.testSound')">🔊 Test Sound</button>
      </div>
      <div style="margin-top:8px">${hookHtml}</div>
    </div>
  </div>

  <script>
    const vscode = acquireVsCodeApi();
    function cmd(command) { vscode.postMessage({ command }); }

    // Persist accordion state across re-renders
    const state = vscode.getState() || { collapsed: {} };
    function toggle(id) {
      state.collapsed[id] = !state.collapsed[id];
      vscode.setState(state);
      const el = document.querySelector('[data-id="' + id + '"]');
      if (el) el.classList.toggle('collapsed');
    }
    // Restore collapsed state on load
    for (const [id, collapsed] of Object.entries(state.collapsed)) {
      if (collapsed) {
        const el = document.querySelector('[data-id="' + id + '"]');
        if (el) el.classList.add('collapsed');
      }
    }
  </script>
</body>
</html>`;
  }

  dispose(): void {
    for (const u of this.unsubs) u();
  }
}
