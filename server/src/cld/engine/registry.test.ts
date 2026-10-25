import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import { LEAD_HISTORY_VERSION } from './leadSwap.js';
import {
  ASSIGNMENT_ID_RE,
  ASSIGNMENTS_VERSION,
  assignmentsPath,
  type LeadRecord,
  loadRegistry,
  migrateRegistry,
  PROJECT_ID_RE,
  type ProjectRecord,
  PROJECTS_VERSION,
  registryFault,
  type RegistryPair,
  saveRegistry,
  splitRegistry,
} from './registry.js';
import { TASKS_VERSION } from './tasks.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function file(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cld-registry-'));
  dirs.push(dir);
  return path.join(dir, 'projects.json');
}

function project(overrides: Partial<ProjectRecord> = {}): ProjectRecord {
  return {
    projectId: 'p_abcdefghij',
    name: 'alpha',
    folder: path.join(os.tmpdir(), 'alpha'),
    wantRunning: false,
    room: 'room',
    title: 'Alpha',
    ...overrides,
  };
}

/** Every field a ProjectRecord holds, each set. */
function full(overrides: Partial<ProjectRecord> = {}): ProjectRecord {
  return project({
    rulesFile: path.join(os.tmpdir(), 'rules.md'),
    model: 'opus',
    permissionMode: 'acceptEdits',
    effort: 'high',
    remoteControl: true,
    alwaysOn: true,
    title: 'Alpha talk',
    wantRunning: true,
    sessionId: '0123abcd-0000-4000-8000-0123456789ab',
    backgroundId: 'bg-1',
    idleRetired: true,
    compactionNudge: 3,
    ...overrides,
  });
}

const read = (f: string): unknown => JSON.parse(fs.readFileSync(f, 'utf8'));
const files = (target: string): string[] => fs.readdirSync(path.dirname(target)).sort();

