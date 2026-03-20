import * as vscode from "vscode";
import { execFile } from "node:child_process";
import { join } from "node:path";
import { readdirSync } from "node:fs";
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
    this.playSound(this.getSoundSetting("onStopWorking"));
    if (this.getToastEnabled()) {
      vscode.window.showInformationMessage("Claude finished — sites are now blocked", "Pause for 5 min").then(action => {
        if (action === "Pause for 5 min") vscode.commands.executeCommand("claude-blocker.suspend");
      });
    }
  }

  async onWaitingForInput(): Promise<void> {
    this.playSound(this.getSoundSetting("onWaitingForInput"));
    if (this.getToastEnabled()) {
      vscode.window.showInformationMessage("Claude is waiting for your input");
    }
  }

  async onPomodoroSwitch(phase: "active" | "break"): Promise<void> {
    this.playSound(this.getSoundSetting("onPomodoroSwitch"));
    if (this.getToastEnabled()) {
      vscode.window.showInformationMessage(phase === "break" ? "Pomodoro break — take a rest!" : "Break over — back to work!");
    }
  }

  async onSuspendExpired(): Promise<void> {
    this.playSound(this.getSoundSetting("onSuspendExpired"));
    if (this.getToastEnabled()) {
      vscode.window.showInformationMessage("Suspend expired — sites are now blocked");
    }
  }

  async onServerStopped(): Promise<void> {
    if (this.getToastEnabled()) {
      vscode.window.showWarningMessage("Claude Blocker server stopped unexpectedly", "Restart").then(action => {
        if (action === "Restart") vscode.commands.executeCommand("claude-blocker.startServer");
      });
    }
  }

  private findSoundFile(style: string): string | null {
    const dir = join(this.extensionPath, "media", "sounds");
    try {
      const file = readdirSync(dir).find(f => f.startsWith(style + "."));
      return file ? join(dir, file) : null;
    } catch { return null; }
  }

  private playSound(style: SoundStyle): void {
    if (!this._soundEnabled || style === "none") return;
    const soundFile = this.findSoundFile(style);
    if (!soundFile) return;
    const volume = this.getVolume();
    try {
      const os = platform();
      if (os === "darwin") {
        execFile("afplay", ["-v", String(volume / 100), soundFile]);
      } else if (os === "linux") {
        execFile("paplay", [soundFile], (err) => { if (err) execFile("aplay", [soundFile]); });
      } else if (os === "win32") {
        execFile("powershell", ["-c", `(New-Object Media.SoundPlayer '${soundFile}').PlaySync()`]);
      }
    } catch { /* best-effort */ }
  }

  dispose(): void {}
}
