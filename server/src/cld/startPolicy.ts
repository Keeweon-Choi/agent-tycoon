/**
 * R3: 설정's start-and-recovery section. Shows the start policy (R1 + P6, cld/install/manager.mjs) with
 * the same read-only facts `agty doctor` reads (the install record, the Windows logon task, linger, WSL
 * apart from the daemon), and changes it with `agty start-policy <p>` through the manager.
 *
 * The manager refuses any caller with CLD_AGENT_TOKEN in its environment (agent sessions). The daemon
 * runs it without one, so the owner's request passes and agents' own `agty start-policy` still does not.
 * The HTTP side takes a logged-in browser session only: the host's Bearer token sits in
 * ~/.pixel-agents/server.json, which every agent session can read. A remote device needs a fresh
 * step-up. Nothing here stops the daemon or a session (INSTALL-16: the manager never does).
 */
import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { type Refused,refused } from '../../../core/src/cld/serverText.js';
import { sameOriginRequest } from './authRoutes.js';
import { readJson, writeJsonAtomic } from './jsonFile.js';
import { STEPUP_REQUIRED } from './shell/gate.js';
import type { RequestKind } from './updateNotice.js';

export const START_POLICIES = ['on-demand', 'always', 'manual'] as const;
export type StartPolicyName = (typeof START_POLICIES)[number];
/** Where R1/P6 can apply a policy (macOS is the only managed platform without it). */
const SUPPORTED = ['linux', 'wsl', 'win32'];
const MANAGER_TIMEOUT_MS = 120_000;
const TASK_QUERY_TIMEOUT_MS = 10_000;

/** The parts of the manager's install.json this reads. */
interface InstallRecord {
  startPolicy?: unknown;
  service?: { name?: unknown; kind?: unknown } | null;
  logonTask?: { name?: unknown } | null;
  linger?: { user?: unknown } | null;
  wslDistro?: unknown;
}

export interface StartPolicyDeps {
  platform: string;
  /** The managed install this daemon runs from; null for a source install. */
  install: { root: string; managerPath: string; version: string | null } | null;
  user: string;
  readRecord(): InstallRecord | null;
  /** The Windows logon task is registered (read-only query); null: could not tell. */
  taskPresent(name: string): Promise<boolean | null>;
  lingerOn(user: string): boolean;
  systemd(): boolean;
  /** `node <manager> ...args`, never with an agent token in its environment. */
  manager(args: string[]): Promise<{ ok: boolean; error: string }>;
}

export interface StartPolicyView {
  platform: string;
  /** Why the policy cannot be changed on this install at all, or null. */
  blocked: Refused | null;
  policy: StartPolicyName | null;
  service: { name: string; kind: string } | null;
  /** WSL only: the Windows logon task `always` needs. */
  logonTask: { name: string | null; present: boolean | null } | null;
  /** systemd only: linger keeps the daemon up without a login. `ours`: we turned it on. */
  linger: { user: string; on: boolean; ours: boolean } | null;
  wsl: { distro: string; systemd: boolean } | null;
  daemon: { pid: number; startedAt: string; version: string | null };
  /** This requester may change it. */
  canChange: boolean;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const isPolicy = (v: unknown): v is StartPolicyName =>
  (START_POLICIES as readonly unknown[]).includes(v);

export function detectPlatform(): string {
  return process.platform === 'linux' && /microsoft/i.test(os.release()) ? 'wsl' : process.platform;
}

export class StartPolicyControl {
  constructor(private readonly d: StartPolicyDeps) {}

  blocked(): Refused | null {
    if (!this.d.install) return refused('start_policy_not_managed');
    if (!SUPPORTED.includes(this.d.platform))
      return refused('start_policy_unsupported', { platform: this.d.platform });
    return null;
  }

  async view(mayChange: boolean): Promise<StartPolicyView> {
    const record = this.d.install ? this.d.readRecord() : null;
    const blocked = this.blocked();
    const kind = str(record?.service?.kind);
    const service = record && kind ? { name: str(record.service?.name) ?? '', kind } : null;
    const wsl = this.d.platform === 'wsl';
    const taskName = str(record?.logonTask?.name);
    const distro = str(record?.wslDistro) ?? process.env.WSL_DISTRO_NAME ?? '';
    return {
      platform: this.d.platform,
      blocked,
      policy: record ? (isPolicy(record.startPolicy) ? record.startPolicy : 'on-demand') : null,
      service,
      logonTask:
        record && wsl
          ? { name: taskName, present: taskName ? await this.d.taskPresent(taskName) : false }
          : null,
      // The manager treats a dry-run service as systemd too; linger only matters there.
      linger:
        record && (kind === 'systemd' || kind === 'dry-run')
          ? {
              user: this.d.user,
              on: !!record.linger || this.d.lingerOn(this.d.user),
              ours: !!record.linger,
            }
          : null,
      wsl: wsl ? { distro, systemd: this.d.systemd() } : null,
      daemon: {
        pid: process.pid,
        startedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(),
        version: this.d.install?.version ?? null,
      },
      canChange: mayChange && !blocked,
    };
  }