describe('project registry versions', () => {
  it("matches the release's dataSchema, tasks.json too (P3's rollback snapshots data only when these differ)", () => {
    const release = read(path.join(__dirname, '../../../../cld/release/version.json')) as {
      dataSchema: Record<string, number>;
    };
    expect(release.dataSchema['projects.json']).toBe(PROJECTS_VERSION);
    expect(release.dataSchema['assignments.json']).toBe(ASSIGNMENTS_VERSION);
    expect(release.dataSchema['tasks.json']).toBe(TASKS_VERSION);
    expect(release.dataSchema['lead-history.json']).toBe(LEAD_HISTORY_VERSION); // D3b
  });

  it('reads a legacy array into records with fresh well-formed ids', () => {
    const target = file();
    fs.writeFileSync(target, `${JSON.stringify([project({ projectId: undefined as never })])}\n`);

    const loaded = loadRegistry(target);

    expect(loaded.broken).toBeNull();
    expect(loaded.migrated).toBe(true);
    expect(loaded.version).toBe(0);
    expect(loaded.projects).toHaveLength(1);
    expect(loaded.projects[0].projectId).toMatch(PROJECT_ID_RE);
    expect(loaded.projects[0].leadAssignmentId).toMatch(ASSIGNMENT_ID_RE);
  });

  it('round-trips v2: the project part in projects.json, the agent part in assignments.json', () => {
    const target = file();
    const records = [
      full({ projectId: 'p_abcde23456', leadAssignmentId: 'a_abcde23456' }),
      project({ name: 'beta', projectId: 'p_bbbbbbbbbb', leadAssignmentId: 'a_bbbbbbbbbb' }),
    ];

    saveRegistry(target, records);

    expect(read(target)).toEqual({
      v: 2,
      projects: [
        {
          projectId: 'p_abcde23456',
          name: 'alpha',
          folder: records[0].folder,
          room: 'room',
          leadAssignmentId: 'a_abcde23456',
        },
        {
          projectId: 'p_bbbbbbbbbb',
          name: 'beta',
          folder: records[1].folder,
          room: 'room',
          leadAssignmentId: 'a_bbbbbbbbbb',
        },
      ],
    });
    expect(read(assignmentsPath(target))).toEqual({
      v: 1,
      assignments: [
        {
          assignmentId: 'a_abcde23456',
          projectId: 'p_abcde23456',
          role: 'lead',
          provider: 'claude',
          title: 'Alpha talk',
          rulesFile: records[0].rulesFile,
          model: 'opus',
          permissionMode: 'acceptEdits',
          effort: 'high',
          remoteControl: true,
          alwaysOn: true,
          wantRunning: true,
          sessionId: records[0].sessionId,
          backgroundId: 'bg-1',
          idleRetired: true,
          compactionNudge: 3,
        },
        {
          assignmentId: 'a_bbbbbbbbbb',
          projectId: 'p_bbbbbbbbbb',
          role: 'lead',
          provider: 'claude',
          title: 'Alpha',
          wantRunning: false,
        },
      ],
    });
    expect(fs.statSync(target).mode & 0o777).toBe(0o600);
    expect(fs.statSync(assignmentsPath(target)).mode & 0o777).toBe(0o600);
    expect(loadRegistry(target)).toEqual({
      projects: records,
      broken: null,
      migrated: false,
      version: 2,
      orphans: [],
    });
  });

  it('gives a new record both ids at its first write and keeps them on rename', () => {
    const target = file();
    saveRegistry(target, [{ name: 'alpha', folder: '/w/alpha', wantRunning: false }]);
    const [first] = loadRegistry(target).projects;
    expect(first.projectId).toMatch(PROJECT_ID_RE);
    expect(first.leadAssignmentId).toMatch(ASSIGNMENT_ID_RE);

    saveRegistry(target, [{ ...first, name: 'beta' }]);

    expect(loadRegistry(target).projects[0]).toMatchObject({
      name: 'beta',
      projectId: first.projectId,
      leadAssignmentId: first.leadAssignmentId,
    });
  });

  it('writes per change only what changed, in a crash-safe order', () => {
    const target = file();
    const written: string[] = [];
    registryFault.afterWrite = (f) => written.push(path.basename(f));
    try {
      const alpha = project({ leadAssignmentId: 'a_aaaaaaaaaa' });
      const beta = project({
        name: 'beta',
        projectId: 'p_bbbbbbbbbb',
        leadAssignmentId: 'a_bbbbbbbbbb',
      });
      const order = (records: ProjectRecord[]) => {
        written.length = 0;
        saveRegistry(target, records);
        return [...written];
      };
      expect(order([alpha])).toEqual(['assignments.json', 'projects.json']); // the first add
      expect(order([alpha, beta])).toEqual(['assignments.json', 'projects.json']); // add
      expect(order([alpha, { ...beta, model: 'opus', wantRunning: true }])).toEqual([
        'assignments.json',
      ]); // agent fields only
      expect(order([alpha, { ...beta, model: 'opus', wantRunning: true, room: 'lab' }])).toEqual([
        'projects.json',
      ]); // project fields only
      expect(order([alpha])).toEqual(['projects.json', 'assignments.json']); // remove
      expect(order([alpha])).toEqual([]); // nothing changed
    } finally {
      delete registryFault.afterWrite;
    }
  });

  it('never writes over a file older than v2 (only the migration does)', () => {
    const target = file();
    const bytes = `${JSON.stringify({ v: 1, projects: [project()] })}\n`;
    fs.writeFileSync(target, bytes);
    expect(() => saveRegistry(target, [project()])).toThrow(/not v2/);
    expect(fs.readFileSync(target, 'utf8')).toBe(bytes);
    expect(fs.existsSync(assignmentsPath(target))).toBe(false);
  });

  it('refuses duplicate and malformed v1 project ids', () => {
    const target = file();
    fs.writeFileSync(
      target,
      JSON.stringify({
        v: 1,
        projects: [project(), project({ name: 'beta', projectId: 'p_abcdefghij' })],
      }),
    );
    expect(loadRegistry(target).broken).toContain('duplicate projectId');

    fs.writeFileSync(target, JSON.stringify({ v: 1, projects: [project({ projectId: 'wrong' })] }));
    expect(loadRegistry(target).broken).toBe('an invalid entry');
  });
});

