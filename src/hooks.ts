import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

interface ClaudeSettings {
  hooks?: Record<string, unknown[]>;
  [key: string]: unknown;
}

const HOOK_EVENTS = [
  "SessionStart", "SessionEnd", "UserPromptSubmit",
  "PreToolUse", "PostToolUse", "Stop",
];

function getSettingsPath(): string {
  return join(homedir(), ".claude", "settings.json");
}

function makeHookCommand(port: number): string {
  return `curl -s -X POST http://localhost:${port}/hook -H 'Content-Type: application/json' -d "$(cat)" > /dev/null 2>&1 &`;
}

function buildHooksConfig(port: number): Record<string, unknown[]> {
  const command = makeHookCommand(port);
  const config: Record<string, unknown[]> = {};
  for (const event of HOOK_EVENTS) {
    if (event === "PreToolUse" || event === "PostToolUse") {
      config[event] = [{ matcher: "*", hooks: [{ type: "command", command }] }];
    } else {
      config[event] = [{ hooks: [{ type: "command", command }] }];
    }
  }
  return config;
}

export function areHooksConfigured(port: number): "installed" | "wrong-port" | "not-installed" {
  const settingsPath = getSettingsPath();
  if (!existsSync(settingsPath)) return "not-installed";
  try {
    const settings: ClaudeSettings = JSON.parse(readFileSync(settingsPath, "utf-8"));
    if (!settings.hooks) return "not-installed";
    const hasAny = HOOK_EVENTS.some(e => e in settings.hooks!);
    if (!hasAny) return "not-installed";
    const hookStr = JSON.stringify(settings.hooks);
    if (hookStr.includes(`localhost:${port}/hook`)) return "installed";
    return "wrong-port";
  } catch { return "not-installed"; }
}

export function setupHooks(port: number): void {
  const claudeDir = join(homedir(), ".claude");
  const settingsPath = join(claudeDir, "settings.json");
  if (!existsSync(claudeDir)) mkdirSync(claudeDir, { recursive: true });

  let settings: ClaudeSettings = {};
  if (existsSync(settingsPath)) {
    try { settings = JSON.parse(readFileSync(settingsPath, "utf-8")); } catch { /* start fresh */ }
  }
  settings.hooks = { ...settings.hooks, ...buildHooksConfig(port) };
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
}

export function removeHooks(): void {
  const settingsPath = getSettingsPath();
  if (!existsSync(settingsPath)) return;
  try {
    const settings: ClaudeSettings = JSON.parse(readFileSync(settingsPath, "utf-8"));
    if (!settings.hooks) return;
    for (const event of HOOK_EVENTS) delete settings.hooks[event];
    if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  } catch { /* ignore */ }
}
