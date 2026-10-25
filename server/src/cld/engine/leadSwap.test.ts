// D3b (design-d3b §3.6, unit): the target pair, the commit at every crash point and its
// re-run, the re-addressing cut-off, the first prompt, and the lead chain.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import type { BoardTask } from '../../../../core/src/messages.js';
import { configDir } from './events.js';
import type { LeadTerm, SwapJournal } from './leadSwap.js';
import {
  applySwap,
  eventLines,
  journalPath,
  leadHistoryPath,
  leadPrompt,
  leadPromptFile,
  leadTermBefore,
  promotePair,
  readJournal,
  readLeadHistory,
  rolePromptFile,
  writeJournal,
} from './leadSwap.js';
import { readdressFiles } from './messenger.js';
import type { LeadRecord, ProjectRecord } from './registry.js';
import {
  assignmentsPath,
  loadRegistry,
  registryFault,
  registryPath,
  registryTexts,
  saveRegistry,
} from './registry.js';

const homes: string[] = [];
afterEach(() => {
  delete registryFault.afterWrite;
  for (const h of homes.splice(0)) fs.rmSync(h, { recursive: true, force: true });
});

const S1 = '11111111-0000-4000-8000-000000000001';
const S2 = '22222222-0000-4000-8000-000000000002';

/** Project alpha: its Lead (the seat fields set, a title equal to its name as the ops Lead has)
 *  and Workers alpha-a (in the project folder) and alpha-b (a worktree); project beta. */
function home() {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), 'cld-swap-'));
  homes.push(h);
  const alpha = path.join(h, 'work', 'alpha');
  const tree = path.join(alpha, '.worktrees', 'b');
  fs.mkdirSync(tree, { recursive: true });
  fs.mkdirSync(path.join(h, 'work', 'beta'), { recursive: true });
  const rules = path.join(h, 'rules.md');
  fs.writeFileSync(rules, '# rules\n');
  const records: ProjectRecord[] = [
    {
      projectId: 'p_aaaaaaaaaa',
      leadAssignmentId: 'a_aaaaaaaaaa',
      name: 'alpha',
      folder: alpha,
      room: 'lab',
      title: 'alpha',
      rulesFile: rules,
      remoteControl: true,
      alwaysOn: true,
      model: 'lead-model',
      effort: 'high',
      permissionMode: 'plan',
      compactionNudge: 2,
      wantRunning: true,
      sessionId: S1,
      backgroundId: 'bglead',
    },
    { projectId: 'p_bbbbbbbbbb', leadAssignmentId: 'a_bbbbbbbbbb', name: 'beta', folder: path.join(h, 'work', 'beta'), wantRunning: false },
    {
      projectId: 'p_aaaaaaaaaa',
      assignmentId: 'a_cccccccccc',
      role: 'reviewer',
      name: 'alpha-a',
      folder: alpha,
      title: 'Alpha A',
      model: 'worker-model',
      wantRunning: true,
      sessionId: S2,
      backgroundId: 'bgworker',
      idleRetired: true,
    },
    { projectId: 'p_aaaaaaaaaa', assignmentId: 'a_dddddddddd', role: 'worker', name: 'alpha-b', folder: tree, workFolder: tree, wantRunning: false },
  ];
  saveRegistry(registryPath(h), records);
  return { h, alpha, tree, file: registryPath(h), records: loadRegistry(registryPath(h)).projects };
}

const byName = (rs: ProjectRecord[], n: string) => rs.find((r) => r.name === n)!;

