// RQ4 (RQW §3.4): the engine path's routes. A fake `uvx` on PATH (never the real uv, specify or
// network) records its argv and folder and writes what Spec Kit would; the switch, the plan and
// the install are refused to a remote device without a fresh step-up, the install without the
// plan this session was shown (or after it expired, or on a read-only daemon); the daemon writes
// none of .claude/settings.json, CLAUDE.md, AGENTS.md, and a Spec Kit that touches one is reported,
// never called a success.
import Fastify from 'fastify';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SPEC_KIT_COMMIT, SPEC_KIT_CONSENT_TTL_MS, SPEC_KIT_SOURCE, SPEC_KIT_VERSION } from '../../constants.js';
import { registerSpecRoutes } from './routes.js';
import { type SpecProject, SpecService } from './service.js';
import { SpecWorkflow, UNTOUCHED } from './workflow.js';

const PROJECT_ID = 'p_abcdefghij';
const FAKE_UVX = `#!/usr/bin/env node
const fs = require('fs');
const a = process.argv.slice(2);
fs.appendFileSync(process.env.XDG_FAKE_LOG, JSON.stringify({ argv: a, cwd: process.cwd() }) + '\\n');
if (process.env.CLD_AGENT_TOKEN || process.env.AWS_ACCESS_KEY_ID || process.env.DATABASE_URL || process.env.GH_PAT) fs.writeFileSync(process.env.XDG_FAKE_LOG + '.token', 'seen');
if (process.env.XDG_FAKE_MODE === 'fail') { process.stderr.write('could not reach github.com\\n'); process.exit(2); }
const skills = { claude: '.claude/skills', codex: '.agents/skills' };
const key = a.includes('init') ? a[a.indexOf('--integration') + 1] : a.includes('install') ? a[a.indexOf('install') + 1] : null;
if (a.includes('init')) { fs.mkdirSync('.specify/templates', { recursive: true }); fs.writeFileSync('.specify/templates/spec-template.md', '# t\\n'); }
if (key) { fs.mkdirSync(skills[key] + '/speckit-specify', { recursive: true }); fs.writeFileSync(skills[key] + '/speckit-specify/SKILL.md', 's\\n'); }
if (a.includes('uninstall')) fs.rmSync(skills[a[a.indexOf('uninstall') + 1]] + '/speckit-specify', { recursive: true, force: true });
if (process.env.XDG_FAKE_MODE === 'touch') fs.appendFileSync('CLAUDE.md', '<!-- SPECKIT START -->\\n');
`;

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  vi.restoreAllMocks();
});
const tmp = (name: string) => {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), name)));
  dirs.push(d);
  return d;
};

/** Every file under `folder` (project-relative), to compare before and after. */
const files = (folder: string): string[] =>
  (fs.readdirSync(folder, { recursive: true, withFileTypes: true }) as fs.Dirent[])
    .filter((e) => e.isFile())
    .map((e) => path.relative(folder, path.join(e.parentPath, e.name)))
    .sort();

function setup(o: { clis?: string[]; uvx?: boolean; mode?: string; readOnly?: boolean; engine?: boolean } = {}) {
  const home = tmp('cld-wf-home-');
  const folder = tmp('cld-wf-proj-');
  fs.writeFileSync(path.join(folder, 'README.md'), '# alpha\n');
  fs.writeFileSync(path.join(folder, 'CLAUDE.md'), '# the user\'s own\n');
  const bin = tmp('cld-wf-bin-');
  const log = path.join(bin, 'calls.jsonl');
  if (o.uvx !== false) fs.writeFileSync(path.join(bin, 'uvx'), FAKE_UVX, { mode: 0o755 });
  const project: SpecProject = { name: 'alpha', folder, projectId: PROJECT_ID };
  const state = { on: false, clis: o.clis ?? ['claude'] };
  const sets: boolean[] = [];
  let at = 1_000_000;
  const wf = new SpecWorkflow({
    uvx: () => (o.uvx === false ? null : path.join(bin, 'uvx')),
    engine: () =>
      o.engine === false
        ? null
        : { get: (n) => (n === 'alpha' ? { ...state } : null), set: (_n, on) => (sets.push(on), (state.on = on), true) },
    env: { PATH: [bin, path.dirname(process.execPath)].join(path.delimiter), HOME: home, XDG_FAKE_LOG: log, XDG_FAKE_MODE: o.mode ?? '', CLD_AGENT_TOKEN: 'secret', AWS_ACCESS_KEY_ID: 'AKIA', DATABASE_URL: 'postgres://u:p@h/db', GH_PAT: 'ghp_x' },
    platform: 'linux',
    now: () => at,
  });
  const s = new SpecService({ home, projects: () => [project], broadcast: () => undefined, later: () => undefined, idle: () => undefined });
  const server = Fastify();
  const out = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  const who = { remote: false, fresh: false };
  registerSpecRoutes(server, s, {
    auth: async () => undefined,
    kindOf: () => ({ host: false, remote: who.remote }),
    actorOf: () => 'Test phone',
    stepUpFresh: () => who.fresh,
    workflow: wf,
    readOnly: !!o.readOnly,
  });
  const post = (route: string, body: object = {}, cookie = 'sid=one') =>
    server.inject({ method: 'POST', url: `/api/cld/spec/alpha/${route}`, headers: { origin: 'http://localhost:80', host: 'localhost:80', cookie }, payload: body });
  const calls = () =>
    fs.existsSync(log) ? fs.readFileSync(log, 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { argv: string[]; cwd: string }) : [];
  const audits = () => out.mock.calls.map((c) => String(c[0])).filter((l) => l.startsWith('[agty spec] workflow'));
  return { home, folder, log, state, sets, post, calls, audits, who, server, later: (ms: number) => (at += ms) };
}

