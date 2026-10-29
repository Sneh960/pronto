import test from 'node:test';
import assert from 'node:assert/strict';
import { renderRestartNote, renderSection, stripAnsi } from '../src/display.mjs';

// Mirrors the output of render() in src/handoff.mjs.
const FIXTURE = [
  '# TOMORROW.md',
  '',
  '> Written by `pronto` at shutdown. Everything you need to restart is on this page, so you can stop thinking about work tonight.',
  '',
  '## 1. Shutdown Snapshot',
  '',
  '- **Shut down:** Wed, Oct 29, 05:30 PM',
  '- **Repo:** `/home/dev/code/pronto`',
  '- **Branch:** `worker/display` at `935c37c`',
  '- **Backup patch:** `.pronto/backups/2026-10-29.patch` (restore with `git apply .pronto/backups/2026-10-29.patch`)',
  '- **Working tree:** untouched; your changes are still exactly where you left them',
  '- **Written by:** offline git-diff analysis (no ANTHROPIC_API_KEY)',
  '',
  '## 2. Where You Left Off',
  '',
  '2 uncommitted file(s) on `worker/display`, +40/−3 lines in tracked files:',
  '',
  '- `src/display.mjs` (modified +30/−2, near `function wrap`)',
  '- `tests/display.test.mjs` (new, untracked)',
  '',
  'Last commit: `935c37c Merge pull request #1`',
  '',
  '## 3. Closed Mental Loops',
  '',
  '- [x] Your uncommitted work is backed up twice (stash checkpoint + patch). Nothing can be lost overnight.',
  '- [x] TODO in `src/display.mjs:12`: handle tables. Captured, deal with it tomorrow.',
  '',
  '## 4. First 10 Minutes Tomorrow',
  '',
  '**First step:** Open `src/display.mjs` at line 12: you left a TODO there.',
  '',
  '```sh',
  'cd /home/dev/code/pronto',
  'pronto resume',
  'echo **x** `y`',
  '```',
  '',
  '- [ ] Run `pronto resume` to unlock your agents.',
  '- [ ] Run `git status` and confirm the changes listed above are all there.',
  '',
].join('\n');

const ESC = '\x1b';

