/**
 * The H/W screen's missing-sensor fixes (`hwSensorTool`):
 * - `plan`: the installer's own LibreHardwareMonitor detection (read-only) and its consent
 *   text, from `node cld/install/hwSensors.mjs plan --port <p>`;
 * - `install`: that step's install path, `node cld/install/hwSensors.mjs install --port <p>`,
 *   the one Windows admin prompt (UAC) it already shows on the host. Never silent: it needs
 *   `consent: true` within CONSENT_TTL_MS after this socket was given a plan with something to
 *   install, a privileged connection on a daemon that is not read-only, and from a remote device
 *   a fresh step-up. One run (plan or install) at a time.
 * - `nvidiaOn` / `nvidiaOff`: the nvidia-smi opt-in, stored as gpu.json's `nvidiaSmi` (the flag the
 *   daemon and the worker read at start) and applied at once. Turning it on needs the same
 *   step-up from a remote device (a GPU query can hang in D state); turning it off never does.
 * Every child runs async with a timeout: the event loop never waits on it.
 */
import { execFile } from 'child_process';

import { gpuConfigPath } from '../engine/gpu.js';
import type { SocketStepUp, WsSend } from '../hooks.js';
import { readJson, writeJsonAtomic } from '../jsonFile.js';
import { STEPUP_REQUIRED } from '../shell/gate.js';
import type { HwPlatform } from './hwSource.js';

/** Detection runs tasklist, netsh and curl.exe (20 s each at most in the step). */
const PLAN_TIMEOUT_MS = 90_000;
/** The step's PowerShell gets 15 min (download, UAC, PawnIO), then 60 s for LHM to answer. */
const INSTALL_TIMEOUT_MS = 17 * 60_000;
const MAX_OUTPUT_BYTES = 256 * 1024;
/** A shown consent text counts this long. */
export const CONSENT_TTL_MS = 10 * 60_000;

export type ToolRun = (
  args: string[],
  timeoutMs: number,
) => Promise<{ code: number; stdout: string; timedOut?: boolean }>;

export interface SensorToolDeps {
  platform: HwPlatform;
  /** cld/install/hwSensors.mjs next to this daemon; null when the bundle has none. */
  script: string | null;
  /** The LHM port the sampler reads. */
  port: () => number;
  home: string;
  run?: ToolRun;
  /** The install found or set up LHM on `port`: read it now. */
  installed: (port: number) => void;
  /** The nvidia-smi switch; false when there is no nvidia-smi. */
  setNvidiaSmi: (on: boolean) => boolean;
  now?: () => number;
}

export interface SensorToolCtx {
  privileged: boolean;
  readOnly: boolean;
  stepUp?: SocketStepUp;
}

/** `node <script> ...args`, async, never with an agent token in its environment. */
const realRun: ToolRun = (args, timeoutMs) =>
  new Promise((resolve) =>
    execFile(
      process.execPath,
      args,
      {
        timeout: timeoutMs,
        maxBuffer: MAX_OUTPUT_BYTES,
        windowsHide: true,
        env: { ...process.env, CLD_AGENT_TOKEN: undefined },
      },
      (err, stdout) =>
        resolve({
          code: err ? (typeof err.code === 'number' ? err.code : -1) : 0,
          stdout: String(stdout ?? ''),
          timedOut: !!err && err.killed === true,
        }),
    ),
  );

/** The step prints its own lines, then one JSON line last. */
function split(stdout: string): { lines: string[]; json: Record<string, unknown> | null } {
  const lines = stdout.split(/\r?\n/).filter((l) => l.trim());
  let json: Record<string, unknown> | null = null;
  try {
    const last = JSON.parse(lines.at(-1) ?? '') as unknown;
    if (last && typeof last === 'object') {
      json = last as Record<string, unknown>;
      lines.pop();
    }
  } catch {
    /* no JSON: the step failed before its answer */
  }
  return { lines, json };
}

export class SensorTool {
  private busy = false;
  /** The plan each socket was shown: whether it had anything to install, and when. */
  private readonly planned = new WeakMap<WsSend, { canInstall: boolean; at: number }>();
  private readonly run: ToolRun;
  private readonly now: () => number;

  constructor(private readonly d: SensorToolDeps) {
    this.run = d.run ?? realRun;
    this.now = d.now ?? Date.now;
  }

