/**
 * T-0021 `cld-gui codex`: the daemon side (CodexTasks) with the real worker
 * (workerMain.ts bundled into a temp file) run as an engine job, against the
 * fake `codex` (cld/test/fake-codex/codex): success, limit then resume,
 * failure, stop, refusals and recovery. Never the real codex. A temp git
 * repository and a temp HOME; signals only to the job groups this file started.
 */
import { spawn, spawnSync } from 'child_process';
import { buildSync } from 'esbuild';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { findOnPath } from '../providers/claudeProvider.js';
import { REPO_ROOT } from '../testHome.js';
import type { CodexRecord } from './codex.js';
import {
  CODEX_TIMING,
  codexDir,
  codexJson,
  CodexTasks,
  excludeLine,
  hitLimit,
  LIMIT_RE,
  readCodex,
  RESUME_TEXT,
  runCodex,
  saveCodex,
} from './codex.js';
import { EngineEvents, eventsPath } from './events.js';
import { GIT_AVAILABLE, makeTempRepo } from './git/testRepo.js';
import { Worktrees } from './git/worktrees.js';
import type { KillFn } from './jobs.js';
import { Jobs } from './jobs.js';
import { startForTask, tasksPath, TaskStore } from './tasks.js';

const FAKE_BIN = path.join(REPO_ROOT, 'cld/test/fake-codex');
const CLD_BIN = path.join(REPO_ROOT, 'cld/bin/cld-gui');
let WORKER = '';

beforeAll(() => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'cld-worker-'));
  WORKER = path.join(out, 'cld-worker.js');
  buildSync({
    entryPoints: [path.join(REPO_ROOT, 'server/src/cld/engine/workerMain.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: WORKER,
    logLevel: 'silent',
  });
}, 120_000);

// The tests start a real worker, git and the fake codex (and wait out a 3 s limit window); on a
// starved CPU (the deploy gate: two nice'd cores) one of them takes far longer than the 10 s default.
// The waits below end the moment their state is reached, so this only bounds a real hang.
vi.setConfig({ testTimeout: 120_000 });

let cleanup: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanup.reverse()) c();
  cleanup = [];
});

function rig(
  scenario = 'success',
  o: {
    codexOnPath?: boolean;
    worker?: string | null;
    projectFolder?: (repo: ReturnType<typeof makeTempRepo>) => string;
    /** The stop's signal becomes SIGKILL: the worker dies before it can record the stop. */
    hardKill?: boolean;
    /** C7b: where the shipped rules are (none: a Worker's prompt has no shipped part). */
    rulesDir?: string;
  } = {},
) {
  const repo = makeTempRepo({ push: false });
  const projectFolder = o.projectFolder?.(repo) ?? repo.folder;
  const home = path.join(repo.root, 'home');
  // The engine project `alpha` (the notice's receiver; projects.json read by `cld-gui send`).
  fs.mkdirSync(path.join(home, '.config/cld-gui'), { recursive: true });
  fs.writeFileSync(
    path.join(home, '.config/cld-gui/projects.json'),
    JSON.stringify([{ name: 'alpha', folder: repo.folder }]),
  );
  // Never the user's PATH: the real codex lives there (~/.local/bin). node, git, bash only.
  const PATH = [
    ...(o.codexOnPath === false ? [] : [FAKE_BIN]),
    path.dirname(process.execPath),
    '/usr/bin',
    '/bin',
  ].join(':');
  const found = findOnPath('codex', PATH);
  if (found !== null && found !== path.join(FAKE_BIN, 'codex'))
    throw new Error(`a real codex: ${found}`);
  const started = new Set<number>();
  const sent: Array<[number, string]> = [];
  // stop's signals reach only the job groups this rig started.
  const kill: KillFn = (target, sig) => {
    sent.push([target, sig]);
    if (started.has(Math.abs(target))) process.kill(target, o.hardKill ? 'SIGKILL' : sig);
  };
  const jobs = new Jobs({
    home,
    events: new EngineEvents(eventsPath(home)),
    env: () => ({
      HOME: home,
      PATH,
      CLD_BIN,
      FAKE_CODEX: scenario,
      // A 3 s limit window: at 1 s a loaded machine missed the 'limit' state (10-22 19:52 gate).
      FAKE_CODEX_RESET_S: '3',
      CLD_CODEX_POLL_MS: '300',
      CLD_CODEX_MARGIN_MS: '0',
      GIT_CONFIG_NOSYSTEM: '1',
    }),
    systemdRun: null,
    worker: o.worker === undefined ? WORKER : o.worker,
    kill,
  });
  const codex = new CodexTasks({
    home,
    rulesDir: o.rulesDir ?? null,
    jobs,
    worktree: (p, task) =>
      new Worktrees({
        file: path.join(home, '.config/cld-gui/worktrees.json'),
        run: repo.run,
      }).create(p, task),
    folderOf: (name) => (name === 'alpha' ? projectFolder : null),
  });
  const spec = path.join(repo.root, 'spec.md');
  fs.writeFileSync(spec, '# Task\nDo the thing.\n');
  cleanup.push(() => {
    for (const pid of started)
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        /* gone */
      }
    repo.cleanup();
  });
  const until = async (id: string, ok: (r: CodexRecord) => boolean, ms = 90_000) => {
    const end = Date.now() + ms;
    for (;;) {
      const r = readCodex(codexDir(home), id);
      if (r && ok(r)) return r;
      if (Date.now() > end) throw new Error(`timed out: ${JSON.stringify(r)}`);
      await new Promise((x) => setTimeout(x, 50));
    }
  };
  const start = async (extra: Partial<Parameters<CodexTasks['run']>[0]> = {}) => {
    const r = await codex.run({
      spec,
      model: null,
      worktree: false,
      project: 'alpha',
      cwd: repo.folder,
      source: 'cli',
      ...extra,
    });
    if (r.ok) started.add(r.pid as number);
    return r;
  };
  const calls = () =>
    fs.existsSync(path.join(home, 'fake-codex.log'))
      ? fs
          .readFileSync(path.join(home, 'fake-codex.log'), 'utf-8')
          .split('\n')
          .filter(Boolean)
          .map((l) => JSON.parse(l) as { argv: string[]; cwd: string; stdin: string })
      : [];
  const events = () =>
    fs
      .readFileSync(eventsPath(home), 'utf-8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .filter((e) => String(e.type).startsWith('codex_'));
  /** Notices `cld-gui send` queued (no daemon here): their texts. */
  const notices = () => {
    const dir = path.join(home, '.config/cld-gui/queue');
    return fs.existsSync(dir)
      ? fs
          .readdirSync(dir)
          .sort()
          .map(
            (f) =>
              JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8')) as {
                to: string;
                text: string;
                source: string;
              },
          )
      : [];
  };
  /** The notices once `n` are there (the worker sends the end notice after saving its state). */
  const noticesN = async (n: number) => {
    const end = Date.now() + 90_000;
    while (notices().length < n && Date.now() < end) await new Promise((x) => setTimeout(x, 50));
    return notices();
  };
  return {
    repo,
    home,
    jobs,
    codex,
    spec,
    until,
    start,
    calls,
    events,
    notices,
    noticesN,
    started,
    sent,
  };
}

