import { type ChildProcess,spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { EngineAction } from '../../../../core/src/messages.js';
import { transcriptPath } from '../providers/claudeProvider.js';
import { engineCalls, isFakeOf, makeEngineHome, removeTestHome } from '../testHome.js';
import { readLiveSessions } from './agents/claude/sessions.js';
import { Engine, type EngineOptions } from './engine.js';

const FAST = {
  pollMs: 20,
  appearMs: 5_000,
  goneMs: 5_000,
  reviveGapMs: 10,
  safetyMs: 60_000,
  debounceMs: 20,
  watchMs: 0,
};

const engines: Engine[] = [];
const homes: string[] = [];
const recorded = new Map<string, Set<number>>();
const daemons: ChildProcess[] = [];

function recordSessions(home: string): void {
  const pids = recorded.get(home) ?? new Set<number>();
  for (const session of readLiveSessions(home)) pids.add(session.pid);
  recorded.set(home, pids);
}

function killRecordedSessions(home: string): void {
  for (const pid of recorded.get(home) ?? []) {
    if (!isFakeOf(pid, home)) continue;
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // The fake session can already have exited.
    }
  }
}

afterEach(() => {
  for (const engine of engines.splice(0)) engine.dispose();
  for (const daemon of daemons.splice(0)) {
    if (daemon.exitCode === null && daemon.signalCode === null) daemon.kill('SIGKILL');
  }
  for (const home of homes.splice(0)) {
    killRecordedSessions(home);
    removeTestHome(home);
  }
  recorded.clear();
});

function setup() {
  const { home, claudePath } = makeEngineHome();
  homes.push(home);
  const inbox: Array<{ name: string; text: string }> = [];
  const logs: string[] = [];
  let request = 0;
  const boot = (extra: Partial<EngineOptions> = {}) => {
    const engine = new Engine({
      claudePath,
      home,
      readOnly: false,
      systemdRun: null,
      timing: FAST,
      log: (line) => logs.push(line),
      writeInbox: (name, text) => (inbox.push({ name, text }), true),
      ...extra,
    });
    engines.push(engine);
    engine.start();
    return engine;
  };
  const folder = (name: string) => {
    const dir = path.join(home, 'work', name);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  };
  const action = (
    engine: Engine,
    action: EngineAction['action'],
    name: string,
    fields: Partial<EngineAction> = {},
  ) =>
    engine.run(
      { type: 'engineAction', requestId: `recovery-${++request}`, action, name, ...fields },
      true,
      'test',
    );
  const project = (engine: Engine, name: string) =>
    engine.state().projects.find((candidate) => candidate.name === name)!;
  return { home, claudePath, inbox, logs, boot, folder, action, project };
}

type DaemonMessage = Record<string, unknown> & { type?: string; id?: number };

function startRecoveryDaemon(home: string, claudePath: string) {
  const daemon = spawn(
    process.execPath,
    ['--import', 'tsx', path.join(__dirname, 'recoveryDaemon.ts')],
    {
      env: {
        ...process.env,
        HOME: home,
        CLD_RECOVERY_HOME: home,
        CLD_RECOVERY_CLAUDE: claudePath,
      },
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    },
  );
  daemons.push(daemon);
  const messages: DaemonMessage[] = [];
  const replies = new Map<number, (message: DaemonMessage) => void>();
  daemon.on('message', (message: DaemonMessage) => {
    messages.push(message);
    if (typeof message.id === 'number') replies.get(message.id)?.(message);
  });
  let id = 0;
  const request = (type: 'action' | 'state', action?: EngineAction) => {
    const requestId = ++id;
    return new Promise<DaemonMessage>((resolve, reject) => {
      const timeout = setTimeout(() => {
        replies.delete(requestId);
        reject(new Error(`recovery daemon did not answer ${type}`));
      }, 5_000);
      replies.set(requestId, (message) => {
        clearTimeout(timeout);
        replies.delete(requestId);
        resolve(message);
      });
      daemon.send({ type, id: requestId, ...(action && { action }) });
    });
  };
  const ready = vi.waitFor(() => expect(messages.some((message) => message.type === 'ready')).toBe(true), {
    timeout: 5_000,
    interval: 20,
  });
  return { daemon, messages, ready, request };
}

async function waitForLive(home: string, engine: Engine, names: string[]): Promise<void> {
  await vi.waitFor(
    () => {
      for (const name of names) expect(engine.state().projects.find((p) => p.name === name)?.live).toBe(true);
      recordSessions(home);
    },
    { timeout: 5_000, interval: 20 },
  );
}

