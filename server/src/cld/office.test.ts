import { spawn } from 'child_process';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { OfficeSnapshot } from '../../../core/src/messages.js';
import { AgentRuntime } from '../agentRuntime.js';
import { AgentStateStore } from '../agentStateStore.js';
import { claudeProvider } from '../providers/hook/claude/claude.js';
import type { AgentChoicesReader } from './engine/agentCapabilities.js';
import { codexDir, saveCodex } from './engine/codex.js';
import { GIT_AVAILABLE, makeTempRepo } from './engine/git/testRepo.js';
import { ezRulesPath } from './ezRules.js';
import { cldHooks } from './hooks.js';
import type { HwSource } from './hw/hwSource.js';
import { contractorSeatUid } from './layout.js';
import { Office } from './office.js';
import { ROSTER, startEngineOffice } from './officeTestKit.js';
import { ClaudeAgentsSource, parseAgents } from './providers/claudeProvider.js';
import { FAKE_CLAUDE, makeFakeHome, REPO_ROOT } from './testHome.js';

const savedEnv = { ...process.env };
let cleanup: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanup) c();
  cleanup = [];
  process.env = { ...savedEnv };
});

async function startOffice(opts: {
  claude?: string;
  chat?: boolean;
  /** Text of ~/.config/cld-gui/ez-rules.json. */
  ezRules?: string;
  codexUsageSpawnFn?: typeof spawn;
  codexUsageNow?: () => number;
  codexUsageProbeTimeoutMs?: number;
  codexUsageProbeKillGraceMs?: number;
}) {
  const fake = makeFakeHome({ claude: opts.claude ?? null });
  Object.assign(process.env, fake.env);
  if (opts.ezRules !== undefined) {
    fs.mkdirSync(path.dirname(ezRulesPath(fake.home)), { recursive: true });
    fs.writeFileSync(ezRulesPath(fake.home), opts.ezRules);
  }
  const store = new AgentStateStore();
  const runtime = new AgentRuntime(store, claudeProvider);
  const messages: Array<Record<string, unknown>> = [];
  store.on('broadcast', (m) => messages.push(m));
  const claude = opts.claude ? new ClaudeAgentsSource(fake.claudePath) : null;
  const office = new Office({
    runtime,
    store,
    readOnly: true,
    chat: opts.chat,
    claude,
    home: fake.home,
    defaultLayout: { tiles: [1], furniture: [] },
    codexUsageSpawnFn: opts.codexUsageSpawnFn,
    codexUsageNow: opts.codexUsageNow,
    codexUsageProbeTimeoutMs: opts.codexUsageProbeTimeoutMs,
    codexUsageProbeKillGraceMs: opts.codexUsageProbeKillGraceMs,
  });
  cleanup.push(() => {
    office.dispose();
    runtime.dispose();
  });
  await office.start();
  const last = (type: string) => [...messages].reverse().find((m) => m.type === type);
  return { fake, store, office, messages, last };
}

