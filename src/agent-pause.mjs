// src/agent-pause.mjs
//
// Pronto — "The Agent Blocker"
//
// Genuinely pauses Claude Code agents and git commits until morning by
// installing REAL Claude Code hooks (.claude/settings.json) and a REAL
// git pre-commit hook. No mocks, no fakes — these are the same mechanisms
// Claude Code and git actually execute.
//
// Public API:
//   pauseAgents({ until, minutes, repoRoot })  -> installs the shutdown
//   resumeAgents({ repoRoot })                 -> cleanly removes it
//   getPauseStatus({ repoRoot })               -> inspect current lock
//   findProntoRoot(startDir)                   -> walk up to the locked repo
//
// Everything is non-destructive: existing settings and hooks are backed up
// and restored exactly on resume.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(__dirname, '..');
const GUARD_PATH = path.join(PKG_ROOT, 'hooks', 'claude-guard.mjs');

export const LOCK_REASON = 'Pronto Cognitive Shutdown';

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

// Accept either `repoRoot` (this module's name) or `cwd` (the name bin/pronto.mjs
// uses) so the CLI and the hook integrate without a translation layer.
function resolveRoot({ repoRoot, cwd } = {}) {
  return path.resolve(repoRoot || cwd || process.cwd());
}

function paths(repoRoot) {
  const root = path.resolve(repoRoot);
  const prontoDir = path.join(root, '.pronto');
  const backupsDir = path.join(prontoDir, 'backups');
  return {
    root,
    prontoDir,
    backupsDir,
    lock: path.join(prontoDir, 'lock.json'),
    manifest: path.join(backupsDir, 'manifest.json'),
    claudeDir: path.join(root, '.claude'),
    claudeSettings: path.join(root, '.claude', 'settings.json'),
    claudeBackup: path.join(backupsDir, 'claude-settings.json.bak'),
    gitHooksDir: path.join(root, '.git', 'hooks'),
    preCommit: path.join(root, '.git', 'hooks', 'pre-commit'),
    preCommitBackup: path.join(backupsDir, 'pre-commit.bak'),
  };
}

function readJsonSafe(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
}

/**
 * Walk up from startDir looking for a repo that holds `.pronto/lock.json`.
 * Returns the repo root (dir containing .pronto) or null.
 */
