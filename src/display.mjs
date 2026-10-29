// Terminal renderer for TOMORROW.md. Handles only the markdown subset that
// handoff.mjs render() emits, so it needs no parser and no dependencies.

const ANSI_RE = /\x1b\[[0-9;]*m/g;

export function stripAnsi(s) {
  return String(s).replace(ANSI_RE, '');
}

const BOLD = '1';
const DIM = '2';
const GREEN = '32';
const CYAN = '36';

const paint = (text, style, color) => (color && style.length && text ? `\x1b[${style.join(';')}m${text}\x1b[0m` : text);
const visibleLength = (s) => Array.from(s).length;

// Inline `code` and **bold** into [{ text, style }]. Bold may contain code, not the reverse.
function parseInline(text, style = []) {
  const out = [];
  const re = /`([^`]+)`|\*\*(.+?)\*\*/g;
  let last = 0;
  let m;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push({ text: text.slice(last, m.index), style });
    if (m[1] !== undefined) out.push({ text: m[1], style: [...style, CYAN] });
    else out.push(...parseInline(m[2], [...style, BOLD]));
    last = re.lastIndex;
  }
  if (last < text.length) out.push({ text: text.slice(last), style });
  return out;
}

// Words are lists of styled pieces, so a style never straddles a line break.
function toWords(segments) {
  const words = [];
  let current = [];
  for (const seg of segments) {
    for (const part of seg.text.split(/(\s+)/)) {
      if (part === '') continue;
      if (/^\s+$/.test(part)) {
        if (current.length) words.push(current);
        current = [];
      } else {
        current.push({ text: part, style: seg.style });
      }
    }
  }
  if (current.length) words.push(current);
  return words;
}

// `prefix` is already painted; `prefixWidth` is its visible width. Words longer than
// the line stay whole so paths remain copyable.
function wrap(text, { prefix = '', prefixWidth = 0, hang = prefixWidth, style = [], width, color }) {
  const words = toWords(parseInline(text, style)).map((pieces) => ({
    str: pieces.map((p) => paint(p.text, p.style, color)).join(''),
    len: pieces.reduce((n, p) => n + visibleLength(p.text), 0),
  }));
  if (!words.length) return [prefix.trimEnd()];

  const avail = Math.max(width - prefixWidth, 1);
  const lines = [];
  let line = '';
  let len = 0;
  for (const w of words) {
    if (len && len + 1 + w.len > avail) {
      lines.push(line);
      line = '';
      len = 0;
    }
    line += (len ? ' ' : '') + w.str;
    len += (len ? 1 : 0) + w.len;
  }
  lines.push(line);
  return lines.map((l, i) => (i === 0 ? prefix : ' '.repeat(hang)) + l);
}

export function renderRestartNote(markdown, { color = true, width = 80 } = {}) {
  width = Math.max(Math.floor(width) || 80, 10);
  const out = [];
  let inCode = false;

  for (const raw of String(markdown ?? '').split(/\r?\n/)) {
    if (/^\s*```/.test(raw)) {
      inCode = !inCode;
      continue;
    }
    if (inCode) {
      out.push(paint('│ ', [DIM], color) + raw);
      continue;
    }

    let m;
    if ((m = raw.match(/^# (.*)$/))) {
      out.push(paint(m[1], [BOLD], color));
    } else if ((m = raw.match(/^## (.*)$/))) {
      const title = m[1].trim();
      out.push(paint(title, [BOLD, CYAN], color));
      out.push(paint('─'.repeat(Math.min(visibleLength(title), width)), [DIM], color));
    } else if ((m = raw.match(/^>\s?(.*)$/))) {
      out.push(...wrap(m[1], { style: [DIM], width, color }));
    } else if ((m = raw.match(/^(\s*)- \[( |x|X)\] ?(.*)$/))) {
      const done = m[2] !== ' ';
      const pad = ' '.repeat(2 + m[1].length);
      const glyph = done ? paint('✓', [GREEN], color) : '☐';
      out.push(...wrap(m[3], { prefix: `${pad}${glyph} `, prefixWidth: pad.length + 2, style: done ? [DIM] : [], width, color }));
    } else if ((m = raw.match(/^(\s*)[-*] (.*)$/))) {
      const pad = ' '.repeat(2 + m[1].length);
      out.push(...wrap(m[2], { prefix: `${pad}• `, prefixWidth: pad.length + 2, width, color }));
    } else {
      out.push(...wrap(raw.trim(), { width, color }));
    }
  }
  return out.join('\n').trimEnd();
}

// `title` may include the "N. " number; it is ignored on both sides.
export function renderSection(markdown, title, opts) {
  const bare = (s) => s.replace(/^\s*\d+\.\s*/, '').trim().toLowerCase();
  const wanted = bare(title);
  const lines = String(markdown ?? '').split(/\r?\n/);

  let start = -1;
  let end = lines.length;
  let inCode = false;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*```/.test(lines[i])) inCode = !inCode;
    if (inCode || !lines[i].startsWith('## ')) continue;
    if (start === -1) {
      if (bare(lines[i].slice(3)) === wanted) start = i;
    } else {
      end = i;
      break;
    }
  }
  if (start === -1) return null;
  return renderRestartNote(lines.slice(start, end).join('\n'), opts);
}
