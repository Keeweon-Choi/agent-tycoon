import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

// The manager is a plain ESM JavaScript entry point; this integration test
// deliberately exercises its real socket client.
// @ts-expect-error no declaration file for the JavaScript manager
import { realDeps as managerDeps } from '../../../../cld/install/manager.mjs';
import { REPO_ROOT } from '../testHome.js';
import type { ControlDeps, ControlRequest, Reply } from './control.js';
import { answerControl, controlPath, listenControl, parseControl } from './control.js';
import { header, parseQueued } from './messenger.js';

const CLI = path.join(REPO_ROOT, 'cld/bin/cld-gui');

// Many tests run the real CLI as a process, one node start per call (a dozen in a row for the
// exit-code and job tests); on a starved CPU (the deploy gate: two nice'd cores) that outlasts the
// 10 s default while nothing is wrong. The calls return as soon as they are answered.
vi.setConfig({ testTimeout: 90_000 });

let cleanup: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanup.reverse()) c();
  cleanup = [];
});

function home(): string {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), 'cld-ctl-'));
  cleanup.push(() => fs.rmSync(h, { recursive: true, force: true }));
  return h;
}

/** Run the CLI as the user would, with HOME = the test home. */
function cli(
  h: string,
  args: string[],
  o: { env?: Record<string, string>; cwd?: string; input?: string } = {},
): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd: o.cwd ?? h,
      env: { PATH: process.env.PATH, HOME: h, ...o.env },
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (b: Buffer) => (out += b.toString()));
    child.stderr.on('data', (b: Buffer) => (err += b.toString()));
    child.on('close', (code) => resolve({ code, out, err }));
    child.stdin.end(o.input ?? '');
  });
}

const SAMPLE = {
  ts: '2026-10-22T10:00:00+09:00',
  stale: false,
  cpuTempC: 61.6,
  cpuUtil: 0.123,
  gpuTempC: 47,
  gpuPowerW: 80.4,
  vramUsedMib: 812,
  vramTotalMib: 8192,
  ramUsedGib: 12.3,
  ramTotalGib: 31.2,
  hostRamUsedGib: 34.6,
  hostRamTotalGib: 44.5,
  topProcesses: [{ pid: 42, cpuPct: 55, rssMib: 120, command: 'python --api-key=***' }],
  gpuProcesses: [{ pid: 42, usedMib: 512 }],
  disks: [
    { name: 'WSL', freeGib: 120, totalGib: 500, warning: false },
    { name: 'D:', freeGib: 10, totalGib: 1000, warning: true },
  ],
  warnings: ['nvidia-smi 응답 없음'],
  sources: { cpuTempC: 'sysfs', gpuTempC: 'nvidia-smi' },
  sensorsHint: false,
};

/** A daemon socket answering with fake deps; the requests it got. */
async function daemon(h: string, deps: Partial<ControlDeps> = {}) {
  const seen: ControlRequest[] = [];
  const full: ControlDeps = {
    names: () => ['alpha', 'beta'],
    projectAt: (cwd) => (cwd.startsWith(path.join(h, 'alpha')) ? 'alpha' : null),
    send: (r) =>
      Promise.resolve({
        ok: true,
        delivered: r.to === 'beta' ? 'inbox' : 'pane',
        ...(r.to === 'beta' && { reason: 'off' }),
        messageId: 'ab2cd3ef',
      }),
    job: () => ({ ok: true, id: '1021-231502-alpha', pid: 4242, log: '/l/1021-231502-alpha.log' }),
    jobs: () => ({ ok: true, jobs: [{ id: 'x', pid: 1 }] }),
    stop: (t) =>
      t === '4242'
        ? { ok: true, pid: 4242, id: '1021-231502-alpha' }
        : {
            ok: false,
            code: 'no_such_job',
            error: `pid ${t} 작업이 없습니다(이미 끝났을 수 있다)`,
          },
    renew: (name) => ({ ok: true, name, renew: 'pending' }),
    codex: (r) =>
      Promise.resolve({
        ok: true,
        id: '1022-041502-alpha',
        pid: 4343,
        log: '/l/1022-041502-alpha.log',
        dir: r.cwd,
        worktree: null,
        branch: null,
      }),
    codexList: () => ({ ok: true, tasks: [{ id: 'c1', state: 'limit' }] }),
    hw: () => Promise.resolve({ ok: true, hw: SAMPLE }),
    ...deps,
  };
  const server = await listenControl(
    controlPath(h),
    (req) => {
      seen.push(req);
      return answerControl(req, full);
    },
    () => undefined,
  );
  if (!server) throw new Error('no socket');
  cleanup.push(() => server.close());
  return { server, seen };
}

