/**
 * R3: the start policy in 설정. A fake manager and fake facts; nothing here runs agty, schtasks,
 * powershell, wsl, systemctl or loginctl.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import Fastify from 'fastify';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  realStartPolicyDeps,
  registerStartPolicyRoutes,
  StartPolicyControl,
  type StartPolicyDeps,
} from './startPolicy.js';

const ROOT = '/fake/agent-tycoon';
let calls: string[][];
let record: Record<string, unknown> | null;
let managerAnswer: { ok: boolean; error: string };
beforeEach(() => {
  calls = [];
  record = {
    startPolicy: 'on-demand',
    service: { name: 'agent-tycoon', kind: 'systemd' },
    wslDistro: 'Ubuntu',
  };
  managerAnswer = { ok: true, error: '' };
});

const control = (o: Partial<StartPolicyDeps> = {}) =>
  new StartPolicyControl({
    platform: 'wsl',
    install: { root: ROOT, managerPath: '/v/cld/install/manager.mjs', version: '1.2.3' },
    user: 'owner',
    readRecord: () => record,
    taskPresent: async () => true,
    lingerOn: () => false,
    systemd: () => true,
    manager: async (args) => {
      calls.push(args);
      return managerAnswer;
    },
    ...o,
  });

type Kind = { host: boolean; remote: boolean };
async function app(
  opts: { readOnly?: boolean; kind?: Kind; fresh?: boolean; deps?: Partial<StartPolicyDeps> } = {},
) {
  const server = Fastify();
  registerStartPolicyRoutes(
    server,
    async () => undefined,
    control(opts.deps),
    !!opts.readOnly,
    () => !!opts.fresh,
    () => opts.kind ?? { host: false, remote: false },
  );
  const post = (payload: object) =>
    server.inject({
      method: 'POST',
      url: '/api/cld/start-policy',
      headers: { origin: 'http://localhost:80', host: 'localhost:80' },
      payload,
    });
  const get = async () => (await server.inject({ url: '/api/cld/start-policy' })).json();
  return { post, get };
}

describe('reading the state', () => {
  it('shows the policy, the logon task, linger, WSL and the daemon separately', async () => {
    record = { ...record, startPolicy: 'always', logonTask: { name: 'agent-tycoon-wsl-Ubuntu' } };
    const v = await (await app()).get();
    expect(v).toMatchObject({
      platform: 'wsl',
      blocked: null,
      policy: 'always',
      service: { name: 'agent-tycoon', kind: 'systemd' },
      logonTask: { name: 'agent-tycoon-wsl-Ubuntu', present: true },
      linger: { user: 'owner', on: false, ours: false },
      wsl: { distro: 'Ubuntu', systemd: true },
      daemon: { pid: process.pid, version: '1.2.3' },
      canChange: true,
    });
  });

  it('a missing logon task and a record without a policy read as such', async () => {
    record = { ...record, startPolicy: undefined };
    const v = await (await app({ deps: { lingerOn: () => true } })).get();
    expect(v.policy).toBe('on-demand');
    expect(v.logonTask).toEqual({ name: null, present: false });
    expect(v.linger).toEqual({ user: 'owner', on: true, ours: false }); // already on, not ours
  });

  it('a source install has no policy and says why', async () => {
    const v = await (await app({ deps: { install: null } })).get();
    expect(v.policy).toBeNull();
    expect(v.blocked.errorCode).toBe('start_policy_not_managed');
    expect(v.canChange).toBe(false);
  });
});

describe('changing it', () => {
  it('from this PC: the manager gets exactly start-policy <p> --root, nothing that stops anything', async () => {
    const { post } = await app();
    const r = await post({ policy: 'manual' });
    expect(r.statusCode).toBe(200);
    expect(r.json().ok).toBe(true);
    expect(calls).toEqual([['/v/cld/install/manager.mjs', 'start-policy', 'manual', '--root', ROOT]]);
  });

  it('always carries the linger answer explicitly (the manager never prompts here)', async () => {
    const { post } = await app();
    await post({ policy: 'always', linger: true });
    await post({ policy: 'always' });
    expect(calls.map((c) => c[3])).toEqual(['--linger', '--no-linger']);
    expect(calls.flat()).not.toContain('stop');
    expect(calls.flat()).not.toContain('--now');
  });

  it('a remote device without a fresh step-up is refused; with one it passes', async () => {
    const stale = await (await app({ kind: { host: false, remote: true }, fresh: false })).post({
      policy: 'always',
    });
    expect([stale.statusCode, stale.json()]).toEqual([403, { error: 'stepup' }]);
    expect(calls).toHaveLength(0);
    const fresh = await (await app({ kind: { host: false, remote: true }, fresh: true })).post({
      policy: 'always',
    });
    expect(fresh.statusCode).toBe(200);
    expect(calls).toHaveLength(1);
  });

  it('a read-only office is refused, and its view says it cannot change', async () => {
    const a = await app({ readOnly: true });
    const r = await a.post({ policy: 'manual' });
    expect([r.statusCode, r.json().errorCode]).toEqual([403, 'read_only_mode']);
    expect((await a.get()).canChange).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('the host Bearer token (agent sessions can read it) is refused: a logged-in session only', async () => {
    const a = await app({ kind: { host: true, remote: false } });
    const r = await a.post({ policy: 'manual' });
    expect([r.statusCode, r.json().errorCode]).toEqual([403, 'start_policy_session_only']);
    expect((await a.get()).canChange).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('an unknown standing counts as remote', async () => {
    const server = Fastify();
    registerStartPolicyRoutes(server, async () => undefined, control(), false);
    const r = await server.inject({
      method: 'POST',
      url: '/api/cld/start-policy',
      headers: { origin: 'http://localhost:80', host: 'localhost:80' },
      payload: { policy: 'manual' },
    });
    expect(r.statusCode).toBe(403);
    expect(calls).toHaveLength(0);
  });

  it('macOS and native Windows are refused with the reason, before any step-up', async () => {
    for (const platform of ['darwin', 'win32']) {
      const a = await app({ kind: { host: false, remote: true }, deps: { platform } });
      const r = await a.post({ policy: 'always' });
      expect([r.statusCode, r.json().errorCode, r.json().errorParams]).toEqual([
        409,
        'start_policy_unsupported',
        { platform },
      ]);
      expect((await a.get()).blocked.errorCode).toBe('start_policy_unsupported');
    }
    expect(calls).toHaveLength(0);
  });

  it('a bad policy, another origin, and a failed manager are each refused with a reason', async () => {
    const { post } = await app();
    expect((await post({ policy: 'sometimes' })).json().errorCode).toBe('start_policy_bad');
    managerAnswer = { ok: false, error: 'another manager operation is running' };
    const failed = await post({ policy: 'manual' });
    expect([failed.statusCode, failed.json().errorParams]).toEqual([
      409,
      { why: 'another manager operation is running' },
    ]);
    const server = Fastify();
    registerStartPolicyRoutes(server, async () => undefined, control(), false, undefined, () => ({
      host: false,
      remote: false,
    }));
    const cross = await server.inject({
      method: 'POST',
      url: '/api/cld/start-policy',
      headers: { origin: 'https://evil.example', host: 'localhost:80' },
      payload: { policy: 'manual' },
    });
    expect([cross.statusCode, cross.json().errorCode]).toEqual([403, 'origin_mismatch']);
  });
});

describe('the daemon runs the manager as itself, never as an agent', () => {
  it('an agent token in the daemon environment does not reach the manager; its error comes back', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cld-r3-'));
    // A stand-in with the manager's own gate (manager.mjs startPolicy): it refuses an agent token.
    const stub = path.join(dir, 'manager.mjs');
    fs.writeFileSync(
      stub,
      `if (process.env.CLD_AGENT_TOKEN) { console.error('✖ agent session'); process.exit(1); }
       if (process.argv[3] === 'broken') { console.error('noise\\n✖ lock held'); process.exit(4); }`,
    );
    const before = process.env.CLD_AGENT_TOKEN;
    process.env.CLD_AGENT_TOKEN = 'agent-token';
    try {
      const deps = realStartPolicyDeps({ root: dir, managerPath: stub, version: null });
      expect(await deps.manager([stub, 'start-policy', 'manual'])).toEqual({ ok: true, error: '' });
      expect(await deps.manager([stub, 'start-policy', 'broken'])).toEqual({
        ok: false,
        error: 'lock held',
      });
    } finally {
      if (before === undefined) delete process.env.CLD_AGENT_TOKEN;
      else process.env.CLD_AGENT_TOKEN = before;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
