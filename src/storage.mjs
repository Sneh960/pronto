// Nightly history: each shutdown's TOMORROW.md, patch and state are copied to
// .pronto/history/<YYYY-MM-DD_HHMMSS>/ so tonight's run never overwrites last night's.

import fs from 'node:fs';
import path from 'node:path';

const historyDir = (root) => path.join(root, '.pronto', 'history');
const SOURCES = { 'TOMORROW.md': 'TOMORROW.md', 'wip-backup.patch': '.pronto/wip-backup.patch', 'state.json': '.pronto/state.json' };

function stamp(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export function archiveShutdown(root, { savedAt = new Date() } = {}) {
  fs.mkdirSync(historyDir(root), { recursive: true });
  let id = stamp(savedAt);
  for (let n = 2; fs.existsSync(path.join(historyDir(root), id)); n++) id = `${stamp(savedAt)}-${n}`;
  const dir = path.join(historyDir(root), id);
  fs.mkdirSync(dir);

  const files = [];
  for (const [name, rel] of Object.entries(SOURCES)) {
    const src = path.join(root, rel);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, path.join(dir, name));
      files.push(name);
    }
  }
  let branch = null;
  try {
    branch = JSON.parse(fs.readFileSync(path.join(root, '.pronto', 'state.json'), 'utf8')).checkpoint?.branch ?? null;
  } catch {
    // no state yet
  }
  const meta = { id, savedAt: savedAt.toISOString(), files, branch };
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2) + '\n');
  return { id, dir, files };
}

export function listShutdowns(root) {
  let ids;
  try {
    ids = fs.readdirSync(historyDir(root));
  } catch {
    return [];
  }
  const entries = [];
  for (const id of ids) {
    const dir = path.join(historyDir(root), id);
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
      entries.push({ id, dir, savedAt: meta.savedAt, branch: meta.branch ?? null, files: meta.files ?? [] });
    } catch {
      // skip dirs with missing or corrupt meta.json
    }
  }
  return entries.sort((a, b) => b.savedAt.localeCompare(a.savedAt) || b.id.localeCompare(a.id));
}

export function latestShutdown(root) {
  return listShutdowns(root)[0] ?? null;
}

export function pruneHistory(root, { keepDays = 14, now = new Date() } = {}) {
  const cutoff = now.getTime() - keepDays * 24 * 60 * 60 * 1000;
  const removed = [];
  for (const entry of listShutdowns(root).slice(1)) {
    if (new Date(entry.savedAt).getTime() < cutoff) {
      fs.rmSync(entry.dir, { recursive: true, force: true });
      removed.push(entry.id);
    }
  }
  return removed;
}