describe('D3b promotePair (§3.1)', () => {
  it('the Worker’s assignment leads under the project’s name; seat fields stay, agent fields follow', () => {
    const { records, alpha } = home();
    const r = promotePair(records, 'alpha-a', 'worker');
    if ('error' in r) throw new Error(r.error);
    const lead = byName(r.records, 'alpha');
    const worker = byName(r.records, 'alpha-a');
    // The new Lead: W's assignment and agent fields, the seat's title/rules/remote/always-on,
    // a fresh conversation, the project folder.
    expect(lead).toMatchObject({
      leadAssignmentId: 'a_cccccccccc',
      projectId: 'p_aaaaaaaaaa',
      folder: alpha,
      room: 'lab',
      title: 'alpha',
      remoteControl: true,
      alwaysOn: true,
      model: 'worker-model',
      wantRunning: true,
    });
    expect(lead.rulesFile).toBe(byName(records, 'alpha').rulesFile);
    expect(lead.role).toBeUndefined();
    for (const k of ['sessionId', 'backgroundId', 'idleRetired', 'effort', 'permissionMode', 'compactionNudge'] as const)
      expect(lead[k]).toBeUndefined();
    // The old Lead: a worker (even though W was a reviewer) named alpha-a, its own agent fields
    // and conversation, W's former seat values, no folder of its own.
    expect(worker).toMatchObject({
      assignmentId: 'a_aaaaaaaaaa',
      role: 'worker',
      title: 'Alpha A',
      model: 'lead-model',
      effort: 'high',
      permissionMode: 'plan',
      compactionNudge: 2,
      sessionId: S1,
      backgroundId: 'bglead',
      wantRunning: true,
      folder: alpha,
      room: 'lab',
    });
    for (const k of ['rulesFile', 'remoteControl', 'alwaysOn', 'workFolder', 'idleRetired'] as const)
      expect(worker[k]).toBeUndefined();
    // Everyone else as they were; one Lead per project.
    expect(byName(r.records, 'alpha-b')).toEqual(byName(records, 'alpha-b'));
    expect(byName(r.records, 'beta')).toEqual(byName(records, 'beta'));
    expect(r.records.filter((x) => !x.role && x.projectId === 'p_aaaaaaaaaa')).toHaveLength(1);
  });

  it('oldLead stop leaves the old Lead off; a Lead or an unknown name is refused', () => {
    const { records } = home();
    const r = promotePair(records, 'alpha-b', 'stop');
    if ('error' in r) throw new Error(r.error);
    expect(byName(r.records, 'alpha-b').wantRunning).toBe(false);
    expect(byName(r.records, 'alpha-b').workFolder).toBeUndefined(); // the old Lead: the project folder
    expect(promotePair(records, 'alpha', 'worker')).toHaveProperty('error');
    expect(promotePair(records, 'nobody', 'worker')).toHaveProperty('error');
  });

  it('promoting back restores the original names, roles and seat fields', () => {
    const { records } = home();
    const once = promotePair(records, 'alpha-a', 'worker');
    if ('error' in once) throw new Error(once.error);
    const back = promotePair(once.records, 'alpha-a', 'worker');
    if ('error' in back) throw new Error(back.error);
    const seat = (r: ProjectRecord) => ({
      id: r.role ? r.assignmentId : r.leadAssignmentId,
      name: r.name,
      role: r.role === 'reviewer' ? 'worker' : r.role, // a promoted reviewer comes back a worker
      title: r.title,
      rulesFile: r.rulesFile,
      remoteControl: r.remoteControl,
      alwaysOn: r.alwaysOn,
      model: r.model,
    });
    expect(back.records.map(seat)).toEqual(records.map(seat));
  });
});

/** A journal for promoting alpha-a, as the engine writes it. */
function journalFor(t: ReturnType<typeof home>, at = 1_800_000_000_000): SwapJournal {
  const r = promotePair(t.records, 'alpha-a', 'worker');
  if ('error' in r) throw new Error(r.error);
  return {
    v: 1,
    projectId: 'p_aaaaaaaaaa',
    at,
    from: 'a_aaaaaaaaaa',
    to: 'a_cccccccccc',
    oldLead: 'worker',
    names: { lead: 'alpha', worker: 'alpha-a' },
    ...registryTexts(r.records as LeadRecord[]),
    term: { projectId: 'p_aaaaaaaaaa', assignmentId: 'a_aaaaaaaaaa', sessionId: S1, transcript: path.join(t.h, 'S1.jsonl'), bytes: 42, endedAt: at },
    prompts: { lead: 'LEAD PROMPT', worker: 'ROLE NOTICE' },
  };
}

