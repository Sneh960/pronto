// Turns a saveOpenWork() snapshot into TOMORROW.md. Uses the Claude Messages API
// when ANTHROPIC_API_KEY is set; otherwise (or if the call fails) falls back to a
// deterministic summary parsed straight from the git diff. Section 1 is always
// built from facts, never generated, so the backup paths are exact.

import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_MODEL = 'claude-sonnet-5-5';
const API_URL = 'https://api.anthropic.com/v1/messages';
const MAX_DIFF_CHARS = 80_000;
// Works without installing anything; a bare `pronto` is only on PATH after npm link/-g.
export const RESUME_CMD = 'npx github:Sneh960/pronto resume';

export const SECTION_TITLES = [
  '1. Shutdown Snapshot',
  '2. Where You Left Off',
  '3. Closed Mental Loops',
  '4. First 10 Minutes Tomorrow',
];

// Session logs and diffs can contain credentials; never forward or write them.
const SECRET_PATTERNS = [
  [/sk-ant-[A-Za-z0-9_-]{10,}/g, 'sk-ant-[REDACTED]'],
  [/\b(sk|pk|rk)-[A-Za-z0-9_-]{20,}/g, '$1-[REDACTED]'],
  [/\b(ghp|gho|ghu|ghs|github_pat)_[A-Za-z0-9_]{20,}/g, '$1_[REDACTED]'],
  [/\bAKIA[0-9A-Z]{16}\b/g, 'AKIA[REDACTED]'],
  [/\b(xox[abpors]-)[A-Za-z0-9-]{10,}/g, '$1[REDACTED]'],
];
// Only for chat text: in source code this would also hit things like `tokenizer = ...`.
const PROSE_SECRET = [/((?:password|passwd|pwd|secret|token|api[_-]?key)\S*\s*(?:is|=|:)?\s*['"]?)[^\s'",]{4,}/gi, '$1[REDACTED]'];

export function redact(text, { prose = false } = {}) {
  const patterns = prose ? [...SECRET_PATTERNS, PROSE_SECRET] : SECRET_PATTERNS;
  return patterns.reduce((out, [re, sub]) => out.replace(re, sub), String(text ?? ''));
}

// Per file: the new-side start line of each hunk, plus added lines with their line numbers.
export function parseDiff(diff) {
  const files = new Map();
  let current = null;
  let line = 0;
  for (const raw of diff.split('\n')) {
    if (raw.startsWith('diff --git ')) {
      current = null;
      continue;
    }
    if (raw.startsWith('+++ ')) {
      const name = raw.slice(4).replace(/^b\//, '');
      if (name === '/dev/null') continue;
      if (!files.has(name)) files.set(name, { hunks: [], added: [] });
      current = files.get(name);
      continue;
    }
    const hunk = raw.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@ ?(.*)$/);
    if (hunk && current) {
      line = Number(hunk[1]);
      current.hunks.push({ start: line, context: hunk[2].trim() });
      continue;
    }
    if (!current) continue;
    if (raw.startsWith('+')) {
      current.added.push({ line, text: raw.slice(1) });
      line++;
    } else if (raw.startsWith(' ')) {
      line++;
    }
  }
  return files;
}

// A TODO tag only counts when it sits in a comment, not in strings or regexes.
const TODO_RE = /(?:\/\/|#|\/\*|\*|<!--|--|;)\s*(TODO|FIXME|XXX|HACK)\b[:\s-]*(.*)$/;

const STATUS_LABELS = { M: 'modified', A: 'added', D: 'deleted', R: 'renamed', C: 'copied', U: 'conflicted', '?': 'new, untracked' };

function describeStatus(code) {
  const labels = new Set();
  for (const ch of code.replace(/ /g, '')) if (STATUS_LABELS[ch]) labels.add(STATUS_LABELS[ch]);
  const staged = code[0] !== ' ' && code[0] !== '?';
  return [...labels].join(', ') + (staged ? ', staged' : '');
}

function shellQuote(s) {
  return /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

function formatTime(date) {
  return date.toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

// Facts both modes rely on: per-file stats, TODOs added today, and a best guess
// at where to start tomorrow.
export function analyze(snapshot) {
  const { repo, claude } = snapshot;
  if (!repo.isRepo) return { files: [], todos: [], focus: null, lastRequest: null };

  const diffs = parseDiff(`${repo.stagedDiff}\n${repo.unstagedDiff}`);
  const stats = new Map(repo.numstat.map((n) => [n.file, n]));
  const files = repo.status.map((s) => {
    const n = stats.get(s.file);
    const d = diffs.get(s.file);
    return {
      file: s.file,
      status: describeStatus(s.code),
      untracked: s.untracked,
      added: n?.added ?? null,
      removed: n?.removed ?? null,
      firstLine: d?.hunks[0]?.start ?? 1,
      context: d?.hunks.find((h) => h.context)?.context ?? null,
    };
  });

  const todos = [];
  for (const [file, d] of diffs) {
    for (const a of d.added) {
      const m = a.text.match(TODO_RE);
      if (m) todos.push({ file, line: a.line, tag: m[1], text: m[2].trim() || a.text.trim() });
    }
  }
  for (const file of repo.untracked) {
    try {
      fs.readFileSync(path.join(repo.root, file), 'utf8')
        .split('\n')
        .forEach((text, i) => {
          const m = text.match(TODO_RE);
          if (m) todos.push({ file, line: i + 1, tag: m[1], text: m[2].trim() || text.trim() });
        });
    } catch {
      // unreadable or binary: skip
    }
  }

  const churn = (f) => (f.added ?? 0) + (f.removed ?? 0);
  const ranked = [...files].filter((f) => !f.status.includes('deleted')).sort((a, b) => churn(b) - churn(a));
  const todo = todos[0];
  const focus = todo
    ? { file: todo.file, line: todo.line, reason: `you left a ${todo.tag} there: "${todo.text}"` }
    : ranked[0]
      ? { file: ranked[0].file, line: ranked[0].firstLine, reason: 'it has the most uncommitted change' }
      : null;

  const lastRequest = [...(claude.messages ?? [])].reverse().find((m) => m.role === 'user')?.text ?? null;
  return { files, todos, focus, lastRequest };
}

function snapshotSection(snapshot, { unlockAt, mode }) {
  const { repo, checkpoint, savedAt } = snapshot;
  const rel = (p) => (p ? path.relative(repo.root, p) : null);
  const lines = [`- **Shut down:** ${formatTime(new Date(savedAt))}`];
  if (repo.isRepo) {
    lines.push(`- **Repo:** \`${repo.root}\``);
    lines.push(`- **Branch:** \`${repo.branch}\`${repo.head ? ` at \`${repo.head.slice(0, 7)}\`` : ' (no commits yet)'}`);
    if (checkpoint.hadChanges) {
      lines.push(`- **Backup patch:** \`${rel(checkpoint.patchPath)}\` (restore with \`git apply ${rel(checkpoint.patchPath)}\`)`);
      if (checkpoint.stashRef) {
        lines.push(`- **Stash checkpoint:** \`${checkpoint.stashRef.slice(0, 12)}\` in \`git stash list\` (restore with \`git stash apply ${checkpoint.stashRef.slice(0, 12)}\`)`);
      }
      if (checkpoint.skippedUntracked.length) {
        lines.push(`- **Not in patch (over 1 MB):** ${checkpoint.skippedUntracked.map((f) => `\`${f}\``).join(', ')}`);
      }
      lines.push('- **Working tree:** untouched; your changes are still exactly where you left them');
    } else {
      lines.push('- **Backup:** nothing to back up; working tree is clean');
    }
  } else {
    lines.push(`- **Directory:** \`${repo.root}\` (not a git repository, so nothing was backed up)`);
  }
  lines.push(`- **Agents unlock:** ${unlockAt ? `${formatTime(unlockAt)} (or run \`${RESUME_CMD}\`)` : 'agent pause module not installed'}`);
  lines.push(`- **Written by:** ${mode}`);
  return lines.join('\n');
}

function offlineSections(snapshot, facts) {
  const { repo, claude, checkpoint } = snapshot;

  let where;
  if (!repo.isRepo) {
    where = '- This directory is not a git repository, so there are no tracked changes to summarize.';
  } else if (!facts.files.length) {
    where = `- Working tree is clean on \`${repo.branch}\`. Everything is committed.`;
    if (repo.recentCommits[0]) where += `\n- Last commit: \`${repo.recentCommits[0]}\``;
  } else {
    const totalAdd = facts.files.reduce((s, f) => s + (f.added ?? 0), 0);
    const totalDel = facts.files.reduce((s, f) => s + (f.removed ?? 0), 0);
    where = `${facts.files.length} uncommitted file(s) on \`${repo.branch}\`, +${totalAdd}/−${totalDel} lines in tracked files:\n\n`;
    where += facts.files
      .map((f) => {
        const delta = f.added != null ? ` +${f.added}/−${f.removed}` : '';
        const ctx = f.context ? `, near \`${f.context}\`` : '';
        return `- \`${f.file}\` (${f.status}${delta}${ctx})`;
      })
      .join('\n');
    if (repo.recentCommits[0]) where += `\n\nLast commit: \`${repo.recentCommits[0]}\``;
  }
  if (facts.lastRequest) {
    const quote = redact(facts.lastRequest, { prose: true }).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    where += `\n\nLast thing you asked Claude Code: “${quote.length > 240 ? `${quote.slice(0, 240)}…` : quote}”`;
  }

  const loops = [];
  if (checkpoint.hadChanges) loops.push('Your uncommitted work is backed up twice (stash checkpoint + patch). Nothing can be lost overnight.');
  if (facts.files.length) loops.push(`Which files you were in: all ${facts.files.length} are listed above. You don't need to remember them.`);
  for (const t of facts.todos.slice(0, 5)) loops.push(`${t.tag} in \`${t.file}:${t.line}\`: ${t.text}. Captured, deal with it tomorrow.`);
  if (claude.found && claude.messages.length) loops.push('Your recent Claude Code conversation was captured; the context is not lost.');
  loops.push('Coding agents are paused. Nothing will change in this repo while you are away.');
  loops.push('Tomorrow starts with one concrete step (below). You don\'t need to plan it tonight.');

  const focus = facts.focus;
  const first = {
    firstStep: focus
      ? `Open \`${focus.file}\` at line ${focus.line}: ${focus.reason}.`
      : repo.isRepo
        ? 'Working tree is clean. Pick the next item from your backlog and create a branch for it.'
        : 'Open this directory and review where you stopped.',
    file: focus?.file ?? '',
    line: focus?.line ?? 1,
    checklist: [
      `Run \`${RESUME_CMD}\` to unlock your agents.`,
      facts.files.length ? 'Run `git status` and confirm the changes listed above are all there.' : 'Run `git status` to confirm the tree is still clean.',
      focus ? `Re-read \`${focus.file}\` around line ${focus.line} before writing anything new.` : 'Re-read the last commit to reload context.',
      facts.files.length ? 'Decide: commit what is finished, keep going on the rest.' : 'Write the first failing test or TODO for the next task.',
    ],
  };
  return { where, loops, first };
}

function buildPrompt(snapshot, facts) {
  const { repo, claude } = snapshot;
  let diff = redact(`${repo.stagedDiff}\n${repo.unstagedDiff}`.trim());
  const truncated = diff.length > MAX_DIFF_CHARS;
  if (truncated) diff = diff.slice(0, MAX_DIFF_CHARS);

  const context = {
    branch: repo.branch,
    recentCommits: repo.recentCommits,
    files: facts.files,
    todosAddedToday: facts.todos,
    suggestedFocus: facts.focus,
    recentClaudeCodeMessages: (claude.messages ?? []).map((m) => ({ role: m.role, text: redact(m.text, { prose: true }).slice(0, 2000) })),
  };

  return [
    'A developer is shutting down for the night. Write their handoff note for tomorrow morning.',
    'The goal is to stop evening rumination: everything they might lie awake thinking about should be captured, so they can let it go.',
    '',
    'Return JSON with:',
    '- whereYouLeftOff: 3-6 markdown bullets. Concrete: what they were building, which files, what state it is in (working, half-done, broken). Name files in backticks. Infer intent from the diff and the Claude Code conversation; do not just list files.',
    '- closedLoops: 3-6 short sentences, each naming a specific open thread and why it is safe to stop thinking about it tonight (it is backed up, written down, or scheduled for tomorrow).',
    '- firstStep: one sentence, the exact first action tomorrow. Name the file and line.',
    '- file / line: where to open the editor first. Must be a file from the list below.',
    '- checklist: 3-5 items for the first 10 minutes, in order, each small enough to do in a couple of minutes.',
    'Be specific and calm. No filler, no motivational language.',
    '',
    '<context>',
    JSON.stringify(context, null, 2),
    '</context>',
    '',
    `<diff${truncated ? ' truncated="true"' : ''}>`,
    diff || '(no uncommitted changes)',
    '</diff>',
  ].join('\n');
}

const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    whereYouLeftOff: { type: 'string' },
    closedLoops: { type: 'array', items: { type: 'string' } },
    firstStep: { type: 'string' },
    file: { type: 'string' },
    line: { type: 'integer' },
    checklist: { type: 'array', items: { type: 'string' } },
  },
  required: ['whereYouLeftOff', 'closedLoops', 'firstStep', 'file', 'line', 'checklist'],
  additionalProperties: false,
};

async function claudeSections(snapshot, facts, { apiKey, model }) {
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2026-10-21',
      'anthropic-beta': 'server-side-fallback-2026-07-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: 16000,
      fallbacks: 'default',
      output_config: { effort: 'low', format: { type: 'json_schema', schema: RESPONSE_SCHEMA } },
      messages: [{ role: 'user', content: buildPrompt(snapshot, facts) }],
    }),
    signal: AbortSignal.timeout(90_000),
  });

  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${body?.error?.message ?? res.statusText}`);
  if (body.stop_reason === 'refusal') throw new Error(`model declined (${body.stop_details?.category ?? 'refusal'})`);
  if (body.stop_reason === 'max_tokens') throw new Error('response hit max_tokens');

  const text = body.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  const out = JSON.parse(text);
  return {
    where: out.whereYouLeftOff,
    loops: out.closedLoops,
    first: { firstStep: out.firstStep, file: out.file, line: out.line, checklist: out.checklist },
    model: body.model ?? model,
  };
}

function render(snapshot, sections, { unlockAt, mode }) {
  const { repo } = snapshot;
  const { first } = sections;
  const commands = [`cd ${shellQuote(repo.root)}`, RESUME_CMD];
  if (repo.isRepo) commands.push('git status');
  if (first.file) commands.push(`code -g ${shellQuote(`${first.file}:${first.line || 1}`)}`);

  return [
    '# TOMORROW.md',
    '',
    '> Written by `pronto` at shutdown. Everything you need to restart is on this page, so you can stop thinking about work tonight.',
    '',
    `## ${SECTION_TITLES[0]}`,
    '',
    snapshotSection(snapshot, { unlockAt, mode }),
    '',
    `## ${SECTION_TITLES[1]}`,
    '',
    sections.where.trim(),
    '',
    `## ${SECTION_TITLES[2]}`,
    '',
    ...sections.loops.map((l) => `- [x] ${l.trim()}`),
    '',
    `## ${SECTION_TITLES[3]}`,
    '',
    `**First step:** ${first.firstStep.trim()}`,
    '',
    '```sh',
    ...commands,
    '```',
    '',
    ...first.checklist.map((c) => `- [ ] ${c.trim()}`),
    '',
  ].join('\n');
}