describe('office with the Claude provider only (no engine)', () => {
  it('publishes and records an early usage reset notice without an engine', async () => {
    const { fake, office, messages } = await startOffice({ claude: 'C-4' });
    (
      office as unknown as {
        usageResetEarly(reset: { provider: 'codex'; period: 'sevenDay' }): void;
      }
    ).usageResetEarly({ provider: 'codex', period: 'sevenDay' });
    expect(messages.at(-1)).toMatchObject({
      type: 'officeEvent',
      kind: 'usage_reset_early',
      summary: 'Codex 주간 사용량이 예정보다 일찍 초기화됐어요',
      provider: 'codex',
      period: 'sevenDay',
    });
    expect(
      fs.readFileSync(path.join(fake.home, '.config', 'cld-gui', 'events.jsonl'), 'utf-8'),
    ).toContain('"usage_reset_early"');
  });

  it('runs an injected, rate-limited Codex usage probe only for a privileged client', async () => {
    const calls: Array<{ bin: string; args: string[]; cwd: string; env?: NodeJS.ProcessEnv }> = [];
    const probe = ((
      bin: string,
      args: string[],
      options: { cwd?: string; env?: NodeJS.ProcessEnv },
    ) => {
      const child = new EventEmitter() as ReturnType<typeof spawn>;
      calls.push({ bin, args, cwd: options.cwd!, env: options.env });
      expect(fs.existsSync(options.cwd!)).toBe(true);
      queueMicrotask(() => child.emit('close', 0));
      return child;
    }) as typeof spawn;
    let now = Date.now();
    const bin = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cld-codex-bin-')), 'codex');
    cleanup.push(() => fs.rmSync(path.dirname(bin), { recursive: true, force: true }));
    fs.writeFileSync(bin, '');
    fs.chmodSync(bin, 0o755);
    process.env.PATH = `${path.dirname(bin)}${path.delimiter}${process.env.PATH}`;
    process.env.CODEX_USAGE_PROBE_SECRET = 'must-not-reach-child';
    const { fake, office } = await startOffice({
      claude: 'C-4',
      codexUsageSpawnFn: probe,
      codexUsageNow: () => now,
    });
    const replies: Array<Record<string, unknown>> = [];
    office.onClientMessage({ type: 'codexUsageCheck' }, (m) => replies.push(m), false);
    expect(replies).toEqual([
      {
        type: 'codexUsageCheckResult',
        ok: false,
        error: '이 접속에는 사용량을 확인할 권한이 없어요',
        errorCode: 'usage_denied',
      },
    ]);
    expect(calls).toEqual([]);

    office.onClientMessage({ type: 'codexUsageCheck' }, (m) => replies.push(m), true);
    await vi.waitFor(() =>
      expect(replies.at(-1)).toEqual({ type: 'codexUsageCheckResult', ok: true }),
    );
    expect(calls[0]).toMatchObject({
      bin,
      args: ['exec', '--skip-git-repo-check', '-c', 'model_reasoning_effort=low', 'Reply with exactly: OK'],
      env: expect.objectContaining({ HOME: fake.home }),
    });
    expect(calls[0].env).not.toHaveProperty('CODEX_USAGE_PROBE_SECRET');
    // codex writes its fresh limits where the usage line reads them.
    expect(calls[0].env?.CODEX_HOME).toBe(process.env.CODEX_HOME ?? path.join(fake.home, '.codex'));
    expect(calls[0].args).not.toContain('-m');
    expect(fs.existsSync(calls[0].cwd)).toBe(false);

    office.onClientMessage({ type: 'codexUsageCheck' }, (m) => replies.push(m), true);
    expect(replies.at(-1)).toEqual({
      type: 'codexUsageCheckResult',
      ok: false,
      error: '10분에 한 번만 확인할 수 있어요',
      errorCode: 'usage_cooldown',
    });
    expect(calls).toHaveLength(1);
    now += 10 * 60_000;
    office.onClientMessage({ type: 'codexUsageCheck' }, (m) => replies.push(m), true);
    await vi.waitFor(() =>
      expect(replies.at(-1)).toEqual({ type: 'codexUsageCheckResult', ok: true }),
    );
    expect(calls).toHaveLength(2);
  });

  it('escalates an unresponsive probe and cleans its directory only after it exits', async () => {
    const kills: string[] = [];
    let child: ReturnType<typeof spawn>;
    let cwd = '';
    const probe = ((_bin: string, _args: string[], options: { cwd?: string }) => {
      child = new EventEmitter() as ReturnType<typeof spawn>;
      child.kill = ((signal?: NodeJS.Signals | number) => {
        kills.push(String(signal));
        return true;
      }) as typeof child.kill;
      cwd = options.cwd!;
      return child;
    }) as typeof spawn;
    const bin = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cld-codex-bin-')), 'codex');
    cleanup.push(() => fs.rmSync(path.dirname(bin), { recursive: true, force: true }));
    fs.writeFileSync(bin, '');
    fs.chmodSync(bin, 0o755);
    process.env.PATH = `${path.dirname(bin)}${path.delimiter}${process.env.PATH}`;
    const { office } = await startOffice({
      claude: 'C-4',
      codexUsageSpawnFn: probe,
      codexUsageProbeTimeoutMs: 1,
      codexUsageProbeKillGraceMs: 1,
    });
    const replies: Array<Record<string, unknown>> = [];
    office.onClientMessage({ type: 'codexUsageCheck' }, (m) => replies.push(m), true);
    await vi.waitFor(() => expect(kills).toContain('SIGTERM'));
    expect(fs.existsSync(cwd)).toBe(true);
    await vi.waitFor(() => expect(kills).toContain('SIGKILL'));
    expect(fs.existsSync(cwd)).toBe(true);
    child!.emit('close', null);
    await vi.waitFor(() => expect(replies.at(-1)).toMatchObject({ ok: false }));
    expect(fs.existsSync(cwd)).toBe(false);
  });

  it('stops a running Codex usage probe when the office is disposed', async () => {
    const kills: string[] = [];
    let child: ReturnType<typeof spawn>;
    const probe = ((_bin: string, _args: string[]) => {
      child = new EventEmitter() as ReturnType<typeof spawn>;
      child.kill = ((signal?: NodeJS.Signals | number) => {
        kills.push(String(signal));
        return true;
      }) as typeof child.kill;
      return child;
    }) as typeof spawn;
    const bin = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cld-codex-bin-')), 'codex');
    cleanup.push(() => fs.rmSync(path.dirname(bin), { recursive: true, force: true }));
    fs.writeFileSync(bin, '');
    fs.chmodSync(bin, 0o755);
    process.env.PATH = `${path.dirname(bin)}${path.delimiter}${process.env.PATH}`;
    const { office } = await startOffice({
      claude: 'C-4',
      codexUsageSpawnFn: probe,
      codexUsageProbeKillGraceMs: 1,
    });
    office.onClientMessage({ type: 'codexUsageCheck' }, () => undefined, true);
    await vi.waitFor(() => expect(child).toBeDefined());
    office.dispose();
    expect(kills).toContain('SIGTERM');
    child!.emit('close', null);
  });

  it('characters from `claude agents --json`, rooms by project, no engine data', async () => {
    const { office, last, store } = await startOffice({ claude: 'C-4' });
    const hs = last('officeSnapshot') as unknown as OfficeSnapshot;
    expect(Object.keys(hs).sort()).toEqual(['orchestrators', 'readOnly', 'tabs', 'type']);
    expect(hs.tabs.map((t) => t.name)).toEqual(['alpha', 'beta', 'delta', 'gamma']);
    expect(hs.orchestrators).toHaveLength(5);
    expect(hs.orchestrators.every((o) => o.provider === 'claude')).toBe(true);
    expect(hs.orchestrators.every((o) => typeof o.agentId === 'number')).toBe(true);
    expect(store.size).toBe(5);
    expect(store.get(hs.orchestrators[0].agentId!)!.directoryName).toBe('alpha-orchestrator');
    // Engine-only messages are absent; HW comes from the built-in sampler, which
    // the first viewer starts (its sample is async and reaches every client).
    office.onClientOpened(vi.fn());
    await vi.waitFor(() => expect(last('hwSample')).toBeDefined());
    const snap: Array<Record<string, unknown>> = [];
    office.onClientReady((m) => snap.push(m));
    expect(snap.map((m) => m.type).sort()).toEqual([
      'buildingState',
      'characterParts', // CHAR-HUMAN: the owner's imported parts (none in this HOME)
      'characterPresets',
      'hostInfo',
      'hwSample',
      'newAgentPermission', // O4: the starting permission default for new agents (unanswered here)
      'officeSnapshot',
      'taskBoard', // 작업 현황 (DEV-BOARD) needs no engine: the office edits it too
      'usageState',
    ]);
    // ENV-2: no source in this HOME, so usage is unknown, never a made-up number.
    expect(snap.find((m) => m.type === 'usageState')).toMatchObject({ claude: null, codex: null });
    // Generated office: one room per project dir.
    const layout = office.layoutFor() as { areas: Array<{ label: string }> };
    expect(layout.areas.map((a) => a.label)).toEqual([
      'alpha',
      'beta',
      'delta',
      'gamma',
      '라운지',
      '로비',
    ]);
    expect(office.seatFor(hs.orchestrators[0].agentId!)).toBe('seat:name:alpha-orchestrator');
  });

  it('setCharacter by name, kept under HOME, also on a read-only daemon (T-0017)', async () => {
    const { office, last, fake } = await startOffice({ claude: 'C-4' });
    const name = (last('officeSnapshot') as unknown as OfficeSnapshot).orchestrators[0].name;
    const look = { palette: 2, hueShift: 30 };
    office.onClientMessage({ type: 'setCharacter', key: name, character: look }, () => undefined);
    office.onClientMessage(
      { type: 'setCharacter', key: 'nobody', character: look },
      () => undefined,
    );
    expect(last('characterPresets')).toMatchObject({ assignments: { [name]: look } });
    const store = path.join(fake.home, '.config/cld-gui/characters.json');
    const saved = JSON.parse(fs.readFileSync(store, 'utf-8')) as Record<string, unknown>;
    expect(saved[name]).toEqual(look);
    expect(saved.nobody).toBeUndefined();
    // CH-1: every other character keeps the palette it was made with (pinned), then $meta.
    const snap = last('officeSnapshot') as unknown as OfficeSnapshot;
    for (const o of snap.orchestrators.filter((o) => o.name !== name))
      expect(saved[o.name]).toEqual({ palette: expect.any(Number), hueShift: expect.any(Number) });
    expect(saved.$meta).toMatchObject({ v: 2 });
    expect(fs.existsSync(path.join(fake.home, '.config/cld-gui/characters/README.md'))).toBe(true);
  });
});