describe.runIf(GIT_AVAILABLE && process.platform !== 'win32')(
  'cld-gui codex with a fake codex',
  () => {
    it('makes the worktree in a repository subfolder when called there, while containing outside callers', async () => {
      const setupProject = (repo: ReturnType<typeof makeTempRepo>) => {
        const project = path.join(repo.root, 'pofol');
        fs.mkdirSync(project);
        fs.renameSync(repo.folder, path.join(project, '01_pill-detection'));
        return project;
      };

      const inside = rig('success', {
        projectFolder: setupProject,
      });
      const insidePaths = {
        nestedRepo: path.join(inside.repo.root, 'pofol', '01_pill-detection'),
      };
      const created = await inside.start({ worktree: true, cwd: insidePaths.nestedRepo });
      expect(created).toMatchObject({ ok: true });
      expect(created.worktree).toContain(path.join(insidePaths.nestedRepo, '.worktrees'));

      const atTop = rig('success', { projectFolder: setupProject });
      const topPaths = { project: path.join(atTop.repo.root, 'pofol') };
      expect(await atTop.start({ worktree: true, cwd: topPaths.project })).toMatchObject({
        code: 'worktree_failed',
        error: expect.stringContaining('git 저장소가 아니에요'),
      });

      const outside = rig('success', { projectFolder: setupProject });
      const outsidePaths = { outside: path.join(outside.repo.root, 'outside') };
      fs.mkdirSync(outsidePaths.outside);
      expect(await outside.start({ worktree: true, cwd: outsidePaths.outside })).toMatchObject({
        code: 'worktree_failed',
        error: expect.stringContaining('git 저장소가 아니에요'),
      });
    });

    it('a caller folder cannot escape the project by .. or a symlink: the project folder is used', async () => {
      const setupProject = (repo: ReturnType<typeof makeTempRepo>) => {
        const project = path.join(repo.root, 'pofol');
        fs.mkdirSync(project);
        // A repository next to the project, and a way in from the project to it.
        fs.symlinkSync(repo.folder, path.join(project, 'link-out'));
        return project;
      };
      const r = rig('success', { projectFolder: setupProject });
      const project = path.join(r.repo.root, 'pofol');
      fs.mkdirSync(path.join(project, 'sub'));
      const refused = { code: 'worktree_failed', error: expect.stringContaining('git 저장소가') };
      // Through the symlink: its real path is the outside repository.
      expect(await r.start({ worktree: true, cwd: path.join(project, 'link-out') })).toMatchObject(
        refused,
      );
      // Out with ..: the real path is the outside repository.
      expect(
        await r.start({ worktree: true, cwd: path.join(project, 'sub', '..', '..', 'clone') }),
      ).toMatchObject(refused);
      // A sibling whose name only starts with the project's name.
      fs.symlinkSync(r.repo.folder, path.join(r.repo.root, 'pofol-evil'));
      expect(
        await r.start({ worktree: true, cwd: path.join(r.repo.root, 'pofol-evil') }),
      ).toMatchObject(refused);
      expect(fs.existsSync(path.join(r.repo.folder, '.worktrees'))).toBe(false);
    });

    it('success in a new worktree: codex exec with the spec as is, a commit, codex_start/end, one notice', async () => {
      const r = rig('success');
      const res = await r.start({ worktree: true, model: 'm-test' });
      expect(res).toMatchObject({
        ok: true,
        branch: expect.stringMatching(/^task\/codex-\d{4}-\d{6}$/),
      });
      const id = res.id as string;
      const done = await r.until(id, (x) => x.state === 'done');
      expect(done).toMatchObject({
        exit: 0,
        commits: 1,
        worktree: res.worktree,
        dir: res.worktree,
      });
      const exclude = fs.readFileSync(path.join(r.repo.folder, '.git/info/exclude'), 'utf-8');
      expect(exclude.split('\n').filter((l) => l === 'CODEX_PROGRESS.md')).toHaveLength(1);
      const [call] = r.calls();
      expect(call.cwd).toBe(res.worktree);
      expect(call.stdin).toBe('# Task\nDo the thing.\n'); // no rules added
      expect(call.argv.slice(0, 4)).toEqual(['exec', '--json', '-m', 'm-test']);
      expect(call.argv.join(' ')).not.toContain('model_reasoning_effort'); // unset = Codex's own
      expect(call.argv).toContain('-c');
      expect(
        call.argv.find((a) => a.startsWith('sandbox_workspace_write.writable_roots=')),
      ).toContain(path.join(r.repo.folder, '.git'));
      expect(call.argv.slice(-5)).toEqual(['-s', 'workspace-write', '-C', res.worktree, '-']);
      expect(r.events().map((e) => [e.type, e.state ?? null])).toEqual([
        ['codex_start', null],
        ['codex_end', 'done'],
      ]);
      expect(r.events()[0]).toMatchObject({
        id,
        project: 'alpha',
        model: 'm-test',
        source: 'codex',
      });
      const n = await r.noticesN(1);
      expect(n).toHaveLength(1);
      expect(n[0]).toMatchObject({ to: 'alpha', source: 'codex' });
      expect(n[0].text).toMatch(
        new RegExp(`^\\[cld-gui codex\\] 작업 ${id} 끝: done · 폴더 .* · 커밋 1개 · 로그 `),
      );
      // A task, not a job; the office's row says who runs it.
      expect(r.jobs.list(true).map((j) => j.id)).toEqual([]);
      expect(r.codex.tasks()).toMatchObject([
        { id, state: 'done', provider: 'engine', spec: 'spec.md' },
      ]);
      expect(codexJson(done)).toMatchObject({
        id,
        progress: { done: null, total: null, commits: 1 },
      });
    });

    it('D5 pins `cld-gui codex`: the whole argv of a new run (no model or effort), and of its resume after a limit', async () => {
      const r = rig('limit');
      const res = await r.start();
      const id = res.id as string;
      const done = await r.until(id, (x) => x.state === 'done');
      const roots = `sandbox_workspace_write.writable_roots=${JSON.stringify([path.join(fs.realpathSync(r.repo.folder), '.git')])}`;
      const [first, second] = r.calls();
      const rootsArg = first.argv[3];
      expect(path.normalize(JSON.parse(rootsArg.split('=')[1])[0])).toBe(path.normalize(JSON.parse(roots.split('=')[1])[0]));
      expect(first.argv).toEqual(['exec', '--json', '-c', rootsArg, '-s', 'workspace-write', '-C', r.repo.folder, '-']);
      expect(first.stdin).toBe('# Task\nDo the thing.\n');
      expect(second.argv).toEqual(['exec', 'resume', '--json', '-c', rootsArg, done.sid, RESUME_TEXT]);
      expect(second.stdin).toBe('');
      // The record has none of a Worker run's fields; the end notice still goes (cld-gui send).
      for (const k of ['agent', 'assignmentId', 'task', 'resume', 'messageId', 'room', 'summary'])
        expect(done).not.toHaveProperty(k);
      expect(fs.existsSync(path.join(codexDir(r.home), `${id}.last.md`))).toBe(false);
      const texts = (await r.noticesN(2)).map((n) => n.text);
      expect(texts).toHaveLength(2);
      expect(texts.every((t) => t.startsWith(`[cld-gui codex] 작업 ${id} `))).toBe(true);
    });

    it('D5: a Worker run: its message as the prompt (0600), -o, a new thread; summary from the last message; no notice', async () => {
      const r = rig('success');
      fs.writeFileSync(path.join(r.home, 'fake-codex.json'), JSON.stringify({ message: '고쳤어요 · 커밋 1개' }));
      const prompt = '[cld-gui · alpha에게서 · Task T-1 · 10-24 12:00] ⟨m:abcdefgh⟩\n로그인 고치기';
      const res = await r.start({
        spec: '',
        worker: { name: 'alpha-w1', assignmentId: 'a_wwwwwwwwww', prompt, task: 'T-1', messageId: 'abcdefgh', title: 'T-1 로그인 고치기' },
      });
      expect(res).toMatchObject({ ok: true });
      const id = res.id as string;
      // In memory at once (no watch event needed): the next message sees it running.
      expect(r.codex.runsOf('a_wwwwwwwwww').map((x) => [x.id, x.state])).toEqual([[id, 'running']]);
      const promptFile = path.join(codexDir(r.home), `${id}.prompt.md`);
      expect(fs.readFileSync(promptFile, 'utf-8')).toBe(prompt);
      expect(fs.statSync(promptFile).mode & 0o777).toBe(0o600);
      const done = await r.until(id, (x) => x.state === 'done');
      expect(done).toMatchObject({
        agent: 'alpha-w1',
        assignmentId: 'a_wwwwwwwwww',
        task: 'T-1',
        messageId: 'abcdefgh',
        spec: promptFile,
        title: 'T-1 로그인 고치기',
        summary: '고쳤어요 · 커밋 1개',
        exit: 0,
      });
      const [call] = r.calls();
      const last = path.join(codexDir(r.home), `${id}.last.md`);
      expect(call.argv).toEqual(['exec', '--json', '-c', call.argv[3], '-o', last, '-s', 'workspace-write', '-C', r.repo.folder, '-']);
      expect(call.stdin).toBe(prompt);
      expect(r.events().map((e) => [e.type, e.agent, e.task])).toEqual([
        ['codex_start', 'alpha-w1', 'T-1'],
        ['codex_end', 'alpha-w1', 'T-1'],
      ]);
      await new Promise((x) => setTimeout(x, 500));
      expect(r.notices()).toEqual([]); // the daemon tells the Lead, not the worker
      // Sidecar files are not records.
      expect(r.codex.records().map((x) => x.id)).toEqual([id]);
    });

    describe('C7b: the rules a Worker run starts with', () => {
      const prompt = '[cld-gui · alpha에게서 · 10-24 12:00]\n로그인 고치기';
      const setup = () => {
        const rulesDir = path.join(os.tmpdir(), `c7b-rules-${process.pid}-${Math.random().toString(36).slice(2)}`);
        fs.mkdirSync(rulesDir);
        fs.writeFileSync(path.join(rulesDir, 'default.en.md'), 'SHIPPED-DEFAULT\n');
        fs.writeFileSync(path.join(rulesDir, 'worker.en.md'), 'SHIPPED-WORKER\n');
        cleanup.push(() => fs.rmSync(rulesDir, { recursive: true, force: true }));
        const r = rig('success', { rulesDir });
        const cfg = path.join(r.home, '.config/cld-gui');
        fs.writeFileSync(path.join(cfg, 'ui-language'), 'en\n');
        return { r, cfg };
      };
      const promptOf = (r: ReturnType<typeof rig>, id: string) =>
        fs.readFileSync(path.join(codexDir(r.home), `${id}.prompt.md`), 'utf-8');

      it('shipped worker rules, then the user\'s, a separator, then the message; the start event names the playbook; nothing in the worktree', async () => {
        const { r, cfg } = setup();
        fs.writeFileSync(path.join(cfg, 'rules.md'), 'USER-RULES\n');
        const res = await r.start({ spec: '', worker: { name: 'alpha-w1', assignmentId: 'a_wwwwwwwwww', prompt, role: 'worker' } });
        expect(res).toMatchObject({ ok: true });
        const id = res.id as string;
        expect(promptOf(r, id)).toBe(`SHIPPED-DEFAULT\n\nSHIPPED-WORKER\n\nUSER-RULES\n\n---\n\n${prompt}`);
        await r.until(id, (x) => x.state === 'done');
        expect(r.calls()[0].stdin).toBe(promptOf(r, id));
        expect(r.events().find((e) => e.type === 'codex_start')).toMatchObject({ role: 'worker', playbook: expect.stringMatching(/^worker-[0-9a-f]{8}$/) });
        expect(spawnSync('git', ['status', '--porcelain'], { cwd: r.repo.folder, encoding: 'utf-8' }).stdout).toBe('');
      });

      it('a resumed thread gets just the message (the rules are already in its history), and no playbook in its start event', async () => {
        const { r, cfg } = setup();
        fs.writeFileSync(path.join(cfg, 'rules.md'), 'USER-RULES\n');
        const sid = '0000aaaa-0000-4000-8000-000000000001';
        const res = await r.start({ spec: '', worker: { name: 'alpha-w1', assignmentId: 'a_wwwwwwwwww', prompt, resume: sid } });
        const id = res.id as string;
        expect(promptOf(r, id)).toBe(prompt);
        await r.until(id, (x) => x.state === 'done');
        expect(r.events().find((e) => e.type === 'codex_start')).not.toHaveProperty('playbook');
      });

      it('useBuiltInRules off: no shipped text, the user\'s rules stay, no playbook', async () => {
        const { r, cfg } = setup();
        fs.writeFileSync(path.join(cfg, 'rules.md'), 'USER-RULES\n');
        fs.writeFileSync(path.join(cfg, 'use-built-in-rules'), 'off\n');
        const res = await r.start({ spec: '', worker: { name: 'alpha-w1', assignmentId: 'a_wwwwwwwwww', prompt } });
        const id = res.id as string;
        expect(promptOf(r, id)).toBe(`USER-RULES\n\n---\n\n${prompt}`);
        await r.until(id, (x) => x.state === 'done');
        expect(r.events().find((e) => e.type === 'codex_start')).not.toHaveProperty('playbook');
      });

      it('a plain `cld-gui codex` spec run: the engine adds nothing', async () => {
        const { r, cfg } = setup();
        fs.writeFileSync(path.join(cfg, 'rules.md'), 'USER-RULES\n');
        const res = await r.start();
        const id = res.id as string;
        await r.until(id, (x) => x.state === 'done');
        expect(r.calls()[0].stdin).toBe('# Task\nDo the thing.\n');
      });
    });

    it('D5: a Worker follow-up resumes its thread with the new prompt; a limit then resumes it with RESUME_TEXT, sandbox kept', async () => {
      const r = rig('limit');
      const sid = '0000aaaa-0000-4000-8000-000000000001';
      const prompt = '[cld-gui · alpha에게서 · 10-24 12:00]\n이어서';
      const res = await r.start({ spec: '', worker: { name: 'alpha-w1', assignmentId: 'a_wwwwwwwwww', prompt, resume: sid } });
      expect(res).toMatchObject({ ok: true });
      const id = res.id as string;
      const done = await r.until(id, (x) => x.state === 'done');
      const last = path.join(codexDir(r.home), `${id}.last.md`);
      const [first, second] = r.calls();
      const roots = first.argv[4];
      expect(first.argv).toEqual(['exec', 'resume', '--json', '-c', roots, '-c', 'sandbox_mode="workspace-write"', '-o', last, sid, '-']);
      expect(first.stdin).toBe(prompt);
      expect(first.cwd).toBe(r.repo.folder);
      expect(done.sid).toBe(sid);
      expect(second.argv).toEqual(['exec', 'resume', '--json', '-c', roots, '-c', 'sandbox_mode="workspace-write"', '-o', last, sid, RESUME_TEXT]);
      expect(done.summary).toBe('resumed and done');
      expect(r.events().map((e) => [e.type, e.agent ?? null])).toEqual([
        ['codex_start', 'alpha-w1'],
        ['codex_limit', 'alpha-w1'],
        ['codex_resume', null],
        ['codex_end', 'alpha-w1'],
      ]);
      await new Promise((x) => setTimeout(x, 500));
      expect(r.notices()).toEqual([]);
    });

    it('limit, then resume of the same session after the reset; "limit" while waiting', async () => {
      const r = rig('limit');
      const res = await r.start();
      const id = res.id as string;
      const waiting = await r.until(id, (x) => x.state === 'limit');
      expect(waiting.resetAt).toMatch(/^\d{4}-\d\d-\d\dT/);
      expect(waiting.sid).toMatch(/^[0-9a-f-]{36}$/);
      const done = await r.until(id, (x) => x.state === 'done');
      expect(done.exit).toBe(0);
      const c = r.calls();
      expect(c).toHaveLength(2);
      expect(c[1].argv).toEqual([
        'exec',
        'resume',
        '--json',
        '-c',
        expect.any(String),
        waiting.sid,
        RESUME_TEXT,
      ]);
      expect(r.events().map((e) => e.type)).toEqual([
        'codex_start',
        'codex_limit',
        'codex_resume',
        'codex_end',
      ]);
      expect(r.events()[1].reset_at).toBe(waiting.resetAt);
      const texts = (await r.noticesN(2)).map((x) => x.text);
      expect(texts).toHaveLength(2);
      expect(texts[0]).toContain(`작업 ${id} 이 Codex 사용량 한도에 걸렸다`);
      expect(texts[1]).toContain('끝: done');
    });

    it('-e high: model_reasoning_effort is passed, and again when the task resumes after a limit', async () => {
      const r = rig('limit');
      const res = await r.start({ effort: 'high' });
      const id = res.id as string;
      await r.until(id, (x) => x.state === 'done');
      expect(readCodex(codexDir(r.home), id)?.effort).toBe('high');
      const c = r.calls();
      expect(c).toHaveLength(2);
      expect(c[0].argv).toContain('model_reasoning_effort=high');
      expect(c[1].argv.slice(0, 2)).toEqual(['exec', 'resume']);
      expect(c[1].argv).toContain('model_reasoning_effort=high');
    });

    it('failure: state failed with codex’s exit code', async () => {
      const r = rig('fail');
      const id = (await r.start()).id as string;
      const done = await r.until(id, (x) => x.state === 'failed');
      expect(done.exit).toBe(2);
      // As in the stop test: the job's end event may land after codex_end on a busy CPU.
      expect(r.events()).toContainEqual(
        expect.objectContaining({ type: 'codex_end', id, state: 'failed', exit: 2 }),
      );
      expect((await r.noticesN(1)).at(-1)?.text).toContain('끝: failed');
    });

    it('cld-gui stop <task id>: the worker and codex end, state stopped', async () => {
      const r = rig('hang');
      const res = await r.start();
      const id = res.id as string;
      await r.until(id, (x) => !!x.sid);
      expect(r.jobs.stop(r.codex.jobOf(id)!, 'cli')).toMatchObject({ ok: true, id });
      expect(r.sent).toContainEqual([-(res.pid as number), 'SIGTERM']);
      const done = await r.until(id, (x) => x.state === 'stopped');
      expect(done.ended).not.toBeNull();
      // The job's own end event may land after codex_end on a busy CPU: not the last, just there.
      expect(r.events()).toContainEqual(
        expect.objectContaining({ type: 'codex_end', state: 'stopped' }),
      );
    });

    it('refusals: spec, codex, --worktree outside a project, no build', async () => {
      const r = rig('success');
      expect(await r.start({ spec: path.join(r.repo.root, 'nope.md') })).toMatchObject({
        code: 'bad_file',
      });
      expect(await r.start({ worktree: true, project: null })).toMatchObject({
        code: 'no_project',
      });
      expect(await r.start({ model: 'x; rm -rf /' })).toMatchObject({ code: 'usage' });
      expect(await r.start({ effort: 'ultra' })).toMatchObject({ code: 'usage' });
      expect(await rig('success', { codexOnPath: false }).start()).toMatchObject({
        code: 'no_codex',
      });
      expect(await rig('success', { worker: null }).start()).toMatchObject({ code: 'no_build' });
      expect(r.calls()).toEqual([]);
    });

    it('recovery: a waiting task whose worker is gone starts again and resumes its session', async () => {
      const r = rig('limit');
      const dir = codexDir(r.home);
      const rec: CodexRecord = {
        id: '1022-040000-alpha',
        project: 'alpha',
        model: null,
        state: 'limit',
        dir: r.repo.folder,
        worktree: null,
        branch: null,
        base: null,
        spec: r.spec,
        started: '2026-10-22T04:00:00+09:00',
        ended: null,
        exit: null,
        resetAt: new Date(Date.now() - 1000).toISOString(),
        sid: '00000000-0000-4000-8000-000000000001',
        commits: null,
        jobId: '1022-040000-alpha',
        log: '/nowhere.log',
        pid: null,
        source: 'cli',
      };
      saveCodex(dir, rec);
      r.codex.recover();
      const job = r.codex.jobOf(rec.id)!;
      expect(job).not.toBe(rec.id);
      const j = r.jobs.list(true, true).find((x) => x.id === job)!;
      r.started.add(j.pid!);
      const done = await r.until(rec.id, (x) => x.state === 'done');
      expect(done.exit).toBe(0);
      expect(r.calls()[0].argv.slice(0, 2)).toEqual(['exec', 'resume']);
      expect(r.events().map((e) => e.type)).toEqual(['codex_resume', 'codex_end']);
    });
    it('TOKEN-GUARD: a task the user stopped is not started again by recovery, even when its worker never wrote "stopped"', async () => {
      const r = rig('hang', { hardKill: true });
      const res = await r.start();
      const id = res.id as string;
      await r.until(id, (x) => !!x.sid);
      const job = r.codex.jobOf(id)!;
      expect(r.jobs.stop(job, 'cli')).toMatchObject({ ok: true });
      const end = Date.now() + 30_000;
      while (!r.jobs.list(true, true).find((j) => j.id === job)?.ended && Date.now() < end)
        await new Promise((x) => setTimeout(x, 100));
      expect(readCodex(codexDir(r.home), id)!.state).toBe('running'); // the stop never got written
      r.codex.recover(); // what the next daemon start does
      expect(r.codex.jobOf(id)).toBe(job); // no new job, no new Codex run
      expect(r.calls()).toHaveLength(1);
      expect(readCodex(codexDir(r.home), id)!.state).toBe('stopped');
      // (A job that vanished without a stop is still recovered: the recovery test above.)
    });
    it('D6: codex --task attaches an Execution; its end is observed (exit, worktree commits), a limit inferred, the status untouched', async () => {
      const sources = (r: ReturnType<typeof rig>) => ({
        codex: (id: string) => readCodex(codexDir(r.home), id),
        job: () => null,
      });
      const ok = rig('success');
      const store = new TaskStore(tasksPath(ok.home), undefined, () => undefined);
      store.add({ id: 'T-1', project: 'alpha', title: '맡길 일', status: 'doing' }, 'cli');
      const before = store.get('T-1')!;
      // An unknown task is refused before anything starts.
      expect(
        await startForTask(store, 'T-9', 'codex', 'cli', () => ok.start({ worktree: true })),
      ).toMatchObject({ ok: false, code: 'unknown_task' });
      expect(ok.codex.records()).toEqual([]);
      const res = await startForTask(store, 'T-1', 'codex', 'cli', () =>
        ok.start({ worktree: true }),
      );
      expect(res).toMatchObject({ ok: true, task: 'T-1' });
      const id = res.id as string;
      expect(store.get('T-1')!.executions).toEqual([
        { id: `codex:${id}`, kind: 'codex', ref: id, startedAt: expect.any(String), log: res.log },
      ]);
      await ok.until(id, (x) => x.state === 'done');
      expect(store.observe(sources(ok))).toBe(true);
      const [e] = store.get('T-1')!.executions!;
      expect(e).toMatchObject({
        endedAt: { source: 'observed' },
        exit: { value: 0, source: 'observed' },
        commits: { value: 1, source: 'observed' },
      });
      expect(e.limit).toBeUndefined();
      expect(store.observe(sources(ok))).toBe(false); // settled: nothing more to write
      const after = store.get('T-1')!;
      expect(after).toMatchObject({ status: 'doing', statusSource: 'reported' });
      expect(after.history).toHaveLength(before.history.length + 1); // the attach only
      expect(after.reportedDone).toBeUndefined();

      const lim = rig('limit');
      const store2 = new TaskStore(tasksPath(lim.home), undefined, () => undefined);
      store2.add({ id: 'T-2', project: 'alpha', title: '한도에 걸릴 일' }, 'cli');
      const r2 = await startForTask(store2, 'T-2', 'codex', 'cli', () => lim.start());
      const id2 = r2.id as string;
      const waiting = await lim.until(id2, (x) => x.state === 'limit');
      store2.observe(sources(lim));
      expect(store2.get('T-2')!.executions![0]).toMatchObject({
        limit: { value: { resetAt: waiting.resetAt }, source: 'inferred' },
      });
      expect(store2.get('T-2')!.executions![0].endedAt).toBeUndefined();
      await lim.until(id2, (x) => x.state === 'done');
      store2.observe(sources(lim));
      const e2 = store2.get('T-2')!.executions![0];
      expect(e2).toMatchObject({
        endedAt: { source: 'observed' },
        exit: { value: 0, source: 'observed' },
        limit: { source: 'inferred' },
      });
      expect(e2.commits).toBeUndefined(); // no worktree of its own: commits are not counted
      expect(store2.get('T-2')!.status).toBe('todo');
    });
  },
);

