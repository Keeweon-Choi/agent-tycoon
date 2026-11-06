/**
 * DV2 개발실 실행 row: the owner's run buttons per worktree.
 *
 *   runScripts {project, task, picks?} -> runScriptsResult  the worktree's package.json scripts (read
 *                                        only, size-capped) and the project's picks; with `picks` the
 *                                        owner replaces them first (run-scripts.json, atomic)
 *   jobStart {project, task, scriptId} -> jobStartResult    one picked script as an engine job in the work
 *                                        space's folder; its end is told by officeJobs like every job
 *
 * What runs is decided here alone: the project must be registered, the worktree one the daemon's
 * worktree records hold (RepoManager.workSpace), the script one the owner picked, and its command
 * still the one it had when picked (an agent editing package.json does not change what a button
 * runs). The client names a script by its key; no command, path or argv ever comes from it. A remote
 * session needs a fresh step-up, the engine's check (engine.ts handle), to run and to save picks
 * (a re-pick is what clears run_changed). Stopping is jobAction stop, which signals only jobs whose
 * records we wrote (jobs.ts).
 *
 * Stated limit: run_changed guards the script's literal command only. What the command then does can
 * still change through files in the worktree that an agent may write: an .npmrc `script-shell=`, a
 * tool's config file, node_modules/.bin. Agents already run code as the same user, so this is a
 * limit of the check, not a way past the owner's press.
 */
import * as fs from 'fs';
import * as path from 'path';

import { refused } from '../../../core/src/cld/serverText.js';
import type { JobStartResult, RunPick, RunRole, RunScript, RunScriptsResult } from '../../../core/src/messages.js';
import { deviceLabel } from './device.js';
import type { Jobs } from './engine/jobs.js';
import { maskSecrets } from './engine/jobs.js';
import type { ClientMessageContext } from './hooks.js';
import { maskJobLog } from './jobDigest.js';
import { readJson, writeJsonAtomic } from './jsonFile.js';
import { STEPUP_REQUIRED } from './shell/gate.js';

const PACKAGE_MAX_BYTES = 256 * 1024;
const SCRIPTS_MAX = 100;
const PICKS_MAX = 20;
const CMD_MAX = 2000;
const ID_MAX = 128;
const NAME_MAX = 256;
/** A script key that is a plain word: it goes on the command line unquoted, on every shell. */
export const SCRIPT_RE = /^[A-Za-z0-9][A-Za-z0-9:._@/-]{0,99}$/;
const ROLES: readonly RunRole[] = ['dev', 'test', 'typecheck', 'other'];

interface StoredPick {
  script: string;
  role: RunRole;
  /** The command the script had when the owner picked it. */
  cmd: string;
}
type Store = { v: 1; projects: Record<string, StoredPick[]> };

/** `<dir>/package.json`'s scripts (plain keys, string commands), or null when missing, too big or not JSON. */
export function readScripts(dir: string): Map<string, string> | null {
  const file = path.join(dir, 'package.json');
  try {
    if (fs.statSync(file).size > PACKAGE_MAX_BYTES) return null;
    const scripts = (JSON.parse(fs.readFileSync(file, 'utf-8')) as { scripts?: unknown } | null)?.scripts;
    const out = new Map<string, string>();
    if (scripts && typeof scripts === 'object' && !Array.isArray(scripts))
      for (const [k, v] of Object.entries(scripts))
        if (out.size < SCRIPTS_MAX && SCRIPT_RE.test(k) && typeof v === 'string' && v.length <= CMD_MAX) out.set(k, v);
    return out;
  } catch {
    return null;
  }
}

/** What a picked script runs: npm's runner (node_modules/.bin on PATH) without its pre/post scripts. */
export const runCommand = (script: string): string => `npm run --ignore-scripts ${script}`;

