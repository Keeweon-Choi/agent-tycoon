import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, expect, it } from 'vitest';

import { normalizeProjectPath } from '../../../../core/src/normalizeProjectPath.js';
import { detectHostInfo } from '../folders.js';
import { Engine } from './engine.js';
import { safeHomeFolder, scanProjects } from './importProjects.js';
import { loadRegistry, registryPath } from './registry.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function fixture() {
  const top = fs.mkdtempSync(path.join(os.tmpdir(), 'cld-import-'));
  dirs.push(top);
  const home = path.join(top, 'home');
  const root = path.join(home, 'projects');
  fs.mkdirSync(root, { recursive: true });
  const git = path.join(root, 'same');
  fs.mkdirSync(path.join(git, '.git'), { recursive: true });
  fs.writeFileSync(path.join(git, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  const claude = path.join(root, 'nested', 'same');
  fs.mkdirSync(claude, { recursive: true });
  fs.writeFileSync(path.join(claude, 'CLAUDE.md'), 'rules');
  const session = path.join(root, 'session');
  fs.mkdirSync(session);
  const transcriptDir = path.join(home, '.claude', 'projects', normalizeProjectPath(session));
  fs.mkdirSync(transcriptDir, { recursive: true });
  const oldFile = path.join(transcriptDir, `${uuid(1)}.jsonl`);
  const newFile = path.join(transcriptDir, `${uuid(2)}.jsonl`);
  fs.writeFileSync(oldFile, '{"type":"user","message":{"content":"old"}}\n');
  fs.writeFileSync(
    newFile,
    '{"type":"user","message":{"content":"Newest request with more words"}}\n',
  );
  fs.utimesSync(oldFile, 1, 1);
  fs.utimesSync(newFile, 2, 2);
  const outside = path.join(top, 'outside');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'CLAUDE.md'), 'outside');
  fs.symlinkSync(outside, path.join(root, 'escape'));
  const linkedGit = path.join(root, 'linked-git');
  fs.mkdirSync(linkedGit);
  fs.mkdirSync(path.join(outside, '.git'));
  fs.writeFileSync(path.join(outside, '.git', 'HEAD'), 'ref: refs/heads/outside\n');
  fs.symlinkSync(path.join(outside, '.git'), path.join(linkedGit, '.git'));
  return { home, root, git, claude, session, newFile, outside };
}

it('finds git, CLAUDE.md and the newest Claude conversation; de-duplicates names and marks existing', () => {
  const f = fixture();
  const rows = scanProjects(
    f.root,
    detectHostInfo(f.home),
    [
      { name: 'same', folder: f.git, wantRunning: false },
      { name: 'registered-session', folder: f.outside, sessionId: uuid(2), wantRunning: false },
    ],
    [{ cwd: f.claude, kind: 'background', sessionId: uuid(3), pid: 123 }],
  );
  expect(rows).toHaveLength(3);
  expect(rows.find((r) => r.folder === f.git)).toMatchObject({ branch: 'main', already: true });
  expect(rows.find((r) => r.folder === f.session)).toMatchObject({
    sessionId: uuid(2),
    title: 'Newest request with more words',
    already: true,
  });
  expect(rows.find((r) => r.folder === f.git)?.name).toBe('same'); // already in the office: its own name
  expect(rows.find((r) => r.folder === f.claude)?.live).toBe(true);
  expect(new Set(rows.map((r) => r.name)).size).toBe(3);
  expect(rows.some((r) => r.folder === f.outside)).toBe(false);
  expect(rows.some((r) => r.folder.endsWith('linked-git'))).toBe(false);
  expect(safeHomeFolder(path.join(f.root, 'escape'), detectHostInfo(f.home))).toBeNull();
});

it('C2: an engine-started conversation titles with its header line, never the mark', () => {
  const f = fixture();
  fs.writeFileSync(
    f.newFile,
    `${JSON.stringify({ type: 'user', message: { content: '[사장 · 메신저 · 10-24 07:41] ⟨m:ab2cd3ef⟩\n배포해 줘' } })}\n`,
  );
  const rows = scanProjects(f.root, detectHostInfo(f.home), [], []);
  expect(rows.find((r) => r.folder === f.session)?.title).toBe('[사장 · 메신저 · 10-24 07:41]');
});

it('reads only a bounded transcript head even when the file is 300 MB', () => {
  const f = fixture();
  fs.truncateSync(f.newFile, 300 * 1024 * 1024);
  expect(fs.statSync(f.newFile).size).toBe(300 * 1024 * 1024);
  const rows = scanProjects(f.root, detectHostInfo(f.home), [], []);
  expect(rows.find((r) => r.folder === f.session)?.sessionId).toBe(uuid(2));
  expect(rows.find((r) => r.folder === f.session)?.title).toBe('Newest request with more words');
});

it('imports resume or a new conversation without touching project folders; refuses read-only clients and undoes registry rows', async () => {
  const f = fixture();
  const before = fs.readdirSync(f.root, { recursive: true }).sort();
  const engine = new Engine({
    claudePath: '/missing/claude',
    home: f.home,
    readOnly: false,
    systemdRun: null,
    timing: { watchMs: 0 },
  });
  engine.start();
  try {
    expect(() => engine.scanImport(f.root, false)).toThrow('권한');
    const denied = await engine.importProjects(
      'denied',
      f.root,
      [{ folder: f.session, name: 'session', room: 'projects', resume: true, start: false }],
      false,
    );
    expect(denied.rows[0].status).toBe('failed');
    const result = await engine.importProjects(
      'batch',
      f.root,
      [
        { folder: f.session, name: 'session', room: 'projects', resume: true, start: false },
        { folder: f.claude, name: 'new', room: 'projects', resume: false, start: false },
      ],
      true,
    );
    expect(result.rows.map((r) => r.status)).toEqual(['added', 'added']);
    const stored = loadRegistry(registryPath(f.home)).projects;
    expect(stored.find((p) => p.name === 'session')?.sessionId).toBe(uuid(2));
    expect(stored.find((p) => p.name === 'new')?.sessionId).toBeUndefined();
    // D2: each imported project got its own lead assignment.
    expect(loadRegistry(registryPath(f.home)).broken).toBeNull();
    expect(new Set(stored.map((p) => p.leadAssignmentId)).size).toBe(2);
    expect(fs.readdirSync(f.root, { recursive: true }).sort()).toEqual(before);
    const undo = engine.undoImport('undo', result.batchId!, true);
    expect(undo.rows.map((r) => r.status)).toEqual(['removed', 'removed']);
    expect(loadRegistry(registryPath(f.home))).toMatchObject({ projects: [], broken: null });
  } finally {
    engine.dispose();
  }
});

it('refuses scans and imports when the daemon is read-only', async () => {
  const f = fixture();
  const engine = new Engine({
    claudePath: '/missing/claude',
    home: f.home,
    readOnly: true,
    systemdRun: null,
    timing: { watchMs: 0 },
  });
  engine.start();
  try {
    expect(() => engine.scanImport(f.root, true)).toThrow('읽기 전용');
    const result = await engine.importProjects(
      'read-only',
      f.root,
      [{ folder: f.session, name: 'session', room: 'projects', resume: true, start: false }],
      true,
    );
    expect(result.rows[0]).toMatchObject({
      status: 'failed',
      reason: '읽기 전용 모드라 조작할 수 없어요',
    });
    expect(fs.existsSync(registryPath(f.home))).toBe(false);
  } finally {
    engine.dispose();
  }
});