describe('local control channel', () => {
  it.runIf(process.platform !== 'win32')(
    'the manager keeps its socket open until a delayed control reply arrives',
    async () => {
      const h = home();
      const server = await listenControl(
        controlPath(h),
        async () => {
          await new Promise((resolve) => setTimeout(resolve, 50));
          return { ok: true, delayed: true };
        },
        () => undefined,
      );
      if (!server) throw new Error('no socket');
      cleanup.push(() => server.close());

      await expect(managerDeps({ home: h }).control('status')).resolves.toMatchObject({
        ok: true,
        delayed: true,
      });
    },
  );

  it('lives in the config folder (Unix socket) or a per-user pipe (Windows)', () => {
    expect(controlPath('/home/u', 'linux')).toBe('/home/u/.config/agent-tycoon/engine.sock');
    expect(controlPath('/Users/u', 'darwin')).toBe('/Users/u/.config/agent-tycoon/engine.sock');
    expect(controlPath('C:\\Users\\Kim', 'win32', 'Kim Lee')).toBe(
      '\\\\.\\pipe\\cld-gui-engine-kim_lee',
    );
  });

  it.runIf(process.platform !== 'win32')(
    'socket 0600 in a 0700 folder; a second daemon does not take it over',
    async () => {
      const h = home();
      await daemon(h);
      const sock = controlPath(h);
      expect(fs.statSync(sock).isSocket()).toBe(true);
      expect(fs.statSync(sock).mode & 0o777).toBe(0o600);
      expect(fs.statSync(path.dirname(sock)).mode & 0o777).toBe(0o700);
      const second = await listenControl(
        sock,
        () => Promise.resolve({ ok: true }),
        () => undefined,
      );
      expect(second).toBeNull();
      expect((await cli(h, ['jobs'])).code).toBe(0); // the first still answers
    },
  );

  it.runIf(process.platform !== 'win32')(
    'an existing config folder (0775) becomes 0700 before the socket is made',
    async () => {
      const h = home();
      const dir = path.dirname(controlPath(h));
      fs.mkdirSync(dir, { recursive: true });
      fs.chmodSync(dir, 0o775);
      await daemon(h);
      expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
      expect(fs.statSync(controlPath(h)).mode & 0o777).toBe(0o600);
    },
  );

  it('checks requests: JSON line, version, absolute cwd; source falls back to cli', () => {
    expect(parseControl('nope')).toMatchObject({ ok: false, code: 'bad_request' });
    expect(parseControl('{"v":2,"cmd":"send","cwd":"/"}')).toMatchObject({
      ok: false,
      code: 'bad_request',
    });
    expect(parseControl('{"v":1,"cmd":"send","cwd":"rel"}')).toMatchObject({
      ok: false,
      code: 'bad_request',
    });
    expect(parseControl('{"v":1,"cmd":"send","cwd":"/w","source":"gui:x;rm"}')).toMatchObject({
      source: 'cli',
    });
  });

  it('stop-agents is owner-only and reports stopped and left work', async () => {
    const calls: string[] = [];
    const deps = {
      names: () => ['alpha'],
      projectAt: () => null,
      agentOf: (token: string) => (token === 'agent-token' ? 'alpha' : null),
      stopAgents: () => {
        calls.push('sessions then jobs');
        return {
          ok: true,
          stopped: [{ kind: 'session', name: 'alpha' }, { kind: 'job', name: 'j1' }],
          left: [{ kind: 'session', name: 'terminal', why: '터미널에서 열린 대화' }],
        };
      },
    } as unknown as ControlDeps;
    expect(await answerControl({ cmd: 'stop-agents', cwd: '/tmp', source: 'cli', token: 'agent-token', args: {} }, deps))
      .toMatchObject({ ok: false, code: 'forbidden' });
    expect(await answerControl({ cmd: 'stop-agents', cwd: '/tmp', source: 'cli', args: {} }, deps))
      .toEqual({
        ok: true,
        stopped: [{ kind: 'session', name: 'alpha' }, { kind: 'job', name: 'j1' }],
        left: [{ kind: 'session', name: 'terminal', why: '터미널에서 열린 대화' }],
      });
    expect(calls).toEqual(['sessions then jobs']);
  });

  it('send: the project the caller stands in wins over --from; --from stands in for none', async () => {
    const got: Array<string | null> = [];
    const deps = {
      names: () => ['alpha', 'beta'],
      projectAt: (cwd: string) => (cwd === '/w/alpha' ? 'alpha' : null),
      send: (r: { from: string | null }) => (
        got.push(r.from),
        Promise.resolve({ ok: true } as Reply)
      ),
    } as unknown as ControlDeps;
    const req = (cwd: string, from: string | null) =>
      answerControl(
        { cmd: 'send', cwd, source: 'cli', args: { to: 'beta', text: 'x', from } },
        deps,
      );
    await req('/w/alpha', 'savetax');
    await req('/tmp', 'savetax');
    await req('/tmp', null);
    expect(got).toEqual(['alpha', 'savetax', null]);
    expect(await req('/tmp', 'bad name!')).toMatchObject({ ok: false, code: 'usage' });
  });

  it('TOKEN-GUARD (TG-09): an agent token naming the target sends as itself (the messenger refuses it); the owner\'s terminal in that folder sends unnamed', async () => {
    const got: Array<{ to: string; from: string | null }> = [];
    const deps = {
      names: () => ['alpha', 'beta'],
      projectAt: (cwd: string) => (cwd === '/w/alpha' ? 'alpha' : null),
      agentOf: (token: string) => (token === 'agent-token' ? 'alpha' : null),
      send: (r: { to: string; from: string | null }) => (got.push({ to: r.to, from: r.from }), Promise.resolve({ ok: true } as Reply)),
    } as unknown as ControlDeps;
    const req = (cwd: string, token?: string) =>
      answerControl({ cmd: 'send', cwd, source: 'cli', ...(token && { token }), args: { to: 'alpha', text: 'x' } }, deps);
    await req('/tmp', 'agent-token'); // the agent itself, anywhere: a self-send
    await req('/w/alpha'); // no token, in alpha's folder: the owner's terminal
    await req('/w/alpha', 'agent-token');
    expect(got).toEqual([
      { to: 'alpha', from: 'alpha' },
      { to: 'alpha', from: null },
      { to: 'alpha', from: 'alpha' },
    ]);
  });

  it('S-06: an agent token renews only itself or its own Workers; the owner keeps --project', async () => {
    const renewed: string[] = [];
    const deps = {
      names: () => ['alpha', 'alpha-a', 'beta'],
      projectAt: () => null,
      projectOf: (n: string) => (n === 'alpha-a' ? 'alpha' : n),
      agentOf: (token: string) => (token === 'alpha-token' ? 'alpha' : token === 'beta-token' ? 'beta' : null),
      renew: (name: string) => (renewed.push(name), { ok: true, name, renew: 'pending' }),
    } as unknown as ControlDeps;
    const renew = (project: string, token?: string) =>
      answerControl({ cmd: 'renew', cwd: '/tmp', source: 'cli', ...(token && { token }), args: { project, text: 'h' } }, deps);
    expect(await renew('alpha', 'beta-token')).toMatchObject({ ok: false, code: 'forbidden' });
    expect(await renew('alpha-a', 'beta-token')).toMatchObject({ ok: false, code: 'forbidden' });
    expect(await renew('beta', 'beta-token')).toMatchObject({ ok: true });
    expect(await renew('alpha-a', 'alpha-token')).toMatchObject({ ok: true }); // a Lead its own Worker
    expect(await renew('alpha')).toMatchObject({ ok: true }); // the owner (no token)
    expect(renewed).toEqual(['beta', 'alpha-a', 'alpha']);
  });

  it('send --group and groups read use the daemon room contract', async () => {
    const sent: Array<Record<string, unknown>> = [];
    const deps = {
      names: () => ['alpha'], projectAt: () => null,
      groupPost: (request: Record<string, unknown>) => (sent.push(request), Promise.resolve({ ok: true, post: { targets: ['alpha'] } })),
      groups: () => ({ ok: true, groups: [{ id: 'all', name: '전체', members: ['alpha'] }] }),
      groupRead: (room: string, n: number) => ({ ok: true, room, n, posts: [] }),
    } as unknown as ControlDeps;
    expect(await answerControl({ cmd: 'send', cwd: '/tmp', source: 'cli', args: { group: '전체', text: '@전체 확인' } }, deps)).toMatchObject({ ok: true });
    expect(sent).toEqual([{ room: '전체', text: '@전체 확인', from: null, source: 'cli' }]);
    sent.length = 0;
    await answerControl({ cmd: 'send', cwd: '/tmp', source: 'messenger:pc', args: { group: '전체', text: '@전체 x' } }, deps);
    expect(sent[0].source).toBe('cli'); // the app's source is not claimable over the socket
    expect(await answerControl({ cmd: 'groups', cwd: '/tmp', source: 'cli', args: { read: '전체', n: 3 } }, deps)).toEqual({ ok: true, room: '전체', n: 3, posts: [] });
  });

  it('D3: a Worker’s token is the Worker; its jobs, Codex tasks and tasks belong to its project', async () => {
    const got: Array<Record<string, unknown>> = [];
    const deps = {
      names: () => ['alpha', 'alpha-a'],
      projectAt: () => 'alpha', // its folder is the project's: cwd never says which agent
      agentOf: (token: string) => (token === 'worker-token' ? 'alpha-a' : null),
      projectOf: (name: string) => (name === 'alpha-a' || name === 'alpha' ? 'alpha' : null),
      send: (r: Record<string, unknown>) => (got.push(r), Promise.resolve({ ok: true } as Reply)),
      job: (r: Record<string, unknown>) => (got.push(r), { ok: true }),
      task: (_a: unknown, who: Record<string, unknown>) => (got.push(who), { ok: true }),
    } as unknown as ControlDeps;
    const as = (cmd: string, args: Record<string, unknown>) =>
      answerControl({ cmd, cwd: '/w/alpha', source: 'cli', token: 'worker-token', args }, deps);
    await as('send', { to: 'alpha', text: 'done' });
    await as('job', { cmd: 'make', task: 'T-1' });
    await as('task', { op: 'list' });
    expect(got.map((r) => r.from ?? r.project ?? r.by)).toEqual(['alpha-a', 'alpha', 'alpha']);
    expect(got[1].task).toBe('T-1'); // D6: --task reaches the job
    expect(got[2]).toEqual({ by: 'alpha-a', project: 'alpha', agent: 'alpha-a' });
  });

  it('D3: worker add/start/list through the engine action, for the owner only', async () => {
    const actions: Array<Record<string, unknown>> = [];
    const deps = {
      names: () => ['alpha', 'alpha-a'],
      projectAt: () => null,
      agentOf: (token: string) => (token === 'agent-token' ? 'alpha' : null),
      workers: () => [{ name: 'alpha-a', project: 'alpha', role: 'worker' }],
      engineAction: (r: Record<string, unknown>) => (
        actions.push(r), Promise.resolve({ ok: true, note: 'n' })
      ),
    } as unknown as ControlDeps;
    const ask = (args: Record<string, unknown>, token?: string) =>
      answerControl({ cmd: 'worker', cwd: '/tmp', source: 'cli', ...(token && { token }), args }, deps);
    expect(await ask({ op: 'add', project: 'alpha', name: 'alpha-b', model: 'sonnet' })).toEqual({
      ok: true,
      name: 'alpha-b',
      action: 'add',
      note: 'n',
    });
    expect(actions[0]).toMatchObject({
      type: 'engineAction',
      action: 'add',
      name: 'alpha-b',
      role: 'worker',
      project: 'alpha',
      model: 'sonnet',
    });
    expect(await ask({ op: 'start', name: 'alpha-a' })).toMatchObject({ ok: true });
    expect(await ask({ op: 'start', name: 'alpha' })).toMatchObject({ code: 'unknown_worker' });
    expect(await ask({ op: 'list' })).toMatchObject({ ok: true, workers: [{ name: 'alpha-a' }] });
    expect(await ask({ op: 'add', project: 'alpha', name: 'x' }, 'agent-token')).toMatchObject({
      code: 'forbidden',
    });
    expect(await ask({ op: 'fly', name: 'x' })).toMatchObject({ code: 'usage' });
    expect(actions).toHaveLength(2);
    // D5: `--provider codex` reaches the engine's add.
    expect(await ask({ op: 'add', project: 'alpha', name: 'alpha-c', provider: 'codex', effort: 'high' })).toMatchObject({ ok: true });
    expect(actions[2]).toMatchObject({ action: 'add', name: 'alpha-c', role: 'worker', provider: 'codex', effort: 'high' });
  });
});