const FROM = ['--from', `${SPEC_KIT_SOURCE}@${SPEC_KIT_COMMIT}`, 'specify'];
const INIT_CLAUDE = [...FROM, 'init', '--here', '--force', '--non-interactive', '--ignore-agent-tools', '--script', 'sh', '--integration', 'claude', '--integration-options=--events false'];

describe.skipIf(process.platform === 'win32')('the engine path (RQ4)', () => {
  it('the docs answer carries the switch and what this machine has; the switch reaches the engine and is audited', async () => {
    const t = setup();
    const docs = await t.server.inject({ method: 'GET', url: '/api/cld/spec/alpha/docs' });
    expect(docs.json().workflow).toEqual({ engine: true, on: false, uv: true, installed: false, version: SPEC_KIT_VERSION, busy: false });
    const r = await t.post('workflow', { on: true });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ engine: true, on: true });
    expect(t.sets).toEqual([true]);
    expect((await t.post('workflow', { on: 'yes' })).statusCode).toBe(400);
    expect(t.audits()).toEqual([expect.stringContaining('[agty spec] workflow device="Test phone" project="alpha" on=true')]);
  });

  it('plan → consent → install runs exactly the pinned argv in the project folder, reports what it made, leaves the three files alone', async () => {
    const t = setup();
    const before = files(t.folder);
    const plan = await t.post('workflow/plan');
    expect(plan.statusCode).toBe(200);
    const p = plan.json() as { planId: string; version: string; integrations: string[]; files: string[]; untouched: string[] };
    expect(p.version).toBe(SPEC_KIT_VERSION);
    expect(p.integrations).toEqual(['claude']);
    expect(p.files[0]).toBe('.specify/');
    expect(p.files).toContain('.claude/skills/speckit-specify/SKILL.md');
    expect(p.untouched).toEqual([...UNTOUCHED]);
    expect(p.untouched).toEqual(expect.arrayContaining(['.claude/settings.json', 'CLAUDE.md', 'AGENTS.md']));
    expect(t.calls()).toEqual([]); // a plan runs nothing
    const r = await t.post('workflow/install', { planId: p.planId, consent: true });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ ok: true, files: ['.claude/', '.claude/skills/speckit-specify/SKILL.md', '.specify/', '.specify/templates/spec-template.md'], count: 4, changed: [], lines: [] });
    expect(t.calls()).toEqual([{ argv: INIT_CLAUDE, cwd: t.folder }]);
    // the daemon wrote nothing of .claude/settings.json, CLAUDE.md, AGENTS.md: only Spec Kit's own files appeared
    expect(files(t.folder)).toEqual([...before, '.claude/skills/speckit-specify/SKILL.md', '.specify/templates/spec-template.md'].sort());
    expect(fs.readFileSync(path.join(t.folder, 'CLAUDE.md'), 'utf-8')).toBe("# the user's own\n");
    expect(t.audits().at(-1)).toContain('workflow-install device="Test phone" project="alpha" ok:true files:4 changed:0');
    // installed now: a second plan is refused, nothing runs over it
    expect((await t.post('workflow/plan')).json().errorCode).toBe('spec_workflow_installed');
  });

  it('a Claude + Codex project: init for Claude, then the Codex integration, each with events off', async () => {
    const t = setup({ clis: ['claude', 'codex', 'gemini'] });
    const p = (await t.post('workflow/plan')).json() as { planId: string; integrations: string[]; skipped: string[]; files: string[] };
    expect([p.integrations, p.skipped]).toEqual([['claude', 'codex'], ['gemini']]);
    expect(p.files).toContain('.agents/skills/speckit-plan/SKILL.md');
    expect((await t.post('workflow/install', { planId: p.planId, consent: true })).json()).toMatchObject({ ok: true });
    expect(t.calls().map((c) => c.argv)).toEqual([INIT_CLAUDE, [...FROM, 'integration', 'install', 'codex', '--integration-options=--events false']]);
  });

  it('a remote device without a fresh step-up is refused the switch, the plan and the install; with one, they go', async () => {
    const t = setup();
    t.who.remote = true;
    for (const [route, body] of [['workflow', { on: true }], ['workflow/plan', {}], ['workflow/install', { planId: 'x', consent: true }], ['workflow/uninstall', {}]] as const) {
      const r = await t.post(route, body);
      expect([route, r.statusCode, r.json().error]).toEqual([route, 403, 'stepup']);
    }
    expect([t.sets, t.calls()]).toEqual([[], []]);
    // negative control: the same requests with a fresh step-up pass the gate
    t.who.fresh = true;
    expect((await t.post('workflow', { on: true })).statusCode).toBe(200);
    const p = (await t.post('workflow/plan')).json() as { planId: string };
    expect((await t.post('workflow/install', { planId: p.planId, consent: true })).json()).toMatchObject({ ok: true });
  });

  it('install is refused without a matching plan: none, no consent, another session, used once, expired', async () => {
    const t = setup();
    const refusedWith = async (body: object, cookie?: string) => {
      const r = await t.post('workflow/install', body, cookie);
      return [r.statusCode, r.json().errorCode];
    };
    const consent = [403, 'spec_workflow_consent'];
    expect(await refusedWith({ consent: true })).toEqual(consent);
    expect(await refusedWith({ planId: 'f'.repeat(32), consent: true })).toEqual(consent);
    let p = (await t.post('workflow/plan')).json() as { planId: string };
    expect(await refusedWith({ planId: p.planId })).toEqual(consent); // no consent: and the plan is spent
    expect(await refusedWith({ planId: p.planId, consent: true })).toEqual(consent);
    p = (await t.post('workflow/plan')).json() as { planId: string };
    expect(await refusedWith({ planId: p.planId, consent: true }, 'sid=two')).toEqual(consent);
    p = (await t.post('workflow/plan')).json() as { planId: string };
    t.later(SPEC_KIT_CONSENT_TTL_MS + 1);
    expect(await refusedWith({ planId: p.planId, consent: true })).toEqual(consent);
    expect(t.calls()).toEqual([]);
  });

  it("a skill folder of Spec Kit's name without its SKILL.md counts as there: no plan runs over it", async () => {
    const t = setup();
    fs.mkdirSync(path.join(t.folder, '.claude/skills/speckit-plan'), { recursive: true });
    expect((await t.post('workflow/plan')).json().errorCode).toBe('spec_workflow_installed');
    expect(t.calls()).toEqual([]);
  });

  it('a read-only daemon refuses the switch, the plan and the install', async () => {
    const t = setup({ readOnly: true });
    for (const route of ['workflow', 'workflow/plan', 'workflow/install', 'workflow/uninstall'])
      expect((await t.post(route, { on: true })).json().errorCode).toBe('read_only_mode');
    expect([t.sets, t.calls()]).toEqual([[], []]);
  });

  it('a Spec Kit that changes CLAUDE.md is reported, never a success', async () => {
    const t = setup({ mode: 'touch' });
    const p = (await t.post('workflow/plan')).json() as { planId: string };
    const r = (await t.post('workflow/install', { planId: p.planId, consent: true })).json() as { ok: boolean; changed: string[] };
    expect(r).toMatchObject({ ok: false, changed: ['CLAUDE.md'] });
    expect(t.audits().at(-1)).toContain('ok:false files:4 changed:1 CLAUDE.md');
  });

  it('a failed run (offline) says so with its last lines; the agent token never reaches it', async () => {
    const t = setup({ mode: 'fail' });
    const p = (await t.post('workflow/plan')).json() as { planId: string };
    expect((await t.post('workflow/install', { planId: p.planId, consent: true })).json()).toEqual({
      ok: false,
      files: [],
      count: 0,
      changed: [],
      failed: 'exit',
      lines: ['could not reach github.com'],
    });
    expect(t.calls()).toHaveLength(1);
    expect(fs.existsSync(`${t.log}.token`)).toBe(false); // an allow list: the agent token, cloud keys, a database URL, a PAT never reach it
  });

  it('no uv: the view says so and a plan is refused; not an engine project: refused', async () => {
    const t = setup({ uvx: false });
    expect((await t.server.inject({ method: 'GET', url: '/api/cld/spec/alpha/docs' })).json().workflow).toMatchObject({ uv: false });
    expect((await t.post('workflow/plan')).json().errorCode).toBe('spec_workflow_uv');
    const n = setup({ engine: false });
    expect((await n.post('workflow', { on: true })).json().errorCode).toBe('spec_workflow_engine');
    expect((await n.post('workflow/plan')).json().errorCode).toBe('spec_workflow_engine');
  });

  it('uninstall runs `specify integration uninstall <key>` for what is there; .specify/ stays', async () => {
    const t = setup();
    expect((await t.post('workflow/uninstall')).json().errorCode).toBe('spec_workflow_not_installed');
    const p = (await t.post('workflow/plan')).json() as { planId: string };
    await t.post('workflow/install', { planId: p.planId, consent: true });
    const r = (await t.post('workflow/uninstall')).json() as { ok: boolean; files: string[] };
    expect(r).toMatchObject({ ok: true, files: ['.claude/skills/speckit-specify/SKILL.md'] });
    expect(t.calls().at(-1)).toEqual({ argv: [...FROM, 'integration', 'uninstall', 'claude'], cwd: t.folder });
    expect(fs.existsSync(path.join(t.folder, '.specify'))).toBe(true);
  });
});