describe('a Codex task before and after its worker is up (U-03)', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cld-codex-times-'));
  cleanup.push(() => fs.rmSync(home, { recursive: true, force: true }));
  const rec = (over: Partial<CodexRecord>): CodexRecord => ({
    id: '1023-100000-alpha',
    project: 'alpha',
    model: null,
    state: 'running',
    dir: '/work',
    worktree: null,
    branch: null,
    base: null,
    spec: '/work/spec.md',
    started: '2026-10-23T10:00:00+09:00',
    ended: null,
    exit: null,
    resetAt: null,
    sid: null,
    commits: null,
    jobId: '1023-100000-alpha',
    log: '/nowhere.log',
    pid: null,
    source: 'cli',
    ...over,
  });
  const tasks = () =>
    new CodexTasks({ home, jobs: {} as Jobs, worktree: async () => ({ path: '', branch: '' }), folderOf: () => null }).tasks();

  it('queued: created is the record time, started is null until the worker runs codex', () => {
    saveCodex(codexDir(home), rec({}));
    expect(tasks()[0]).toMatchObject({
      state: 'running',
      pid: null,
      created: '2026-10-23T10:00:00+09:00',
      started: null,
    });
  });

  it('running: started is when the worker came up, apart from created', () => {
    saveCodex(codexDir(home), rec({ pid: 4242, ran: '2026-10-23T10:07:00+09:00' }));
    expect(tasks()[0]).toMatchObject({
      created: '2026-10-23T10:00:00+09:00',
      started: '2026-10-23T10:07:00+09:00',
    });
  });

  it('D5: a record from before D5 reads as it is and is no Worker run', () => {
    saveCodex(codexDir(home), rec({ pid: 4242 }));
    const c = new CodexTasks({ home, jobs: {} as Jobs, worktree: async () => ({ path: '', branch: '' }), folderOf: () => null });
    expect(c.records()).toHaveLength(1);
    expect(c.workerRecords()).toEqual([]);
    expect(c.runsOf('a_wwwwwwwwww')).toEqual([]);
  });

  it('D5: a Worker’s runs in the order they were asked for, two in one second included (base before base-2)', () => {
    const h = fs.mkdtempSync(path.join(os.tmpdir(), 'cld-codex-order-'));
    cleanup.push(() => fs.rmSync(h, { recursive: true, force: true }));
    const w = { agent: 'w1', assignmentId: 'a_wwwwwwwwww' };
    saveCodex(codexDir(h), rec({ ...w, id: '1024-121437-alpha-2', started: '2026-10-24T12:14:37+09:00' }));
    saveCodex(codexDir(h), rec({ ...w, id: '1024-121437-alpha', started: '2026-10-24T12:14:37+09:00' }));
    saveCodex(codexDir(h), rec({ ...w, id: '1024-121436-alpha', started: '2026-10-24T12:14:36+09:00' }));
    const c = new CodexTasks({ home: h, jobs: {} as Jobs, worktree: async () => ({ path: '', branch: '' }), folderOf: () => null });
    expect(c.runsOf('a_wwwwwwwwww').map((r) => r.id)).toEqual(['1024-121436-alpha', '1024-121437-alpha', '1024-121437-alpha-2']);
  });

  it('D5 (F3): the Worker-run index is read again on a folder change, else only after 60 s (no re-read per refresh)', async () => {
    const h = fs.mkdtempSync(path.join(os.tmpdir(), 'cld-codex-index-'));
    cleanup.push(() => fs.rmSync(h, { recursive: true, force: true }));
    let now = Date.parse('2026-10-24T12:00:00Z');
    const w = { agent: 'w1', assignmentId: 'a_wwwwwwwwww', state: 'done' as const };
    saveCodex(codexDir(h), rec({ ...w, id: '1024-120000-alpha', started: '2026-10-24T12:00:00+09:00' }));
    const c = new CodexTasks({ home: h, jobs: { list: () => [] } as unknown as Jobs, worktree: async () => ({ path: '', branch: '' }), folderOf: () => null, now: () => now });
    const read = vi.spyOn(c, 'records');
    expect(c.workerRecords()).toHaveLength(1);
    now += 30_000;
    expect(c.workerRecords()).toHaveLength(1);
    expect(read).toHaveBeenCalledTimes(1); // 30 s on, no change: from memory
    // Another daemon process wrote a run (no watch here): seen after the fallback only.
    saveCodex(codexDir(h), rec({ ...w, id: '1024-120100-alpha', started: '2026-10-24T12:01:00+09:00' }));
    expect(c.workerRecords()).toHaveLength(1);
    now += 31_000;
    expect(c.workerRecords()).toHaveLength(2);
    expect(read).toHaveBeenCalledTimes(2);
    // With the folder watched: a change is seen at the next ask, without the fallback.
    c.start();
    cleanup.push(() => c.dispose());
    expect(c.workerRecords()).toHaveLength(2);
    saveCodex(codexDir(h), rec({ ...w, id: '1024-120200-alpha', started: '2026-10-24T12:02:00+09:00' }));
    await vi.waitFor(() => expect(c.workerRecords()).toHaveLength(3), { timeout: 5_000, interval: 20 });
  });

  it('a record from before `ran` existed: started falls back to created once the worker has a pid', () => {
    saveCodex(codexDir(home), rec({ pid: 4242 }));
    expect(tasks()[0]).toMatchObject({ created: '2026-10-23T10:00:00+09:00', started: '2026-10-23T10:00:00+09:00' });
  });
});