test('color:false output has no ANSI escape codes', () => {
  const out = renderRestartNote(FIXTURE, { color: false });
  assert.ok(!out.includes(ESC));
  assert.ok(out.includes('TOMORROW.md'));
  const outsideCode = out.split('\n').filter((l) => !l.startsWith('│ ')).join('\n');
  assert.ok(!/`|\*\*/.test(outsideCode));
});

test('color:true emits ANSI and stripAnsi round-trips to the plain output', () => {
  const colored = renderRestartNote(FIXTURE, { color: true });
  assert.ok(colored.includes(ESC));
  assert.equal(stripAnsi(colored), renderRestartNote(FIXTURE, { color: false }));
});

test('styles: bold title, bold cyan heading with dim rule, cyan code, green check', () => {
  const out = renderRestartNote(FIXTURE, { color: true });
  assert.ok(out.includes(`${ESC}[1mTOMORROW.md${ESC}[0m`));
  assert.ok(out.includes(`${ESC}[1;36m1. Shutdown Snapshot${ESC}[0m`));
  assert.ok(out.includes(`${ESC}[2m${'─'.repeat('1. Shutdown Snapshot'.length)}${ESC}[0m`));
  assert.ok(out.includes(`${ESC}[36m/home/dev/code/pronto${ESC}[0m`));
  assert.ok(out.includes(`${ESC}[32m✓${ESC}[0m`));
  assert.ok(out.includes(`${ESC}[2m│ ${ESC}[0mpronto resume`));
});

test('checkbox and bullet glyphs', () => {
  const lines = renderRestartNote(FIXTURE, { color: false, width: 200 }).split('\n');
  assert.ok(lines.includes('  ☐ Run `pronto resume` to unlock your agents.'.replaceAll('`', '')));
  assert.ok(lines.some((l) => l.startsWith('  ✓ Your uncommitted work is backed up twice')));
  assert.ok(lines.includes('  • Repo: /home/dev/code/pronto'));
  assert.ok(lines.includes('  • Shut down: Wed, Oct 29, 05:30 PM'));
  assert.ok(!lines.some((l) => /\[[ x]\]/.test(l)));
});

test('headings get a rule no wider than width', () => {
  const lines = renderRestartNote('## 2. Where You Left Off', { color: false, width: 10 }).split('\n');
  assert.equal(lines[0], '2. Where You Left Off');
  assert.equal(lines[1], '─'.repeat(10));
  const wide = renderRestartNote('## Short', { color: false, width: 80 }).split('\n');
  assert.equal(wide[1], '─'.repeat(5));
});

test('code block contents are untouched and prefixed', () => {
  const lines = renderRestartNote(FIXTURE, { color: false }).split('\n');
  assert.ok(lines.includes('│ echo **x** `y`'));
  assert.ok(lines.includes('│ cd /home/dev/code/pronto'));
  assert.ok(!lines.some((l) => l.includes('```')));
  const colored = renderRestartNote(FIXTURE, { color: true });
  assert.ok(colored.includes('echo **x** `y`'));
});

test('long lines wrap to width and keep bullet indent', () => {
  const width = 40;
  const out = renderRestartNote(FIXTURE, { color: false, width });
  const lines = out.split('\n');
  for (const l of lines) assert.ok(l.length <= width, `too wide (${l.length}): ${l}`);

  const i = lines.findIndex((l) => l.startsWith('  ✓ Your uncommitted'));
  assert.ok(lines[i + 1].startsWith('    ') && !lines[i + 1].startsWith('     '));
  assert.ok(!lines[i + 1].includes('✓'));
});

test('wrapping with color measures visible width, not escape codes', () => {
  const width = 50;
  const lines = renderRestartNote(FIXTURE, { color: true, width }).split('\n');
  for (const l of lines) assert.ok(stripAnsi(l).length <= width, `too wide: ${stripAnsi(l)}`);
  // every line is balanced: no style leaks across a line break
  for (const l of lines) assert.equal((l.match(/\x1b\[[1-9][0-9;]*m/g) ?? []).length, (l.match(/\x1b\[0m/g) ?? []).length);
});

test('blockquote text is dim and wrapped without the > marker', () => {
  const plain = renderRestartNote(FIXTURE, { color: false, width: 60 }).split('\n');
  assert.ok(plain[2].startsWith('Written by pronto at shutdown.'));
  assert.ok(!plain.some((l) => l.startsWith('>')));
  assert.ok(renderRestartNote('> hi', { color: true }).includes(`${ESC}[2mhi${ESC}[0m`));
});

test('renderSection finds a section with or without its number', () => {
  const byFull = renderSection(FIXTURE, '4. First 10 Minutes Tomorrow', { color: false });
  const byBare = renderSection(FIXTURE, 'First 10 Minutes Tomorrow', { color: false });
  assert.equal(byFull, byBare);
  assert.ok(byFull.startsWith('4. First 10 Minutes Tomorrow\n'));
  assert.ok(byFull.includes('First step: Open src/display.mjs'));
  assert.ok(byFull.includes('  ☐ Run pronto resume'));
  assert.ok(!byFull.includes('Closed Mental Loops'));
  assert.ok(!byFull.includes('Shutdown Snapshot'));
});

test('renderSection stops at the next heading', () => {
  const out = renderSection(FIXTURE, 'Where You Left Off', { color: false, width: 200 });
  assert.ok(out.includes('src/display.mjs (modified'));
  assert.ok(!out.includes('Closed Mental Loops'));
  assert.ok(!out.includes('Your uncommitted work'));
});

test('renderSection returns null when the section is absent', () => {
  assert.equal(renderSection(FIXTURE, 'No Such Section'), null);
  assert.equal(renderSection('', 'Anything'), null);
});

test('stripAnsi removes SGR codes only', () => {
  assert.equal(stripAnsi('\x1b[1;36mhi\x1b[0m there'), 'hi there');
  assert.equal(stripAnsi('plain'), 'plain');
});