describe('office chat flag (T-0014)', () => {
  it('officeState says chat only with --allow-chat; background rows carry their attach id', async () => {
    const off = await startOffice({ claude: 'C-4' });
    expect((off.last('officeSnapshot') as unknown as OfficeSnapshot).chat).toBeUndefined();
    const on = await startOffice({ claude: 'C-4', chat: true });
    const hs = on.last('officeSnapshot') as unknown as OfficeSnapshot;
    expect(hs.chat).toBe(true);
    expect(hs.orchestrators.filter((o) => o.bg).map((o) => o.bg!.id)).toEqual([
      'a0000016',
      'a0000017',
      'a0000018',
    ]);
  });
});

describe('office with the built-in engine', () => {
  it('engine projects are the characters: rooms by project room, the 관리실 is an ops room without a contractor desk', async () => {
    const { office, last, store, agentId } = await startEngineOffice({ projects: ROSTER });
    const hs = last('officeSnapshot') as unknown as OfficeSnapshot;
    expect(Object.keys(hs).sort()).toEqual(['orchestrators', 'readOnly', 'tabs', 'type']);
    expect(hs.tabs.map((r) => [r.name, r.kind])).toEqual([
      ['orch-alpha', 'orch'],
      ['orch-beta', 'orch'],
      ['orch-gamma', 'orch'],
      ['관리실', 'ops'],
    ]);
    expect(hs.orchestrators.map((o) => o.name)).toEqual(ROSTER.map((p) => p.name));
    expect(hs.orchestrators.every((o) => o.provider === 'engine' && o.state === 'off')).toBe(true);
    expect(new Set(hs.orchestrators.map((o) => o.agentId)).size).toBe(9);
    expect(store.size).toBe(9);
    // Characters were created once, under their final keys (no churn at startup).
    expect(Math.max(...store.keys())).toBe(9);
    expect(store.get(agentId('ops-desk'))!.directoryName).toBe('ops-desk');
    // A contractor desk in every work room, none in the 관리실.
    const uids = (office.layoutFor().furniture as Array<{ uid: string }>).map((f) => f.uid);
    expect(uids).toContain(contractorSeatUid('orch-alpha'));
    expect(uids).toContain(contractorSeatUid('orch-gamma'));
    expect(uids).not.toContain(contractorSeatUid('관리실'));
    expect(office.seatFor(agentId('ops-desk'))).toBe('seat:engine:ops-desk');
    expect(office.areaMappings()['ops-desk']).toEqual(['관리실']);
    expect(office.areaMappings()['codex·alpha']).toEqual(['orch-alpha']);
  });

  it('a new client gets the engine data: jobs, GPU board, Codex tasks, the state and the feed', async () => {
    const { office, messages } = await startEngineOffice({ projects: ROSTER });
    office.onClientOpened(vi.fn()); // the first viewer starts the (async) HW sampling
    await vi.waitFor(() => expect(messages.some((m) => m.type === 'hwSample')).toBe(true));
    const snap: Array<Record<string, unknown>> = [];
    office.onClientReady((m) => snap.push(m));
    expect(snap.map((m) => m.type)).toEqual(
      expect.arrayContaining([
        'buildingState',
        'characterPresets',
        'hostInfo',
        'officeSnapshot',
        'engineState',
        'codexTasks',
        'officeJobs',
        'gpuBoard',
        'hwSample',
      ]),
    );
    expect(snap.find((m) => m.type === 'officeJobs')).toEqual({ type: 'officeJobs', jobs: [] });
    expect(snap.find((m) => m.type === 'codexTasks')).toEqual({ type: 'codexTasks', tasks: [] });
    expect(snap.find((m) => m.type === 'gpuBoard')).toMatchObject({
      holders: [],
      queue: [],
      recent: [],
    });
    // Nothing a removed provider gave is sent; usage, without a source, is unknown.
    expect(snap.some((m) => m.type === 'statusOutput')).toBe(false);
    expect(snap.filter((m) => m.type === 'usageState').every((m) => !m.claude && !m.codex)).toBe(
      true,
    );
  });

  it('Codex tasks of the engine: a waiting task is a contractor at its project’s desk (T-0021)', async () => {
    const { home, office, last, store } = await startEngineOffice({ projects: ROSTER });
    const id = '1022-100000-alpha';
    saveCodex(codexDir(home), {
      id,
      project: 'alpha',
      model: null,
      state: 'limit',
      dir: '/work/alpha',
      worktree: null,
      branch: null,
      base: null,
      spec: '/specs/T-1.md',
      title: 'T-1',
      started: new Date().toISOString(),
      ended: null,
      exit: null,
      resetAt: null,
      sid: null,
      commits: null,
      jobId: 'j-none',
      log: '/nowhere.log',
      pid: null,
      source: 'cli',
    });
    await vi.waitFor(
      () =>
        expect(
          (last('codexTasks') as unknown as { tasks: unknown[] } | undefined)?.tasks,
        ).toHaveLength(1),
      { timeout: 5000 },
    );
    const [task] = (
      last('codexTasks') as unknown as {
        tasks: Array<{ id: string; provider: string; agentId: number | null; project: string }>;
      }
    ).tasks;
    expect(task).toMatchObject({ id, provider: 'engine', project: 'alpha' });
    expect(typeof task.agentId).toBe('number');
    expect(store.get(task.agentId!)!.directoryName).toBe('codex·alpha');
    expect(office.seatFor(task.agentId!)).toBe(contractorSeatUid('orch-alpha'));
  });

  it('the GPU board folds the engine’s gpu_* events and is sent on change (T-0046)', async () => {
    const { office, last } = await startEngineOffice({ projects: ROSTER });
    const events = (
      office as unknown as {
        engineEvents: { append(type: string, source: string, f: Record<string, unknown>): void };
      }
    ).engineEvents;
    events.append('gpu_queue', 'engine', {
      id: 'g-1',
      project: 'alpha',
      vram_gib: 2,
      label: 'train',
    });
    events.append('gpu_queue', 'engine', { id: 'g-2', project: 'beta' });
    expect(last('gpuBoard')).toMatchObject({
      holders: [],
      queue: [
        { id: 'g-1', project: 'alpha' },
        { id: 'g-2', project: 'beta' },
      ],
    });
    events.append('gpu_lease', 'engine', { id: 'g-1', project: 'alpha', vram_gib: 2 });
    expect(last('gpuBoard')).toMatchObject({
      holders: [{ id: 'g-1', label: 'train' }],
      queue: [{ id: 'g-2' }],
    });
    events.append('gpu_release', 'engine', { id: 'g-1', project: 'alpha', exit: 0 });
    expect(last('gpuBoard')).toMatchObject({
      holders: [],
      recent: [{ id: 'g-1', kind: 'release', exit: 0 }],
    });
    // The same events are in the feed and in a new client's snapshot.
    const snap: Array<Record<string, unknown>> = [];
    office.onClientReady((m) => snap.push(m));
    expect(snap.filter((m) => m.type === 'officeEvent').map((m) => m.kind)).toEqual([
      'gpu_queue',
      'gpu_queue',
      'gpu_lease',
      'gpu_release',
    ]);
  });

  it('stable agent ids across refreshes', async () => {
    const { office, last } = await startEngineOffice({ projects: ROSTER, claude: 'S-8' });
    const first = (last('officeSnapshot') as unknown as OfficeSnapshot).orchestrators.map(
      (o) => o.agentId,
    );
    await office.refreshClaude();
    expect(office.officeState().orchestrators.map((o) => o.agentId)).toEqual(first);
  });

  /** An office running the engine with its fake `claude` in a test HOME. */
  async function engineOffice(agentChoices?: AgentChoicesReader, chat = false) {
    const { home, store, office, messages } = await startEngineOffice({
      readOnly: false,
      chat,
      extra: { agentChoices },
    });
    return { home, store, office, messages };
  }

  it('engineState carries what the injected reader found, never a probe of the real CLIs', async () => {
    const found = { claude: { models: ['m1'], efforts: ['low'] } };
    let current: Record<string, unknown> = {};
    const discover = vi.fn((refresh?: boolean) => {
      if (refresh) current = found;
      return current;
    });
    const { office, messages } = await engineOffice({ discover });
    const state = () => [...messages].reverse().find((m) => m.type === 'engineState');
    expect(state()?.agentChoices).toBeUndefined();
    const answers: Array<Record<string, unknown>> = [];
    office.onClientMessage({ type: 'engineChoicesRefresh' }, (m) => answers.push(m), true);
    expect(answers[0]?.agentChoices).toEqual(found);
  });

  it('engineChoicesRefresh re-reads the installed CLIs only for a privileged client', async () => {
    const { office } = await engineOffice();
    const answers: Array<Record<string, unknown>> = [];
    const send = (m: Record<string, unknown>) => answers.push(m);
    office.onClientMessage({ type: 'engineChoicesRefresh' }, send, false);
    expect(answers).toEqual([]);
    office.onClientMessage({ type: 'engineChoicesRefresh' }, send, true);
    expect(answers).toHaveLength(1);
    expect(answers[0]).toMatchObject({ type: 'engineState' });
  });

  it('only lets a privileged chatHold reach the engine messenger; a closed page never releases it (MSG-HOLD2)', async () => {
    const { office } = await startEngineOffice({ projects: ROSTER, readOnly: false, chat: true });
    const messenger = (office as unknown as { messenger: { hold: (...args: unknown[]) => boolean } }).messenger;
    const hold = vi.spyOn(messenger, 'hold');
    const send = () => undefined;
    const msg = { type: 'chatHold', name: 'alpha', id: 'waiting.json', on: true };

    office.onClientMessage(msg, send, false);
    expect(hold).not.toHaveBeenCalled();
    office.onClientMessage(msg, send, true);
    expect(hold).toHaveBeenCalledWith('alpha', 'waiting.json', true);
    office.onClientClosed(send);
    expect(hold).toHaveBeenCalledTimes(1);
  });

  it('group rooms (T-0088): writes need a privileged client, and posts need the chat feature', async () => {
    const off = await engineOffice(); // chat off
    const answers: Array<Record<string, unknown>> = [];
    const send = (m: Record<string, unknown>) => answers.push(m);
    const room = (a: Record<string, unknown>, privileged: boolean) => {
      answers.length = 0;
      off.office.onClientMessage({ type: 'groupAction', requestId: 'g', ...a }, send, privileged);
      return answers.at(-1);
    };
    expect(room({ action: 'create', name: '출시팀', members: [] }, false)).toMatchObject({
      ok: false,
      error: expect.stringContaining('권한'),
    });
    expect(off.office.groupStore!.list().map((r) => r.name)).toEqual(['전체']);
    expect(room({ action: 'create', name: '출시팀', members: [] }, true)).toMatchObject({
      ok: true,
    });
    expect(room({ action: 'delete', id: 'all' }, true)).toMatchObject({ ok: false });
    const post = (privileged: boolean, o = off.office) => {
      answers.length = 0;
      o.onClientMessage(
        { type: 'groupPost', requestId: 'p', room: 'all', text: '@전체 hi' },
        send,
        privileged,
      );
      return answers.at(-1);
    };
    expect(post(false)).toMatchObject({ ok: false });
    expect(post(true)).toMatchObject({ ok: false, error: '대화 기능이 꺼져 있어요' });
    const on = await engineOffice(undefined, true);
    expect(post(false, on.office)).toMatchObject({
      ok: false,
      error: expect.stringContaining('권한'),
    });
  });

  it('an engine project has its repository panel (T-0020)', async () => {
    if (!GIT_AVAILABLE) return;
    const repo = makeTempRepo({ commit: true });
    cleanup.push(() => repo.cleanup());
    const { office } = await engineOffice();
    const answers: Array<Record<string, unknown>> = [];
    const send = (m: Record<string, unknown>) => answers.push(m);
    office.onClientMessage({ type: 'repoView', project: 'alpha', on: true }, send, true);
    await vi.waitFor(() => expect(answers.find((m) => m.type === 'repoState')).toBeDefined());
    expect(answers.find((m) => m.type === 'repoState')).toMatchObject({ ok: false }); // not yet
    office.onClientMessage({ type: 'repoView', project: 'alpha', on: false }, send, true);
    answers.length = 0;
    office.onClientMessage(
      { type: 'engineAction', requestId: 'r1', action: 'add', name: 'alpha', folder: repo.folder },
      send,
      true,
    );
    await vi.waitFor(() =>
      expect(answers[0]).toMatchObject({ type: 'engineActionResult', ok: true }),
    );
    office.onClientMessage({ type: 'repoView', project: 'alpha', on: true }, send, true);
    await vi.waitFor(
      () =>
        expect(answers.find((m) => m.type === 'repoState')).toMatchObject({
          project: 'alpha',
          ok: true,
        }),
      { timeout: 8000 },
    );
    office.onClientClosed(send);
  });

  it('reports an engine project locally and stops its status view', async () => {
    if (!GIT_AVAILABLE) return;
    const repo = makeTempRepo({ commit: true });
    cleanup.push(() => repo.cleanup());
    const { office } = await engineOffice();
    const add = await office.engine!.run(
      { type: 'engineAction', requestId: 'add', action: 'add', name: 'alpha', folder: repo.folder },
      true,
      'test',
    );
    expect(add.ok).toBe(true);
    const viewer = vi.fn();
    office.onClientMessage({ type: 'statusView', name: 'alpha', on: true }, viewer);
    await vi.waitFor(() => expect(viewer).toHaveBeenCalled());
    expect(viewer.mock.calls[0][0]).toMatchObject({
      type: 'statusOutput',
      name: 'alpha',
      cmd: null,
      isDefault: true,
      output: '돌고 있는 작업 없음',
      git: { branch: 'main' },
    });
    const unknown = vi.fn();
    office.onClientMessage({ type: 'statusView', name: 'unknown', on: true }, unknown);
    expect(unknown).not.toHaveBeenCalled();
    const clear = vi.spyOn(global, 'clearInterval');
    office.onClientMessage({ type: 'statusView', name: 'alpha', on: false }, viewer);
    expect(clear).toHaveBeenCalledTimes(1);
  });

  it('the built-in engine: projects are rooms and characters, engineAction answers the sender', async () => {
    const { home, store, office, messages } = await engineOffice();
    const last = (type: string) => [...messages].reverse().find((m) => m.type === type);
    expect(last('engineState')).toEqual({ type: 'engineState', projects: [] });

    const answers: Array<Record<string, unknown>> = [];
    const send = (m: Record<string, unknown>) => answers.push(m);
    const ask = async (msg: Record<string, unknown>) => {
      const n = answers.length;
      office.onClientMessage(
        { type: 'engineAction', requestId: `r${n}`, ...msg },
        send,
        true,
        'iPhone',
      );
      await vi.waitFor(() => expect(answers.length).toBe(n + 1), { timeout: 8000 });
      return answers[n];
    };
    for (const name of ['alpha', 'beta']) {
      fs.mkdirSync(path.join(home, 'w', name), { recursive: true });
      expect(await ask({ action: 'add', name, folder: path.join(home, 'w', name) })).toMatchObject({
        type: 'engineActionResult',
        ok: true,
      });
    }
    const started = await ask({ action: 'start', name: 'alpha' });
    expect(started).toMatchObject({ ok: true, bgId: expect.stringMatching(/^[0-9a-f]{8}$/) });
    await office.refreshClaude(); // the Claude provider's row folds into the project
    const hs = last('officeSnapshot') as unknown as OfficeSnapshot;
    expect(hs.tabs.map((t) => t.name)).toEqual(['alpha', 'beta']);
    expect(hs.orchestrators.map((o) => [o.name, o.state, o.bg?.id ?? null])).toEqual([
      ['alpha', 'running', started.bgId],
      ['beta', 'off', null],
    ]);
    expect(hs.orchestrators.every((o) => typeof o.agentId === 'number')).toBe(true);
    expect(store.size).toBe(2);
    expect(last('engineState')).toMatchObject({
      projects: [
        { name: 'alpha', live: true, wantRunning: true, bgId: started.bgId },
        { name: 'beta', live: false },
      ],
    });
    const snap: Array<Record<string, unknown>> = [];
    office.onClientReady((m) => snap.push(m));
    expect(snap.map((m) => m.type)).toContain('engineState');
    expect(office.layoutFor()).toMatchObject({
      areas: [{ label: 'alpha' }, { label: 'beta' }, { label: '라운지' }, { label: '로비' }],
    });
    // An unprivileged client is refused; nothing runs.
    const n = answers.length;
    office.onClientMessage(
      { type: 'engineAction', requestId: 'ro', action: 'stop', name: 'alpha' },
      send,
      false,
    );
    await vi.waitFor(() => expect(answers.length).toBe(n + 1));
    expect(answers[n]).toMatchObject({
      requestId: 'ro',
      ok: false,
      error: '이 접속에는 조작 권한이 없어요',
    });
    expect(await ask({ action: 'stop', name: 'alpha' })).toMatchObject({ ok: true });
  });

  it('S7 through the office socket: a Lead’s token is the Lead, a Worker’s is that Worker, never its Lead', async () => {
    const { home, office } = await engineOffice();
    const work = path.join(home, 'w', 'alpha');
    fs.mkdirSync(work, { recursive: true });
    const engine = office.engine!;
    const act = (fields: Record<string, unknown>) =>
      engine.run({ type: 'engineAction', requestId: 'a', ...fields } as never, true, 'test');
    expect((await act({ action: 'add', name: 'alpha', folder: work })).ok).toBe(true);
    expect(
      (await act({ action: 'add', name: 'alpha-a', role: 'worker', project: 'alpha' })).ok,
    ).toBe(true);
    // The tokens a start hands each session (engine.ts startProject: tokens.issue(name)).
    const lead = engine.tokens.issue('alpha');
    const worker = engine.tokens.issue('alpha-a');
    // `cld-gui send` from the shared folder, where cwd alone says the project (= its Lead).
    const send = (to: string, token?: string) =>
      new Promise<number | null>((resolve) => {
        const child = spawn(
          process.execPath,
          [path.join(REPO_ROOT, 'cld/bin/cld-gui'), 'send', to, 'hi'],
          {
            cwd: work,
            env: { PATH: process.env.PATH, HOME: home, ...(token && { CLD_AGENT_TOKEN: token }) },
          },
        );
        child.on('close', resolve);
      });
    const senders = (to: string) => {
      const dir = path.join(home, '.config/cld-gui/inbox', to);
      return fs
        .readdirSync(dir)
        .filter((f) => f.endsWith('.md'))
        .sort()
        .map((f) => /· (\S+)에게서 ·/.exec(fs.readFileSync(path.join(dir, f), 'utf-8'))?.[1]);
    };
    expect(await send('alpha', worker)).toBe(0);
    expect(await send('alpha-a', lead)).toBe(0);
    expect(await send('alpha-a')).toBe(0); // no token: the folder's project
    expect(senders('alpha')).toEqual(['alpha-a']);
    expect(senders('alpha-a')).toEqual(['alpha', 'alpha']);
  });

  it('D6 through the office socket: --assignee resolves the Lead and a Worker by assignment id, job --task becomes an observed Execution, a removed Worker shows as removed', async () => {
    const { home, office, messages } = await engineOffice();
    const work = path.join(home, 'w', 'alpha');
    fs.mkdirSync(work, { recursive: true });
    const engine = office.engine!;
    const act = (fields: Record<string, unknown>) =>
      engine.run({ type: 'engineAction', requestId: 'a', ...fields } as never, true, 'test');
    expect((await act({ action: 'add', name: 'alpha', folder: work })).ok).toBe(true);
    expect(
      (await act({ action: 'add', name: 'alpha-a', role: 'worker', project: 'alpha' })).ok,
    ).toBe(true);
    const disk = (f: string) =>
      JSON.parse(fs.readFileSync(path.join(home, '.config/cld-gui', f), 'utf-8'));
    const leadId = disk('projects.json').projects[0].leadAssignmentId as string;
    const workerId = (disk('assignments.json').assignments as Array<Record<string, string>>).find(
      (a) => a.name === 'alpha-a',
    )!.assignmentId;
    const run = (args: string[]) =>
      new Promise<{ status: number | null; out: string; err: string }>((resolve) => {
        const child = spawn(process.execPath, [path.join(REPO_ROOT, 'cld/bin/cld-gui'), ...args], {
          cwd: work,
          env: { PATH: process.env.PATH, HOME: home },
        });
        let out = '';
        let err = '';
        child.stdout.on('data', (b: Buffer) => (out += b.toString()));
        child.stderr.on('data', (b: Buffer) => (err += b.toString()));
        child.on('close', (status) => resolve({ status, out, err }));
      });
    expect((await run(['task', 'add', '리드 일', '--assignee', 'alpha'])).status).toBe(0);
    expect(
      (await run(['task', 'add', '워커 일', '--assignee', 'alpha-a', '--parent', 'T-1'])).status,
    ).toBe(0);
    const bad = await run(['task', 'add', '없는 이', '--assignee', 'nobody']);
    expect(bad.status).toBe(1);
    expect(bad.err).toMatch(/'nobody' 에이전트가 없습니다/);
    expect(office.tasks.get('T-1')!.assignee).toEqual({ assignmentId: leadId, name: 'alpha' });
    expect(office.tasks.get('T-2')).toMatchObject({
      assignee: { assignmentId: workerId, name: 'alpha-a' },
      parentId: 'T-1',
      project: 'alpha',
    });
    const job = await run(['job', '--task', 'T-2', 'exit', '4']);
    expect(job.status).toBe(0);
    expect(job.out).toContain('작업 T-2 의 실행으로 붙임');
    expect((await run(['job', '--task', 'T-9', 'true'])).status).toBe(1);
    await vi.waitFor(
      () =>
        expect(office.tasks.get('T-2')!.executions![0]).toMatchObject({
          kind: 'job',
          exit: { value: 4, source: 'observed' },
        }),
      { timeout: 10_000 },
    );
    expect(office.tasks.get('T-2')!.status).toBe('todo');
    const show = await run(['task', 'show', 'T-2']);
    expect(show.out).toMatch(/exit 4 \(관측, /);
    expect(show.out).toContain('  상태: todo (보고)');
    // The Worker goes: its task stays, its assignee is shown as removed.
    expect((await act({ action: 'remove', name: 'alpha-a' })).ok).toBe(true);
    const board = () =>
      [...messages].reverse().find((m) => m.type === 'taskBoard') as
        { removedAssignees?: string[] } | undefined;
    await vi.waitFor(() => expect(board()?.removedAssignees).toEqual([workerId]));
    expect(office.tasks.get('T-2')).toBeTruthy();
    expect((await run(['task', 'show', 'T-2'])).out).toContain(
      `배정: (삭제됨) alpha-a (${workerId})`,
    );
  });

  it('T-0019: cld-gui job through the socket shows in the job panel; log and stop with the gates', async () => {
    const { home, office, messages } = await engineOffice();
    const last = (type: string) => [...messages].reverse().find((m) => m.type === type);
    expect(last('officeJobs')).toEqual({ type: 'officeJobs', jobs: [] }); // the panel exists with the engine
    const work = path.join(home, 'w', 'alpha');
    fs.mkdirSync(work, { recursive: true });
    const add = await office.engine!.run(
      { type: 'engineAction', requestId: 'a', action: 'add', name: 'alpha', folder: work },
      true,
      'test',
    );
    expect(add.ok).toBe(true);
    // The CLI as an orchestrator runs it (async: the daemon answers from this process).
    const run = (args: string[]) =>
      new Promise<{ status: number | null; out: Record<string, unknown> }>((resolve) => {
        const child = spawn(process.execPath, [path.join(REPO_ROOT, 'cld/bin/cld-gui'), ...args], {
          cwd: work,
          env: { PATH: process.env.PATH, HOME: home, CLD_OUTPUT: 'json' },
        });
        let out = '';
        child.stdout.on('data', (b: Buffer) => (out += b.toString()));
        child.on('close', (status) =>
          resolve({ status, out: JSON.parse(out) as Record<string, unknown> }),
        );
      });
    const job = await run(['job', 'echo', 'tick;', 'sleep', '60']);
    expect(job.status).toBe(0);
    expect(job.out).toMatchObject({ ok: true, id: expect.stringMatching(/-alpha$/) });
    const id = job.out.id as string;
    await vi.waitFor(() =>
      expect((last('officeJobs') as { jobs: Array<Record<string, unknown>> }).jobs).toEqual([
        expect.objectContaining({ id, project: 'alpha', cmd: 'echo tick; sleep 60', ended: null }),
      ]),
    );
    const answers: Array<Record<string, unknown>> = [];
    const send = (m: Record<string, unknown>) => answers.push(m);
    office.onClientMessage({ type: 'jobAction', requestId: 'l1', action: 'log', id }, send, false);
    expect(answers.at(-1)).toMatchObject({
      requestId: 'l1',
      ok: false,
      error: '이 접속에는 조작 권한이 없어요',
    });
    await vi.waitFor(() => {
      office.onClientMessage({ type: 'jobAction', requestId: 'l2', action: 'log', id }, send, true);
      expect(answers.at(-1)).toMatchObject({ requestId: 'l2', ok: true, log: 'tick\n' });
    });
    office.onClientMessage(
      { type: 'jobAction', requestId: 's1', action: 'stop', id },
      send,
      true,
      'iPhone',
    );
    expect(answers.at(-1)).toMatchObject({
      type: 'jobActionResult',
      requestId: 's1',
      action: 'stop',
      id,
      ok: true,
    });
    await vi.waitFor(
      () =>
        expect(
          (last('officeJobs') as { jobs: Array<Record<string, unknown>> }).jobs[0].ended,
        ).toBeTruthy(),
      { timeout: 5000 },
    );
    // The engine's events reach the feed (and a new client's snapshot).
    const kinds = messages.filter((m) => m.type === 'officeEvent').map((m) => m.kind);
    expect(kinds).toEqual(expect.arrayContaining(['job_start', 'stop', 'job_end']));
    const snap: Array<Record<string, unknown>> = [];
    office.onClientReady((m) => snap.push(m));
    expect(snap.filter((m) => m.type === 'officeEvent').map((m) => m.kind)).toEqual([
      'job_start',
      'stop',
      'job_end',
    ]);
    expect(fs.readFileSync(path.join(home, '.config/cld-gui/events.jsonl'), 'utf-8')).toContain(
      '"source":"gui:ios"',
    );
    // `cld-gui jobs` sees it ended; a send to an engine project that is off goes to its inbox.
    const jobs = await run(['jobs']);
    expect((jobs.out.jobs as Array<Record<string, unknown>>)[0]).toMatchObject({ id, exit: null });
    const sent = await run(['send', 'alpha', 'hello']);
    // C2: the JSON names the message's id (its inbox file's header carries the same mark).
    expect(sent.out).toEqual({
      v: 1,
      ok: true,
      delivered: 'inbox',
      reason: 'off',
      messageId: expect.stringMatching(/^[a-z2-7]{8}$/),
    });
    const inbox = path.join(home, '.config/cld-gui/inbox/alpha');
    const [md] = fs.readdirSync(inbox).filter((f) => f.endsWith('.md'));
    expect(fs.readFileSync(path.join(inbox, md), 'utf-8').split('\n')[0]).toMatch(
      new RegExp(` ⟨m:${String(sent.out.messageId)}⟩$`),
    );
  });

  it('installs the upstream hooks and removes them on dispose', async () => {
    const { office } = await startOffice({ claude: 'C-4' });
    expect(typeof cldHooks.onClientReady).toBe('function');
    expect(typeof cldHooks.onClientOpened).toBe('function');
    expect(cldHooks.logLevel).toBe('warn');
    office.dispose();
    expect(cldHooks.onClientReady).toBeUndefined();
  });
});

/** S-8 answers from a stub instead of a process, fake timers instead of waiting:
 *  every `claude` call and HW sample is counted. */
async function startCounted(opts: { attaching?: () => boolean; pushFile?: string } = {}) {
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
  });
  const fake = makeFakeHome({});
  const list = vi.fn(async (_spawn: boolean) =>
    parseAgents(
      JSON.parse(
        fs
          .readFileSync(path.join(FAKE_CLAUDE, 'S-8/agents.json'), 'utf-8')
          .replaceAll('@HOME@', fake.home),
      ),
    ),
  );
  const sample = vi.fn(() => ({
    ts: new Date().toISOString(),
    stale: false,
    cpuUtil: null,
    ramUsedGib: 1,
    ramTotalGib: 2,
    disks: [],
    warnings: [],
    // The boards' per-core and memory detail: `cld-gui hw` must not print it.
    cpuCores: [{ name: 'x' }],
    ramDetail: { usedGib: 1, availableGib: 1 },
    sources: { ramUsedGib: 'os', cpuCores: 'os', ramDetail: 'os' },
  }));
  const store = new AgentStateStore();
  const runtime = new AgentRuntime(store, claudeProvider);
  const office = new Office({
    runtime,
    store,
    readOnly: false,
    claude: { list },
    hw: { sample } as unknown as HwSource,
    home: fake.home,
    attaching: opts.attaching,
    pushFile: opts.pushFile,
  });
  cleanup.push(() => {
    office.dispose();
    runtime.dispose();
    vi.useRealTimers();
    fs.rmSync(fake.home, { recursive: true, force: true });
  });
  await office.start();
  const count = () => ({ claude: list.mock.calls.length, hw: sample.mock.calls.length });
  const spawnFlags = () => list.mock.calls.map((c) => c[0]);
  return { office, count, fake, spawnFlags };
}