export interface DevroomRunsOptions {
  /** run-scripts.json in the daemon's settings directory (configDirectory(home)). */
  file: string;
  readOnly: boolean;
  workSpace(project: string, task: string): Promise<{ path: string; taskId?: string } | null>;
  jobs(): Pick<Jobs, 'run' | 'list'> | null;
  /** The run is an Execution of the worktree's issue (its end may become the observed test result). */
  attach(taskId: string, jobId: string, log: string, by: string): void;
  log?: (line: string) => void;
}

const str = (v: unknown, max: number): v is string => typeof v === 'string' && v.length <= max;

export class DevroomRuns {
  constructor(private readonly o: DevroomRunsOptions) {}

  /** True when `msg` was ours (also a malformed one, which is dropped). */
  onClientMessage(msg: Record<string, unknown>, ctx: ClientMessageContext): boolean {
    if (msg.type !== 'runScripts' && msg.type !== 'jobStart') return false;
    const { requestId, project, task } = msg;
    if (!str(requestId, ID_MAX) || !requestId || !str(project, NAME_MAX) || !project || !str(task, NAME_MAX)) {
      this.log(`malformed ${msg.type} dropped`);
      return true;
    }
    if (msg.type === 'runScripts') {
      if (msg.picks !== undefined && !Array.isArray(msg.picks)) return true;
      void this.scripts(requestId, project, task, msg.picks as unknown[] | undefined, ctx).then(
        (r) => ctx.send({ ...r }),
        () => this.log('runScripts failed'),
      );
      return true;
    }
    if (!str(msg.scriptId, NAME_MAX)) return true;
    void this.start(requestId, project, task, msg.scriptId, ctx).then(
      (r) => ctx.send({ ...r }),
      () => this.log('jobStart failed'),
    );
    return true;
  }

  private async scripts(
    requestId: string,
    project: string,
    task: string,
    picks: unknown[] | undefined,
    ctx: ClientMessageContext,
  ): Promise<RunScriptsResult> {
    const head = { type: 'runScriptsResult' as const, requestId, project, task, scripts: [] as RunScript[] };
    const fail = (r: ReturnType<typeof refused>) => ({ ...head, ok: false, picks: this.wirePicks(project, null), ...r });
    if (!ctx.privileged) return fail(refused('no_permission'));
    const ws = await this.o.workSpace(project, task);
    if (!ws) return fail(refused('worktree_missing'));
    const found = readScripts(ws.path);
    if (!found) return fail(refused('run_no_package'));
    if (picks) {
      if (this.o.readOnly) return fail(refused('read_only_mode'));
      // S1 as for a run: re-picking a changed script is what lets it run again.
      if (ctx.stepUp?.remote && !ctx.stepUp.fresh()) {
        this.log(`runScripts picks gui:${deviceLabel(ctx.userAgent)}: step-up needed`);
        return { ...head, ok: false, picks: this.wirePicks(project, null), error: STEPUP_REQUIRED };
      }
      const next: StoredPick[] = [];
      for (const p of picks.slice(0, PICKS_MAX) as Array<Record<string, unknown> | null>) {
        const script = p?.script;
        if (typeof script !== 'string' || !ROLES.includes(p?.role as RunRole) || next.some((x) => x.script === script)) return fail(refused('bad_request'));
        const cmd = found.get(script);
        if (cmd === undefined) return fail(refused('run_bad_pick', { script: script.slice(0, 100) }));
        next.push({ script, role: p!.role as RunRole, cmd });
      }
      try {
        const store = this.read();
        store.projects[project] = next;
        writeJsonAtomic(this.o.file, store);
        this.log(`picks of ${JSON.stringify(project).slice(0, 66)}: ${next.map((x) => `${x.script}=${x.role}`).join(', ') || 'none'}`);
      } catch (err) {
        this.log(`picks not written: ${String(err)}`);
        return fail(refused('bad_request'));
      }
    }
    return {
      ...head,
      ok: true,
      scripts: [...found].map(([name, cmd]) => ({ name, cmd: maskJobLog(maskSecrets(cmd)) })),
      picks: this.wirePicks(project, found),
    };
  }

