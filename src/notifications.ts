import * as vscode from "vscode";
import { execFile } from "node:child_process";
import { join } from "node:path";
import { readdirSync, existsSync } from "node:fs";
import { platform } from "node:os";

export type SoundStyle = "none" | "custom" | "notification-unctuous" | "bright-bell" | "marimba-ascending" | "dry-bongos" | "message-notification" | "notification-sound";

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

  private getSoundConfig(key: string): { sound: SoundStyle; volume: number; customPath?: string } {
    const cfg = vscode.workspace.getConfiguration(`claudeBlocker.notifications.sound.${key}`);
    return {
      sound: cfg.get<string>("sound", "none") as SoundStyle,
      volume: cfg.get<number>("volume", 70),
      customPath: cfg.get<string>("customPath", ""),
    };
  }

  private getToastEnabled(): boolean {
    return vscode.workspace.getConfiguration("claudeBlocker.notifications.toast").get("enabled", true);
  }

  async onStopWorking(): Promise<void> {
    const cfg = this.getSoundConfig("onStopWorking");
    this.playSoundFromConfig(cfg);
    if (this.getToastEnabled()) {
      vscode.window.showInformationMessage("Claude finished — sites are now blocked", "Pause for 5 min").then(action => {
        if (action === "Pause for 5 min") vscode.commands.executeCommand("claude-blocker.suspend");
      });
    }
  }

  async onWaitingForInput(): Promise<void> {
    const cfg = this.getSoundConfig("onWaitingForInput");
    this.playSoundFromConfig(cfg);
    if (this.getToastEnabled()) {
      vscode.window.showInformationMessage("Claude is waiting for your input");
    }
  }

  async onPomodoroSwitch(phase: "active" | "break"): Promise<void> {
    const cfg = this.getSoundConfig("onPomodoroSwitch");
    this.playSoundFromConfig(cfg);
    if (this.getToastEnabled()) {
      vscode.window.showInformationMessage(phase === "break" ? "Pomodoro break — take a rest!" : "Break over — back to work!");
    }
  }

  async onSuspendExpired(): Promise<void> {
    const cfg = this.getSoundConfig("onSuspendExpired");
    this.playSoundFromConfig(cfg);
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

  testSound(name: string, volume = 70): void {
    if (name === "custom") return;
    const soundFile = this.findBundledSound(name);
    if (!soundFile) {
      vscode.window.showWarningMessage(`Sound file "${name}" not found`);
      return;
    }
    this.playFile(soundFile, volume);
  }

  private playSoundFromConfig(cfg: { sound: SoundStyle; volume: number; customPath?: string }): void {
    if (!this._soundEnabled || cfg.sound === "none") return;

    let file: string | null;
    if (cfg.sound === "custom") {
      file = cfg.customPath && existsSync(cfg.customPath) ? cfg.customPath : null;
      if (!file) return;
    } else {
      file = this.findBundledSound(cfg.sound);
      if (!file) return;
    }

    this.playFile(file, cfg.volume);
  }

  private findBundledSound(name: string): string | null {
    const dir = join(this.extensionPath, "media", "sounds");
    try {
      const file = readdirSync(dir).find(f => f.startsWith(name + "."));
      return file ? join(dir, file) : null;
    } catch { return null; }
  }

  private playFile(soundFile: string, volume: number): void {
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
