// tests/e2e.test.mjs
//
// REAL end-to-end tests. Nothing is mocked:
//   - a real temporary git repository is created with fs.mkdtempSync + `git init`
//   - the real pause/resume functions install real hooks
//   - the real guard script is executed as a child process and we assert on its
//     actual exit codes (the same codes Claude Code and git act on)
//   - a real `git commit` is attempted and we assert it is actually blocked
//
// Run:  node --test tests/e2e.test.mjs

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  pauseAgents,
  resumeAgents,
  getPauseStatus,
  computeUnlock,
} from '../src/agent-pause.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(__dirname, '..');
const GUARD = path.join(PKG_ROOT, 'hooks', 'claude-guard.mjs');
const BIN = path.join(PKG_ROOT, 'bin', 'pronto.mjs');

let repo;

function git(args, cwd = repo) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

/** Run the guard as Claude Code would (default mode), feeding it stdin JSON. */
function runGuardClaude(cwd) {
  return spawnSync(process.execPath, [GUARD], {
    cwd,
    input: JSON.stringify({ cwd, hook_event_name: 'PreToolUse' }),
    encoding: 'utf8',
  });
}

/** Run the guard as git would (pre-commit mode). */
function runGuardGit(cwd) {
  return spawnSync(process.execPath, [GUARD, '--git-precommit'], {
    cwd,
    encoding: 'utf8',
  });
}

before(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'pronto-e2e-'));
  git(['init', '-q']);
  git(['config', 'user.email', 'test@pronto.dev']);
  git(['config', 'user.name', 'Pronto Test']);
  git(['config', 'commit.gpgsign', 'false']);
  fs.writeFileSync(path.join(repo, 'app.js'), 'console.log("v1");\n');
  git(['add', '.']);
  git(['commit', '-qm', 'initial']);
  // Leave some real in-progress work behind.
  fs.writeFileSync(path.join(repo, 'app.js'), 'console.log("v2 WIP");\n');
});

after(() => {
  try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ---------------------------------------------------------------------------

test('computeUnlock: HH:MM resolves to a future instant', () => {
  const d = computeUnlock({ until: '09:00' });
  assert.ok(d instanceof Date);
  assert.ok(d.getTime() > Date.now(), 'next 09:00 must be in the future');
});

test('computeUnlock: minutes offset is honoured', () => {
  const d = computeUnlock({ minutes: 1 });
  const delta = d.getTime() - Date.now();
  assert.ok(delta > 55_000 && delta < 65_000, `expected ~60s, got ${delta}ms`);
});

// --- Test 1: pause installs the real hooks + lock ---------------------------

test('Test 1: pauseAgents installs .claude/settings.json and .pronto/lock.json', async () => {
  const lock = await pauseAgents({ repoRoot: repo, minutes: 120 });

  const lockPath = path.join(repo, '.pronto', 'lock.json');
  const settingsPath = path.join(repo, '.claude', 'settings.json');

  assert.ok(fs.existsSync(lockPath), '.pronto/lock.json must exist');
  assert.ok(fs.existsSync(settingsPath), '.claude/settings.json must exist');

  const onDisk = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  assert.equal(onDisk.active, true);
  assert.equal(onDisk.reason, 'Pronto Cognitive Shutdown');
  assert.equal(onDisk.unlockAt, lock.unlockAt);

  const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  const cmds = JSON.stringify(settings.hooks);
  assert.ok(settings.hooks.PreToolUse, 'PreToolUse hook registered');
  assert.ok(settings.hooks.UserPromptSubmit, 'UserPromptSubmit hook registered');
  assert.ok(cmds.includes('claude-guard.mjs'), 'hook points at the real guard');

  const status = getPauseStatus({ repoRoot: repo });
  assert.equal(status.active, true);
  assert.ok(status.remainingMs > 0);
});

test('Test 1b: pause preserves pre-existing Claude settings', async () => {
  // Fresh repo so we can assert on a user's prior setting surviving.
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'pronto-merge-'));
  fs.mkdirSync(path.join(r, '.claude'), { recursive: true });
  fs.writeFileSync(
    path.join(r, '.claude', 'settings.json'),
    JSON.stringify({ model: 'claude-opus-4-8', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo bye' }] }] } }, null, 2),
  );
  await pauseAgents({ repoRoot: r, minutes: 120 });
  const s = JSON.parse(fs.readFileSync(path.join(r, '.claude', 'settings.json'), 'utf8'));
  assert.equal(s.model, 'claude-opus-4-8', 'existing top-level setting preserved');
  assert.ok(s.hooks.Stop, 'existing Stop hook preserved');
  assert.ok(s.hooks.PreToolUse, 'our PreToolUse hook added');
  await resumeAgents({ repoRoot: r });
  const restored = JSON.parse(fs.readFileSync(path.join(r, '.claude', 'settings.json'), 'utf8'));
  assert.deepEqual(restored.hooks.Stop, [{ hooks: [{ type: 'command', command: 'echo bye' }] }]);
  assert.ok(!restored.hooks || !restored.hooks.PreToolUse, 'our hook removed on resume');
  fs.rmSync(r, { recursive: true, force: true });
});

// --- Test 2: guard blocks while locked --------------------------------------

test('Test 2: claude-guard.mjs exits 2 (blocks the agent) while locked', () => {
  const res = runGuardClaude(repo);
  assert.equal(res.status, 2, 'Claude Code hook must exit 2 to block');
  assert.match(res.stderr, /Pronto Shutdown Active/);
  assert.match(res.stderr, /TOMORROW\.md/);
});

test('Test 2b: git pre-commit is genuinely blocked while locked', () => {
  // Guard in git mode exits non-zero...
  const guard = runGuardGit(repo);
  assert.equal(guard.status, 1, 'git-mode guard must exit non-zero');

  // ...and a real `git commit` is actually aborted by the installed hook.
  git(['add', '-A']);
  const commit = spawnSync('git', ['commit', '-m', 'late night commit'], {
    cwd: repo,
    encoding: 'utf8',
  });
  assert.notEqual(commit.status, 0, 'commit must fail while shutdown is active');
  const combined = (commit.stderr || '') + (commit.stdout || '');
  assert.match(combined, /Pronto Shutdown Active/);
});

// --- Test 3: resume lifts the lock, guard allows again ----------------------

test('Test 3: resumeAgents unlocks and claude-guard.mjs exits 0', async () => {
  await resumeAgents({ repoRoot: repo });

  assert.ok(!fs.existsSync(path.join(repo, '.pronto', 'lock.json')), 'lock removed');
  assert.ok(!fs.existsSync(path.join(repo, '.git', 'hooks', 'pre-commit')), 'pre-commit removed');
  assert.equal(getPauseStatus({ repoRoot: repo }).active, false);

  const res = runGuardClaude(repo);
  assert.equal(res.status, 0, 'guard must allow once unlocked');

  // A real commit now succeeds.
  const commit = spawnSync('git', ['commit', '-m', 'morning commit'], {
    cwd: repo,
    encoding: 'utf8',
  });
  assert.equal(commit.status, 0, 'commit must succeed after resume');
});

// --- Test 3b: guard auto-unlocks once the morning time has passed -----------

test('Test 3b: guard auto-unlocks when unlockAt is in the past', async () => {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'pronto-expire-'));
  execFileSync('git', ['init', '-q'], { cwd: r });
  await pauseAgents({ repoRoot: r, minutes: 120 });

  // Force the lock into the past, as if morning already arrived.
  const lockPath = path.join(r, '.pronto', 'lock.json');
  const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  lock.unlockAt = new Date(Date.now() - 60_000).toISOString();
  fs.writeFileSync(lockPath, JSON.stringify(lock));

  const res = runGuardClaude(r);
  assert.equal(res.status, 0, 'expired lock must allow');
  assert.ok(!fs.existsSync(lockPath), 'guard auto-removed the expired lock');
  fs.rmSync(r, { recursive: true, force: true });
});