describe('broken v2 registries are refused and never written', () => {
  const lead = (p: ProjectRecord, id: string) => ({ ...p, leadAssignmentId: id });
  /** A v2 pair on disk, then what loading and migrating it make of it. */
  function refused(projects: unknown[], assignments: unknown | null, v = 2) {
    const target = file();
    const bytes = `${JSON.stringify({ v, projects })}\n`;
    fs.writeFileSync(target, bytes);
    const abytes = assignments === null ? null : `${JSON.stringify(assignments)}\n`;
    if (abytes !== null) fs.writeFileSync(assignmentsPath(target), abytes);
    const before = files(target);
    const loaded = loadRegistry(target);
    const logs: string[] = [];
    expect(migrateRegistry(target, loaded, (l) => logs.push(l))).toBeNull(); // nothing to do
    expect(fs.readFileSync(target, 'utf8')).toBe(bytes);
    if (abytes !== null) expect(fs.readFileSync(assignmentsPath(target), 'utf8')).toBe(abytes);
    expect(files(target)).toEqual(before);
    expect(logs).toEqual([]);
    return loaded.broken;
  }
  const pair = (records: ProjectRecord[]): RegistryPair => splitRegistry(records as LeadRecord[]);
  const asFile = (assignments: unknown[]) => ({ v: 1, assignments });

  it('a missing or unreadable assignments.json', () => {
    const { projects } = pair([lead(project(), 'a_aaaaaaaaaa')]);
    expect(refused(projects, null)).toBe('assignments.json is missing');
    // D3 reads v2 (a file with Workers); v3 is newer.
    expect(refused(projects, { v: 3, assignments: [] })).toBe(
      'assignments.json written by a newer version (v=3)',
    );
    expect(refused(projects, [])).toMatch(/not an assignment list/);
  });

  it('a project whose lead assignment is missing or another project’s', () => {
    const a = pair([lead(project(), 'a_aaaaaaaaaa')]);
    const b = pair([lead(project({ name: 'beta', projectId: 'p_bbbbbbbbbb' }), 'a_bbbbbbbbbb')]);
    expect(refused(a.projects, asFile([]))).toBe(
      'no assignment "a_aaaaaaaaaa" for project "alpha"',
    );
    expect(
      refused(a.projects, asFile([{ ...b.assignments[0], assignmentId: 'a_aaaaaaaaaa' }])),
    ).toBe('assignment "a_aaaaaaaaaa" belongs to another project');
  });

  it('a second assignment of a project, or a project without its id', () => {
    const a = pair([lead(project(), 'a_aaaaaaaaaa')]);
    const second = { ...a.assignments[0], assignmentId: 'a_cccccccccc' };
    expect(refused(a.projects, asFile([...a.assignments, second]))).toBe(
      'assignment "a_cccccccccc" is not its project\'s lead',
    );
    const { leadAssignmentId: _, ...noId } = a.projects[0];
    expect(refused([noId], asFile(a.assignments))).toBe('an invalid entry');
  });

  it('duplicate assignment ids', () => {
    const a = pair([lead(project(), 'a_aaaaaaaaaa')]);
    expect(refused(a.projects, asFile([...a.assignments, ...a.assignments]))).toBe(
      'a duplicate assignmentId "a_aaaaaaaaaa"',
    );
    const two = pair([
      lead(project(), 'a_aaaaaaaaaa'),
      lead(project({ name: 'beta', projectId: 'p_bbbbbbbbbb' }), 'a_aaaaaaaaaa'),
    ]);
    expect(refused(two.projects, asFile(two.assignments))).toMatch(/duplicate assignmentId/);
  });

  it('a role D3 cannot hold, a provider that is no provider id, or a project lead that is a Worker', () => {
    const a = pair([lead(project(), 'a_aaaaaaaaaa')]);
    expect(refused(a.projects, asFile([{ ...a.assignments[0], role: 'boss' }]))).toBe(
      'an invalid assignment',
    );
    // D3: 'worker' is a role now, but never the one the project names as its lead.
    expect(refused(a.projects, asFile([{ ...a.assignments[0], role: 'worker' }]))).toBe(
      'assignment "a_aaaaaaaaaa" is not a lead',
    );
    // D4: a provider this build does not have is not broken (that agent alone cannot start);
    // a value that is no provider id is.
    for (const provider of [7, '--x', ''])
      expect(refused(a.projects, asFile([{ ...a.assignments[0], provider }]))).toBe(
        'an invalid assignment',
      );
  });

  it('D4: an unknown provider loads as it is and is written back; absent reads as claude', () => {
    const target = file();
    const a = pair([lead(project(), 'a_aaaaaaaaaa')]);
    fs.writeFileSync(target, JSON.stringify({ v: 2, projects: a.projects }));
    fs.writeFileSync(
      assignmentsPath(target),
      JSON.stringify(asFile([{ ...a.assignments[0], provider: 'codex' }])),
    );
    const loaded = loadRegistry(target);
    expect(loaded.broken).toBeNull();
    expect(loaded.projects).toEqual([{ ...lead(project(), 'a_aaaaaaaaaa'), provider: 'codex' }]);
    saveRegistry(target, loaded.projects);
    expect(JSON.parse(fs.readFileSync(assignmentsPath(target), 'utf8')).assignments[0].provider).toBe(
      'codex',
    );
    const { provider: _p, ...bare } = a.assignments[0];
    fs.writeFileSync(assignmentsPath(target), JSON.stringify(asFile([bare])));
    expect(loadRegistry(target)).toMatchObject({
      broken: null,
      projects: [lead(project(), 'a_aaaaaaaaaa')],
    });
  });

  it('an orphan (its project gone, as a save cut short leaves) is ignored, not broken', () => {
    const target = file();
    const a = pair([lead(project(), 'a_aaaaaaaaaa')]);
    const orphan = { ...a.assignments[0], assignmentId: 'a_cccccccccc', projectId: 'p_cccccccccc' };
    fs.writeFileSync(target, JSON.stringify({ v: 2, projects: a.projects }));
    fs.writeFileSync(assignmentsPath(target), JSON.stringify(asFile([...a.assignments, orphan])));
    const loaded = loadRegistry(target);
    expect(loaded).toMatchObject({ broken: null, orphans: ['a_cccccccccc'] });
    expect(loaded.projects).toEqual([lead(project(), 'a_aaaaaaaaaa')]);

    saveRegistry(target, loaded.projects); // the next save drops it
    expect(loadRegistry(target)).toMatchObject({ broken: null, orphans: [] });
  });

  it('a newer projects.json', () => {
    expect(refused([], asFile([]), 3)).toBe('written by a newer version (v=3)');
  });
});