  /** `agty start-policy <policy>`; `always` always says --linger or --no-linger (the manager never asks here). */
  async change(policy: StartPolicyName, linger: boolean): Promise<Refused | null> {
    const blocked = this.blocked();
    if (blocked) return blocked;
    const { managerPath, root } = this.d.install!;
    const flags = policy === 'always' ? [linger ? '--linger' : '--no-linger'] : [];
    const r = await this.d.manager([managerPath, 'start-policy', policy, ...flags, '--root', root]);
    return r.ok ? null : refused('start_policy_failed', { why: r.error || '?' });
  }
}

/** The real effects. Only the change writes anything, and it is the manager that does. */
export function realStartPolicyDeps(
  install: StartPolicyDeps['install'],
): StartPolicyDeps {
  return {
    platform: detectPlatform(),
    install,
    user: process.env.USER || os.userInfo().username,
    readRecord: () =>
      install ? (readJson(path.join(install.root, 'install.json')) as InstallRecord | null) : null,
    taskPresent: (name) =>
      new Promise((resolve) =>
        execFile('schtasks.exe', ['/Query', '/TN', name], { timeout: TASK_QUERY_TIMEOUT_MS }, (err) =>
          resolve(!err ? true : typeof err.code === 'number' ? false : null),
        ),
      ),
    lingerOn: (user) => fs.existsSync(path.join('/var/lib/systemd/linger', user)),
    systemd: () => fs.existsSync('/run/systemd/system'),
    manager: (args) =>
      new Promise((resolve) =>
        execFile(
          process.execPath,
          args,
          {
            timeout: MANAGER_TIMEOUT_MS,
            maxBuffer: 256 * 1024,
            // The daemon's own call: an agent token here would make the manager refuse it.
            env: { ...process.env, CLD_AGENT_TOKEN: undefined },
          },
          (err, _stdout, stderr) =>
            resolve({
              ok: !err,
              error: err
                ? String(stderr || err.message)
                    .trim()
                    .split('\n')
                    .pop()!
                    .replace(/^✖\s*/, '')
                    .slice(0, 400)
                : '',
            }),
        ),
      ),
  };
}

/**
 * Browser runners only (cld/test/run-r3.ts): a fake install whose facts live in `file`, and a fake
 * manager that records the policy there. Unset in every install.
 */
export function testStartPolicyDeps(file: string): StartPolicyDeps {
  const facts = () =>
    (readJson(file) ?? {}) as {
      platform?: string;
      record?: InstallRecord & Record<string, unknown>;
      taskPresent?: boolean;
      lingerOn?: boolean;
      calls?: string[][];
    };
  return {
    platform: facts().platform ?? 'wsl',
    install: { root: '/fake/agent-tycoon', managerPath: '/fake/manager.mjs', version: '0.0.0-test' },
    user: 'owner',
    readRecord: () => facts().record ?? null,
    taskPresent: async () => facts().taskPresent ?? true,
    lingerOn: () => facts().lingerOn === true,
    systemd: () => true,
    manager: async (args) => {
      const f = facts();
      const policy = args[2];
      const record = { ...f.record, startPolicy: policy };
      if (policy === 'always' && f.platform !== 'linux')
        record.logonTask = { name: 'agent-tycoon-wsl-Ubuntu' };
      else delete record.logonTask;
      if (args.includes('--linger')) record.linger = { user: 'owner' };
      else if (policy !== 'always') delete record.linger;
      writeJsonAtomic(file, { ...f, record, calls: [...(f.calls ?? []), args] });
      return { ok: true, error: '' };
    },
  };
}

/** GET /api/cld/start-policy, POST /api/cld/start-policy { policy, linger? }. */
export function registerStartPolicyRoutes(
  app: FastifyInstance,
  auth: (request: FastifyRequest, reply: FastifyReply) => Promise<void>,
  control: StartPolicyControl,
  readOnly: boolean,
  stepUpFresh?: (request: FastifyRequest) => boolean,
  kindOf?: (request: FastifyRequest) => RequestKind,
  actorOf?: (request: FastifyRequest) => string | undefined,
): void {
  // Unknown standing is the careful one: a remote device, not the host.
  const kind = (request: FastifyRequest): RequestKind =>
    kindOf?.(request) ?? { host: false, remote: true };
  const refusal = (request: FastifyRequest): Refused | null => {
    if (readOnly) return refused('read_only_mode');
    if (kind(request).host) return refused('start_policy_session_only');
    return null;
  };
  app.get('/api/cld/start-policy', { preHandler: auth }, async (request) =>
    control.view(refusal(request) === null),
  );
  app.post<{ Body: { policy?: unknown; linger?: unknown } | undefined }>(
    '/api/cld/start-policy',
    { preHandler: auth },
    async (request, reply) => {
      const k = kind(request);
      if (!k.host && !sameOriginRequest(request))
        return reply.code(403).send(refused('origin_mismatch'));
      const no = refusal(request);
      if (no) return reply.code(403).send(no);
      const policy = request.body?.policy;
      if (!isPolicy(policy)) return reply.code(400).send(refused('start_policy_bad'));
      const blocked = control.blocked();
      if (blocked) return reply.code(409).send(blocked);
      if (k.remote && !stepUpFresh?.(request))
        return reply.code(403).send({ error: STEPUP_REQUIRED });
      const failed = await control.change(policy, request.body?.linger === true);
      if (failed) return reply.code(409).send(failed);
      console.log(
        `[cld start-policy] ${policy}${request.body?.linger === true ? ' --linger' : ''} by ${actorOf?.(request) ?? 'device'}`,
      );
      return { ok: true, view: await control.view(true) };
    },
  );
}
