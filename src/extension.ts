import * as vscode from "vscode";
import { ServerManager } from "./server.js";
import { Blocker } from "./blocker.js";
import { Pomodoro } from "./pomodoro.js";
import { NotificationManager } from "./notifications.js";
import { StatsTracker } from "./stats.js";
import { StatusBar } from "./ui/statusBar.js";
import { SidebarProvider } from "./ui/sidebarProvider.js";
import { ActivityTracker } from "./activityTracker.js";
import { areHooksConfigured, setupHooks, removeHooks } from "./hooks.js";

export function activate(context: vscode.ExtensionContext) {
  const config = vscode.workspace.getConfiguration("claudeBlocker");
  const port = config.get<number>("port", 8765);
  const autoStart = config.get<boolean>("autoStart", true);
  const activeMin = config.get<number>("pomodoro.activeMinutes", 25);
  const breakMin = config.get<number>("pomodoro.breakMinutes", 5);

  const server = new ServerManager(context.extensionPath, port);
  const blocker = new Blocker(server);
  const pomodoro = new Pomodoro(blocker, activeMin, breakMin);
  const notifications = new NotificationManager(context.extensionPath);
  const stats = new StatsTracker(context.globalState, server);
  const activity = new ActivityTracker(server);
  const statusBar = new StatusBar(server, blocker, pomodoro);

  const sidebarProvider = new SidebarProvider(server, blocker, pomodoro, stats, activity, port);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("claude-blocker.panel", sidebarProvider),
  );

  const refreshAll = () => sidebarProvider.refresh();

  // Notification triggers
  let prevWorking = 0;
  let prevWaiting = 0;
  let waitingTimer: ReturnType<typeof setTimeout> | null = null;
  server.onStateChange((status) => {
    if (status.state !== "running") return;
    if (prevWorking > 0 && status.working === 0 && status.waitingForInput === 0 && blocker.state === "active") {
      notifications.onStopWorking();
    }
    if (prevWaiting === 0 && status.waitingForInput > 0) {
      // Debounce: only notify if still waiting after 5s (filters auto-approved tools)
      waitingTimer = setTimeout(() => {
        if (server.status.waitingForInput > 0) {
          notifications.onWaitingForInput();
        }
      }, 5000);
    }
    if (prevWaiting > 0 && status.waitingForInput === 0 && waitingTimer) {
      clearTimeout(waitingTimer);
      waitingTimer = null;
    }
    prevWorking = status.working;
    prevWaiting = status.waitingForInput;
  });

  pomodoro.onPhaseChange((phase) => {
    notifications.onPomodoroSwitch(phase);
    if (phase === "active") stats.recordPomodoro();
  });

  blocker.onSuspendExpired(() => notifications.onSuspendExpired());

  // Commands
  const cmds: [string, () => void | Promise<void>][] = [
    ["claude-blocker.startServer", () => server.start()],
    ["claude-blocker.stopServer", () => server.stop()],
    ["claude-blocker.pause", () => { blocker.pause(); stats.recordPause(); }],
    ["claude-blocker.resume", () => blocker.resume()],
    ["claude-blocker.suspend", async () => {
      const presets = config.get<number[]>("suspendPresets", [5, 10, 15, 30]);
      const items = [...presets.map(m => ({ label: `${m} minutes`, value: m })), { label: "Custom...", value: -1 }];
      const picked = await vscode.window.showQuickPick(items, { placeHolder: "Suspend for how long?" });
      if (!picked) return;
      let minutes = picked.value;
      if (minutes === -1) {
        const input = await vscode.window.showInputBox({ prompt: "Minutes", validateInput: v => isNaN(Number(v)) ? "Enter a number" : null });
        if (!input) return;
        minutes = Number(input);
      }
      blocker.suspend(minutes);
      stats.recordPause();
    }],
    ["claude-blocker.startPomodoro", () => pomodoro.start()],
    ["claude-blocker.stopPomodoro", () => pomodoro.stop()],
    ["claude-blocker.togglePomodoro", () => pomodoro.toggle()],
    ["claude-blocker.toggleSound", () => {
      notifications.toggleSound();
      vscode.window.showInformationMessage(`Sound ${notifications.soundEnabled ? "enabled" : "disabled"}`);
    }],
    ["claude-blocker.showStats", () => {
      const today = stats.getToday();
      const all = stats.getAllTime();
      const fmt = (ms: number) => `${Math.floor(ms / 60000)}m`;
      vscode.window.showInformationMessage(
        `Today: ${fmt(today.blockingMs)} blocked, ${today.sessionCount} sessions, ${today.pomodoroCount} pomodoros | ` +
        `All time: ${fmt(all.blockingMs)} blocked, ${all.sessionCount} sessions over ${all.days} days`
      );
    }],
    ["claude-blocker.openSettings", () => {
      vscode.commands.executeCommand("workbench.action.openSettings", "claudeBlocker");
    }],
    ["claude-blocker.testSound", async () => {
      const sounds = ["notification-unctuous", "bright-bell", "marimba-ascending", "dry-bongos", "message-notification", "notification-sound"];
      const picked = await vscode.window.showQuickPick(sounds, { placeHolder: "Pick a sound to test" });
      if (picked) notifications.testSound(picked);
    }],
    ["claude-blocker.setPomodoroActive", async () => {
      const input = await vscode.window.showInputBox({ prompt: "Active phase (minutes)", value: String(config.get<number>("pomodoro.activeMinutes", 25)), validateInput: v => isNaN(Number(v)) || Number(v) <= 0 ? "Enter a positive number" : null });
      if (!input) return;
      await config.update("pomodoro.activeMinutes", Number(input), true);
      pomodoro.updateSettings(Number(input), config.get<number>("pomodoro.breakMinutes", 5));
      refreshAll();
    }],
    ["claude-blocker.setPomodoroBreak", async () => {
      const input = await vscode.window.showInputBox({ prompt: "Break phase (minutes)", value: String(config.get<number>("pomodoro.breakMinutes", 5)), validateInput: v => isNaN(Number(v)) || Number(v) <= 0 ? "Enter a positive number" : null });
      if (!input) return;
      await config.update("pomodoro.breakMinutes", Number(input), true);
      pomodoro.updateSettings(config.get<number>("pomodoro.activeMinutes", 25), Number(input));
      refreshAll();
    }],
    ["claude-blocker.setupHooks", () => { setupHooks(port); vscode.window.showInformationMessage("Claude Blocker hooks installed"); refreshAll(); }],
    ["claude-blocker.removeHooks", () => { removeHooks(); vscode.window.showInformationMessage("Claude Blocker hooks removed"); refreshAll(); }],
    ["claude-blocker.quickPick", async () => {
      const isPaused = blocker.state !== "active";
      const isPom = pomodoro.state.running;
      const items = [
        isPaused ? { label: "$(play) Resume", cmd: "claude-blocker.resume" }
                 : { label: "$(debug-pause) Pause", cmd: "claude-blocker.pause" },
        { label: "$(clock) Suspend...", cmd: "claude-blocker.suspend" },
        isPom ? { label: "$(primitive-square) Stop Pomodoro", cmd: "claude-blocker.stopPomodoro" }
              : { label: "$(clock) Start Pomodoro", cmd: "claude-blocker.startPomodoro" },
        { label: "$(graph) Show Stats", cmd: "claude-blocker.showStats" },
      ];
      const picked = await vscode.window.showQuickPick(items, { placeHolder: "Claude Blocker" });
      if (picked) vscode.commands.executeCommand(picked.cmd);
    }],
  ];

  for (const [id, handler] of cmds) {
    context.subscriptions.push(vscode.commands.registerCommand(id, handler));
  }

  // Config change listener
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(e => {
    if (e.affectsConfiguration("claudeBlocker.pomodoro")) {
      pomodoro.updateSettings(
        config.get<number>("pomodoro.activeMinutes", 25),
        config.get<number>("pomodoro.breakMinutes", 5),
      );
    }
  }));

  // Auto-start
  if (autoStart) server.start();

  // Prompt to install hooks if missing or incomplete
  const hookStatus = areHooksConfigured(port);
  if (hookStatus === "not-installed" || hookStatus === "incomplete") {
    const label = hookStatus === "incomplete" ? "Some Claude Code hooks are missing." : "Claude Blocker needs to configure Claude Code hooks.";
    vscode.window.showInformationMessage(label, "Set up now").then(action => {
      if (action === "Set up now") { setupHooks(port); vscode.window.showInformationMessage("Hooks installed!"); refreshAll(); }
    });
  } else if (hookStatus === "wrong-port") {
    vscode.window.showWarningMessage(`Claude Blocker hooks are configured for a different port. Update to port ${port}?`, "Update").then(action => {
      if (action === "Update") { setupHooks(port); refreshAll(); }
    });
  }

  // Cleanup
  context.subscriptions.push({ dispose: () => {
    statusBar.dispose();
    pomodoro.dispose();
    blocker.dispose();
    stats.dispose();
    notifications.dispose();
    sidebarProvider.dispose();
    activity.dispose();
    server.dispose();
  }});
}

export function deactivate() {}
