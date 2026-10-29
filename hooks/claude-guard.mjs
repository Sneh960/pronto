#!/usr/bin/env node
// hooks/claude-guard.mjs
//
// The Pronto guard. This is the REAL script that Claude Code executes for the
// PreToolUse / UserPromptSubmit hook events, and that git executes as the
// pre-commit hook. It is the single source of truth for "are we still locked?".
//
// Modes:
//   (default)          Claude Code hook. Blocks with exit(2) + stderr message.
//   --git-precommit    git pre-commit hook. Blocks with exit(1) + stderr message.
//
// Behaviour:
//   - No lock, or lock inactive  -> exit 0 (allow).
//   - now  <  unlockAt           -> BLOCK (exit 2 / 1) with the shutdown notice.
//   - now >= unlockAt            -> auto-unlock (restore everything) and exit 0.
//
// Fail-open: any unexpected error allows the action, so a bug here can never
// permanently brick a developer's tooling.

import fs from 'node:fs';
import path from 'node:path';
import { findProntoRoot, resumeAgents } from '../src/agent-pause.mjs';

const GIT_MODE = process.argv.includes('--git-precommit');

function readJsonSafe(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

// Claude Code passes a JSON payload on stdin (includes `cwd`). We read it best
// effort — if nothing arrives quickly we just fall back to process.cwd().
function readStdinJson() {
  return new Promise((resolve) => {
    if (GIT_MODE || process.stdin.isTTY) return resolve(null);
    let data = '';
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      try { resolve(JSON.parse(data)); } catch { resolve(null); }
    };
    const timer = setTimeout(finish, 300);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => { data += c; });
    process.stdin.on('end', () => { clearTimeout(timer); finish(); });
    process.stdin.on('error', () => { clearTimeout(timer); finish(); });
  });
}

function formatTime(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function block(unlockIso) {
  const msg =
    `🛑 Pronto Shutdown Active until ${formatTime(unlockIso)}. ` +
    `Your context is safely stored in TOMORROW.md. Close the terminal and rest. ` +
    '(Run `npx pronto resume` for emergencies).';
  process.stderr.write(msg + '\n');
  // git aborts a commit on any non-zero exit; Claude Code treats exit 2 as a
  // blocking error and feeds stderr back to the model.
  process.exit(GIT_MODE ? 1 : 2);
}

async function main() {
  const stdin = await readStdinJson();
  const startDir =
    (stdin && typeof stdin.cwd === 'string' && stdin.cwd) || process.cwd();

  const repoRoot = findProntoRoot(startDir);
  if (!repoRoot) process.exit(0); // nothing locked anywhere above us

  const lock = readJsonSafe(path.join(repoRoot, '.pronto', 'lock.json'));
  if (!lock || !lock.active) process.exit(0);

  const unlockMs = Date.parse(lock.unlockAt);
  if (Number.isNaN(unlockMs)) process.exit(0); // malformed -> fail open

  if (Date.now() >= unlockMs) {
    // Morning has arrived: lift the shutdown automatically, then allow.
    try { await resumeAgents({ repoRoot }); } catch { /* fail open */ }
    process.exit(0);
  }

  block(lock.unlockAt);
}

main().catch(() => process.exit(0)); // fail open on any unexpected error
