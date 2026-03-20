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
      this.item.text = "$(error) CB: Stopped";
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