export async function generateHandoff(snapshot, { unlockAt = null, apiKey = process.env.ANTHROPIC_API_KEY, model = process.env.PRONTO_MODEL || DEFAULT_MODEL, offline = false, log = () => {} } = {}) {
  const facts = analyze(snapshot);
  let sections;
  let mode;

  if (apiKey && !offline) {
    try {
      const result = await claudeSections(snapshot, facts, { apiKey, model });
      sections = result;
      mode = `Claude (\`${result.model}\`)`;
      log({ mode: 'claude', model: result.model });
    } catch (err) {
      log({ mode: 'offline', reason: `Claude API call failed: ${err.message}` });
      mode = 'offline git-diff analysis (Claude API call failed)';
    }
  } else {
    log({ mode: 'offline', reason: offline ? '--offline flag' : 'ANTHROPIC_API_KEY is not set' });
    mode = 'offline git-diff analysis (no ANTHROPIC_API_KEY)';
  }
  sections ??= offlineSections(snapshot, facts);

  const content = render(snapshot, sections, { unlockAt, mode });
  const file = path.join(snapshot.repo.root, 'TOMORROW.md');
  fs.writeFileSync(file, content);
  return { path: file, mode: sections.model ? 'claude' : 'offline', content, facts };
}

// Returns the body of one "## N. Title" section from TOMORROW.md.
export function extractSection(markdown, index) {
  const title = `## ${SECTION_TITLES[index]}`;
  const start = markdown.indexOf(title);
  if (start === -1) return null;
  const rest = markdown.slice(start + title.length);
  const end = rest.search(/\n## /);
  return (end === -1 ? rest : rest.slice(0, end)).trim();
}
