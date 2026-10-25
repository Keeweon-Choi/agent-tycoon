// D2 through the engine: the migration on start, and add/edit/remove keeping
// projects.json and assignments.json consistent.
import * as fs from 'fs';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { EngineActionKind } from '../../../../core/src/messages.js';
import { engineCalls, killFakeSessions, makeEngineHome, removeTestHome } from '../testHome.js';
import { Engine } from './engine.js';
import type { ProjectRecord } from './registry.js';
import { assignmentsPath, loadRegistry, registryFault, registryPath } from './registry.js';

let cleanup: Array<() => void> = [];
afterEach(() => {
  delete registryFault.afterWrite;
  for (const c of cleanup.reverse()) c();
  cleanup = [];
});

function setup(readOnly = false) {
  const { home, claudePath } = makeEngineHome();
  const file = registryPath(home);
  const logs: string[] = [];
  const engines: Engine[] = [];
  const boot = () => {
    const e = new Engine({
      claudePath,
      home,
      readOnly,
      systemdRun: null,
      log: (l) => logs.push(l),
      timing: {
        pollMs: 20,
        appearMs: 5_000,
        goneMs: 5_000,
        reviveGapMs: 150,
        debounceMs: 50,
        watchMs: 0,
        safetyMs: 60_000,
      },
      env: process.env,
      binDir: null,
    });
    engines.push(e);
    e.start();
    return e;
  };
  cleanup.push(() => {
    for (const e of engines) e.dispose();
    killFakeSessions(home);
    removeTestHome(home);
  });
  const folder = (name: string) => {
    const d = path.join(home, 'work', name);
    fs.mkdirSync(d, { recursive: true });
    return d;
  };
  let n = 0;
  const act = (e: Engine, action: EngineActionKind, name: string, fields = {}) =>
    e.run({ type: 'engineAction', requestId: `r${++n}`, action, name, ...fields }, true, 'linux');
  const v1 = (projects: unknown[]) => {
    const bytes = `${JSON.stringify({ v: 1, projects })}\n`;
    fs.writeFileSync(file, bytes);
    return bytes;
  };
  const listing = () =>
    fs
      .readdirSync(path.dirname(file))
      .filter((f) => /^(projects|assignments)\.json/.test(f))
      .sort();
  return { home, file, logs, boot, folder, act, v1, listing };
}

const readJson = (f: string) => JSON.parse(fs.readFileSync(f, 'utf8')) as Record<string, unknown>;

