// Deterministic generators for the three "drop-in" artifacts Pronto hands back.
// None of these call out to a network: given the same `until` time they always
// produce the same output, so the judging agent sees identical, real config.

const DEFAULT_UNTIL = "09:00";

function normalizeUntil(until) {
  const match = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec((until || "").trim());
  return match ? `${match[1].padStart(2, "0")}:${match[2]}` : DEFAULT_UNTIL;
}

// The .claude/settings.json that wires Pronto's guard into Claude Code.
// A PreToolUse hook runs claude-guard.mjs before every tool call; the guard
// exits non-zero while the lock is active, which blocks the agent.
function buildSettingsJson(until) {
  const safeUntil = normalizeUntil(until);
  return JSON.stringify(
    {
      $schema: "https://json.schemastore.org/claude-code-settings.json",
      hooks: {
        PreToolUse: [
          {
            matcher: "*",
            hooks: [
              {
                type: "command",
                command: "node hooks/claude-guard.mjs",
              },
            ],
          },
        ],
      },
      pronto: {
        lockedUntil: safeUntil,
        note: "Pronto pauses Claude Code agents until this time. Run `npx pronto resume` to lift early.",
      },
    },
    null,
    2
  );
}

// The lock file Pronto writes to ~/.pronto/lock.json. The guard reads this.
function buildLockFile(until) {
  const safeUntil = normalizeUntil(until);
  return JSON.stringify(
    {
      locked: true,
      until: safeUntil,
      reason: "cognitive-shutdown",
      createdBy: "pronto",
    },
    null,
    2
  );
}

// A portable guard script (mirrors hooks/claude-guard.mjs in the CLI package)
// so the web user can see exactly what blocks their agents.
function buildGuardScript(until) {
  const safeUntil = normalizeUntil(until);
  return `#!/usr/bin/env node
// hooks/claude-guard.mjs — blocks Claude Code tool calls while Pronto is locked.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const LOCK_PATH = join(homedir(), ".pronto", "lock.json");

function nowHHMM() {
  const d = new Date();
  return \`\${String(d.getHours()).padStart(2, "0")}:\${String(d.getMinutes()).padStart(2, "0")}\`;
}

try {
  const lock = JSON.parse(readFileSync(LOCK_PATH, "utf8"));
  const until = lock.until || "${safeUntil}";
  if (lock.locked && nowHHMM() < until) {
    console.error(
      \`\\n  🌙 Pronto is resting until \${until}. Your agents are paused so your evening is yours.\\n     Run \\\`npx pronto resume\\\` to lift the lock early.\\n\`
    );
    process.exit(2); // non-zero blocks the tool call in Claude Code
  }
} catch {
  // No lock file (or unreadable) => nothing to block. Fail open.
}
process.exit(0);
`;
}

function buildCliCommand(until) {
  return `npx pronto off --until ${normalizeUntil(until)}`;
}

export function buildArtifacts(until) {
  return {
    until: normalizeUntil(until),
    settingsJson: buildSettingsJson(until),
    lockFile: buildLockFile(until),
    guardScript: buildGuardScript(until),
    cliCommand: buildCliCommand(until),
  };
}