const cfg = (h: string, ...p: string[]) => path.join(configDir(h), ...p);
const put = (file: string, text: string) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};
const queued = (to: string, created: number, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ v: 1, to, text: `for ${to} at ${created}`, from: null, source: 'messenger:pc', ifIdle: false, created, ...extra });

/** Every file under the config dir (the bookkeeping that is not D3b's left out). */
function snapshot(h: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const e of fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }) : []) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else out[path.relative(configDir(h), p)] = fs.readFileSync(p, 'utf-8');
    }
  };
  walk(configDir(h));
  return out;
}

describe('D3b applySwap (§3.2 step 5)', () => {
  it('commits the pair, the term, the re-addressing, the typed hints and the prompts; a re-run changes nothing', () => {
    const t = home();
    const j = journalFor(t);
    put(cfg(t.h, 'typed', 'alpha.json'), '[]');
    put(cfg(t.h, 'typed', 'alpha-a.json'), '[]');
    put(cfg(t.h, 'typed', 'alpha-b.json'), '[]');
    writeJournal(t.h, j);
    applySwap(t.h, t.file, readJournal(t.h) as SwapJournal);
    const loaded = loadRegistry(t.file);
    expect(loaded.broken).toBeNull();
    expect(loaded.projects.map((p) => [p.name, p.role ?? 'lead', p.role ? p.assignmentId : p.leadAssignmentId])).toEqual([
      ['alpha', 'lead', 'a_cccccccccc'],
      ['beta', 'lead', 'a_bbbbbbbbbb'],
      ['alpha-a', 'worker', 'a_aaaaaaaaaa'],
      ['alpha-b', 'worker', 'a_dddddddddd'],
    ]);
    expect(readLeadHistory(t.h)).toEqual([j.term]);
    expect(fs.existsSync(cfg(t.h, 'typed', 'alpha.json')) || fs.existsSync(cfg(t.h, 'typed', 'alpha-a.json'))).toBe(false);
    expect(fs.existsSync(cfg(t.h, 'typed', 'alpha-b.json'))).toBe(true); // another agent's hint stays
    expect(fs.readFileSync(leadPromptFile(t.h, j), 'utf-8')).toBe('LEAD PROMPT');
    expect(fs.readFileSync(rolePromptFile(t.h, j), 'utf-8')).toBe('ROLE NOTICE');
    expect(fs.existsSync(journalPath(t.h))).toBe(false);
    // The same journal again (a crash after its last step but before it was removed): no change.
    const before = snapshot(t.h);
    writeJournal(t.h, j);
    applySwap(t.h, t.file, j);
    expect(snapshot(t.h)).toEqual(before);
  });

  it('a crash after any step either loads the old pair or rolls forward at the next start; never two Leads, never a lost Worker', () => {
    // Count the steps of one clean run.
    const steps: string[] = [];
    {
      const t = home();
      writeJournal(t.h, journalFor(t));
      registryFault.afterWrite = (f) => steps.push(f);
      applySwap(t.h, t.file, journalFor(t));
      delete registryFault.afterWrite;
    }
    expect(steps.length).toBeGreaterThanOrEqual(7);
    for (let crash = 0; crash < steps.length; crash++) {
      const t = home();
      const j = journalFor(t);
      put(cfg(t.h, 'queue', '1700000000000-000001aa.json'), queued('alpha-a', 1_700_000_000_000));
      writeJournal(t.h, j);
      let n = 0;
      registryFault.afterWrite = () => {
        if (n++ === crash) throw new Error('crash');
      };
      expect(() => applySwap(t.h, t.file, j)).toThrow('crash');
      delete registryFault.afterWrite;
      // What a daemon that died here leaves: never two Leads of alpha, never a Worker gone.
      const mid = loadRegistry(t.file);
      if (!mid.broken) {
        expect(mid.projects.filter((p) => !p.role && p.projectId === 'p_aaaaaaaaaa')).toHaveLength(1);
        expect(mid.projects.map((p) => p.name).sort()).toEqual(['alpha', 'alpha-a', 'alpha-b', 'beta']);
      }
      // The next start finds the journal and rolls forward.
      const again = readJournal(t.h);
      if (again === null) {
        expect(crash).toBe(steps.length - 1); // only the journal's own removal was cut short
      } else applySwap(t.h, t.file, again as SwapJournal);
      const end = loadRegistry(t.file);
      expect(end.broken).toBeNull();
      expect(end.projects.map((p) => [p.name, p.role ? p.assignmentId : p.leadAssignmentId])).toEqual([
        ['alpha', 'a_cccccccccc'],
        ['beta', 'a_bbbbbbbbbb'],
        ['alpha-a', 'a_aaaaaaaaaa'],
        ['alpha-b', 'a_dddddddddd'],
      ]);
      expect(readLeadHistory(t.h)).toHaveLength(1);
      expect(JSON.parse(fs.readFileSync(cfg(t.h, 'queue', '1700000000000-000001aa.json'), 'utf-8')).to).toBe('alpha');
      expect(fs.readdirSync(cfg(t.h, 'inbox', 'alpha')).filter((f) => f.startsWith('0-lead-'))).toHaveLength(1);
      expect(fs.existsSync(journalPath(t.h))).toBe(false);
    }
  });

  it('a crash before the journal leaves everything as it was', () => {
    const t = home();
    const before = snapshot(t.h);
    journalFor(t); // built, never written
    expect(readJournal(t.h)).toBeNull();
    expect(snapshot(t.h)).toEqual(before);
  });
});