describe('migration to v2 (D2)', () => {
  function migrate(target: string, split?: (r: LeadRecord[]) => RegistryPair) {
    const logs: string[] = [];
    const loaded = loadRegistry(target);
    const result = migrateRegistry(target, loaded, (l) => logs.push(l), split);
    return { loaded, result, logs };
  }

  it('from v1: keeps projects.json.v1, every field and both ids, stable across restarts', () => {
    const target = file();
    const records = [full(), project({ name: 'beta', projectId: 'p_bbbbbbbbbb' })];
    const v1 = `${JSON.stringify({ v: 1, projects: records })}\n`;
    fs.writeFileSync(target, v1);

    const { loaded, result, logs } = migrate(target);

    expect(result).toBeNull();
    expect(logs).toEqual([expect.stringMatching(/^projects\.json: migrated to v2/)]);
    expect(fs.readFileSync(`${target}.v1`, 'utf8')).toBe(v1);
    const after = loadRegistry(target);
    expect(after).toMatchObject({ broken: null, migrated: false, version: 2 });
    expect(after.projects).toEqual(loaded.projects); // the ids minted at load are the ones written
    expect(after.projects.map(({ leadAssignmentId: _, ...p }) => p)).toEqual(records);
    expect(new Set(after.projects.map((p) => p.leadAssignmentId)).size).toBe(2);

    // A restart: nothing to do, nothing rewritten, the same ids.
    const bytes = fs.readFileSync(target, 'utf8');
    const again = migrate(target);
    expect(again.result).toBeNull();
    expect(again.logs).toEqual([]);
    expect(fs.readFileSync(target, 'utf8')).toBe(bytes);
    expect(loadRegistry(target).projects).toEqual(after.projects);
  });

  it('from a legacy array: through v1 (projects.json.v0 and .v1 kept) to v2', () => {
    const target = file();
    const records = [full({ projectId: undefined as never })];
    const legacy = `${JSON.stringify(records)}\n`;
    fs.writeFileSync(target, legacy);

    const { result, logs } = migrate(target);

    expect(result).toBeNull();
    expect(logs).toEqual([
      'projects.json: migrated to v1 (original kept as projects.json.v0)',
      expect.stringMatching(/^projects\.json: migrated to v2/),
    ]);
    expect(fs.readFileSync(`${target}.v0`, 'utf8')).toBe(legacy);
    const v1 = read(`${target}.v1`) as { v: number; projects: ProjectRecord[] };
    expect(v1.v).toBe(1);
    const after = loadRegistry(target);
    expect(after.version).toBe(2);
    expect(v1.projects).toEqual([{ ...records[0], projectId: after.projects[0].projectId }]);
    expect(after.projects).toEqual([
      {
        ...records[0],
        projectId: after.projects[0].projectId,
        leadAssignmentId: after.projects[0].leadAssignmentId,
      },
    ]);
    expect(files(target)).toEqual([
      'assignments.json',
      'projects.json',
      'projects.json.v0',
      'projects.json.v1',
    ]);
  });

  it('never overwrites an existing projects.json.v1 (a different one gets a second copy)', () => {
    const target = file();
    fs.writeFileSync(`${target}.v1`, 'older');
    const v1 = `${JSON.stringify({ v: 1, projects: [project()] })}\n`;
    fs.writeFileSync(target, v1);

    const { result, logs } = migrate(target);
    expect(result).toBeNull();

    expect(fs.readFileSync(`${target}.v1`, 'utf8')).toBe('older');
    const copy = files(target).find((f) => /^projects\.json\.v1\.\d+$/.test(f))!;
    expect(fs.readFileSync(path.join(path.dirname(target), copy), 'utf8')).toBe(v1);
    expect(logs[0]).toContain(`(v1 kept as ${copy})`); // the file it really went to
  });

  it('a routing table that would change aborts with nothing written', () => {
    const target = file();
    const legacy = `${JSON.stringify([full({ projectId: undefined as never })])}\n`;
    fs.writeFileSync(target, legacy);
    const before = files(target);
    const wrongModel = (records: LeadRecord[]): RegistryPair => {
      const pair = splitRegistry(records);
      pair.assignments[0].model = 'sonnet';
      return pair;
    };

    const { result, logs } = migrate(target, wrongModel);

    expect(result).toMatch(/routing table would change/);
    expect(logs).toEqual([
      expect.stringMatching(/routing table would change; nothing was written$/),
    ]);
    expect(fs.readFileSync(target, 'utf8')).toBe(legacy);
    expect(files(target)).toEqual(before); // no .v0, no .v1, no assignments.json
  });

  it('a failed projects.json write removes the new assignments.json again', () => {
    const target = file();
    const v1 = `${JSON.stringify({ v: 1, projects: [full()] })}\n`;
    fs.writeFileSync(target, v1);
    // projects.json's temporary file cannot be created: the second write fails.
    fs.mkdirSync(`${target}.${process.pid}.tmp`);

    const { result, logs } = migrate(target);

    expect(result).toMatch(/could not migrate projects\.json to v2/);
    expect(logs).toEqual([expect.stringMatching(/could not migrate projects\.json to v2/)]);
    expect(fs.readFileSync(target, 'utf8')).toBe(v1);
    expect(fs.existsSync(assignmentsPath(target))).toBe(false);
    expect(loadRegistry(target)).toMatchObject({ broken: null, version: 1 });
  });
});