describe.runIf(GIT_AVAILABLE)('CODEX_PROGRESS.md stays out of commits', () => {
  it('is appended to the shared info/exclude once, however often a task starts', () => {
    const repo = makeTempRepo({ push: false });
    cleanup.push(repo.cleanup);
    const wt = path.join(repo.root, 'wt');
    repo.git(['worktree', 'add', '-b', 'task/x', wt]);
    expect(excludeLine(wt)).toBe(true);
    expect(excludeLine(wt)).toBe(false);
    expect(excludeLine(repo.folder)).toBe(false); // the same file for every worktree
    const lines = fs.readFileSync(path.join(repo.folder, '.git/info/exclude'), 'utf-8').split('\n');
    expect(lines.filter((l) => l === 'CODEX_PROGRESS.md')).toHaveLength(1);
    fs.writeFileSync(path.join(wt, 'CODEX_PROGRESS.md'), 'x');
    expect(repo.git(['status', '--porcelain'], wt)).toBe('');
  });

  it('keeps a user line without a final newline intact', () => {
    const repo = makeTempRepo({ push: false });
    cleanup.push(repo.cleanup);
    const file = path.join(repo.folder, '.git/info/exclude');
    fs.writeFileSync(file, '*.log');
    expect(excludeLine(repo.folder)).toBe(true);
    expect(fs.readFileSync(file, 'utf-8')).toBe('*.log\nCODEX_PROGRESS.md\n');
  });

  it('is a no-op outside a git folder', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cld-nogit-'));
    cleanup.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    expect(excludeLine(dir)).toBe(false);
  });
});

