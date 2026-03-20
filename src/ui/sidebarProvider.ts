import * as vscode from "vscode";
import type { ServerManager } from "../server.js";
import type { Blocker } from "../blocker.js";
import type { Pomodoro } from "../pomodoro.js";
import type { StatsTracker } from "../stats.js";
import { areHooksConfigured } from "../hooks.js";

class SidebarItem extends vscode.TreeItem {
  constructor(
    label: string,
    collapsible: vscode.TreeItemCollapsibleState = vscode.TreeItemCollapsibleState.None,
    public children: SidebarItem[] = [],
  ) {
    super(label, collapsible);
  }
}

function fmtMs(ms: number): string {
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  return `${hrs}h ${mins % 60}m`;
}

export class SidebarProvider implements vscode.TreeDataProvider<SidebarItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
  private unsubs: (() => void)[] = [];
  private server: ServerManager;
  private blocker: Blocker;
  private pomodoro: Pomodoro;
  private stats: StatsTracker;
  private port: number;
  private viewId: string | null = null;

  constructor(server: ServerManager, blocker: Blocker, pomodoro: Pomodoro, stats: StatsTracker, port: number) {
    this.server = server;
    this.blocker = blocker;
    this.pomodoro = pomodoro;
    this.stats = stats;
    this.port = port;

    const refresh = () => this._onDidChangeTreeData.fire();
    this.unsubs.push(server.onStateChange(refresh));
    this.unsubs.push(blocker.onChange(refresh));
    this.unsubs.push(pomodoro.onChange(refresh));
  }

  refresh(): void { this._onDidChangeTreeData.fire(); }

  setViewId(id: string): void { this.viewId = id; }

  getTreeItem(element: SidebarItem): vscode.TreeItem { return element; }

  getChildren(element?: SidebarItem): SidebarItem[] {
    if (element) return element.children;

    switch (this.viewId) {
      case "claude-blocker.status": return this.getStatusItems();
      case "claude-blocker.controls": return this.getControlItems();
      case "claude-blocker.stats": return this.getStatsItems();
      case "claude-blocker.setup": return this.getSetupItems();
      default: return [];
    }
  }

  private getStatusItems(): SidebarItem[] {
    const s = this.server.status;
    const items: SidebarItem[] = [];

    if (s.state !== "running") {
      const item = new SidebarItem(`$(error) Server: ${s.state}`);
      if (s.error) item.description = s.error;
      items.push(item);
    } else {
      items.push(new SidebarItem(`$(check) Server running on port ${s.port}`));
      items.push(new SidebarItem(`Sessions: ${s.sessions.length}`));
      items.push(new SidebarItem(`Working: ${s.working}`));
      items.push(new SidebarItem(`Waiting: ${s.waitingForInput}`));
      items.push(new SidebarItem(`Blocked: ${s.blocked ? "Yes" : "No"}`));
    }

    const bState = this.blocker.state;
    if (bState !== "active") {
      items.push(new SidebarItem(`$(debug-pause) Blocker: ${bState}`));
    }

    const pState = this.pomodoro.state;
    if (pState.running) {
      items.push(new SidebarItem(`$(clock) Pomodoro: ${pState.phase}`));
    }

    return items;
  }

  private getControlItems(): SidebarItem[] {
    const items: SidebarItem[] = [];
    const isPaused = this.blocker.state !== "active";

    if (this.server.status.state !== "running") {
      const start = new SidebarItem("$(play) Start Server");
      start.command = { command: "claude-blocker.startServer", title: "Start" };
      items.push(start);
    } else {
      const stop = new SidebarItem("$(primitive-square) Stop Server");
      stop.command = { command: "claude-blocker.stopServer", title: "Stop" };
      items.push(stop);
    }

    if (isPaused) {
      const resume = new SidebarItem("$(play) Resume");
      resume.command = { command: "claude-blocker.resume", title: "Resume" };
      items.push(resume);
    } else {
      const pause = new SidebarItem("$(debug-pause) Pause");
      pause.command = { command: "claude-blocker.pause", title: "Pause" };
      items.push(pause);
    }

    const suspend = new SidebarItem("$(clock) Suspend...");
    suspend.command = { command: "claude-blocker.suspend", title: "Suspend" };
    items.push(suspend);

    const pomLabel = this.pomodoro.state.running ? "$(primitive-square) Stop Pomodoro" : "$(clock) Start Pomodoro";
    const pomCmd = this.pomodoro.state.running ? "claude-blocker.stopPomodoro" : "claude-blocker.startPomodoro";
    const pom = new SidebarItem(pomLabel);
    pom.command = { command: pomCmd, title: "Pomodoro" };
    items.push(pom);

    return items;
  }

  private getStatsItems(): SidebarItem[] {
    const today = this.stats.getToday();
    const all = this.stats.getAllTime();
    return [
      new SidebarItem(`--- Today ---`),
      new SidebarItem(`Blocking: ${fmtMs(today.blockingMs)}`),
      new SidebarItem(`Unblocked: ${fmtMs(today.unblockedMs)}`),
      new SidebarItem(`Sessions: ${today.sessionCount}`),
      new SidebarItem(`Pomodoros: ${today.pomodoroCount}`),
      new SidebarItem(`--- All Time ---`),
      new SidebarItem(`Blocking: ${fmtMs(all.blockingMs)}`),
      new SidebarItem(`Sessions: ${all.sessionCount}`),
      new SidebarItem(`Pomodoros: ${all.pomodoroCount}`),
      new SidebarItem(`Active days: ${all.days}`),
    ];
  }

  private getSetupItems(): SidebarItem[] {
    const hookStatus = areHooksConfigured(this.port);
    const items: SidebarItem[] = [];

    if (hookStatus === "installed") {
      items.push(new SidebarItem("$(check) Hooks installed"));
    } else if (hookStatus === "wrong-port") {
      const item = new SidebarItem("$(warning) Hooks: wrong port");
      item.command = { command: "claude-blocker.setupHooks", title: "Fix" };
      items.push(item);
    } else {
      const item = new SidebarItem("$(x) Hooks not installed");
      item.command = { command: "claude-blocker.setupHooks", title: "Install" };
      items.push(item);
    }

    const remove = new SidebarItem("$(trash) Remove Hooks");
    remove.command = { command: "claude-blocker.removeHooks", title: "Remove" };
    items.push(remove);

    items.push(new SidebarItem(`Port: ${this.port}`));
    return items;
  }

  dispose(): void {
    for (const u of this.unsubs) u();
    this._onDidChangeTreeData.dispose();
  }
}