  private async start(requestId: string, project: string, task: string, scriptId: string, ctx: ClientMessageContext): Promise<JobStartResult> {
    const reply = (r: Partial<JobStartResult> & { ok: boolean }): JobStartResult => ({ type: 'jobStartResult', requestId, project, task, scriptId, ...r });
    const device = deviceLabel(ctx.userAgent);
    if (!ctx.privileged) return reply({ ok: false, ...refused('no_permission') });
    if (this.o.readOnly) return reply({ ok: false, ...refused('read_only_mode') });
    // S1, the same check as the engine's dangerous actions: a remote session on a cookie alone may not run commands.
    if (ctx.stepUp?.remote && !ctx.stepUp.fresh()) {
      this.log(`jobStart ${scriptId.slice(0, 40)} gui:${device}: step-up needed`);
      return reply({ ok: false, error: STEPUP_REQUIRED });
    }
    const jobs = this.o.jobs();
    if (!jobs) return reply({ ok: false, ...refused('engine_off') });
    const pick = this.read().projects[project]?.find((p) => p.script === scriptId);
    if (!pick || !SCRIPT_RE.test(pick.script)) return reply({ ok: false, ...refused('run_unknown') });
    const ws = await this.o.workSpace(project, task);
    if (!ws) return reply({ ok: false, ...refused('worktree_missing') });
    const now = readScripts(ws.path);
    if (!now) return reply({ ok: false, ...refused('run_no_package') });
    if (now.get(pick.script) !== pick.cmd) return reply({ ok: false, ...refused('run_changed', { script: pick.script }) });
    if (jobs.list().some((j) => !j.ended && j.project === project && j.run?.task === task && j.run.script === pick.script))
      return reply({ ok: false, ...refused('run_running', { script: pick.script }) });
    const source = `gui:${device}`;
    const r = jobs.run({
      cmd: runCommand(pick.script),
      cwd: ws.path,
      project,
      tty: false,
      source,
      run: { task, script: pick.script, role: pick.role },
    });
    if (!r.ok) return reply({ ok: false, error: r.error, ...(r.errorCode && { errorCode: r.errorCode, errorParams: r.errorParams }) });
    this.log(`jobStart ${JSON.stringify(project).slice(0, 66)} ${task || '(main)'} ${pick.script}: job ${r.id} ${source}`);
    if (ws.taskId) {
      try {
        this.o.attach(ws.taskId, r.id, r.log, source);
      } catch (err) {
        this.log(`job ${r.id} not attached to ${ws.taskId}: ${String(err)}`);
      }
    }
    return reply({ ok: true, id: r.id });
  }

  /** The picks as the client sees them: `changed` where `found` (this worktree's scripts) differs. */
  private wirePicks(project: string, found: Map<string, string> | null): RunPick[] {
    return (this.read().projects[project] ?? []).map((p) => ({
      script: p.script,
      role: p.role,
      ...(found && found.get(p.script) !== p.cmd && { changed: true }),
    }));
  }

  /** The store; an unreadable or foreign file reads as empty (and a save then replaces it). */
  private read(): Store {
    try {
      const raw = readJson(this.o.file) as Partial<Store> | null;
      if (raw && raw.v === 1 && raw.projects && typeof raw.projects === 'object') {
        // No prototype: a project named `constructor` or `__proto__` is just a missing key.
        const projects: Record<string, StoredPick[]> = Object.create(null) as Record<string, StoredPick[]>;
        for (const [name, list] of Object.entries(raw.projects))
          if (Array.isArray(list))
            projects[name] = list.filter(
              (p): p is StoredPick => !!p && typeof p.script === 'string' && ROLES.includes(p.role) && typeof p.cmd === 'string',
            );
        return { v: 1, projects };
      }
    } catch (err) {
      this.log(`run-scripts.json unreadable: ${String(err)}`);
    }
    return { v: 1, projects: Object.create(null) as Record<string, StoredPick[]> };
  }

  private log(line: string): void {
    (this.o.log ?? ((l: string) => console.log(`[cld devroom] ${l}`)))(line);
  }
}