describe('fake codex is the only codex these tests run', () => {
  it('the fake answers --help-less: it is a file in cld/test, not on the default PATH', () => {
    expect(fs.existsSync(path.join(FAKE_BIN, 'codex'))).toBe(true);
    expect(spawnSync('node', ['--check', path.join(FAKE_BIN, 'codex')]).status).toBe(0);
  });
});

describe.skipIf(!GIT_AVAILABLE)('GIT-HARDEN: the worker’s own git runs no transport', () => {
  it('a partial clone’s lazy fetch (the run’s base a missing commit, an ext:: promisor remote): never on the commit count', async () => {
    const r = makeTempRepo();
    cleanup.push(r.cleanup);
    const home = path.join(r.root, 'home');
    const dir = codexDir(home);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(home, 'spec.md'), 'do it');
    const marker = path.join(r.root, 'marker');
    const ext = path.join(r.root, 'ext.sh');
    fs.writeFileSync(ext, `#!/bin/sh\ntouch '${marker}'\nexit 1\n`, { mode: 0o755 });
    for (const [k, v] of [
      ['core.repositoryformatversion', '1'],
      ['extensions.partialClone', 'evil'],
      ['remote.evil.promisor', 'true'],
      ['protocol.ext.allow', 'always'],
      ['remote.evil.url', `ext::${ext} %S`],
    ])
      r.git(['config', k, v]);
    const base = '1'.repeat(40);
    const rec: CodexRecord = {
      id: '1024-230000-alpha',
      project: null,
      model: null,
      state: 'running',
      dir: r.folder,
      worktree: null,
      branch: null,
      base,
      spec: path.join(home, 'spec.md'),
      started: '2026-10-24T23:00:00+09:00',
      ended: null,
      exit: null,
      resetAt: null,
      sid: null,
      commits: null,
      jobId: '1024-230000-alpha',
      log: '/nowhere.log',
      pid: null,
      source: 'cli',
    };
    saveCodex(dir, rec);
    const rc = await runCodex(rec.id, {
      home,
      codex: '/never/run',
      cldBin: null,
      print: () => undefined,
      onSignal: () => undefined,
      // Never a codex: a child that ends at once.
      spawnFn: ((_bin: string, _args: string[], o: object) =>
        spawn(process.execPath, ['-e', 'process.exit(0)'], o)) as unknown as typeof spawn,
    });
    expect(rc).toBe(0);
    expect(fs.existsSync(marker)).toBe(false);
    // armed: the same count in plain git fetches the base from the promisor remote
    expect(() => r.git(['rev-list', '--count', `${base}..HEAD`])).toThrow();
    expect(fs.existsSync(marker)).toBe(true);
  });
});