describe('registry v2 in the engine (D2)', () => {
  it('migrates v1 on start; a restart keeps both ids', () => {
    const { file, logs, boot, folder, v1 } = setup();
    const bytes = v1([
      { projectId: 'p_aaaaaaaaaa', name: 'alpha', folder: folder('alpha'), wantRunning: false },
    ]);

    const e = boot();

    expect(logs.some((l) => l.includes('projects.json: migrated to v2'))).toBe(true);
    expect(fs.readFileSync(`${file}.v1`, 'utf8')).toBe(bytes);
    const stored = loadRegistry(file);
    expect(stored).toMatchObject({ broken: null, version: 2 });
    const [alpha] = stored.projects;
    expect(alpha.projectId).toBe('p_aaaaaaaaaa');
    expect(e.state().projects.map((p) => p.name)).toEqual(['alpha']);

    boot();
    expect(loadRegistry(file).projects).toEqual([alpha]);
  });

  it('a read-only engine migrates (it writes its own bookkeeping): a revive saves the new conversation', async () => {
    const { file, logs, boot, folder, v1 } = setup(true);
    const old = '11111111-1111-4111-8111-111111111111';
    const bytes = v1([
      {
        projectId: 'p_aaaaaaaaaa',
        name: 'alpha',
        folder: folder('alpha'),
        wantRunning: true,
        sessionId: old,
      },
    ]);

    const e = boot();

    expect(fs.readFileSync(`${file}.v1`, 'utf8')).toBe(bytes);
    const live = () => e.state().projects.find((p) => p.name === 'alpha')!;
    await vi.waitFor(() => expect(live().live).toBe(true), { timeout: 10_000 });
    expect(logs.filter((l) => l.includes('revive "alpha"'))).toEqual([
      expect.stringContaining('revive "alpha": ok'),
    ]);
    const [stored] = loadRegistry(file).projects;
    expect(stored.sessionId).toBe(live().sessionId);
    expect(stored.sessionId).not.toBe(old); // no transcript: a new conversation, recorded
    expect(stored.backgroundId).toBeTruthy();
    expect(stored.wantRunning).toBe(true);
  });

  it('a failed migration leaves the old file the only truth and the registry unwritable', async () => {
    const { home, file, logs, boot, folder, act, v1 } = setup();
    const bytes = v1([
      { projectId: 'p_aaaaaaaaaa', name: 'alpha', folder: folder('alpha'), wantRunning: true },
    ]);
    fs.mkdirSync(`${file}.${process.pid}.tmp`); // projects.json cannot be written

    const e = boot();

    expect(logs.some((l) => l.includes('could not migrate projects.json to v2'))).toBe(true);
    expect(e.state().warnings?.[0]).toMatch(/권한을 확인한 뒤 cld-gui 를 다시 시작하세요/);
    expect(fs.readFileSync(file, 'utf8')).toBe(bytes);
    expect(fs.existsSync(assignmentsPath(file))).toBe(false);
    expect((await act(e, 'add', 'beta', { folder: folder('beta') })).error).toBe(
      '프로젝트 목록 파일을 읽지 못해 바꿀 수 없어요',
    );
    expect(engineCalls(home)).toEqual([]); // and no revive
  });

  it('a broken v2 pair is never written', async () => {
    const { file, boot, folder, act } = setup();
    const bytes = `${JSON.stringify({
      v: 2,
      projects: [
        {
          projectId: 'p_aaaaaaaaaa',
          name: 'alpha',
          folder: folder('alpha'),
          leadAssignmentId: 'a_aaaaaaaaaa',
        },
      ],
    })}\n`;
    fs.writeFileSync(file, bytes);
    fs.writeFileSync(assignmentsPath(file), '{"v":1,"assignments":[]}\n');

    const e = boot();

    expect(e.state().warnings?.[0]).toMatch(/no assignment "a_aaaaaaaaaa"/);
    expect(e.registryProblem()).toMatch(/no assignment "a_aaaaaaaaaa"/); // the messenger holds its queue
    expect((await act(e, 'add', 'beta', { folder: folder('beta') })).error).toBe(
      '프로젝트 목록 파일을 읽지 못해 바꿀 수 없어요',
    );
    expect(fs.readFileSync(file, 'utf8')).toBe(bytes);
    expect(fs.readFileSync(assignmentsPath(file), 'utf8')).toBe('{"v":1,"assignments":[]}\n');
  });

  it('wake on a broken registry starts nothing', async () => {
    const { home, file, boot, folder } = setup();
    const lead = (id: string, name: string) => ({
      projectId: `p_${id.repeat(10)}`,
      name,
      folder: folder(name),
      leadAssignmentId: `a_${id.repeat(10)}`,
    });
    fs.writeFileSync(
      file,
      `${JSON.stringify({ v: 2, projects: [lead('a', 'alpha'), lead('b', 'beta')] })}\n`,
    );
    // alpha, retired for idleness, reads fine; beta's assignment is missing (broken).
    fs.writeFileSync(
      assignmentsPath(file),
      `${JSON.stringify({
        v: 1,
        assignments: [
          {
            assignmentId: 'a_aaaaaaaaaa',
            projectId: 'p_aaaaaaaaaa',
            role: 'lead',
            provider: 'claude',
            wantRunning: true,
            idleRetired: true,
            sessionId: '0123abcd-0000-4000-8000-0123456789ab',
          },
        ],
      })}\n`,
    );

    const e = boot();

    expect(e.registryProblem()).toMatch(/no assignment "a_bbbbbbbbbb"/);
    expect(e.names()).toEqual(['alpha']);
    expect(await e.wake('alpha')).toBe(false);
    expect(engineCalls(home).filter((c) => c.argv.includes('--bg'))).toEqual([]);
  });

  it('add, edit and remove keep both files consistent', async () => {
    const { file, boot, folder, act } = setup();
    const e = boot();
    expect((await act(e, 'add', 'alpha', { folder: folder('alpha') })).ok).toBe(true);
    expect((await act(e, 'add', 'beta', { folder: folder('beta') })).ok).toBe(true);
    const added = loadRegistry(file);
    expect(added.broken).toBeNull();
    const ids = added.projects.map((p) => [p.projectId, p.leadAssignmentId]);
    expect(new Set(ids.flat()).size).toBe(4);

    await act(e, 'edit', 'alpha', { room: 'lab', model: 'opus' });
    const edited = loadRegistry(file);
    expect(edited.broken).toBeNull();
    expect(edited.projects.map((p) => [p.projectId, p.leadAssignmentId])).toEqual(ids);
    expect(readJson(file).projects).toContainEqual(expect.objectContaining({ room: 'lab' }));
    expect(readJson(assignmentsPath(file)).assignments).toContainEqual(
      expect.objectContaining({ assignmentId: ids[0][1], model: 'opus' }),
    );

    await act(e, 'remove', 'beta');
    const removed = loadRegistry(file);
    expect(removed.broken).toBeNull();
    expect(removed.projects.map((p) => p.name)).toEqual(['alpha']);
    expect(readJson(assignmentsPath(file)).assignments).toEqual([
      expect.objectContaining({ assignmentId: ids[0][1], projectId: ids[0][0], role: 'lead' }),
    ]);
  });

  /** The daemon dies right after a save's first file lands (no cleanup runs). */
  const crashAfterFirstWrite = () => {
    registryFault.afterWrite = () => {
      delete registryFault.afterWrite;
      throw new Error('crash');
    };
  };
  /** The next start: every project loads, nothing broken; returns its logs' orphan lines. */
  function restartLoads(s: ReturnType<typeof setup>, expected: Record<string, ProjectRecord>) {
    const from = s.logs.length;
    const e = s.boot();
    expect(e.state().warnings ?? []).toEqual([]);
    const loaded = loadRegistry(s.file);
    expect(loaded.broken).toBeNull();
    expect(Object.fromEntries(loaded.projects.map((p) => [p.name, p]))).toEqual(expected);
    const orphanLines = s.logs.slice(from).filter((l) => l.includes('without a project'));
    return { e, loaded, orphanLines };
  }
  /** After the next save, assignments.json holds exactly the projects' leads. */
  function noOrphanAfterSave(s: ReturnType<typeof setup>) {
    const loaded = loadRegistry(s.file);
    expect(loaded).toMatchObject({ broken: null, orphans: [] });
    expect(
      (readJson(assignmentsPath(s.file)).assignments as Array<{ assignmentId: string }>)
        .map((a) => a.assignmentId)
        .sort(),
    ).toEqual(loaded.projects.map((p) => p.leadAssignmentId).sort());
  }
  const byName = (file: string) =>
    Object.fromEntries(loadRegistry(file).projects.map((p) => [p.name, p]));

  it('a crash in the middle of an add: the next start loads every project, the orphan is dropped', async () => {
    const s = setup();
    const e = s.boot();
    await s.act(e, 'add', 'alpha', { folder: s.folder('alpha'), model: 'opus' });
    const before = byName(s.file);
    crashAfterFirstWrite();
    expect((await s.act(e, 'add', 'beta', { folder: s.folder('beta') })).ok).toBe(false);
    e.dispose();

    const { e: e2, orphanLines } = restartLoads(s, before);
    expect(orphanLines).toHaveLength(1);
    await s.act(e2, 'edit', 'alpha', { room: 'lab' });
    noOrphanAfterSave(s);
  });

  it('a crash in the middle of a remove: the next start loads every project, the orphan is dropped', async () => {
    const s = setup();
    const e = s.boot();
    await s.act(e, 'add', 'alpha', { folder: s.folder('alpha'), model: 'opus' });
    await s.act(e, 'add', 'beta', { folder: s.folder('beta') });
    const { alpha } = byName(s.file);
    crashAfterFirstWrite();
    expect((await s.act(e, 'remove', 'beta')).ok).toBe(false);
    e.dispose();

    const { e: e2, orphanLines } = restartLoads(s, { alpha });
    expect(orphanLines).toHaveLength(1);
    await s.act(e2, 'edit', 'alpha', { room: 'lab' });
    noOrphanAfterSave(s);
  });

  it('a crash in the middle of an agent-field change: only assignments.json was due, nothing lost', async () => {
    const s = setup();
    const e = s.boot();
    await s.act(e, 'add', 'alpha', { folder: s.folder('alpha') });
    const projectsBytes = fs.readFileSync(s.file, 'utf8');
    const { alpha } = byName(s.file);
    crashAfterFirstWrite();
    await s.act(e, 'edit', 'alpha', { model: 'opus' }); // the crash comes after its only write
    e.dispose();
    expect(fs.readFileSync(s.file, 'utf8')).toBe(projectsBytes);

    const { orphanLines } = restartLoads(s, { alpha: { ...alpha, model: 'opus' } });
    expect(orphanLines).toEqual([]);
    noOrphanAfterSave(s);
  });

  it('an error on the last write of a remove: the remove stands, memory and disk agree', async () => {
    const s = setup();
    const e = s.boot();
    await s.act(e, 'add', 'alpha', { folder: s.folder('alpha') });
    await s.act(e, 'add', 'beta', { folder: s.folder('beta') });
    const { alpha } = byName(s.file);
    const jam = `${assignmentsPath(s.file)}.${process.pid}.tmp`;
    fs.mkdirSync(jam); // assignments.json cannot be written (projects.json can)

    expect((await s.act(e, 'remove', 'beta')).ok).toBe(true);
    expect(s.logs.some((l) => l.includes('could not drop the old assignments'))).toBe(true);
    expect(e.state().projects.map((p) => p.name)).toEqual(['alpha']);
    expect(byName(s.file)).toEqual({ alpha });

    fs.rmdirSync(jam);
    await s.act(e, 'edit', 'alpha', { room: 'lab' }); // an unrelated save: beta stays gone
    expect(Object.keys(byName(s.file))).toEqual(['alpha']);
    noOrphanAfterSave(s);
  });
});
