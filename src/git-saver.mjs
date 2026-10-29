// Captures the state of the current working directory and backs it up without
// touching the working tree: a git stash checkpoint (stored, not applied) plus a
// plain patch file under .pronto/. Also pulls recent Claude Code conversation
// context from ~/.claude/projects.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const MAX_BUFFER = 64 * 1024 * 1024;
const MAX_UNTRACKED_BYTES = 1024 * 1024;
const LOG_TAIL_BYTES = 4 * 1024 * 1024;
const HARNESS_WRAPPER = /^<(command-|local-command|system-reminder|bash-|task-notification)/;

function git(args, cwd, { allowExit = [] } = {}) {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      maxBuffer: MAX_BUFFER,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    // `git diff --no-index` exits 1 when files differ; that output is what we want.
    if (allowExit.includes(err.status) && typeof err.stdout === 'string') return err.stdout;
    return null;
  }
}

const trim = (s) => (s == null ? '' : s.replace(/\s+$/, ''));

export function parseStatus(porcelain) {
  return porcelain
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const code = line.slice(0, 2);
      let file = line.slice(3);
      if (file.includes(' -> ')) file = file.split(' -> ')[1];
      if (file.startsWith('"') && file.endsWith('"')) file = file.slice(1, -1);
      return { code, file, untracked: code === '??', staged: code[0] !== ' ' && code[0] !== '?' };
    });
}

export function parseNumstat(numstat) {
  return numstat
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [added, removed, ...rest] = line.split('\t');
      return {
        file: rest.join('\t'),
        added: added === '-' ? 0 : Number(added),
        removed: removed === '-' ? 0 : Number(removed),
        binary: added === '-',
      };
    });
}

// Ignores pronto's own artifacts so they never show up as "your" open work.
const isProntoArtifact = (file) => file === 'TOMORROW.md' || file.startsWith('.pronto/');

export function findRoot(cwd = process.cwd()) {
  return trim(git(['rev-parse', '--show-toplevel'], cwd)) || path.resolve(cwd);
}

export function inspectRepo(cwd = process.cwd()) {
  const inside = trim(git(['rev-parse', '--is-inside-work-tree'], cwd)) === 'true';
  if (!inside) return { isRepo: false, root: path.resolve(cwd) };

  const root = trim(git(['rev-parse', '--show-toplevel'], cwd));
  const head = trim(git(['rev-parse', '--verify', '-q', 'HEAD'], root)) || null;
  const branch =
    trim(git(['symbolic-ref', '--short', '-q', 'HEAD'], root)) ||
    (head ? `detached@${head.slice(0, 7)}` : 'unknown');

  const status = parseStatus(trim(git(['status', '--porcelain', '--untracked-files=all'], root))).filter(
    (s) => !isProntoArtifact(s.file),
  );
  const unstagedDiff = git(['diff'], root) ?? '';
  const stagedDiff = git(['diff', '--staged'], root) ?? '';
  const numstat = parseNumstat(
    trim(head ? git(['diff', '--numstat', 'HEAD'], root) : git(['diff', '--numstat', '--staged'], root)),
  );
  const recentCommits = trim(git(['log', '-n', '5', '--oneline'], root))
    .split('\n')
    .filter(Boolean);

  return {
    isRepo: true,
    root,
    head,
    branch,
    status,
    unstagedDiff,
    stagedDiff,
    numstat,
    recentCommits,
    untracked: status.filter((s) => s.untracked).map((s) => s.file),
  };
}

function untrackedPatch(root, files) {
  let patch = '';
  const skipped = [];
  for (const file of files) {
    const abs = path.join(root, file);
    let size = 0;
    try {
      size = fs.statSync(abs).size;
    } catch {
      continue;
    }
    if (size > MAX_UNTRACKED_BYTES) {
      skipped.push(file);
      continue;
    }
    patch += git(['diff', '--no-index', '--binary', '--', '/dev/null', file], root, { allowExit: [1] }) ?? '';
  }
  return { patch, skipped };
}

function ensureProntoDir(root) {
  const dir = path.join(root, '.pronto');
  fs.mkdirSync(dir, { recursive: true });
  // Self-ignoring directory: keeps backups out of commits without editing the user's .gitignore.
  const ignore = path.join(dir, '.gitignore');
  if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, '*\n');
  return dir;
}

export function readState(root) {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, '.pronto', 'state.json'), 'utf8'));
  } catch {
    return {};
  }
}

// Merges into state.json so keys written by other modules are preserved.
export function writeState(root, patch) {
  const dir = ensureProntoDir(root);
  const next = { ...readState(root), ...patch };
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(next, null, 2) + '\n');
  return next;
}