  handle(msg: Record<string, unknown>, send: WsSend, ctx: SensorToolCtx): Promise<void> {
    const refuse = (error: string) => {
      send({ type: 'hwSensorToolState', phase: 'refused', error });
      return Promise.resolve();
    };
    if (!ctx.privileged || ctx.readOnly) return refuse('read_only');
    const action = msg.action;
    if (
      action !== 'plan' &&
      action !== 'install' &&
      action !== 'nvidiaOn' &&
      action !== 'nvidiaOff'
    )
      return Promise.resolve();
    if (
      (action === 'install' || action === 'nvidiaOn') &&
      ctx.stepUp?.remote &&
      !ctx.stepUp.fresh()
    )
      return refuse(STEPUP_REQUIRED);
    if (action === 'nvidiaOn' || action === 'nvidiaOff')
      return this.nvidia(action === 'nvidiaOn', send);
    if (this.d.platform !== 'win32' && this.d.platform !== 'wsl') return refuse('unsupported');
    if (!this.d.script) return refuse('unavailable');
    if (this.busy) return refuse('busy');
    if (action === 'plan') return this.plan(send);
    const shown = this.planned.get(send);
    if (msg.consent !== true || !shown?.canInstall || this.now() - shown.at > CONSENT_TTL_MS)
      return refuse('consent');
    return this.install(send);
  }

  private async plan(send: WsSend): Promise<void> {
    this.busy = true;
    let r: Awaited<ReturnType<ToolRun>>;
    try {
      r = await this.run(
        [this.d.script!, 'plan', '--port', String(this.d.port())],
        PLAN_TIMEOUT_MS,
      );
    } finally {
      this.busy = false;
    }
    const { json } = split(r.stdout);
    const lines = Array.isArray(json?.lines) ? json.lines.map(String) : [];
    if (r.code !== 0 || !json) {
      send({ type: 'hwSensorToolState', phase: 'refused', error: 'unavailable' });
      return;
    }
    const lhmPort = typeof json.lhmPort === 'number' ? json.lhmPort : null;
    if (lhmPort) this.d.installed(lhmPort); // already running: read it, nothing to install
    const canInstall = json.install === true;
    this.planned.set(send, { canInstall, at: this.now() });
    send({ type: 'hwSensorToolState', phase: 'plan', lines, canInstall });
  }

  private async install(send: WsSend): Promise<void> {
    this.busy = true;
    this.planned.delete(send); // one consent, one run
    console.log(
      "[cld] hw: installing the sensor tool (LibreHardwareMonitor) on the owner's request",
    );
    send({ type: 'hwSensorToolState', phase: 'running' });
    let timedOut = false;
    try {
      const r = await this.run(
        [this.d.script!, 'install', '--port', String(this.d.port())],
        INSTALL_TIMEOUT_MS,
      );
      timedOut = r.timedOut === true;
      const { lines, json } = split(r.stdout);
      const ok = r.code === 0 && json?.ok === true;
      const port = typeof json?.lhmPort === 'number' ? json.lhmPort : this.d.port();
      if (ok) this.d.installed(port);
      send({ type: 'hwSensorToolState', phase: 'done', ok, lines });
    } finally {
      // ponytail: a timed-out install keeps the tool busy until the daemon restarts: the timeout
      // kills our node child, but the elevated PowerShell it started is not ours to watch or kill.
      if (!timedOut) this.busy = false;
    }
  }

  private nvidia(on: boolean, send: WsSend): Promise<void> {
    const file = gpuConfigPath(this.d.home);
    let error: string | null = null;
    let current: unknown = null;
    try {
      current = readJson(file) ?? {};
    } catch {
      /* broken: left alone */
    }
    // gpu.json is the user's file too: keep every other key; a broken one is never overwritten.
    if (!current || typeof current !== 'object' || Array.isArray(current)) error = 'write_failed';
    else if (!this.d.setNvidiaSmi(on)) error = 'not_found';
    else
      try {
        writeJsonAtomic(file, { ...current, nvidiaSmi: on });
      } catch (err) {
        this.d.setNvidiaSmi(!on);
        console.warn(`[cld] hw: gpu.json: ${err instanceof Error ? err.message : String(err)}`);
        error = 'write_failed';
      }
    if (error) send({ type: 'hwSensorToolState', phase: 'refused', error });
    return Promise.resolve();
  }
}