export function findProntoRoot(startDir = process.cwd()) {
  let dir = path.resolve(startDir);
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (fs.existsSync(path.join(dir, '.pronto', 'lock.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

// ---------------------------------------------------------------------------
// Unlock-time computation
// ---------------------------------------------------------------------------

/**
 * Resolve the exact unlock Date from flexible input:
 *   - minutes (number)     : N minutes from now  (great for --minutes 1 tests)
 *   - until  (number)      : N minutes from now
 *   - until  "HH:MM"       : next local occurrence of that time
 *   - until  ISO string    : that exact instant
 */
export function computeUnlock({ until = '09:00', minutes } = {}) {
  if (typeof minutes === 'number' && !Number.isNaN(minutes)) {
    return new Date(Date.now() + minutes * 60_000);
  }
  if (typeof until === 'number' && !Number.isNaN(until)) {
    return new Date(Date.now() + until * 60_000);
  }
  if (typeof until === 'string' && /^\d{1,2}:\d{2}$/.test(until)) {
    const [h, m] = until.split(':').map(Number);
    const d = new Date();
    d.setHours(h, m, 0, 0);
    if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1); // next occurrence
    return d;
  }
  const parsed = new Date(until);
  if (!Number.isNaN(parsed.getTime())) return parsed;
  throw new Error(`pronto: cannot understand unlock time "${until}"`);
}

// ---------------------------------------------------------------------------
// Claude Code settings.json hook (de)installation
// ---------------------------------------------------------------------------

function guardCommand() {
  // `node` is on PATH inside Claude Code's hook environment.
  return `node "${GUARD_PATH}"`;
}

function eventHasOurCommand(entries, cmd) {
  return (entries || []).some((e) =>
    (e.hooks || []).some((h) => h && h.command === cmd),
  );
}

function stripOurCommand(entries, cmd) {
  return (entries || [])
    .map((e) => ({ ...e, hooks: (e.hooks || []).filter((h) => h && h.command !== cmd) }))
    .filter((e) => (e.hooks || []).length > 0);
}

function installClaudeHook(settings) {
  const cmd = guardCommand();
  settings.hooks = settings.hooks || {};

  // PreToolUse — blocks any tool call (edits, bash, etc.) while locked.
  settings.hooks.PreToolUse = settings.hooks.PreToolUse || [];
  if (!eventHasOurCommand(settings.hooks.PreToolUse, cmd)) {
    settings.hooks.PreToolUse.push({
      matcher: '*',
      hooks: [{ type: 'command', command: cmd }],
    });
  }

  // UserPromptSubmit — blocks new prompts while locked (no matcher field).
  settings.hooks.UserPromptSubmit = settings.hooks.UserPromptSubmit || [];
  if (!eventHasOurCommand(settings.hooks.UserPromptSubmit, cmd)) {
    settings.hooks.UserPromptSubmit.push({
      hooks: [{ type: 'command', command: cmd }],
    });
  }
  return settings;
}

function removeClaudeHook(settings) {
  const cmd = guardCommand();
  if (!settings || !settings.hooks) return settings;
  for (const evt of ['PreToolUse', 'UserPromptSubmit']) {
    if (settings.hooks[evt]) {
      settings.hooks[evt] = stripOurCommand(settings.hooks[evt], cmd);
      if (settings.hooks[evt].length === 0) delete settings.hooks[evt];
    }
  }
  if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
  return settings;
}

// ---------------------------------------------------------------------------
// Git pre-commit hook (de)installation
// ---------------------------------------------------------------------------

function preCommitScript() {
  // Use the exact node binary that installed us so the hook works even when
  // git runs with a minimal PATH. Delegates the decision to the shared guard.
  return [
    '#!/bin/sh',
    '# Installed by Pronto (Cognitive Shutdown). Blocks commits until morning.',
    '# Restored automatically by `pronto resume`.',
    `"${process.execPath}" "${GUARD_PATH}" --git-precommit`,
    'exit $?',
    '',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// pauseAgents
// ---------------------------------------------------------------------------

export async function pauseAgents({ until = '09:00', minutes, unlockAt, repoRoot, cwd } = {}) {
  const p = paths(resolveRoot({ repoRoot, cwd }));
  // The CLI pre-computes the unlock instant and passes it as `unlockAt`; honour
  // it as the single source of truth, otherwise derive it from until/minutes.
  const unlock = unlockAt
    ? (unlockAt instanceof Date ? unlockAt : new Date(unlockAt))
    : computeUnlock({ until, minutes });
  if (Number.isNaN(unlock.getTime())) {
    throw new Error(`pronto: invalid unlock time "${unlockAt ?? until}"`);
  }

  fs.mkdirSync(p.prontoDir, { recursive: true });
  fs.mkdirSync(p.backupsDir, { recursive: true });

  const existingLock = readJsonSafe(p.lock, null);
  const alreadyActive = existingLock && existingLock.active;

  // Back up originals exactly once (first time we lock).
  if (!alreadyActive) {
    const manifest = {
      hadClaudeSettings: fs.existsSync(p.claudeSettings),
      hadPreCommit: fs.existsSync(p.preCommit),
      installedAt: new Date().toISOString(),
    };
    if (manifest.hadClaudeSettings) fs.copyFileSync(p.claudeSettings, p.claudeBackup);
    if (manifest.hadPreCommit) fs.copyFileSync(p.preCommit, p.preCommitBackup);
    writeJson(p.manifest, manifest);
  }

  // Install the REAL Claude Code hook, preserving any existing settings.
  fs.mkdirSync(p.claudeDir, { recursive: true });
  const settings = readJsonSafe(p.claudeSettings, {});
  installClaudeHook(settings);
  writeJson(p.claudeSettings, settings);

  // Install the REAL git pre-commit guard (only if this is a git repo).
  if (fs.existsSync(path.join(p.root, '.git'))) {
    fs.mkdirSync(p.gitHooksDir, { recursive: true });
    fs.writeFileSync(p.preCommit, preCommitScript(), { mode: 0o755 });
    fs.chmodSync(p.preCommit, 0o755);
  }

  // Write the lock LAST so the guards only ever see a fully-installed state.
  const lock = {
    active: true,
    lockedAt: new Date().toISOString(),
    unlockAt: unlock.toISOString(),
    reason: LOCK_REASON,
    until,
    guard: GUARD_PATH,
  };
  writeJson(p.lock, lock);

  return lock;
}

// ---------------------------------------------------------------------------
// resumeAgents
// ---------------------------------------------------------------------------

export async function resumeAgents({ repoRoot, cwd } = {}) {
  const p = paths(resolveRoot({ repoRoot, cwd }));
  const manifest = readJsonSafe(p.manifest, null);

  // --- Restore .claude/settings.json ---
  if (manifest) {
    if (manifest.hadClaudeSettings && fs.existsSync(p.claudeBackup)) {
      fs.copyFileSync(p.claudeBackup, p.claudeSettings);
    } else {
      // We created it — remove it (and the dir if we left it empty).
      if (fs.existsSync(p.claudeSettings)) fs.rmSync(p.claudeSettings);
      try { fs.rmdirSync(p.claudeDir); } catch { /* not empty: leave it */ }
    }
  } else if (fs.existsSync(p.claudeSettings)) {
    // No manifest (e.g. partial state): surgically strip only our hook.
    const settings = readJsonSafe(p.claudeSettings, {});
    removeClaudeHook(settings);
    writeJson(p.claudeSettings, settings);
  }

  // --- Restore .git/hooks/pre-commit ---
  if (manifest) {
    if (manifest.hadPreCommit && fs.existsSync(p.preCommitBackup)) {
      fs.copyFileSync(p.preCommitBackup, p.preCommit);
      fs.chmodSync(p.preCommit, 0o755);
    } else if (fs.existsSync(p.preCommit)) {
      fs.rmSync(p.preCommit);
    }
  } else if (fs.existsSync(p.preCommit)) {
    const body = fs.readFileSync(p.preCommit, 'utf8');
    if (body.includes('claude-guard.mjs')) fs.rmSync(p.preCommit);
  }

  // --- Drop the lock + backups ---
  if (fs.existsSync(p.lock)) fs.rmSync(p.lock);
  try { fs.rmSync(p.backupsDir, { recursive: true, force: true }); } catch { /* ignore */ }

  return { resumed: true, repoRoot: p.root };
}

// ---------------------------------------------------------------------------
// getPauseStatus
// ---------------------------------------------------------------------------

export function getPauseStatus({ repoRoot, cwd } = {}) {
  const p = paths(resolveRoot({ repoRoot, cwd }));
  const lock = readJsonSafe(p.lock, null);
  if (!lock || !lock.active) return { active: false };

  const unlockMs = Date.parse(lock.unlockAt);
  const remainingMs = Math.max(0, unlockMs - Date.now());
  return {
    active: true,
    lockedAt: lock.lockedAt,
    unlockAt: lock.unlockAt,
    reason: lock.reason,
    remainingMs,
    expired: Date.now() >= unlockMs,
  };
}

/**
 * Status in the shape bin/pronto.mjs consumes: `{ paused, until, ... }`.
 * A lock that is past its unlock time reports `paused: false` (morning has come).
 */
export function getStatus({ repoRoot, cwd } = {}) {
  const s = getPauseStatus({ repoRoot, cwd });
  if (!s.active) return { paused: false };
  return {
    paused: !s.expired,
    until: s.unlockAt, // ISO string; `new Date(until)` in the CLI parses it
    unlockAt: s.unlockAt,
    remainingMs: s.remainingMs,
    reason: s.reason,
  };
}

export { GUARD_PATH, PKG_ROOT };