function checkpoint(repo, savedAt) {
  const dir = ensureProntoDir(repo.root);
  const result = { stashRef: null, patchPath: null, skippedUntracked: [], hadChanges: repo.status.length > 0 };
  if (!result.hadChanges) return result;

  // `git stash create` builds a stash commit without resetting the working tree;
  // `git stash store` records it in `git stash list` so it can't be garbage-collected.
  if (repo.head) {
    const sha = trim(git(['stash', 'create', `pronto checkpoint ${savedAt}`], repo.root));
    if (sha) {
      git(['stash', 'store', '-m', `pronto checkpoint ${savedAt} on ${repo.branch}`, sha], repo.root);
      result.stashRef = sha;
    }
  }

  // The patch covers what the stash can't (untracked files, repos with no commits yet)
  // and is readable/appliable without knowing git stash: `git apply .pronto/wip-backup.patch`.
  const tracked = repo.head
    ? git(['diff', '--binary', 'HEAD'], repo.root) ?? ''
    : (git(['diff', '--binary', '--staged'], repo.root) ?? '') + (git(['diff', '--binary'], repo.root) ?? '');
  const { patch: untracked, skipped } = untrackedPatch(repo.root, repo.untracked);
  result.skippedUntracked = skipped;

  const patchPath = path.join(dir, 'wip-backup.patch');
  fs.writeFileSync(patchPath, tracked + untracked);
  result.patchPath = patchPath;
  return result;
}

// Claude Code stores each project's sessions under ~/.claude/projects/<cwd with
// every non-alphanumeric character replaced by '-'>/<session>.jsonl.
function projectLogDir(claudeHome, cwd) {
  return path.join(claudeHome, 'projects', path.resolve(cwd).replace(/[^a-zA-Z0-9]/g, '-'));
}

function newestJsonl(dirs) {
  let best = null;
  for (const dir of dirs) {
    let entries;
    try {
      entries = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (!name.endsWith('.jsonl')) continue;
      const file = path.join(dir, name);
      const { mtimeMs } = fs.statSync(file);
      if (!best || mtimeMs > best.mtimeMs) best = { file, mtimeMs };
    }
  }
  return best;
}

function readTail(file, bytes) {
  const fd = fs.openSync(file, 'r');
  try {
    const { size } = fs.fstatSync(fd);
    const start = Math.max(0, size - bytes);
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    const text = buf.toString('utf8');
    // Drop the partial first line when we started mid-file.
    return start > 0 ? text.slice(text.indexOf('\n') + 1) : text;
  } finally {
    fs.closeSync(fd);
  }
}

function messageText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n');
}

export function readClaudeContext(cwd = process.cwd(), { limit = 10, claudeHome = path.join(os.homedir(), '.claude') } = {}) {
  const projectsDir = path.join(claudeHome, 'projects');
  if (!fs.existsSync(projectsDir)) return { found: false, messages: [] };

  // Prefer this project's own sessions; fall back to the newest session anywhere.
  let source = newestJsonl([projectLogDir(claudeHome, cwd)]);
  let scope = 'project';
  if (!source) {
    const all = fs
      .readdirSync(projectsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => path.join(projectsDir, d.name));
    source = newestJsonl(all);
    scope = 'global';
  }
  if (!source) return { found: false, messages: [] };

  const messages = [];
  for (const line of readTail(source.file, LOG_TAIL_BYTES).split('\n')) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if ((entry.type !== 'user' && entry.type !== 'assistant') || entry.isMeta || entry.isSidechain) continue;
    const text = messageText(entry.message?.content).trim();
    // Skip tool results/thinking-only turns and harness wrappers like <command-name>.
    if (!text || HARNESS_WRAPPER.test(text)) continue;
    messages.push({ role: entry.type, text, at: entry.timestamp ?? null });
  }

  return {
    found: true,
    scope,
    file: source.file,
    modifiedAt: new Date(source.mtimeMs).toISOString(),
    messages: messages.slice(-limit),
  };
}

export function saveOpenWork({ cwd = process.cwd(), now = new Date() } = {}) {
  const savedAt = now.toISOString();
  const repo = inspectRepo(cwd);
  const claude = readClaudeContext(cwd);

  if (!repo.isRepo) {
    return { savedAt, repo, claude, checkpoint: { stashRef: null, patchPath: null, hadChanges: false, skippedUntracked: [] } };
  }

  const cp = checkpoint(repo, savedAt);
  writeState(repo.root, {
    checkpoint: {
      savedAt,
      branch: repo.branch,
      head: repo.head,
      stashRef: cp.stashRef,
      patchPath: cp.patchPath && path.relative(repo.root, cp.patchPath),
      files: repo.status.map((s) => s.file),
    },
  });
  return { savedAt, repo, claude, checkpoint: cp };
}