describe('cld-gui CLI', () => {
  it('send: sentences, CLD_OUTPUT=json, CLD_SOURCE, exit 0', async () => {
    const h = home();
    const { seen } = await daemon(h);
    fs.mkdirSync(path.join(h, 'alpha'));
    const pane = await cli(h, ['send', '--if-idle', 'alpha', 'build', 'is', 'green'], {
      cwd: path.join(h, 'alpha'),
    });
    expect(pane).toEqual({ code: 0, out: "'alpha' 오케스트레이터에 보냈습니다\n", err: '' });
    const inbox = await cli(h, ['send', 'beta', 'hello'], {
      env: { CLD_OUTPUT: 'json', CLD_SOURCE: 'gui:laptop' },
    });
    expect(inbox.code).toBe(0);
    // C2: the JSON carries the message id; the sentence above stays as it is.
    expect(JSON.parse(inbox.out)).toEqual({
      v: 1,
      ok: true,
      delivered: 'inbox',
      reason: 'off',
      messageId: 'ab2cd3ef',
    });
    expect(seen.map((r) => [r.cmd, r.source, r.args])).toEqual([
      ['send', 'cli', { to: 'alpha', text: 'build is green', ifIdle: true, from: null }],
      // The app's sources are not the CLI's to claim (S7).
      ['send', 'cli', { to: 'beta', text: 'hello', ifIdle: false, from: null }],
    ]);
    expect(seen[0].cwd).toBe(fs.realpathSync(path.join(h, 'alpha')));
  });

  it('exit codes: 1 refused (with code), 2 usage / unknown / not yet, 3 daemon off', async () => {
    const h = home();
    await daemon(h);
    const json = { CLD_OUTPUT: 'json' };
    const stop = await cli(h, ['stop', '999'], { env: json });
    expect(stop.code).toBe(1);
    expect(JSON.parse(stop.out)).toEqual({
      v: 1,
      ok: false,
      code: 'no_such_job',
      error: 'pid 999 작업이 없습니다(이미 끝났을 수 있다)',
    });
    expect((await cli(h, ['stop', '999'])).err).toBe(
      'pid 999 작업이 없습니다(이미 끝났을 수 있다)\n',
    );
    for (const [args, code] of [
      [['send', 'alpha'], 'empty_message'],
      [['send'], 'usage'],
      [['frob'], 'unknown_command'],
      [['job', '--vram', '4', 'python', 'train.py'], 'usage'],
      [['job', '--gpu', '--vram', 'lots', 'python'], 'usage'],
      [['codex', 'no-such-spec.md'], 'bad_file'],
      [[], 'usage'],
    ] as const) {
      const r = await cli(h, [...args], { env: json });
      expect([args, r.code, (JSON.parse(r.out) as { code: string }).code]).toEqual([
        args,
        code === 'empty_message' || code === 'bad_file' ? 1 : 2,
        code,
      ]);
    }
    const off = home(); // no daemon here
    const r = await cli(off, ['jobs'], { env: json });
    expect(r.code).toBe(3);
    expect(JSON.parse(r.out)).toMatchObject({ ok: false, code: 'daemon_off' });
  });

  it('job --gpu and codex (T-0021): what the daemon gets and what is printed', async () => {
    const h = home();
    const { seen } = await daemon(h);
    const job = await cli(h, [
      'job',
      '--gpu',
      '--vram',
      '2.5',
      '--label',
      '학습',
      'python',
      't.py',
    ]);
    expect(job.code).toBe(0);
    expect(job.out).toContain('GPU 차례를 기다렸다가 돈다(agty gpu)');
    expect(seen[0].args).toMatchObject({
      cmd: 'python t.py',
      gpu: { vramGib: 2.5, exclusive: false, label: '학습' },
    });
    const excl = await cli(h, ['job', '--gpu', '--exclusive', 'x'], {
      env: { CLD_OUTPUT: 'json' },
    });
    expect(JSON.parse(excl.out)).toMatchObject({ ok: true, gpu: true });
    expect(seen[1].args).toMatchObject({ gpu: { vramGib: null, exclusive: true, label: null } });

    const list = await cli(h, ['codex', '--all']);
    expect(JSON.parse(list.out)).toEqual({ v: 1, tasks: [{ id: 'c1', state: 'limit' }] });
    expect(seen[2].args).toEqual({ list: true, all: true });

    fs.writeFileSync(path.join(h, 'spec.md'), 'do it\n');
    const built = fs.existsSync(path.join(REPO_ROOT, 'dist/cld-worker.js'));
    const start = await cli(h, ['codex', '-m', 'm1', '-e', 'high', '--worktree', 'spec.md']);
    if (!built) return expect(start.code).toBe(1); // no_build before npm run build
    expect(start.code).toBe(0);
    expect(start.out).toContain('Codex 에 맡김 · 작업 1022-041502-alpha');
    expect(seen[3].args).toMatchObject({
      spec: path.join(fs.realpathSync(h), 'spec.md'),
      model: 'm1',
      effort: 'high',
      worktree: true,
      project: null,
    });
  });

  it('hw: one line per reading with units and sources; --json and CLD_OUTPUT=json the raw sample; no sample exits 1', async () => {
    const h = home();
    const { seen } = await daemon(h);
    const text = await cli(h, ['hw']);
    expect(text.code).toBe(0);
    expect(text.out.trimEnd().split('\n')).toEqual([
      'CPU 온도: 62 °C (sysfs)',
      'CPU 사용률: 12%',
      'GPU 온도: 47 °C (nvidia-smi)',
      'GPU 전력: 80 W',
      'GPU VRAM: 812 / 8192 MiB',
      'RAM: 12.3 / 31.2 GiB',
      'Windows RAM: 34.6 / 44.5 GiB',
      '디스크 WSL: 380 / 500 GiB (76%)',
      '디스크 D: 990 / 1000 GiB (99%)',
      '⚠ 디스크 D: 10 GiB 남음',
      '상위 CPU  pid 42  55%  RSS 120 MiB  python --api-key=***',
      'GPU 사용  pid 42  512 MiB',
      'nvidia-smi 응답 없음',
    ]);
    expect(seen[0]).toMatchObject({ cmd: 'hw', args: {} });
    const flag = await cli(h, ['hw', '--json']);
    expect(JSON.parse(flag.out)).toEqual({ v: 1, hw: SAMPLE });
    const env = await cli(h, ['hw'], { env: { CLD_OUTPUT: 'json' } });
    expect(JSON.parse(env.out)).toEqual({ v: 1, hw: SAMPLE });
    const bad = await cli(h, ['hw', 'x']);
    expect([bad.code, bad.err]).toEqual([2, '사용법: agty hw [--json]\n']);
  });

  it('hw with no sample: exit 1 with the reason, JSON ok:false', async () => {
    const h = home();
    await daemon(h, {
      hw: () =>
        Promise.resolve({
          ok: false,
          code: 'no_sample',
          error: 'HW 측정값이 아직 없습니다: LHM 응답 없음',
        }),
    });
    const text = await cli(h, ['hw']);
    expect([text.code, text.err]).toEqual([1, 'HW 측정값이 아직 없습니다: LHM 응답 없음\n']);
    const json = await cli(h, ['hw', '--json'], { env: { CLD_OUTPUT: 'json' } });
    expect(json.code).toBe(1);
    expect(JSON.parse(json.out)).toMatchObject({ v: 1, ok: false, code: 'no_sample' });
  });

  it('W2: worktree new|list: what the daemon gets, what is printed, JSON under CLD_OUTPUT=json, usage', async () => {
    const h = home();
    const got: Array<{ args: Record<string, unknown>; who: Record<string, unknown> }> = [];
    const row = { project: 'alpha', task: 't-1-a', taskId: 'T-1', assignee: 'alpha-w1', branch: 'task/t-1-a', path: '/w/.worktrees/t-1-a', base: 'main', exists: true, ahead: 1, behind: 0, dirty: 2, merged: false };
    await daemon(h, {
      worktree: (args, who) => {
        got.push({ args, who });
        if (args.op === 'list') return Promise.resolve({ ok: true, worktrees: [row] });
        if (args.task === 'T-9') return Promise.resolve({ ok: false, code: 'unknown_task', error: "'T-9' 작업이 없습니다" });
        return Promise.resolve({ ok: true, taskId: 'T-1', path: row.path, branch: row.branch, base: 'main', assignee: 'alpha-w1', note: 'alpha-w1 에게 배정했어요' });
      },
    });
    const made = await cli(h, ['worktree', 'new', '--task', 'T-1', '--assign', 'alpha-w1', '--base', 'main']);
    expect(made).toEqual({ code: 0, out: 'worktree 를 만들었어요: /w/.worktrees/t-1-a (브랜치 task/t-1-a, 기준 main)\nalpha-w1 에게 배정했어요\n', err: '' });
    expect(got[0]).toEqual({ args: { op: 'new', task: 'T-1', assign: 'alpha-w1', base: 'main' }, who: { by: 'cli', project: null, agent: null } });
    const json = JSON.parse((await cli(h, ['worktree', 'new', '--task', 'T-1'], { env: { CLD_OUTPUT: 'json' } })).out);
    expect(json).toMatchObject({ v: 1, ok: true, branch: 'task/t-1-a' });
    expect(await cli(h, ['worktree', 'new', '--task', 'T-9'])).toEqual({ code: 1, out: '', err: "'T-9' 작업이 없습니다\n" });
    expect((await cli(h, ['worktree', 'list'])).out).toBe('alpha\tT-1\talpha-w1\ttask/t-1-a\t/w/.worktrees/t-1-a\t↑1 ↓0 미커밋 2\n');
    expect(JSON.parse((await cli(h, ['worktree', 'list', '--task', 'T-1', '--json'])).out)).toEqual({ v: 1, worktrees: [row] });
    expect(got.at(-1)!.args).toEqual({ op: 'list', task: 'T-1' });
    const before = got.length;
    for (const bad of [['worktree'], ['worktree', 'new'], ['worktree', 'list', '--assign', 'x'], ['worktree', 'new', '--task'], ['worktree', 'new', '--task', 'T-1', '--force']])
      expect((await cli(h, bad)).code).toBe(2);
    expect(got).toHaveLength(before);
  });

  it('job, jobs, stop, renew, version: what the daemon gets and what is printed', async () => {
    const h = home();
    const { seen } = await daemon(h);
    const job = await cli(h, [
      'job',
      '-t',
      '--project',
      'alpha',
      'python',
      'train.py',
      '--epochs',
      '3',
    ]);
    expect(job).toEqual({
      code: 0,
      out: '백그라운드로 실행 · pid 4242 (멈추기: agty stop 4242) · 로그 /l/1021-231502-alpha.log\n',
      err: '',
    });
    expect(seen[0].args).toMatchObject({
      cmd: 'python train.py --epochs 3',
      tty: true,
      project: 'alpha',
    });
    expect(typeof seen[0].args.path).toBe('string');
    expect(JSON.parse((await cli(h, ['jobs', '--all'])).out)).toEqual({
      v: 1,
      jobs: [{ id: 'x', pid: 1 }],
    });
    expect(seen[1].args).toEqual({ all: true });
    expect((await cli(h, ['stop', '4242'])).out).toBe('pid 4242 작업을 멈췄습니다\n');
    const handoff = path.join(h, 'handoff.md');
    fs.writeFileSync(handoff, '# state\nnext: tests');
    const renew = await cli(h, ['renew', '--project', 'alpha', handoff], {
      env: { CLD_OUTPUT: 'json' },
    });
    expect(JSON.parse(renew.out)).toEqual({ v: 1, ok: true, name: 'alpha', renew: 'pending' });
    expect(seen[3].args).toEqual({ project: 'alpha', text: '# state\nnext: tests', file: handoff });
    await cli(h, ['renew', '--project', 'alpha', '-'], { input: 'from stdin' });
    expect(seen[4].args).toMatchObject({ text: 'from stdin', file: null });
    expect(
      (await cli(h, ['renew', path.join(h, 'missing.md')], { env: { CLD_OUTPUT: 'json' } })).out,
    ).toContain('"code":"bad_file"');
    const v = JSON.parse((await cli(h, ['version'])).out) as { commands: string[] };
    expect(v.commands).toEqual([
      'version',
      'status',
      'doctor',
      'logs',
      'restart',
      'backup',
      'restore',
      'send',
      'groups',
      'job',
      'jobs',
      'stop',
      'renew',
      'login',
      'codex',
      'gpu',
      'hw',
      'task',
      'worker', // D3
      'trust', // AUTO-TRUST
      'worktree', // W2
      'install',
      'update',
      'rollback',
      'uninstall',
      'open',
      'revert-adopt',
      'start', // R1/P6
      'start-policy',
    ]);
  });

  it('send with the daemon off: a queue file the daemon resumes (0600), exit 0 queued/daemon_off', async () => {
    const h = home();
    const cfg = path.join(h, '.config/agent-tycoon');
    fs.mkdirSync(path.join(h, 'work/alpha'), { recursive: true });
    fs.mkdirSync(cfg, { recursive: true });
    fs.writeFileSync(
      path.join(cfg, 'projects.json'),
      JSON.stringify([
        { name: 'alpha', folder: path.join(h, 'work/alpha'), wantRunning: true },
        { name: 'beta', folder: path.join(h, 'work/beta'), wantRunning: false },
      ]),
    );
    const r = await cli(h, ['send', '--from', 'savetax', 'beta', 'line\x07 one'], {
      cwd: path.join(h, 'work/alpha'),
      env: { CLD_OUTPUT: 'json' },
    });
    expect(r.code).toBe(0);
    const out = JSON.parse(r.out) as { messageId: string };
    expect(out).toEqual({
      v: 1,
      ok: true,
      delivered: 'queued',
      reason: 'daemon_off',
      messageId: expect.stringMatching(/^[a-z2-7]{8}$/), // C2: the id its header will carry
    });
    const [file] = fs.readdirSync(path.join(cfg, 'queue'));
    expect(file).toMatch(/^\d{13}-[0-9a-f]{6}\.json$/);
    expect(fs.statSync(path.join(cfg, 'queue', file)).mode & 0o777).toBe(0o600);
    const q = parseQueued(fs.readFileSync(path.join(cfg, 'queue', file), 'utf-8'));
    // The folder it was called from names the sender, not --from.
    expect(q).toMatchObject({
      to: 'beta',
      text: 'line one',
      from: 'alpha',
      source: 'cli',
      ifIdle: false,
      messageId: out.messageId,
    });
    const [event] = fs.readFileSync(path.join(cfg, 'events.jsonl'), 'utf-8').split('\n');
    expect(JSON.parse(event)).toMatchObject({
      v: 1,
      type: 'send',
      from: 'alpha',
      to: 'beta',
      delivered: 'queued',
      reason: 'daemon_off',
    });
    const unknown = await cli(h, ['send', 'gamma', 'x'], { env: { CLD_OUTPUT: 'json' } });
    expect([unknown.code, JSON.parse(unknown.out).code]).toEqual([1, 'unknown_project']);
    // Exit 3 only when even the queue file cannot be written.
    fs.rmSync(path.join(cfg, 'queue'), { recursive: true });
    fs.writeFileSync(path.join(cfg, 'queue'), 'not a folder');
    const stuck = await cli(h, ['send', 'beta', 'x'], { env: { CLD_OUTPUT: 'json' } });
    expect([stuck.code, JSON.parse(stuck.out).code]).toEqual([3, 'daemon_off']);
  });
});

