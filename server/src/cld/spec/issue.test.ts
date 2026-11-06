// RQ3 (RQW §2.5): 이 요구사항으로 이슈 만들기. The issue goes on the board, the link is stored as
// confirmed and the write is audited; a failed link write keeps the issue (it shows as 글에 적힘);
// the route is session-only like every spec route (the host token is refused).
import Fastify from 'fastify';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { reqState } from '../../../../core/src/cld/spec/reqState.js';
import { SPEC_SETTLE_MS } from '../../constants.js';
import { GIT_AVAILABLE, makeTempRepo, type TempRepo } from '../engine/git/testRepo.js';
import { linksFile } from './links.js';
import { registerSpecRoutes } from './routes.js';
import { type SpecProject, SpecService } from './service.js';
import type { TraceTask } from './trace.js';

const PROJECT_ID = 'p_abcdefghij';
const SRS = '# SRS\n\n## 3.1 엔진(ENG)\n\n| ID | 요구 |\n|---|---|\n| FR-ENG-001 | 엔진이 세션을 이어 받는다 |\n';

let repo: TempRepo | null = null;
const homes: string[] = [];
afterEach(() => {
  repo?.cleanup();
  repo = null;
  for (const h of homes.splice(0)) fs.rmSync(h, { recursive: true, force: true });
  vi.restoreAllMocks();
});

async function setup() {
  repo = makeTempRepo();
  repo.write('docs/requirements/SRS.md', SRS);
  repo.git(['add', '-A']);
  repo.git(['commit', '-q', '-m', 'docs: SRS']);
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cld-issue-')));
  homes.push(home);
  const project: SpecProject = { name: 'alpha', folder: repo.folder, projectId: PROJECT_ID };
  const tasks: Array<TraceTask & { project: string }> = [];
  const added: Array<{ fields: Record<string, unknown>; device: string }> = [];
  const s = new SpecService({
    home,
    projects: () => [project],
    broadcast: () => undefined,
    run: repo.run,
    now: () => Date.now() + SPEC_SETTLE_MS * 2,
    later: () => undefined,
    idle: () => undefined,
    tasks: () => tasks,
    jobs: () => [],
    addTask: (fields, device) => {
      const id = `T-${tasks.length + 1}`;
      tasks.push({ id, project: fields.project, title: fields.title, status: 'todo' });
      added.push({ fields, device });
      return { ok: true, id };
    },
  });
  expect(await s.enable(project, ['docs/requirements/SRS.md'])).toMatchObject({ ok: true });
  const items = (await s.items(project, {})) as { ok: true; value: { items: Array<{ uid: string; feature?: unknown }> } };
  const uid = items.value.items[0].uid;
  const server = Fastify();
  const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  let host = false;
  registerSpecRoutes(server, s, { auth: async () => undefined, kindOf: () => ({ host, remote: false }), actorOf: () => 'Test phone', readOnly: false });
  const post = (body: object, asHost = false) => {
    host = asHost;
    return server.inject({ method: 'POST', url: `/api/cld/spec/alpha/item/${uid}/issue`, headers: { origin: 'http://localhost:80', host: 'localhost:80' }, payload: body });
  };
  const audits = () => log.mock.calls.map((c) => String(c[0])).filter((l) => l.startsWith('[cld spec] issue'));
  return { home, project, s, tasks, added, uid, items: items.value.items, post, audits };
}

describe.skipIf(!GIT_AVAILABLE)('이 요구사항으로 이슈 만들기 (RQ3)', () => {
  it('makes the issue, stores a confirmed implements link, audits it; the requirement shows the issue', async () => {
    const t = await setup();
    expect(t.items[0].feature).toMatchObject({ key: 'FR-ENG', rule: 'prefix' });
    const r = await t.post({ title: 'FR-ENG-001 엔진이 세션을 이어 받는다', note: 'SRS.md 7행' });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ task: 'T-1', linked: true });
    expect(t.added).toEqual([{ fields: { project: 'alpha', title: 'FR-ENG-001 엔진이 세션을 이어 받는다', note: 'SRS.md 7행' }, device: 'Test phone' }]);
    const links = JSON.parse(fs.readFileSync(linksFile(t.home, PROJECT_ID), 'utf-8')) as { links: Array<{ status: string; rel: string; to: unknown }> };
    expect(links.links).toEqual([expect.objectContaining({ status: 'confirmed', rel: 'implements', to: { t: 'task', id: 'T-1' } })]);
    expect(t.audits()).toEqual([expect.stringContaining(`uid=${t.uid} task=T-1 linked=true`)]);
    expect(t.audits()[0]).not.toContain('세션');
    const d = await t.s.item(t.project, t.uid);
    expect(d.ok && d.value.node.state?.facts?.issues).toEqual([{ id: 'T-1', status: 'todo', how: 'confirmed' }]);
    expect(d.ok && reqState(d.value.node.state).status).toBe('todo');
  });

  it('a failed link write keeps the issue; its title names the ID, so it shows as 글에 적힘', async () => {
    const t = await setup();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    // The links file's write-then-rename cannot write its temporary file.
    fs.mkdirSync(`${linksFile(t.home, PROJECT_ID)}.${process.pid}.tmp`, { recursive: true });
    const r = await t.post({ title: 'FR-ENG-001 엔진이 세션을 이어 받는다' });
    expect(r.json()).toEqual({ task: 'T-1', linked: false });
    expect(t.tasks.map((x) => x.id)).toEqual(['T-1']);
    const d = await t.s.item(t.project, t.uid);
    expect(d.ok && d.value.node.state?.facts?.issues).toEqual([{ id: 'T-1', status: 'todo', how: 'written' }]);
    expect(d.ok && d.value.edges.find((e) => e.to === 'T-1')?.status).toBe('observed');
  });

  it('is session-only (the host token is refused) and checks what it is sent', async () => {
    const t = await setup();
    const host = await t.post({ title: 'x' }, true);
    expect(host.statusCode).toBe(403);
    expect(host.json().errorCode).toBe('spec_session_only');
    expect((await t.post({})).statusCode).toBe(400);
    expect((await t.post({ title: 'x'.repeat(201) })).statusCode).toBe(400);
    expect((await t.post({ title: 'x', owner: 3 })).statusCode).toBe(400);
    expect(t.tasks).toEqual([]);
    expect(t.audits()).toEqual([]);
  });
});