describe('the limit wait never spins hot', () => {
  it('a reset already past (stale reading or skewed clock) waits a poll before the resume', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cld-codexwait-'));
    cleanup.push(() => fs.rmSync(home, { recursive: true, force: true }));
    const dir = codexDir(home);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(home, 'spec.md'), 'do it');
    // The session's own log: the window used up, reset an hour AGO.
    const sessions = path.join(home, '.codex', 'sessions');
    fs.mkdirSync(sessions, { recursive: true });
    const past = Math.floor(Date.now() / 1000) - 3600;
    fs.writeFileSync(
      path.join(sessions, 'rollout-s1.jsonl'),
      `${JSON.stringify({ rate_limits: { limit_id: 'codex', primary: { used_percent: 100, resets_at: past } } })}\n`,
    );
    const rec: CodexRecord = {
      id: '1022-040000-alpha',
      project: null,
      model: null,
      state: 'running',
      dir: home,
      worktree: null,
      branch: null,
      base: null,
      spec: path.join(home, 'spec.md'),
      started: '2026-10-22T04:00:00+09:00',
      ended: null,
      exit: null,
      resetAt: null,
      sid: null,
      commits: null,
      jobId: '1022-040000-alpha',
      log: '/nowhere.log',
      pid: null,
      source: 'cli',
    };
    saveCodex(dir, rec);
    const runs: string[][] = [];
    const sleeps: number[] = [];
    const say = (o: unknown) => `process.stdout.write(${JSON.stringify(JSON.stringify(o) + '\n')})`;
    const prevCodexHome = process.env.CODEX_HOME;
    delete process.env.CODEX_HOME;
    cleanup.push(() => {
      if (prevCodexHome !== undefined) process.env.CODEX_HOME = prevCodexHome;
    });
    const rc = await runCodex(rec.id, {
      home,
      codex: '/never/run',
      cldBin: null,
      timing: { pollMs: 1_000, marginMs: 0, sidMs: 50 },
      print: () => undefined,
      onSignal: () => undefined,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      // Never a codex: node prints a limit (first run) or a success (the resume).
      spawnFn: ((_bin: string, args: string[], o: object) => {
        runs.push(args);
        const script =
          runs.length === 1
            ? `${say({ type: 'thread.started', thread_id: 's1' })};${say({ type: 'error', message: 'usage_limit_exceeded' })};process.exit(1)`
            : 'process.exit(0)';
        return spawn(process.execPath, ['-e', script], o);
      }) as unknown as typeof spawn,
    });
    expect(rc).toBe(0);
    expect(runs).toHaveLength(2);
    expect(runs[1].slice(0, 2)).toEqual(['exec', 'resume']);
    expect(runs[1]).toContain('s1');
    expect(sleeps).toEqual([1_000]);
  });
});