describe('Workers in assignments.json (D3)', () => {
  const alpha = () => project({ leadAssignmentId: 'a_aaaaaaaaaa' });
  const beta = () =>
    project({ name: 'beta', projectId: 'p_bbbbbbbbbb', leadAssignmentId: 'a_bbbbbbbbbb' });
  const worker = (name: string, id: string, overrides: Partial<ProjectRecord> = {}) =>
    project({ name, role: 'worker', assignmentId: id, title: undefined, ...overrides });

  it('a Lead and two Workers round-trip; a Worker takes its folder and room from its project', () => {
    const target = file();
    const own = path.join(os.tmpdir(), 'alpha', '.worktrees', 'b');
    saveRegistry(target, [
      alpha(),
      worker('alpha-a', 'a_cccccccccc', { model: 'sonnet', wantRunning: true }),
      worker('alpha-b', 'a_dddddddddd', { role: 'reviewer', workFolder: own }),
    ]);

    // projects.json holds the project only; the Workers are assignments of it.
    expect(read(target)).toEqual({
      v: 2,
      projects: [
        {
          projectId: 'p_abcdefghij',
          name: 'alpha',
          folder: alpha().folder,
          room: 'room',
          leadAssignmentId: 'a_aaaaaaaaaa',
        },
      ],
    });
    expect(read(assignmentsPath(target))).toEqual({
      v: 2,
      assignments: [
        expect.objectContaining({ assignmentId: 'a_aaaaaaaaaa', role: 'lead' }),
        {
          assignmentId: 'a_cccccccccc',
          projectId: 'p_abcdefghij',
          role: 'worker',
          provider: 'claude',
          name: 'alpha-a',
          model: 'sonnet',
          wantRunning: true,
        },
        {
          assignmentId: 'a_dddddddddd',
          projectId: 'p_abcdefghij',
          role: 'reviewer',
          provider: 'claude',
          name: 'alpha-b',
          folder: own,
          wantRunning: false,
        },
      ],
    });
    const loaded = loadRegistry(target);
    expect(loaded).toMatchObject({ broken: null, orphans: [] });
    expect(loaded.projects.map((p) => [p.name, p.role, p.folder, p.room])).toEqual([
      ['alpha', undefined, alpha().folder, 'room'],
      ['alpha-a', 'worker', alpha().folder, 'room'],
      ['alpha-b', 'reviewer', own, 'room'],
    ]);
    // Saving what was loaded writes nothing.
    const written: string[] = [];
    registryFault.afterWrite = (f) => written.push(f);
    try {
      saveRegistry(target, loaded.projects);
    } finally {
      delete registryFault.afterWrite;
    }
    expect(written).toEqual([]);
  });

  it('adding a Worker writes only assignments.json (v2); removing the last one goes back to v1', () => {
    const target = file();
    saveRegistry(target, [alpha()]);
    const projects = fs.readFileSync(target, 'utf8');
    const d2 = fs.readFileSync(assignmentsPath(target), 'utf8');
    expect(read(assignmentsPath(target))).toMatchObject({ v: 1 });

    saveRegistry(target, [alpha(), worker('alpha-a', 'a_cccccccccc')]);
    expect(fs.readFileSync(target, 'utf8')).toBe(projects);
    // A D2 daemon reads only v1: it refuses this file instead of rewriting it without the Worker.
    expect(read(assignmentsPath(target))).toMatchObject({ v: 2 });

    saveRegistry(target, [alpha()]);
    expect(fs.readFileSync(assignmentsPath(target), 'utf8')).toBe(d2);
  });

  it('a D2-era pair loads unchanged and is not rewritten', () => {
    const target = file();
    const pair = splitRegistry([alpha() as LeadRecord, beta() as LeadRecord]);
    const bytes = `${JSON.stringify({ v: 2, projects: pair.projects })}\n`;
    const abytes = `${JSON.stringify({ v: 1, assignments: pair.assignments })}\n`;
    fs.writeFileSync(target, bytes);
    fs.writeFileSync(assignmentsPath(target), abytes);

    const loaded = loadRegistry(target);
    expect(loaded).toMatchObject({ broken: null, migrated: false, orphans: [] });
    expect(loaded.projects).toEqual([alpha(), beta()]);
    expect(migrateRegistry(target, loaded, () => undefined)).toBeNull();
    expect(fs.readFileSync(target, 'utf8')).toBe(bytes);
    expect(fs.readFileSync(assignmentsPath(target), 'utf8')).toBe(abytes);
  });

  /** A pair with these Workers written beside alpha and beta: why it is broken. */
  function brokenWith(workers: Array<Record<string, unknown>>): string | null {
    const target = file();
    const pair = splitRegistry([alpha() as LeadRecord, beta() as LeadRecord]);
    fs.writeFileSync(target, JSON.stringify({ v: 2, projects: pair.projects }));
    const assignments = [...pair.assignments, ...workers];
    fs.writeFileSync(assignmentsPath(target), JSON.stringify({ v: 2, assignments }));
    return loadRegistry(target).broken;
  }
  const w = (name: string, id: string, extra: Record<string, unknown> = {}) => ({
    assignmentId: id,
    projectId: 'p_abcdefghij',
    role: 'worker',
    provider: 'claude',
    name,
    wantRunning: false,
    ...extra,
  });

  it('names are unique across projects and agents: a Worker can never take a project’s name', () => {
    expect(brokenWith([w('alpha-a', 'a_cccccccccc'), w('beta-a', 'a_dddddddddd')])).toBeNull();
    expect(brokenWith([w('beta', 'a_cccccccccc')])).toBe('a duplicate name "beta"');
    expect(brokenWith([w('alpha', 'a_cccccccccc')])).toBe('a duplicate name "alpha"');
    expect(
      brokenWith([
        w('alpha-a', 'a_cccccccccc'),
        w('alpha-a', 'a_dddddddddd', { projectId: 'p_bbbbbbbbbb' }),
      ]),
    ).toBe('a duplicate name "alpha-a"');
  });

  it('a second lead is broken; a bad Worker is broken; a Worker of no project is an orphan', () => {
    expect(brokenWith([{ ...w('x', 'a_cccccccccc'), role: 'lead', name: undefined }])).toBe(
      'assignment "a_cccccccccc" is not its project\'s lead',
    );
    expect(brokenWith([w('bad name', 'a_cccccccccc')])).toBe('an invalid worker "bad name"');
    expect(brokenWith([w('alpha-a', 'a_cccccccccc', { folder: 'rel/dir' })])).toBe(
      'an invalid worker "alpha-a"',
    );
    expect(brokenWith([w('alpha-a', 'a_cccccccccc', { model: '--x' })])).toBe(
      'an invalid worker "alpha-a"',
    );
    const target = file();
    const pair = splitRegistry([alpha() as LeadRecord]);
    fs.writeFileSync(target, JSON.stringify({ v: 2, projects: pair.projects }));
    const orphan = w('gone-a', 'a_cccccccccc', { projectId: 'p_cccccccccc' });
    fs.writeFileSync(
      assignmentsPath(target),
      JSON.stringify({ v: 2, assignments: [...pair.assignments, orphan] }),
    );
    expect(loadRegistry(target)).toMatchObject({ broken: null, orphans: ['a_cccccccccc'] });
    expect(loadRegistry(target).projects.map((p) => p.name)).toEqual(['alpha']);
  });
});