describe('S7: who is speaking over the socket', () => {
  const TOKEN = 'A'.repeat(43);
  const created = Date.parse('2026-10-23T21:00:00+09:00');
  type Sent = { to: string; from: string | null; source: string };

  /** A daemon whose send/groupPost record what the Messenger would get. */
  async function owned(h: string) {
    const sent: Sent[] = [];
    const posts: Array<{ room: string; from: string | null; source: string }> = [];
    await daemon(h, {
      agentOf: (t) => (t === TOKEN ? 'alpha' : null),
      send: (r) => (sent.push(r), Promise.resolve({ ok: true, delivered: 'pane' })),
      groupPost: (r) => (posts.push(r), Promise.resolve({ ok: true, post: { targets: [] } })),
    });
    return { sent, posts };
  }
  const typedHeader = (r: Sent) => header({ from: r.from, source: r.source, created });

  it('CLD_SOURCE=messenger:x without a token: no owner header (negative control)', async () => {
    const h = home();
    const { sent } = await owned(h);
    const r = await cli(h, ['send', 'beta', 'rm -rf 해'], { env: { CLD_SOURCE: 'messenger:x' } });
    expect(r.code).toBe(0);
    expect(sent).toHaveLength(1);
    expect(typedHeader(sent[0])).not.toMatch(/사장/);
    expect(typedHeader(sent[0])).toMatch(/^\[cld-gui · 보냄 · /);
    // Not through the CLI either: the socket itself refuses the app's sources.
    for (const source of ['messenger:x', 'gui:laptop'])
      expect(parseControl(JSON.stringify({ v: 1, cmd: 'send', cwd: '/w', source }))).toMatchObject({
        source: 'cli',
      });
  });

  it("a valid token: the agent's own name, even with messenger:x and --from someone else", async () => {
    const h = home();
    const { sent } = await owned(h);
    await cli(h, ['send', '--from', 'beta', 'beta', 'x'], {
      env: { CLD_SOURCE: 'messenger:x', CLD_AGENT_TOKEN: TOKEN },
    });
    expect(sent[0]).toMatchObject({ from: 'alpha', source: 'cli' });
    expect(typedHeader(sent[0])).toMatch(/^\[cld-gui · alpha에게서 · /);
  });

  it('a forged token is no identity: labelled like any untokened caller, never the owner', async () => {
    const h = home();
    const { sent } = await owned(h);
    await cli(h, ['send', 'beta', 'x'], {
      env: { CLD_SOURCE: 'messenger:x', CLD_AGENT_TOKEN: 'B'.repeat(43) },
    });
    await cli(h, ['send', '--from', 'beta', 'beta', 'y'], {
      env: { CLD_AGENT_TOKEN: 'B'.repeat(43) },
    });
    expect(sent.map((r) => [r.from, r.source])).toEqual([
      [null, 'cli'],
      ['beta', 'cli'],
    ]);
    expect(sent.map(typedHeader).some((x) => x.includes('사장'))).toBe(false);
  });

  it('rooms: the owner header only from the app; a token names its agent', async () => {
    const h = home();
    const { posts } = await owned(h);
    await cli(h, ['send', '--group', '전체', '@전체 x'], { env: { CLD_SOURCE: 'messenger:x' } });
    await cli(h, ['send', '--group', '전체', '@전체 y'], {
      env: { CLD_SOURCE: 'messenger:x', CLD_AGENT_TOKEN: TOKEN },
    });
    expect(posts.map((p) => [p.from, p.source])).toEqual([
      [null, 'cli'],
      ['alpha', 'cli'],
    ]);
    const group = { roomId: 'all', roomName: '전체', messageId: 'm1' };
    for (const p of posts)
      expect(header({ from: p.from, source: p.source, created, group })).not.toMatch(/사장/);
    // The app's own routes (office.ts: `messenger:<device>`, from null) still speak as the owner.
    expect(header({ from: null, source: 'messenger:pc', created, group })).toMatch(
      /^\[사장 · 단톡방 '전체' · /,
    );
    expect(header({ from: null, source: 'messenger:pc', created })).toMatch(/^\[사장 · 메신저 · /);
  });

  it('daemon off: the queue file the CLI leaves never carries the app source', async () => {
    const h = home();
    const cfg = path.join(h, '.config/agent-tycoon');
    fs.mkdirSync(cfg, { recursive: true });
    fs.writeFileSync(
      path.join(cfg, 'projects.json'),
      JSON.stringify([{ name: 'beta', folder: path.join(h, 'work/beta'), wantRunning: false }]),
    );
    const r = await cli(h, ['send', 'beta', 'x'], { env: { CLD_SOURCE: 'messenger:x' } });
    expect(r.code).toBe(0);
    const [file] = fs.readdirSync(path.join(cfg, 'queue'));
    const q = parseQueued(fs.readFileSync(path.join(cfg, 'queue', file), 'utf-8'))!;
    expect(q.source).toBe('cli');
    expect(header(q)).not.toMatch(/사장/);
  });
});

describe('AUTO-TRUST: agty trust', () => {
  it('the socket: an agent token is refused, a name or an absolute folder (one of them) is required', async () => {
    const calls: unknown[] = [];
    const deps = {
      names: () => ['alpha'],
      projectAt: () => null,
      agentOf: (token: string) => (token === 'agent-token' ? 'alpha' : null),
      trust: (target: unknown, start: boolean) => {
        calls.push([target, start]);
        return Promise.resolve({ ok: true });
      },
    } as unknown as ControlDeps;
    const ask = (args: Record<string, unknown>, token?: string) =>
      answerControl(
        { cmd: 'trust', cwd: '/tmp', source: 'cli', ...(token && { token }), args },
        deps,
      );
    expect(await ask({ name: 'alpha' }, 'agent-token')).toMatchObject({
      ok: false,
      code: 'forbidden',
    });
    for (const args of [
      {},
      { name: 'alpha', folder: '/w/alpha' },
      { folder: 'w/alpha' },
      { name: '../x' },
    ])
      expect(await ask(args), JSON.stringify(args)).toMatchObject({ ok: false, code: 'usage' });
    expect(calls).toEqual([]);
    await ask({ name: 'alpha', start: true });
    await ask({ folder: '/w/alpha' });
    expect(calls).toEqual([
      [{ name: 'alpha' }, true],
      [{ folder: '/w/alpha' }, false],
    ]);
  });

  it('the CLI: argument checks, an unregistered folder refused, each step and the manual way on failure', async () => {
    const h = home();
    const alpha = path.join(h, 'alpha');
    fs.mkdirSync(alpha);
    const real = fs.realpathSync(alpha);
    const { seen } = await daemon(h, {
      agentOf: (t) => (t === 'agent-token' ? 'alpha' : null),
      // What Engine.trustProject answers: only the registered folder (or name) is known.
      trust: (target, start) => {
        if (target.name !== 'alpha' && target.folder !== alpha && target.folder !== real)
          return Promise.resolve({
            ok: false,
            code: 'unknown_project',
            error: '그런 프로젝트가 없어요',
          });
        if (fs.existsSync(path.join(h, 'unknown-screen')))
          return Promise.resolve({
            ok: true,
            name: 'alpha',
            folder: alpha,
            worker: false,
            outcome: 'unknownScreen',
            steps: ['started', 'closed'],
          });
        return Promise.resolve({
          ok: true,
          name: 'alpha',
          folder: alpha,
          worker: false,
          outcome: 'trusted',
          steps: ['started', 'dialog', 'chose', 'past', 'closed'],
          ...(start && { started: true }),
        });
      },
    });
    for (const args of [['trust'], ['trust', 'a', 'b'], ['trust', '--frob', 'alpha']]) {
      const r = await cli(h, args);
      expect(r.code, args.join(' ')).toBe(2);
      expect(r.err).toContain('trust [--start]');
    }
    expect(seen).toEqual([]);
    const nope = await cli(h, ['trust', './nope']);
    expect(nope.code).toBe(1);
    expect(nope.err).toBe('그런 프로젝트가 없어요\n');
    expect(seen.at(-1)!.args).toEqual({ folder: path.join(h, 'nope'), start: false });
    const ok = await cli(h, ['trust', 'alpha']);
    expect(ok.code).toBe(0);
    expect(ok.out).toContain('"Yes, I trust this folder" 를 골랐어요');
    expect(ok.out).toContain('이제 켤 수 있어요');
    const started = await cli(h, ['trust', '--start', '.'], { cwd: alpha });
    expect(started.code).toBe(0);
    expect(started.out).toContain("'alpha' 을(를) 켰어요");
    expect(seen.at(-1)!.args).toEqual({ folder: real, start: true });
    fs.writeFileSync(path.join(h, 'unknown-screen'), '');
    const failed = await cli(h, ['trust', 'alpha']);
    expect(failed.code).toBe(1);
    expect(failed.err).toContain(`직접 하려면: cd ${JSON.stringify(alpha)} && claude`);
    const agent = await cli(h, ['trust', 'alpha'], { env: { CLD_AGENT_TOKEN: 'agent-token' } });
    expect(agent.code).toBe(1);
    expect(agent.err).toContain('에이전트는 폴더 신뢰에 답할 수 없어요');
  });

  it('the CLI with the daemon off: nothing done, the manual way for a folder', async () => {
    const h = home();
    const r = await cli(h, ['trust', path.join(h, 'alpha')]);
    expect(r.code).toBe(3);
    expect(r.err).toContain('직접 하려면: cd');
  });
});
