// BRN K3: the agent query tools on a real SpecService (temp repository, the code scan faked: no
// child process): a requirement by its display ID, a Task's code by the C2 chain, a document marked
// 민감 left out, and the trace index let go SPEC_TRACE_IDLE_MS after the last query.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import { SPEC_SETTLE_MS, SPEC_TRACE_IDLE_MS } from '../../constants.js';
import { specReads } from '../agentSpecReads.js';
import { AgentQueries } from '../engine/agentQueries.js';
import { GIT_AVAILABLE, makeTempRepo, type TempRepo } from '../engine/git/testRepo.js';
import type { RosterAgent } from '../engine/mcpTools.js';
import { tasksPath, TaskStore } from '../engine/tasks.js';
import type { CodeScan } from './mapWorker.js';
import { type SpecProject, SpecService } from './service.js';
import type { TraceTask } from './trace.js';

const SRS = '# SRS\n\n### 3.1 지도(MAP)\n\n| ID | 요구 |\n|---|---|\n| FR-MAP-001 | The API server answers |\n| FR-MAP-002 | 아무것도 부르지 않는다 |\n';
const PRIVATE = '# Private\n\n| ID | 요구 |\n|---|---|\n| FR-SEC-001 | 비밀 계획 |\n';
const ME: RosterAgent = { name: 'alpha', project: 'alpha', role: 'lead', assignmentId: 'a_aaaaaaaaaa', provider: 'claude', wantRunning: true, live: true, busy: false };
let repo: TempRepo | null = null;
const homes: string[] = [];
afterEach(() => {
  repo?.cleanup();
  repo = null;
  for (const h of homes.splice(0)) fs.rmSync(h, { recursive: true, force: true });
});

async function setup() {
  repo = makeTempRepo();
  repo.write('docs/requirements/SRS.md', SRS);
  repo.write('docs/requirements/private.md', PRIVATE);
  repo.write('server/src/main.ts', 'export const x = 1;');
  repo.write('webview-ui/src/App.tsx', 'x');
  repo.git(['add', '-A']);
  repo.git(['commit', '-q', '-m', 'init']);
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agty-k3-spec-')));
  homes.push(home);
  const project: SpecProject = { name: 'alpha', folder: repo.folder, projectId: 'p_abcdefghij' };
  const clock = { now: Date.now() + SPEC_SETTLE_MS * 2 };
  const idles: Array<() => void> = [];
  // FR-MAP-002 is named in server/src/main.ts (the direct path); the Task's title names FR-MAP-002.
  const scan: CodeScan = {
    files: ['server/src/main.ts', 'webview-ui/src/App.tsx'],
    edges: [],
    unresolved: 0,
    workspaces: [],
    big: 0,
    at: '2026-11-06T00:00:00.000Z',
    ms: 1,
    rssKb: 1,
    links: { body: { 'FR-MAP-002': [0], 'FR-SEC-001': [1] }, names: {}, tags: {}, tasks: {}, commits: [], capped: false },
  };
  const tasks: Array<TraceTask & { project: string }> = [
    { id: 'T-1', project: 'alpha', title: 'FR-MAP-002 을 고친다', status: 'doing' },
    { id: 'T-2', project: 'alpha', title: 'FR-SEC-001 을 숨긴다', status: 'doing' },
  ];
  const s = new SpecService({
    home,
    projects: () => [project],
    broadcast: () => undefined,
    run: repo.run,
    now: () => clock.now,
    later: () => undefined,
    idle: (fn) => void idles.push(fn),
    tasks: () => tasks,
    jobs: () => [],
    specMap: async () => scan,
  });
  expect(await s.enable(project, ['docs/requirements/SRS.md', 'docs/requirements/private.md'])).toMatchObject({ ok: true });
  const store = new TaskStore(tasksPath(home), () => undefined, () => undefined);
  store.add({ project: 'alpha', title: 'FR-MAP-002 을 고친다', status: 'doing' }, 'alpha', clock.now);
  store.add({ project: 'alpha', title: 'FR-SEC-001 을 숨긴다', status: 'doing' }, 'alpha', clock.now);
  const q = new AgentQueries({
    home,
    transcriptOf: () => null,
    folderOf: () => repo!.folder,
    rooms: () => [],
    timeline: () => [],
    tasks: store,
    event: () => undefined,
    spec: specReads(s),
    run: repo.run,
    now: () => clock.now,
  });
  return { s, q, project, clock, idles, call: (tool: string, input: Record<string, unknown> = {}) => q.call(ME, tool, input) };
}

