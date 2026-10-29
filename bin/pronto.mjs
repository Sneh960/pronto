#!/usr/bin/env node
// pronto: end-of-day shutdown. Saves open work, writes TOMORROW.md, pauses
// coding agents until morning. Never asks a question.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { findRoot, readState, saveOpenWork, writeState } from '../src/git-saver.mjs';
import { extractSection, generateHandoff } from '../src/handoff.mjs';

const VERSION = '0.1.0';
const AGENT_PAUSE_PATH = fileURLToPath(new URL('../src/agent-pause.mjs', import.meta.url));

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code) => (s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const dim = paint('2');
const bold = paint('1');
const green = paint('32');
const yellow = paint('33');
const cyan = paint('36');

const ok = (msg) => console.log(`  ${green('✓')} ${msg}`);
const warn = (msg) => console.log(`  ${yellow('•')} ${msg}`);
const detail = (msg) => console.log(`    ${dim(msg)}`);

const HELP = `${bold('pronto')}: end-of-day shutdown for developers

${bold('Usage')}
  pronto [off] [--until HH:MM] [--offline]   save work, write TOMORROW.md, pause agents
  pronto status                              show lock state and TOMORROW.md
  pronto resume                              unlock agents, show your first 10 minutes

${bold('Options')}
  --until HH:MM   when agents unlock (default 09:00, next occurrence)
  --offline       skip the Claude API and use git-diff analysis only
  -h, --help      show this help
  -v, --version   show version

Set ANTHROPIC_API_KEY to have Claude write TOMORROW.md (model: PRONTO_MODEL, default claude-sonnet-5-5).`;

function parseArgs(argv) {
  const opts = { command: 'off', until: '09:00', offline: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help' || arg === 'help') opts.command = 'help';
    else if (arg === '-v' || arg === '--version') opts.command = 'version';
    else if (arg === '--offline') opts.offline = true;
    else if (arg === '--until') opts.until = argv[++i];
    else if (arg.startsWith('--until=')) opts.until = arg.slice('--until='.length);
    else if (['off', 'status', 'resume'].includes(arg)) opts.command = arg;
    else throw new Error(`unknown argument "${arg}" (see pronto --help)`);
  }
  if (opts.command === 'off' && !/^([01]?\d|2[0-3]):[0-5]\d$/.test(opts.until ?? '')) {
    throw new Error(`--until expects a 24h time like 09:00, got "${opts.until ?? ''}"`);
  }
  return opts;
}

// Next wall-clock occurrence of HH:MM after `now` (tonight's 23:00 or tomorrow's 09:00).
export function nextOccurrence(hhmm, now = new Date()) {
  const [h, m] = hhmm.split(':').map(Number);
  const at = new Date(now);
  at.setHours(h, m, 0, 0);
  if (at <= now) at.setDate(at.getDate() + 1);
  return at;
}

// The agent blocker is a separate module; pronto still saves work and writes
// TOMORROW.md without it.
async function loadAgentPause() {
  if (!fs.existsSync(AGENT_PAUSE_PATH)) return null;
  return import(pathToFileURL(AGENT_PAUSE_PATH).href);
}

const when = (d) => d.toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' });

async function off({ until, offline }) {
  const cwd = process.cwd();
  const now = new Date();
  console.log(`\n${bold('pronto')} ${dim('· shutting down for the day')}\n`);

  const snapshot = saveOpenWork({ cwd, now });
  const { repo, checkpoint, claude } = snapshot;
  const root = repo.root;
  const rel = (p) => path.relative(root, p);

  if (!repo.isRepo) {
    warn('Not a git repository, so there was nothing to back up');
  } else if (checkpoint.hadChanges) {
    ok(`Saved open work: ${repo.status.length} file(s) on ${cyan(repo.branch)}`);
    detail(`patch  ${rel(checkpoint.patchPath)}`);
    if (checkpoint.stashRef) detail(`stash  ${checkpoint.stashRef.slice(0, 12)} (git stash list)`);
    if (checkpoint.skippedUntracked.length) detail(`skipped (>1 MB): ${checkpoint.skippedUntracked.join(', ')}`);
    detail('working tree left exactly as it was');
  } else {
    ok(`Working tree clean on ${cyan(repo.branch)}, nothing to back up`);
  }

  if (claude.found && claude.messages.length) {
    ok(`Captured ${claude.messages.length} recent Claude Code message(s)${claude.scope === 'global' ? ' (newest session on this machine)' : ''}`);
  }

  let agentPause = null;
  let pauseError = null;
  try {
    agentPause = await loadAgentPause();
  } catch (err) {
    pauseError = err;
  }
  const unlockAt = agentPause?.pauseAgents ? nextOccurrence(until, now) : null;

  const handoff = await generateHandoff(snapshot, {
    unlockAt,
    offline,
    log: ({ mode, model, reason }) => {
      if (mode === 'claude') detail(`handoff written by Claude (${model})`);
      else detail(`handoff mode: offline git-diff analysis (${reason})`);
    },
  });
  ok(`Wrote ${bold(rel(handoff.path) || 'TOMORROW.md')}`);

  if (agentPause?.pauseAgents) {
    try {
      await agentPause.pauseAgents({ until, unlockAt, cwd: root });
      ok(`Agents paused until ${bold(when(unlockAt))}`);
    } catch (err) {
      pauseError = err;
    }
  } else if (!pauseError) {
    warn('Agent pause module not installed (src/agent-pause.mjs), so agents were not paused');
  }
  if (pauseError) warn(`Could not pause agents: ${pauseError.message}`);

  if (repo.isRepo) {
    writeState(root, {
      shutdown: {
        active: Boolean(unlockAt && !pauseError),
        at: now.toISOString(),
        until,
        unlockAt: unlockAt?.toISOString() ?? null,
        tomorrow: rel(handoff.path),
      },
    });
  }

  const first = extractSection(handoff.content, 3)?.match(/\*\*First step:\*\* (.*)/)?.[1];
  if (first) console.log(`\n  ${dim('Tomorrow:')} ${first}`);
  console.log(`\n  ${dim("You're done for today. It's all written down.")}\n`);
}

async function status() {
  const root = findRoot();
  const state = readState(root);
  const shutdown = state.shutdown;
  console.log(`\n${bold('pronto')} ${dim('· status')}\n`);

  let pauseStatus = null;
  try {
    const agentPause = await loadAgentPause();
    pauseStatus = agentPause?.getStatus ? await agentPause.getStatus({ cwd: root }) : null;
  } catch {
    // fall back to pronto's own record
  }

  const unlockAt = shutdown?.unlockAt ? new Date(shutdown.unlockAt) : null;
  const active = pauseStatus?.paused ?? (shutdown?.active && unlockAt > new Date());
  if (active) ok(`Shutdown lock ${bold('active')}, agents paused until ${bold(when(unlockAt ?? new Date(pauseStatus.until)))}`);
  else warn('Shutdown lock not active');
  if (shutdown?.at) detail(`last shutdown ${when(new Date(shutdown.at))}`);
  if (state.checkpoint?.patchPath) detail(`last backup   ${state.checkpoint.patchPath}`);

  const tomorrow = path.join(root, 'TOMORROW.md');
  if (fs.existsSync(tomorrow)) console.log(`\n${fs.readFileSync(tomorrow, 'utf8')}`);
  else console.log(`\n  ${dim('No TOMORROW.md yet. Run `pronto` at the end of the day.')}\n`);
}

async function resume() {
  const root = findRoot();
  console.log(`\n${bold('pronto')} ${dim('· good morning')}\n`);

  const agentPause = await loadAgentPause();
  if (agentPause?.resumeAgents) {
    await agentPause.resumeAgents({ cwd: root });
    ok('Agents unlocked');
  } else {
    warn('Agent pause module not installed (src/agent-pause.mjs), so there was nothing to unlock');
  }

  const state = readState(root);
  if (state.shutdown) writeState(root, { shutdown: { ...state.shutdown, active: false, resumedAt: new Date().toISOString() } });

  const tomorrow = path.join(root, 'TOMORROW.md');
  const section = fs.existsSync(tomorrow) ? extractSection(fs.readFileSync(tomorrow, 'utf8'), 3) : null;
  if (section) console.log(`\n${bold('First 10 Minutes')}\n\n${section}\n`);
  else console.log(`\n  ${dim('No TOMORROW.md found, so there is no checklist to show.')}\n`);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.command === 'help') return console.log(HELP);
  if (opts.command === 'version') return console.log(VERSION);
  if (opts.command === 'status') return status();
  if (opts.command === 'resume') return resume();
  return off(opts);
}

main().catch((err) => {
  console.error(`pronto: ${err.message}`);
  process.exit(1);
});