const MIN = 60_000;

describe('TOKEN-GUARD (S-01): one engine per HOME', () => {
  it('a second daemon on the same HOME does not start a second engine; once the first is gone it does', async () => {
    const first = await startEngineOffice({ projects: ROSTER, readOnly: false });
    // Two engines would type every queued message twice and run two revive loops.
    await expect(startEngineOffice({ home: first.home, readOnly: false })).rejects.toThrow(
      /another cld-gui daemon/,
    );
    first.stop();
    const again = await startEngineOffice({ home: first.home, readOnly: false });
    expect(again.office).toBeTruthy();
  });

  it('read-only (the CLI and installer default) runs the engine too, so it is refused the same way', async () => {
    const first = await startEngineOffice({ projects: ROSTER });
    await expect(startEngineOffice({ home: first.home })).rejects.toThrow(/another cld-gui daemon/);
  });
});

describe('cld-gui hw (T-0062)', () => {
  it('nobody viewing: one sample on demand, no timer of its own; a fresh viewer sample is reused', async () => {
    const { office, count } = await startCounted();
    const hw = () =>
      (
        office as unknown as {
          hwForCli(): Promise<{
            ok: boolean;
            hw?: { ramTotalGib: number; sources?: Record<string, string> };
          }>;
        }
      ).hwForCli();
    const first = await hw();
    expect(first).toMatchObject({ ok: true, hw: { ramTotalGib: 2 } });
    // The new detail fields stay out of the CLI's sample, and so do their sources.
    expect(first.hw).not.toHaveProperty('cpuCores');
    expect(first.hw).not.toHaveProperty('ramDetail');
    expect(first.hw?.sources).toEqual({ ramUsedGib: 'os' });
    expect(count().hw).toBe(1);
    await vi.advanceTimersByTimeAsync(10 * MIN);
    expect(count().hw).toBe(1); // nothing keeps sampling
    office.onClientOpened(vi.fn());
    await vi.advanceTimersByTimeAsync(0);
    const viewing = count().hw; // the viewer's first tick
    const reused = await hw();
    expect(count().hw).toBe(viewing); // that tick is fresh: no extra sample
    expect(reused.hw).not.toHaveProperty('cpuCores'); // the viewer's sample has it; the CLI's does not
    expect(reused.hw).not.toHaveProperty('ramDetail');
  });
});