describe.skipIf(!GIT_AVAILABLE)('the agent query tools on the spec reader', () => {
  it('a requirement by its display ID; a Task with its requirement, the file and the module the chain reaches', async () => {
    const t = await setup();
    const r = await t.call('get_requirement', { id: 'FR-MAP-002' });
    expect(r).toMatchObject({ project: 'alpha', requirement: { node: { type: 'req', label: 'FR-MAP-002' } } });
    expect(typeof r.rev).toBe('number');
    expect(r.head).toMatch(/^[0-9a-f]{40}$/);
    const c = await t.call('get_task_context', { taskId: 'T-1' });
    expect(c).toMatchObject({ task: { id: 'T-1' }, requirements: [{ label: 'FR-MAP-002' }], code: { files: ['server/src/main.ts'], modules: [{ id: 'server', files: 1 }] } });
    expect(c).not.toHaveProperty('missing');
    expect(await t.call('search_requirements', { query: 'FR-MAP' })).toMatchObject({ total: 2 });
    const sum = await t.call('get_traceability_summary');
    expect(sum).toMatchObject({ items: { total: 3 }, features: [{ key: 'FR-MAP', reqs: 2, linked: 1 }, { key: 'FR-SEC' }] });
    expect(sum).not.toHaveProperty('missing');
  });

  it('a document marked 민감 is left out: not_covered by ID, absent from the search', async () => {
    const t = await setup();
    expect(await t.call('get_requirement', { id: 'FR-SEC-001' })).toMatchObject({ requirement: { node: { label: 'FR-SEC-001' } } });
    const docs = await t.s.docs(t.project);
    const uid = docs.docs.find((d) => d.path === 'docs/requirements/private.md')!.uid;
    expect(t.s.setDoc(t.project, uid, { sensitive: true })).toMatchObject({ ok: true });
    expect(await t.call('get_requirement', { id: 'FR-SEC-001' })).toMatchObject({ status: 'not_covered', missing: [{ code: 'sensitive' }] });
    expect(await t.call('search_requirements', { query: 'FR-SEC' })).toMatchObject({ status: 'not_covered', missing: [{ code: 'not_found' }] });
    // Nothing of it in the summary (its feature, its counts) nor in a Task's code reached only through it.
    const sum = await t.call('get_traceability_summary');
    expect(sum).toMatchObject({ requirements: 2, features: [{ key: 'FR-MAP' }], missing: [{ code: 'sensitive_counts' }] });
    expect(JSON.stringify(sum)).not.toContain('FR-SEC');
    expect(await t.call('get_task_context', { taskId: 'T-2' })).toMatchObject({ requirements: [], missing: [{ code: 'no_link' }] });
    expect((await t.s.taskCode(t.project, 'T-2', t.s.sensitive(t.project).paths)).ok && (await t.s.taskCode(t.project, 'T-2', t.s.sensitive(t.project).paths) as { value: { files: string[] } }).value.files).toEqual([]);
    expect(((await t.s.taskCode(t.project, 'T-2')) as { value: { files: string[] } }).value.files).toEqual(['webview-ui/src/App.tsx']); // without the set it is reached
  });

  it('the index is built by a query and let go SPEC_TRACE_IDLE_MS after the last one', async () => {
    const t = await setup();
    for (const fn of t.idles.splice(0)) fn(); // the enable's own read is over
    t.clock.now += SPEC_TRACE_IDLE_MS;
    for (const fn of t.idles.splice(0)) fn();
    expect(t.s.traceHeld(t.project)).toBe(false);
    await t.call('get_requirement', { id: 'FR-MAP-001' });
    expect(t.s.traceHeld(t.project)).toBe(true);
    t.clock.now += SPEC_TRACE_IDLE_MS;
    for (const fn of t.idles.splice(0)) fn();
    expect(t.s.traceHeld(t.project)).toBe(false);
  });
});