describe('engine recovery scenarios', () => {
  it('adopts both live sessions after the daemon crashes and restarts', async () => {
    const t = setup();
    const first = startRecoveryDaemon(t.home, t.claudePath);
    await first.ready;
    let request = 0;
    for (const name of ['alpha', 'beta']) {
      const add: EngineAction = {
        type: 'engineAction',
        requestId: `daemon-${++request}`,
        action: 'add',
        name,
        folder: t.folder(name),
      };
      const start: EngineAction = {
        type: 'engineAction',
        requestId: `daemon-${++request}`,
        action: 'start',
        name,
      };
      expect((await first.request('action', add)).result).toMatchObject({ ok: true });
      expect((await first.request('action', start)).result).toMatchObject({ ok: true });
    }
    await vi.waitFor(() => {
      expect(readLiveSessions(t.home)).toHaveLength(2);
      recordSessions(t.home);
    });
    const ids = Object.fromEntries(
      readLiveSessions(t.home).map((session) => [session.name!, session.sessionId]),
    );
    const starts = engineCalls(t.home).filter((call) => call.argv[0] === '--bg');
    expect(readLiveSessions(t.home)).toHaveLength(2);
    expect(new Set(readLiveSessions(t.home).map((session) => session.sessionId))).toEqual(new Set(Object.values(ids)));

    first.daemon.kill('SIGKILL');
    await new Promise<void>((resolve) => first.daemon.once('exit', () => resolve()));
    const second = startRecoveryDaemon(t.home, t.claudePath);
    await second.ready;
    await vi.waitFor(() => {
      expect(readLiveSessions(t.home)).toHaveLength(2);
      recordSessions(t.home);
    });
    const state = await second.request('state');
    const projects = (state.state as { projects: Array<{ name: string; sessionId?: string; live: boolean }> })
      .projects;

    expect(Object.fromEntries(projects.map((project) => [project.name, project.sessionId]))).toEqual(ids);
    expect(projects.every((project) => project.live)).toBe(true);
    expect(engineCalls(t.home).filter((call) => call.argv[0] === '--bg')).toHaveLength(starts.length);
    expect(readLiveSessions(t.home)).toHaveLength(2);
    expect(second.messages.filter((message) => message.type === 'inbox')).toEqual([]);
  });

  it('uses reboot recovery text once, leaves resting projects down, and resumes always-on without a prompt', async () => {
    const t = setup();
    const first = t.boot();
    for (const name of ['alpha', 'beta', 'delta', 'gamma']) {
      expect(
        await t.action(first, 'add', name, {
          folder: t.folder(name),
          ...(name === 'gamma' ? { alwaysOn: true } : {}),
        }),
      ).toMatchObject({ ok: true });
    }
    for (const name of ['alpha', 'delta', 'gamma'])
      expect(await t.action(first, 'start', name)).toMatchObject({ ok: true });
    await waitForLive(t.home, first, ['alpha', 'delta', 'gamma']);
    const alpha = t.project(first, 'alpha').sessionId!;
    const gamma = t.project(first, 'gamma').sessionId!;
    const delta = t.project(first, 'delta').sessionId!;
    for (const [name, sessionId] of [
      ['alpha', alpha],
      ['gamma', gamma],
      ['delta', delta],
    ] as const) {
      const transcript = transcriptPath(t.folder(name), sessionId, t.home);
      fs.mkdirSync(path.dirname(transcript), { recursive: true });
      fs.writeFileSync(transcript, '{}\n');
    }
    fs.mkdirSync(path.join(t.home, '.claude'), { recursive: true });
    fs.writeFileSync(
      path.join(t.home, '.claude', 'daemon.log'),
      `[test] bg retire ${delta.slice(0, 8)}: idle-prompt, idle 8h\n[test] bg retire ${gamma.slice(0, 8)}: settled, idle 8h\n`,
    );
    first.dispose();
    killRecordedSessions(t.home);
    await vi.waitFor(() => expect(readLiveSessions(t.home)).toEqual([]), { timeout: 5_000 });
    fs.writeFileSync(path.join(t.home, '.config', 'agent-tycoon', 'engine.boot'), 'previous-boot\n');
    const before = engineCalls(t.home).filter((call) => call.argv[0] === '--bg').length;

    const second = t.boot();
    await waitForLive(t.home, second, ['alpha', 'gamma']);

    const revived = engineCalls(t.home).filter((call) => call.argv[0] === '--bg').slice(before);
    expect(revived.map((call) => call.argv)).toEqual([
      ['--bg', '--resume', alpha],
      ['--bg', '--resume', gamma],
    ]);
    expect(t.inbox.filter((notice) => notice.name === 'alpha')).toHaveLength(1);
    expect(t.inbox.find((notice) => notice.name === 'alpha')?.text).toContain('컴퓨터가 다시 켜져서');
    expect(t.inbox.filter((notice) => notice.name === 'gamma')).toHaveLength(0);
    expect(t.project(second, 'beta')).toMatchObject({ live: false, wantRunning: false });
    expect(t.project(second, 'delta')).toMatchObject({
      live: false,
      wantRunning: true,
      downNote: 'Claude 가 오래 쉬어 내림 · 메시지가 오면 다시 켬',
    });
    expect(t.project(second, 'alpha').sessionId).toBe(alpha);
    expect(t.project(second, 'gamma').sessionId).toBe(gamma);
  });

  it('serializes simultaneous starts into one fake session', async () => {
    const t = setup();
    const engine = t.boot();
    expect(await t.action(engine, 'add', 'alpha', { folder: t.folder('alpha') })).toMatchObject({ ok: true });

    const [first, second] = await Promise.all([
      t.action(engine, 'start', 'alpha'),
      t.action(engine, 'start', 'alpha'),
    ]);
    await waitForLive(t.home, engine, ['alpha']);

    expect([first.ok, second.ok]).toEqual([true, false]);
    expect(readLiveSessions(t.home).filter((session) => session.name === 'alpha')).toHaveLength(1);
    expect(engineCalls(t.home).filter((call) => call.argv[0] === '--bg')).toHaveLength(1);
    expect(t.project(engine, 'alpha').sessionId).toBe(readLiveSessions(t.home)[0].sessionId);
  });
});
