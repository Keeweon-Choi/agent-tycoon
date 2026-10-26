import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import zlib from 'node:zlib';

const require = createRequire(import.meta.url);
const backup = require('./cld-gui-backup.js');

const now = () => Date.UTC(2026, 9, 24, 12, 34, 56);
const allowed = {
  'projects.json': 'projects', 'assignments.json': 'assignments', 'tasks.json': 'tasks',
  'groups/general/posts.json': 'group posts', 'groups/general/thread/a.json': 'nested post',
  'memos.json': 'memos', 'pins.json': 'pins', 'levels.json': 'levels',
  'characters.json': 'characters index', 'characters/ada.json': 'ada', 'characters/sub/bob.json': 'bob',
  'building.json': 'building', 'decor.json': 'decor', 'worktrees.json': 'worktrees',
  'job-history.json': 'history', 'rules-engine.md': 'rules', 'events.jsonl': 'event\n',
  'pixel-agents/layout.json': 'layout',
};

function put(home, relative, content) {
  const file = relative.startsWith('pixel-agents/')
    ? path.join(home, '.pixel-agents', relative.slice('pixel-agents/'.length))
    : path.join(home, '.config', 'agent-tycoon', relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

function get(home, relative) {
  return relative.startsWith('pixel-agents/')
    ? path.join(home, '.pixel-agents', relative.slice('pixel-agents/'.length))
    : path.join(home, '.config', 'agent-tycoon', relative);
}

function seed() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cld-backup-'));
  for (const [relative, content] of Object.entries(allowed)) put(home, relative, content);
  for (const relative of [
    'agent-tokens.json', 'devices.json', 'passkeys.json', 'passkeys.json.old', 'sessions.json',
    'push.json', 'tls/key.pem', 'config.json', 'host.json', 'audit.jsonl', 'shells.json',
    'daemon.log', 'engine.sock', 'engine.state', 'inbox/message.json', 'queue/message.json',
    'typed/message.json', 'tasks.json.bak', 'projects.json.v0', 'mystery-secret.json',
  ]) put(home, relative, `SECRET-TOKEN-1234 in ${relative}`);
  return home;
}

function deps(home, extra = {}) {
  return { home, cwd: home, now, hostname: 'test-host', daemonRunning: async () => false, ...extra };
}

function archive(file) { return JSON.parse(zlib.gunzipSync(fs.readFileSync(file)).toString('utf8')); }
function writeArchive(file, value) { fs.writeFileSync(file, zlib.gzipSync(Buffer.from(JSON.stringify(value)))); }

function treeHash(root) {
  const parts = [];
  const walk = (directory, prefix = '') => {
    for (const name of fs.readdirSync(directory).sort()) {
      const file = path.join(directory, name); const relative = `${prefix}${name}`; const stat = fs.lstatSync(file);
      if (stat.isDirectory()) walk(file, `${relative}/`);
      else parts.push(`${relative}:${stat.mode & 0o777}:${crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')}`);
    }
  };
  walk(root);
  return crypto.createHash('sha256').update(parts.join('\n')).digest('hex');
}

test('backup contains the allow list only and no seeded secret', () => {
  const home = seed();
  try {
    const result = backup.backup(deps(home));
    const parsed = archive(result.file);
    assert.deepEqual(Object.keys(parsed.files).sort(), Object.keys(allowed).sort());
    assert.equal(parsed.format, backup.BACKUP_FORMAT);
    assert.equal(parsed.v, 1);
    assert.equal(parsed.sha256, crypto.createHash('sha256').update(backup.canonicalJson(parsed.files)).digest('hex'));
    assert.doesNotMatch(zlib.gunzipSync(fs.readFileSync(result.file)).toString('utf8'), /SECRET-TOKEN-1234/);
    assert.equal(fs.statSync(result.file).mode & 0o777, 0o600);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('backup skips an oversized event log with a notice', () => {
  const home = seed();
  try {
    fs.truncateSync(get(home, 'events.jsonl'), backup.MAX_EVENTS_SIZE + 1);
    const result = backup.backup(deps(home));
    assert.ok(result.skipped.some((line) => line.includes('events.jsonl')));
    assert.equal(Object.hasOwn(archive(result.file).files, 'events.jsonl'), false);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('round trip restores records, saves replaced copies, and writes mode 0600', async () => {
  const home = seed();
  try {
    const made = backup.backup(deps(home));
    for (const relative of Object.keys(allowed)) put(home, relative, `changed: ${relative}`);
    const restored = await backup.restore(deps(home), { file: made.file, yes: true });
    assert.equal(restored.ok, true);
    for (const [relative, content] of Object.entries(allowed)) {
      assert.equal(fs.readFileSync(get(home, relative), 'utf8'), content);
      assert.equal(fs.readFileSync(path.join(restored.savedDirectory, relative), 'utf8'), `changed: ${relative}`);
      assert.equal(fs.statSync(get(home, relative)).mode & 0o777, 0o600);
    }
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('broken archives are refused before config changes', async () => {
  const home = seed();
  try {
    const made = backup.backup(deps(home));
    const original = archive(made.file);
    const cases = [
      ['truncated gzip', (file) => fs.writeFileSync(file, fs.readFileSync(made.file).subarray(0, 12))],
      ['bad JSON', (file) => fs.writeFileSync(file, zlib.gzipSync(Buffer.from('{')))],
      ['wrong format', (file) => writeArchive(file, { ...original, format: 'wrong' })],
      ['wrong version', (file) => writeArchive(file, { ...original, v: 2 })],
      ['file hash', (file) => writeArchive(file, { ...original, files: { ...original.files, 'projects.json': { ...original.files['projects.json'], sha256: '0'.repeat(64) } } })],
      ['top hash', (file) => writeArchive(file, { ...original, sha256: '0'.repeat(64) })],
      ['parent path', (file) => {
        const files = { '../evil': original.files['projects.json'] };
        writeArchive(file, { ...original, files, sha256: crypto.createHash('sha256').update(backup.canonicalJson(files)).digest('hex') });
      }],
      ['absolute path', (file) => {
        const files = { '/evil': original.files['projects.json'] };
        writeArchive(file, { ...original, files, sha256: crypto.createHash('sha256').update(backup.canonicalJson(files)).digest('hex') });
      }],
      ['not allowed', (file) => {
        const files = { 'agent-tokens.json': original.files['projects.json'] };
        writeArchive(file, { ...original, files, sha256: crypto.createHash('sha256').update(backup.canonicalJson(files)).digest('hex') });
      }],
    ];
    for (const [name, make] of cases) {
      const file = path.join(home, `${name.replaceAll(' ', '-')}.gz`);
      make(file);
      const before = treeHash(path.join(home, '.config', 'agent-tycoon'));
      const result = await backup.restore(deps(home), { file, yes: true });
      assert.equal(result.ok, false, name);
      assert.equal(treeHash(path.join(home, '.config', 'agent-tycoon')), before, name);
    }
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('restore refuses a running daemon and previews without --yes', async () => {
  const home = seed();
  try {
    const made = backup.backup(deps(home));
    put(home, 'projects.json', 'changed');
    const before = treeHash(path.join(home, '.config', 'agent-tycoon'));
    const running = await backup.restore(deps(home, { daemonRunning: async () => true }), { file: made.file, yes: true });
    assert.deepEqual(running, { ok: false, error: 'cld-gui 를 멈춘 뒤 다시 하세요' });
    const preview = await backup.restore(deps(home), { file: made.file, yes: false });
    assert.equal(preview.preview, true);
    assert.ok(preview.lines.includes('바꿀 파일: projects.json'));
    assert.equal(treeHash(path.join(home, '.config', 'agent-tycoon')), before);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('restore preview does not create directories in an empty destination home', async () => {
  const source = seed();
  const destination = fs.mkdtempSync(path.join(os.tmpdir(), 'cld-restore-preview-'));
  try {
    const made = backup.backup(deps(source));
    const result = await backup.restore(deps(destination), { file: made.file, yes: false });
    assert.equal(result.preview, true);
    assert.deepEqual(fs.readdirSync(destination), []);
  } finally {
    fs.rmSync(source, { recursive: true, force: true });
    fs.rmSync(destination, { recursive: true, force: true });
  }
});

test('restore --yes into an empty home (a fresh install after uninstall --reset) creates the folders it needs', async () => {
  const source = seed();
  const destination = fs.mkdtempSync(path.join(os.tmpdir(), 'cld-restore-fresh-'));
  try {
    const made = backup.backup(deps(source));
    const result = await backup.restore(deps(destination), { file: made.file, yes: true });
    assert.equal(result.ok, true, result.error);
    for (const [relative, content] of Object.entries(allowed)) assert.equal(fs.readFileSync(get(destination, relative), 'utf8'), content);
  } finally {
    fs.rmSync(source, { recursive: true, force: true });
    fs.rmSync(destination, { recursive: true, force: true });
  }
});

test('a failed replacement restores the already-written originals', async () => {
  const home = seed();
  try {
    const made = backup.backup(deps(home));
    for (const relative of Object.keys(allowed)) put(home, relative, `changed: ${relative}`);
    const changed = treeHash(path.join(home, '.config', 'agent-tycoon'));
    let renames = 0;
    const failingFs = Object.create(fs);
    failingFs.renameSync = (...args) => {
      renames += 1;
      if (renames === 3) throw new Error('simulated rename failure');
      return fs.renameSync(...args);
    };
    const result = await backup.restore(deps(home, { fs: failingFs }), { file: made.file, yes: true });
    assert.equal(result.ok, false);
    for (const [relative] of Object.entries(allowed)) assert.equal(fs.readFileSync(get(home, relative), 'utf8'), `changed: ${relative}`);
    assert.notEqual(result.savedDirectory, undefined);
    assert.notEqual(treeHash(path.join(home, '.config', 'agent-tycoon')), changed, 'saved originals are retained after rollback');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