describe('D3b readdressFiles (§3.2 5c): what was on its way to the Worker before the commit', () => {
  it('goes to the project; what was sent after it stays for the old Lead; deliveries are dropped', () => {
    const t = home();
    const at = 1_800_000_000_000;
    put(cfg(t.h, 'queue', `${at - 5}-000001aa.json`), queued('alpha-a', at - 5));
    put(cfg(t.h, 'queue', `${at + 5}-000002aa.json`), queued('alpha-a', at + 5));
    put(cfg(t.h, 'queue', `${at - 4}-000003aa.json`), queued('alpha', at - 4));
    put(cfg(t.h, 'queue', `${at - 3}-000004aa.json`), queued('alpha-b', at - 3));
    put(cfg(t.h, 'queue', `0-${at - 2}-000005aa.json`), queued('alpha', at - 2, { inbox: ['x.md'] }));
    put(cfg(t.h, 'queue', `0-${at - 1}-000006aa.json`), queued('alpha-a', at - 1, { inbox: ['y.md'] }));
    put(cfg(t.h, 'inbox', 'alpha-a', `${at - 9}-000007aa.md`), 'old notice');
    put(cfg(t.h, 'inbox', 'alpha-a', `${at - 8}-000008aa.md`), 'boss message');
    put(cfg(t.h, 'inbox', 'alpha-a', `${at - 8}-000008aa.md.meta.json`), queued('alpha-a', at - 8));
    put(cfg(t.h, 'inbox', 'alpha-a', `${at + 9}-000009aa.md`), 'after the commit');
    put(cfg(t.h, 'inbox', 'alpha-a', `0-role-${at - 99}.md`), 'an engine notice');
    put(cfg(t.h, 'inbox', 'alpha-a', 'delivered', `${at - 50}-000010aa.md`), 'history');
    readdressFiles(t.h, 'alpha-a', 'alpha', at);
    const to = (f: string) => JSON.parse(fs.readFileSync(cfg(t.h, 'queue', f), 'utf-8')).to;
    expect(to(`${at - 5}-000001aa.json`)).toBe('alpha');
    expect(to(`${at + 5}-000002aa.json`)).toBe('alpha-a'); // sent after the commit: for the old Lead
    expect(to(`${at - 4}-000003aa.json`)).toBe('alpha');
    expect(to(`${at - 3}-000004aa.json`)).toBe('alpha-b');
    expect(fs.existsSync(cfg(t.h, 'queue', `0-${at - 2}-000005aa.json`))).toBe(false);
    expect(fs.existsSync(cfg(t.h, 'queue', `0-${at - 1}-000006aa.json`))).toBe(false);
    expect(fs.readdirSync(cfg(t.h, 'inbox', 'alpha')).sort()).toEqual([
      `${at - 9}-000007aa.md`,
      `${at - 8}-000008aa.md`,
      `${at - 8}-000008aa.md.meta.json`,
    ]);
    expect(JSON.parse(fs.readFileSync(cfg(t.h, 'inbox', 'alpha', `${at - 8}-000008aa.md.meta.json`), 'utf-8')).to).toBe('alpha');
    expect(fs.readdirSync(cfg(t.h, 'inbox', 'alpha-a')).sort()).toEqual([`0-role-${at - 99}.md`, `${at + 9}-000009aa.md`, 'delivered']);
    // A re-run finds nothing more to move.
    const before = snapshot(t.h);
    readdressFiles(t.h, 'alpha-a', 'alpha', at);
    expect(snapshot(t.h)).toEqual(before);
  });
});

