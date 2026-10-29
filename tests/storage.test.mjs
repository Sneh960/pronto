import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { archiveShutdown, latestShutdown, listShutdowns, pruneHistory } from '../src/storage.mjs';

function tempRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pronto-storage-'));
  fs.mkdirSync(path.join(root, '.pronto'));
  fs.writeFileSync(path.join(root, 'TOMORROW.md'), '# TOMORROW.md\n');
  fs.writeFileSync(path.join(root, '.pronto', 'wip-backup.patch'), 'diff\n');
  fs.writeFileSync(path.join(root, '.pronto', 'state.json'), JSON.stringify({ checkpoint: { branch: 'main' } }));
  return root;
}

test('archive copies files, keeps originals, records branch', () => {
  const root = tempRoot();
  const { dir, files } = archiveShutdown(root);
  assert.deepEqual(files.sort(), ['TOMORROW.md', 'state.json', 'wip-backup.patch']);
  assert.equal(fs.readFileSync(path.join(dir, 'TOMORROW.md'), 'utf8'), '# TOMORROW.md\n');
  assert.ok(fs.existsSync(path.join(root, 'TOMORROW.md')));
  assert.equal(latestShutdown(root).branch, 'main');
});

test('same-second archives get a suffix; list is newest first and skips corrupt meta', () => {
  const root = tempRoot();
  const at = new Date(2026, 9, 29, 19, 0, 0);
  const a = archiveShutdown(root, { savedAt: at });
  const b = archiveShutdown(root, { savedAt: at });
  assert.equal(b.id, `${a.id}-2`);
  archiveShutdown(root, { savedAt: new Date(2026, 9, 30, 19, 0, 0) });
  fs.mkdirSync(path.join(root, '.pronto', 'history', 'broken'));
  const list = listShutdowns(root);
  assert.equal(list.length, 3);
  assert.ok(list[0].savedAt > list[2].savedAt);
});

test('prune removes old entries but always keeps the newest', () => {
  const root = tempRoot();
  archiveShutdown(root, { savedAt: new Date(2026, 0, 1) });
  archiveShutdown(root, { savedAt: new Date(2026, 0, 2) });
  const removed = pruneHistory(root, { keepDays: 14, now: new Date(2026, 5, 1) });
  assert.equal(removed.length, 1);
  assert.equal(listShutdowns(root).length, 1);
});

test('missing files and no history are handled', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pronto-storage-'));
  assert.deepEqual(listShutdowns(root), []);
  assert.equal(latestShutdown(root), null);
  assert.deepEqual(archiveShutdown(root).files, []);
});