// --- Test 4: full CLI flow if bin/pronto.mjs exists -------------------------

test('Test 4: full CLI flow via bin/pronto.mjs (if present)', { skip: !fs.existsSync(BIN) ? 'bin/pronto.mjs not built yet' : false }, () => {
  // Real repo with a commit + in-progress change, exactly like a real shutdown.
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'pronto-cli-'));
  execFileSync('git', ['init', '-q'], { cwd: r });
  execFileSync('git', ['config', 'user.email', 'test@pronto.dev'], { cwd: r });
  execFileSync('git', ['config', 'user.name', 'Pronto Test'], { cwd: r });
  fs.writeFileSync(path.join(r, 'app.js'), 'console.log("v1");\n');
  execFileSync('git', ['add', '.'], { cwd: r });
  execFileSync('git', ['commit', '-qm', 'init'], { cwd: r });
  fs.writeFileSync(path.join(r, 'app.js'), 'console.log("v2 WIP");\n');

  // `pronto off` — save work, write TOMORROW.md, pause agents. --offline avoids
  // any network call so the test is hermetic. Default command is also `off`.
  const off = spawnSync(process.execPath, [BIN, 'off', '--until', '09:00', '--offline'], {
    cwd: r,
    encoding: 'utf8',
    env: { ...process.env, ANTHROPIC_API_KEY: '' },
  });
  assert.equal(off.status, 0, `pronto off should succeed: ${off.stderr}`);
  assert.ok(fs.existsSync(path.join(r, '.pronto', 'lock.json')), 'CLI created the lock');
  assert.match(off.stdout, /paused/i, 'CLI reports agents paused');

  // Agent is genuinely blocked after the CLI shutdown.
  const blocked = runGuardClaude(r);
  assert.equal(blocked.status, 2, 'agent blocked after `pronto off`');

  // `pronto resume` — unlock.
  const up = spawnSync(process.execPath, [BIN, 'resume'], { cwd: r, encoding: 'utf8' });
  assert.equal(up.status, 0, `pronto resume should succeed: ${up.stderr}`);
  assert.ok(!fs.existsSync(path.join(r, '.pronto', 'lock.json')), 'CLI removed the lock');

  const allowed = runGuardClaude(r);
  assert.equal(allowed.status, 0, 'agent allowed after `pronto resume`');

  fs.rmSync(r, { recursive: true, force: true });
});