const task = (id: string, status: BoardTask['status'], extra: Partial<BoardTask> = {}): BoardTask => ({
  id,
  project: 'alpha',
  title: `task ${id}`,
  status,
  source: 'reported',
  createdAt: '2026-10-24T00:00:00.000Z',
  updatedAt: `2026-10-24T00:00:${id.padStart(2, '0').slice(-2)}.000Z`,
  history: [],
  ...extra,
});

describe('D3b the first prompt (§3.3)', () => {
  const base = {
    when: '10-24 09:00',
    now: Date.parse('2026-10-24T09:00:00.000Z'),
    project: 'alpha',
    worker: 'alpha-a',
    oldLead: 'worker' as const,
    workerTranscript: '/w.jsonl',
    leadTranscript: '/l.jsonl',
    nameOf: (id: string) => ({ a_cccccccccc: 'alpha', a_aaaaaaaaaa: 'alpha-a' })[id],
    running: ['빌드 j1'],
    workers: [{ name: 'alpha-a', role: 'worker', on: true }],
  };

  it('lists open Tasks under the names their assignments answer to now, and carries no message body, command or path from events', () => {
    const now = Date.parse('2026-10-24T09:00:00.000Z');
    const ts = (min: number) => new Date(now - min * 60_000).toISOString();
    const events = [
      { v: 1, ts: ts(5), type: 'send', source: 'messenger:pc', to: 'alpha', delivered: 'pane', preview: 'SECRET-BODY 비밀 내용' },
      { v: 1, ts: ts(4), type: 'job_start', source: 'cli', project: 'alpha', id: 'j1', label: '빌드', cmd: 'TOKEN=SECRET-CMD make', log: '/home/x/SECRET-PATH.log' },
      { v: 1, ts: ts(3), type: 'orch_start', source: 'engine', name: 'alpha-b', session_id: 'x', resumed: true },
      { v: 1, ts: ts(2), type: 'orch_start', source: 'engine', name: 'gamma', session_id: 'y', resumed: false },
      { v: 1, ts: ts(60 * 25), type: 'orch_start', source: 'engine', name: 'alpha', session_id: 'z', resumed: false },
    ];
    const lines = eventLines(events, ['alpha', 'alpha-a', 'alpha-b'], now);
    expect(lines).toHaveLength(3); // gamma's and the 25-hour-old one are left out
    const text = leadPrompt({
      ...base,
      tasks: [
        task('1', 'done'),
        task('2', 'review', { assignee: { assignmentId: 'a_cccccccccc', name: 'alpha-a' }, parentId: '1' }),
        task('3', 'todo', { assignee: { assignmentId: 'a_gone000000', name: 'old-name' } }),
      ],
      events: lines,
    });
    expect(text).toContain("이제 너는 프로젝트 'alpha' 의 Lead 다");
    expect(text).toContain("이전 Lead 는 이제 Worker 'alpha-a'(켜짐)");
    expect(text).toContain('열린 Task (2개):');
    expect(text).toContain('#2 task 2 · review · 담당 alpha · 부모 #1'); // W's own task: now under alpha
    expect(text).toContain('#3 task 3 · todo · 담당 old-name');
    expect(text).not.toContain('#1 ');
    expect(text).toContain('돌고 있는 일: 빌드 j1');
    expect(text).toContain('Worker: alpha-a · worker · 켜짐');
    expect(text).toMatch(/alpha-b 이어서 시작/);
    for (const secret of ['SECRET-BODY', '비밀', 'SECRET-CMD', 'SECRET-PATH']) expect(text).not.toContain(secret);
  });

  it('EX-7b: lists the Tasks finished (done, or handed to review) in the last 24 h, from their history', () => {
    const at = (h: number) => new Date(base.now - h * 3_600_000).toISOString();
    const text = leadPrompt({
      ...base,
      events: [],
      tasks: [
        task('4', 'done', { assignee: { assignmentId: 'a_cccccccccc', name: 'alpha-a' }, detail: 'SECRET-DETAIL', history: [{ at: at(30), by: 'cli', change: 'add' }, { at: at(2), by: 'agent:alpha-a', change: 'status doing → done' }] }),
        task('5', 'review', { history: [{ at: at(1), by: 'agent:alpha-b', change: 'status doing → review, note' }] }),
        task('6', 'done', { history: [{ at: at(30), by: 'cli', change: 'status todo → done' }] }), // too old
        task('7', 'done', { history: [{ at: at(1), by: 'cli', change: 'title' }] }), // never moved to done in the window
      ],
    });
    expect(text).toContain('최근 끝난 Task (24시간, 2개):');
    expect(text).toMatch(/#5 task 5 · review · 담당 없음 · \d\d-\d\d \d\d:\d\d\n#4 task 4 · done · 담당 alpha · /);
    expect(text).not.toContain('#6 ');
    expect(text).not.toContain('#7 ');
    expect(text).not.toContain('SECRET-DETAIL');
  });

  it('stays under 8 000 characters, cutting the Task list with "… N개 더"', () => {
    const tasks = Array.from({ length: 200 }, (_, i) => task(String(i + 1), 'todo', { title: 'x'.repeat(80) }));
    const text = leadPrompt({ ...base, tasks, events: [] });
    expect(text.length).toBeLessThanOrEqual(8_000);
    expect(text).toContain('열린 Task (200개):');
    expect(text).toMatch(/… 170개 더 — get_task_status/);
  });
});

describe('D3b the lead chain (§3.4)', () => {
  it('a Lead contact’s session continues into the newest term of its project that ended before it began', () => {
    const terms: LeadTerm[] = [
      { projectId: 'p1', assignmentId: 'a1', sessionId: 'L1', transcript: '/d/L1.jsonl', bytes: 10, endedAt: 100 },
      { projectId: 'p2', assignmentId: 'a9', sessionId: 'X1', transcript: '/e/X1.jsonl', bytes: 5, endedAt: 150 },
      { projectId: 'p1', assignmentId: 'a2', sessionId: 'W1', transcript: '/d/W1.jsonl', bytes: 20, endedAt: 200 },
    ];
    const leadOf = (sid: string) => (sid === 'L2' ? 'p1' : null);
    expect(leadTermBefore(terms, '/d/L2.jsonl', 250, leadOf)).toEqual({ file: '/d/W1.jsonl', end: 20 });
    expect(leadTermBefore(terms, '/d/W1.jsonl', 120, leadOf)).toEqual({ file: '/d/L1.jsonl', end: 10 });
    expect(leadTermBefore(terms, '/d/L1.jsonl', 50, leadOf)).toBeNull();
    expect(leadTermBefore(terms, '/d/worker.jsonl', 250, leadOf)).toBeNull(); // not a Lead's
  });

  it('records each term once', () => {
    const t = home();
    const j = journalFor(t);
    applySwap(t.h, t.file, j);
    applySwap(t.h, t.file, j);
    expect(JSON.parse(fs.readFileSync(leadHistoryPath(t.h), 'utf-8'))).toEqual({ v: 1, terms: [j.term] });
    expect(fs.readFileSync(assignmentsPath(t.file), 'utf-8')).toBe(j.assignments);
  });
});