/**
 * TOKEN-GUARD (TG-05, TG-13): a `cld-gui codex` task stuck on a usage limit whose reset time
 * cannot be read. Every lap used to send the orchestrator a notice (one woken Lead turn every
 * 5 minutes) and retry blindly every 5 minutes for 300 laps. No real codex, no daemon: the
 * runs are fake children that write their JSON line, and `cld-gui send` is a script that logs.
 */
describe('TOKEN-GUARD: a limit with an unknown reset', () => {
  function limitRig(
    script: (call: number, sid: string, codexHome: string) => 'limit' | 'ok',
    runMs = 0,
  ) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cld-tg-codex-'));
    cleanup.push(() => fs.rmSync(home, { recursive: true, force: true }));
    const dir = codexDir(home);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(home, 'spec.md'), 'do it');
    // The CLI the notices go through: it only logs its argv (never a daemon, never a session).
    const bin = path.join(home, 'bin');
    fs.mkdirSync(bin);
    const sendLog = path.join(home, 'send.log');
    fs.writeFileSync(
      path.join(bin, 'cld-gui'),
      `require('fs').appendFileSync(${JSON.stringify(sendLog)}, JSON.stringify(process.argv.slice(2)) + '\\n');\n`,
    );
    const codexHome = path.join(home, '.codex');
    const prev = process.env.CODEX_HOME;
    process.env.CODEX_HOME = codexHome;
    cleanup.push(() => {
      if (prev === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = prev;
    });
    const rec: CodexRecord = {
      id: '1024-170000-alpha',
      project: 'alpha',
      model: null,
      state: 'running',
      dir: home,
      worktree: null,
      branch: null,
      base: null,
      spec: path.join(home, 'spec.md'),
      started: '2026-10-24T17:00:00+09:00',
      ended: null,
      exit: null,
      resetAt: null,
      sid: null,
      commits: null,
      jobId: '1024-170000-alpha',
      log: '/nowhere.log',
      pid: null,
      source: 'cli',
    };
    saveCodex(dir, rec);
    const runs: string[][] = [];
    const sleeps: number[] = [];
    const clock = { t: Date.parse('2026-10-24T17:00:00+09:00') };
    const run = () =>
      runCodex(rec.id, {
        home,
        codex: '/never/run',
        cldBin: path.join(bin, 'cld-gui.js'),
        timing: { pollMs: 1_000, marginMs: 0, sidMs: 50 },
        now: () => clock.t,
        print: () => undefined,
        onSignal: () => undefined,
        sleep: async (ms) => {
          sleeps.push(ms);
          clock.t += ms;
        },
        // A fake child: its JSON lines written straight into the run's output file, then 'close'.
        spawnFn: ((_bin: string, args: string[], o: { stdio: [unknown, number, number] }) => {
          runs.push(args);
          const outcome = script(runs.length, 's1', codexHome);
          const lines = [
            { type: 'thread.started', thread_id: 's1' },
            ...(outcome === 'limit' ? [{ type: 'error', message: 'usage_limit_exceeded' }] : []),
          ];
          fs.writeSync(o.stdio[1], lines.map((l) => JSON.stringify(l) + '\n').join(''));
          const c = new EventEmitter() as EventEmitter & { stdin: unknown };
          c.stdin = { on: () => undefined, end: () => undefined };
          setTimeout(() => c.emit('close', outcome === 'limit' ? 1 : 0, null), runMs);
          return c;
        }) as unknown as typeof spawn,
      });
    const sends = () =>
      fs.existsSync(sendLog)
        ? fs
            .readFileSync(sendLog, 'utf-8')
            .split('\n')
            .filter(Boolean)
            .map((l) => (JSON.parse(l) as string[])[2])
        : [];
    return { run, runs, sleeps, sends, dir, rec };
  }

  it('one notice for the wait, not one per lap; retries back off; bounded, with an end notice', async () => {
    const r = limitRig(() => 'limit');
    const rc = await r.run();
    expect(rc).not.toBe(0);
    const limitNotices = r.sends().filter((t) => t.includes('사용량 한도에 걸렸다'));
    expect(limitNotices).toHaveLength(1);
    expect(r.sends().filter((t) => t.includes('끝: failed'))).toHaveLength(1);
    // Backoff: 1, 2, 4, ... polls, then the cap (the default is an hour); never a hot spin.
    expect(r.sleeps.slice(0, 5)).toEqual([1_000, 2_000, 4_000, 8_000, 16_000]);
    expect(Math.max(...r.sleeps)).toBe(CODEX_TIMING.pollMaxMs);
    expect(readCodex(r.dir, r.rec.id)!.state).toBe('failed');
  });

  it('liveness: a long run is never cut, polled or told about; one end notice', async () => {
    const r = limitRig(() => 'ok', 2_000);
    expect(await r.run()).toBe(0);
    expect(r.runs).toHaveLength(1);
    expect(r.sleeps).toEqual([]);
    expect(r.sends()).toEqual([expect.stringContaining('끝: done')]);
  });

  it('negative control: a reset time that appears later is a new notice; a cleared limit resumes and ends', async () => {
    const future = Math.floor(Date.parse('2026-10-24T20:00:00+09:00') / 1000);
    const r = limitRig((call, sid, codexHome) => {
      if (call === 3) {
        // The second lap's log now names the reset.
        fs.mkdirSync(path.join(codexHome, 'sessions'), { recursive: true });
        fs.writeFileSync(
          path.join(codexHome, 'sessions', `rollout-${sid}.jsonl`),
          `${JSON.stringify({ rate_limits: { limit_id: 'codex', primary: { used_percent: 100, resets_at: future } } })}\n`,
        );
      }
      return call <= 3 ? 'limit' : 'ok';
    });
    expect(await r.run()).toBe(0);
    const texts = r.sends();
    expect(texts.filter((t) => t.includes('사용량 한도에 걸렸다'))).toHaveLength(2);
    expect(texts.filter((t) => t.includes('끝: done'))).toHaveLength(1);
    expect(r.runs).toHaveLength(4);
  });
});

describe('hitLimit: only the error events of Codex itself mean a usage limit', () => {
  it('error and turn.failed events and plain stderr count; text inside other events does not', () => {
    const line = (o: unknown) => JSON.stringify(o);
    const msg = "You've hit your usage limit. Upgrade to Pro or try again at 11:03 PM.";
    expect(hitLimit(line({ type: 'error', message: msg }))).toBe(true);
    expect(hitLimit(line({ type: 'turn.failed', error: { message: msg } }))).toBe(true);
    expect(hitLimit(`ERROR: ${msg}`)).toBe(true);
    // 10-22 18:46: a grep that printed codex.ts read as a limit and set a finished task to resume.
    const grep = line({
      type: 'item.completed',
      item: {
        type: 'command_execution',
        aggregated_output: 'export const LIMIT_RE = /usage_limit_exceeded|hit your usage limit/i;',
      },
    });
    expect(LIMIT_RE.test(grep)).toBe(true); // what the old check matched
    expect(hitLimit(grep)).toBe(false);
    const said = line({ type: 'item.completed', item: { type: 'agent_message', text: msg } });
    expect(hitLimit([grep, said, line({ type: 'turn.completed' })].join('\n'))).toBe(false);
  });
});