describe('footprint: work only while someone views (T-0013)', () => {
  it('0 -> 1 -> 0 viewers turns the claude poll and HW on and off', async () => {
    const { office, count } = await startCounted();
    // Startup: one load, no HW.
    expect(count()).toEqual({ claude: 1, hw: 0 });
    await vi.advanceTimersByTimeAsync(10 * MIN);
    expect(count()).toEqual({ claude: 1, hw: 0 }); // nobody viewing: nothing at all

    const viewer = vi.fn();
    office.onClientOpened(viewer);
    await vi.advanceTimersByTimeAsync(29_000);
    expect(count()).toMatchObject({ claude: 2, hw: 1 + 14 }); // the wake load + HW every 2 s
    await vi.advanceTimersByTimeAsync(2_000);
    expect(count().claude).toBe(3); // the 30 s safety poll
    await vi.advanceTimersByTimeAsync(10 * MIN);
    expect(count().claude).toBe(3 + 20);

    office.onClientClosed(viewer);
    const left = count();
    await vi.advanceTimersByTimeAsync(10 * MIN);
    expect(count()).toEqual(left);
  });

  it('a burst of sessions/ changes gives one re-read, 1 s after the first; none without a viewer', async () => {
    const { office, count } = await startCounted();
    const viewer = vi.fn();
    office.onClientOpened(viewer);
    await vi.advanceTimersByTimeAsync(0);
    const c0 = count().claude;
    for (let i = 0; i < 10; i++) {
      office.sessionsChanged();
      await vi.advanceTimersByTimeAsync(90);
    }
    expect(count().claude).toBe(c0);
    await vi.advanceTimersByTimeAsync(100); // 1 s after the first change
    expect(count().claude).toBe(c0 + 1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(count().claude).toBe(c0 + 1);

    office.onClientClosed(viewer);
    office.sessionsChanged();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(count().claude).toBe(c0 + 1);
  });

  it('the first viewer reloads at once; only a viewer lets claude be spawned', async () => {
    const { office, count, spawnFlags } = await startCounted();
    expect(spawnFlags()).toEqual([false]); // startup reads the files only
    await vi.advanceTimersByTimeAsync(10 * MIN);
    const idle = count();
    office.onClientOpened(vi.fn());
    await vi.advanceTimersByTimeAsync(0); // no timer involved
    expect(count()).toEqual({ claude: idle.claude + 1, hw: idle.hw + 1 });
    expect(spawnFlags()).toEqual([false, true]);
  });

  it('a hidden page is no viewer: 0 -> 1 -> hidden -> visible (T-0025)', async () => {
    const { office, count } = await startCounted();
    const viewer = vi.fn();
    office.onClientOpened(viewer);
    await vi.advanceTimersByTimeAsync(0);
    const awake = count();

    office.onClientMessage({ type: 'viewerVisibility', visible: false }, viewer);
    expect(viewer).toHaveBeenLastCalledWith({ type: 'viewerVisibilityAck', visible: false });
    office.sessionsChanged();
    await vi.advanceTimersByTimeAsync(10 * MIN);
    expect(count()).toEqual(awake); // asleep: no claude, no timers, no HW

    office.onClientMessage({ type: 'viewerVisibility', visible: true }, viewer);
    expect(viewer).toHaveBeenLastCalledWith({ type: 'viewerVisibilityAck', visible: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(count()).toMatchObject({ claude: awake.claude + 1, hw: awake.hw + 1 }); // one wake load
    await vi.advanceTimersByTimeAsync(30_000);
    expect(count().claude).toBe(awake.claude + 2); // the safety poll is back

    // A hidden second viewer keeps nothing awake once the visible one leaves.
    const other = vi.fn();
    office.onClientOpened(other);
    office.onClientMessage({ type: 'viewerVisibility', visible: false }, other);
    office.onClientClosed(viewer);
    const left = count();
    await vi.advanceTimersByTimeAsync(10 * MIN);
    expect(count()).toEqual(left);
    office.onClientMessage({ type: 'viewerVisibility', visible: true }, other);
    await vi.advanceTimersByTimeAsync(0);
    expect(count().claude).toBe(left.claude + 1); // it wakes the office when it shows
  });

  it('U-49: a page counts as looking from its last "showing" report (the heartbeat), not from its socket', async () => {
    const pushFile = path.join(os.tmpdir(), `cld-u49-${process.pid}.json`);
    cleanup.push(() => fs.rmSync(pushFile, { force: true }));
    const { office } = await startCounted({ pushFile });
    const lookedAt = (
      office as unknown as { push: { opts: { lookedAt(send: unknown): number | null } } }
    ).push.opts.lookedAt;
    const viewer = vi.fn();
    const t0 = Date.now();
    office.onClientOpened(viewer);
    expect(lookedAt(viewer)).toBe(t0);
    await vi.advanceTimersByTimeAsync(20_000);
    office.onClientMessage({ type: 'viewerVisibility', visible: true }, viewer); // the heartbeat
    expect(lookedAt(viewer)).toBe(t0 + 20_000);
    await vi.advanceTimersByTimeAsync(40_000); // a suspended page: silent, socket still open
    expect(lookedAt(viewer)).toBe(t0 + 20_000); // 40 s old: PushService no longer counts it
    office.onClientMessage({ type: 'viewerVisibility', visible: false }, viewer);
    expect(lookedAt(viewer)).toBeNull();
    office.onClientMessage({ type: 'viewerVisibility', visible: true }, viewer);
    expect(lookedAt(viewer)).toBe(t0 + 60_000);
    office.onClientClosed(viewer);
    expect(lookedAt(viewer)).toBeNull();
  });

  it('a running claude attach keeps the claude agents --json fallback off', async () => {
    let attach = true;
    const { office, spawnFlags } = await startCounted({ attaching: () => attach });
    office.onClientOpened(vi.fn());
    await vi.advanceTimersByTimeAsync(0);
    attach = false;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(spawnFlags()).toEqual([false, false, true]);
  });
});

describe('the ~/.claude/sessions/ watcher', () => {
  it('reports changes only while someone views', async () => {
    const { office, fake } = await startOffice({ claude: 'C-4' });
    const dir = path.join(fake.home, '.claude/sessions');
    fs.mkdirSync(dir, { recursive: true });
    const changed = vi.spyOn(office, 'sessionsChanged');
    const viewer = vi.fn();
    office.onClientOpened(viewer);
    fs.writeFileSync(path.join(dir, '1101.json'), '{"status":"busy"}');
    await vi.waitFor(() => expect(changed).toHaveBeenCalled());

    office.onClientClosed(viewer);
    changed.mockClear();
    fs.writeFileSync(path.join(dir, '1101.json'), '{"status":"idle"}');
    await new Promise((r) => setTimeout(r, 300));
    expect(changed).not.toHaveBeenCalled();
  });
});

// ADR-0014 / NFR-CMP-009: no policy unless the user brought it.
describe('office without the engine (plain Claude Code)', () => {
  it('HW is the built-in sampler and nothing only the engine can give is sent', async () => {
    const { office, last } = await startOffice({ claude: 'S-8' });
    office.onClientOpened(vi.fn()); // HW is sampled while someone views (T-0013)
    await vi.waitFor(() => expect(last('hwSample')).toBeDefined());
    const hw = last('hwSample') as unknown as Record<string, unknown>;
    expect(hw.stale).toBe(false);
    expect(typeof hw.ramTotalGib).toBe('number');
    const hs = last('officeSnapshot') as unknown as OfficeSnapshot;
    expect(hs.orchestrators.every((o) => o.provider === 'claude')).toBe(true);
    const snap: Array<Record<string, unknown>> = [];
    office.onClientReady((m) => snap.push(m));
    const types = new Set(snap.map((m) => m.type));
    expect(types.has('officeSnapshot') && types.has('hwSample')).toBe(true);
    // ENV-2: usage is not engine-only; without a source it is unknown (null), never invented.
    expect(snap.find((m) => m.type === 'usageState')).toMatchObject({ claude: null, codex: null });
    for (const engineOnly of [
      'codexTasks',
      'officeJobs',
      'gpuBoard',
      'officeEvent',
      'engineState',
      'ezRules',
    ]) {
      expect(types.has(engineOnly), engineOnly).toBe(false);
    }
  });

  it("sends the user's valid ez-rules.json rules to a client, and nothing without them", async () => {
    const rules = JSON.stringify({
      commands: [{ program: 'make', emoji: '🚀', text: '배포하는 중' }, { program: 'x' }],
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const withFile = await startOffice({ claude: 'C-4', ezRules: rules });
    const snap: Array<Record<string, unknown>> = [];
    withFile.office.onClientReady((m) => snap.push(m));
    withFile.office.onClientReady((m) => snap.push(m));
    expect(snap.filter((m) => m.type === 'ezRules')).toEqual([
      {
        type: 'ezRules',
        tools: [],
        commands: [{ program: ['make'], emoji: '🚀', text: '배포하는 중' }],
      },
      {
        type: 'ezRules',
        tools: [],
        commands: [{ program: ['make'], emoji: '🚀', text: '배포하는 중' }],
      },
    ]);
    expect(warn.mock.calls.filter((c) => String(c[0]).includes('ez-rules.json'))).toHaveLength(1);

    const without = await startOffice({ claude: 'C-4' });
    const none: Array<Record<string, unknown>> = [];
    without.office.onClientReady((m) => none.push(m));
    expect(none.some((m) => m.type === 'ezRules')).toBe(false);
    warn.mockRestore();
  });
});
