/**
 * RQ4 (RQW §3.4): the engine path. A project's owner switches on the spec workflow (the engine
 * registry's `specWorkflow`, which adds the spec-workflow rules layer to every agent of the
 * project at its next start) and, when this machine has uv, may add the official GitHub Spec Kit:
 *
 *   plan     what `specify init` would create for the agents this project runs, the pinned
 *            version, and the files it leaves alone; a single-use plan id for this session,
 *   install  that plan, consented: the pinned `uvx --from … specify init --here` with Spec Kit's
 *            event handlers off, in the project's own folder (the engine's record, never a client
 *            path), with a timeout; then it checks the files we never write did not change and
 *            reports what was created,
 *   uninstall `specify integration uninstall <key>` (it removes the files it made and nobody
 *            changed; `.specify/` stays, as the user's files).
 *
 * Nothing from a request becomes a path, an argument or a command: the argv is built from
 * constants and the engine's own record of the project's agents; uvx is found the way the engine
 * finds tools (PATH, then the usual install folders). The daemon itself writes none of
 * `.claude/settings.json`, `CLAUDE.md`, `AGENTS.md` (nor `.codex/config.toml`); the routes' gate
 * (session, same origin, read-only, step-up) is in routes.ts.
 */
import { execFile } from 'child_process';
import { createHash, randomBytes } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import {
  SPEC_KIT_COMMANDS,
  SPEC_KIT_COMMIT,
  SPEC_KIT_CONSENT_TTL_MS,
  SPEC_KIT_OUTPUT_MAX_BYTES,
  SPEC_KIT_REPORT_FILES_MAX,
  SPEC_KIT_RUN_TIMEOUT_MS,
  SPEC_KIT_SOURCE,
  SPEC_KIT_VERSION,
  SPEC_KIT_WALK_MAX,
} from '../../constants.js';
import { maskText } from '../mask.js';
import type { SpecProject } from './service.js';

/** The engine registry's side (injected: the spec routes never hold the engine). */
export interface WorkflowEngine {
  /** The switch and the agent CLIs the project's agents run; null: not an engine project. */
  get(project: string): { on: boolean; clis: string[] } | null;
  set(project: string, on: boolean): boolean;
}

export type KitRun = (file: string, args: string[], cwd: string) => Promise<{ code: number; out: string; timedOut: boolean }>;

export interface WorkflowDeps {
  engine: () => WorkflowEngine | null;
  /** uvx's absolute path, found the way the engine finds tools (agentCli's findUvx), or null. */
  uvx: () => string | null;
  /** The base of the child's environment (only ENV_ALLOW's keys are passed on). */
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  now?: () => number;
  run?: KitRun;
}

/** Our agent CLI → its Spec Kit integration key and the folder its skills go to (v1.3.1 docs). */
const INTEGRATIONS: Record<string, { key: string; skills: string }> = {
  claude: { key: 'claude', skills: '.claude/skills' },
  codex: { key: 'codex', skills: '.agents/skills' },
};
/** Files the daemon never writes and the install must leave as they were. */
export const UNTOUCHED = ['.claude/settings.json', '.claude/settings.local.json', 'CLAUDE.md', 'AGENTS.md', '.codex/config.toml'] as const;
/** Where Spec Kit writes: listed before and after a run. */
const KIT_ROOTS = ['.specify', '.claude', '.agents', '.codex'];
/** Off: Spec Kit's event handlers (`.claude/settings.json`, `.codex/config.toml`). */
const EVENTS_OFF = '--integration-options=--events false';
/** The child's environment is an allow list (the engine's cleanEnv keys, what Windows needs to
 *  start a process, proxies, uv's own UV_* and CA settings): no secret of the daemon or the user
 *  (agent token, cloud keys, database URLs …) reaches it. Matched case-insensitively. */
const ENV_ALLOW =
  /^(HOME|PATH|LANG|USER|SHELL|TERM|TMPDIR|LOGNAME|XDG_[A-Z_]+|LC_[A-Z_]+|UV_[A-Z0-9_]+|SSL_CERT_(FILE|DIR)|REQUESTS_CA_BUNDLE|(HTTPS?|ALL|NO)_PROXY|SYSTEMROOT|WINDIR|COMSPEC|PATHEXT|USERPROFILE|USERNAME|HOMEDRIVE|HOMEPATH|APPDATA|LOCALAPPDATA|PROGRAMDATA|PROGRAMFILES|PROGRAMFILES\(X86\)|TEMP|TMP)$/i;
const REPORT_LINES = 6;

export interface WorkflowView {
  /** An engine project: the switch can reach its agents. */
  engine: boolean;
  on: boolean;
  /** uvx found on this machine. */
  uv: boolean;
  /** `.specify/` is in the project (Spec Kit there, by us or by the user). */
  installed: boolean;
  version: string;
  busy: boolean;
}

export interface WorkflowPlan {
  planId: string;
  version: string;
  /** Spec Kit integration keys, in order (the first is `init`'s). */
  integrations: string[];
  /** The project's agent CLIs Spec Kit is not set up for here. */
  skipped: string[];
  files: string[];
  untouched: readonly string[];
  expiresInMs: number;
}

export interface WorkflowReport {
  ok: boolean;
  /** Files that appeared (or, for uninstall, went), project-relative, at most SPEC_KIT_REPORT_FILES_MAX. */
  files: string[];
  count: number;
  /** Untouched files that changed anyway: never a success. */
  changed: string[];
  /** Why not ok when no file changed: the run failed or timed out. */
  failed?: 'exit' | 'timeout';
  /** The last lines Spec Kit printed (masked), for a failure. */
  lines: string[];
}

export type WorkflowError = 'engine' | 'uv' | 'installed' | 'notInstalled' | 'busy' | 'consent' | 'save';
type R<T> = { ok: true; value: T } | { ok: false; error: WorkflowError };

/** `file args…` in `cwd`, async, with a timeout; never a shell. */
const realRun =
  (env: NodeJS.ProcessEnv): KitRun =>
  (file, args, cwd) =>
    new Promise((resolve) =>
      execFile(
        file,
        args,
        { cwd, timeout: SPEC_KIT_RUN_TIMEOUT_MS, maxBuffer: SPEC_KIT_OUTPUT_MAX_BYTES, windowsHide: true, env },
        (err, stdout, stderr) =>
          resolve({
            code: err ? (typeof err.code === 'number' ? err.code : -1) : 0,
            out: `${String(stdout ?? '')}\n${String(stderr ?? '')}`,
            // ponytail: the timeout ends uvx only; a Python it started and left running is not
            // ours to find. Spec Kit runs to its end in seconds when it can reach GitHub.
            timedOut: !!err && err.killed === true,
          }),
      ),
    );

/** sha256 of each untouched file, 'absent' when there is none. */
function hashes(folder: string): Map<string, string> {
  return new Map(
    UNTOUCHED.map((rel) => {
      try {
        return [rel, createHash('sha256').update(fs.readFileSync(path.join(folder, rel))).digest('hex')];
      } catch (err) {
        return [rel, (err as NodeJS.ErrnoException).code === 'ENOENT' ? 'absent' : 'unreadable'];
      }
    }),
  );
}

/** The project's top-level names and every file under Spec Kit's folders (no link followed). */
function listing(folder: string): Set<string> {
  const out = new Set<string>();
  try {
    for (const e of fs.readdirSync(folder, { withFileTypes: true })) out.add(e.isDirectory() ? `${e.name}/` : e.name);
  } catch {
    /* an unreadable folder lists nothing */
  }
  const walk = (rel: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(path.join(folder, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.size >= SPEC_KIT_WALK_MAX) return;
      const child = `${rel}/${e.name}`;
      if (e.isDirectory()) walk(child);
      else out.add(child);
    }
  };
  for (const root of KIT_ROOTS) walk(root);
  return out;
}

const lastLines = (out: string) => maskText(out).split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(-REPORT_LINES);

export class SpecWorkflow {
  private busy = false;
  /** Shown plans by id: single use, for the session (`key`) it was shown to, until it expires. */
  private readonly plans = new Map<string, { projectId: string; folder: string; integrations: string[]; key: string; at: number }>();
  private readonly env: NodeJS.ProcessEnv;
  private readonly platform: NodeJS.Platform;
  private readonly now: () => number;
  private readonly run: KitRun;

  constructor(private readonly d: WorkflowDeps) {
    this.env = d.env ?? process.env;
    this.platform = d.platform ?? process.platform;
    this.now = d.now ?? Date.now;
    this.run = d.run ?? realRun(Object.fromEntries(Object.entries(this.env).filter(([k]) => ENV_ALLOW.test(k))));
  }

  private uvx(): string | null {
    return this.d.uvx();
  }

  view(p: SpecProject): WorkflowView {
    const wf = this.d.engine()?.get(p.name) ?? null;
    return {
      engine: !!wf,
      on: !!wf?.on,
      uv: !!wf && this.uvx() !== null,
      installed: fs.existsSync(path.join(p.folder, '.specify')),
      version: SPEC_KIT_VERSION,
      busy: this.busy,
    };
  }

  set(p: SpecProject, on: boolean): R<WorkflowView> {
    const engine = this.d.engine();
    if (!engine?.get(p.name)) return { ok: false, error: 'engine' };
    if (!engine.set(p.name, on)) return { ok: false, error: 'save' };
    return { ok: true, value: this.view(p) };
  }

  private integrationsOf(p: SpecProject): { integrations: string[]; skipped: string[] } | null {
    const wf = this.d.engine()?.get(p.name);
    if (!wf) return null;
    const integrations = [...new Set(wf.clis.flatMap((c) => (INTEGRATIONS[c] ? [INTEGRATIONS[c].key] : [])))];
    return { integrations, skipped: wf.clis.filter((c) => !INTEGRATIONS[c]) };
  }

  /** The skills a plan's integrations write, plus `.specify/`. */
  private planned(integrations: string[]): string[] {
    return ['.specify/', ...integrations.flatMap((k) => SPEC_KIT_COMMANDS.map((c) => `${INTEGRATIONS[k].skills}/speckit-${c}/SKILL.md`))];
  }

  /** Something of Spec Kit's is there already: `.specify/`, or a skill's folder (with or without its
   *  SKILL.md: a user's own folder of that name is never run over). */
  private present(folder: string, integrations: string[]): boolean {
    return this.planned(integrations).some((f) => fs.existsSync(path.join(folder, f.endsWith('/SKILL.md') ? path.dirname(f) : f)));
  }

  plan(p: SpecProject, key: string): R<WorkflowPlan> {
    const of = this.integrationsOf(p);
    if (!of || !of.integrations.length) return { ok: false, error: 'engine' };
    if (!this.uvx()) return { ok: false, error: 'uv' };
    if (this.busy) return { ok: false, error: 'busy' };
    const files = this.planned(of.integrations);
    // Spec Kit there already (the user's own, or a skill of that name): never run over it.
    if (this.present(p.folder, of.integrations)) return { ok: false, error: 'installed' };
    const at = this.now();
    for (const [id, x] of this.plans) if (at - x.at > SPEC_KIT_CONSENT_TTL_MS) this.plans.delete(id);
    const planId = randomBytes(16).toString('hex');
    this.plans.set(planId, { projectId: p.projectId, folder: p.folder, integrations: of.integrations, key, at });
    return {
      ok: true,
      value: { planId, version: SPEC_KIT_VERSION, ...of, files, untouched: UNTOUCHED, expiresInMs: SPEC_KIT_CONSENT_TTL_MS },
    };
  }

  /** The argv of each run, in order (exported for the tests' exact comparison). */
  installArgv(integrations: string[]): string[][] {
    const from = ['--from', `${SPEC_KIT_SOURCE}@${SPEC_KIT_COMMIT}`, 'specify'];
    const script = this.platform === 'win32' ? 'ps' : 'sh';
    return integrations.map((k, i) =>
      i === 0
        ? [...from, 'init', '--here', '--force', '--non-interactive', '--ignore-agent-tools', '--script', script, '--integration', k, EVENTS_OFF]
        : [...from, 'integration', 'install', k, EVENTS_OFF],
    );
  }

  uninstallArgv(integrations: string[]): string[][] {
    return integrations.map((k) => ['--from', `${SPEC_KIT_SOURCE}@${SPEC_KIT_COMMIT}`, 'specify', 'integration', 'uninstall', k]);
  }

  async install(p: SpecProject, planId: unknown, consent: unknown, key: string): Promise<R<WorkflowReport>> {
    const shown = typeof planId === 'string' ? this.plans.get(planId) : undefined;
    if (shown) this.plans.delete(planId as string); // one plan, one try
    const now = this.integrationsOf(p);
    if (
      consent !== true ||
      !shown ||
      shown.key !== key ||
      shown.projectId !== p.projectId ||
      shown.folder !== p.folder ||
      this.now() - shown.at > SPEC_KIT_CONSENT_TTL_MS ||
      // the project's agents changed since the plan: what was shown is not what would run
      now?.integrations.join(' ') !== shown.integrations.join(' ')
    )
      return { ok: false, error: 'consent' };
    const uvx = this.uvx();
    if (!uvx) return { ok: false, error: 'uv' };
    if (this.busy) return { ok: false, error: 'busy' };
    if (this.present(p.folder, shown.integrations)) return { ok: false, error: 'installed' };
    return { ok: true, value: await this.runAll(uvx, p.folder, this.installArgv(shown.integrations), 'added') };
  }

  async uninstall(p: SpecProject): Promise<R<WorkflowReport>> {
    if (!this.integrationsOf(p)) return { ok: false, error: 'engine' };
    const uvx = this.uvx();
    if (!uvx) return { ok: false, error: 'uv' };
    if (this.busy) return { ok: false, error: 'busy' };
    // The integrations whose skills are there (a key we know only: nothing else is ever named).
    const there = Object.values(INTEGRATIONS)
      .filter((i) => SPEC_KIT_COMMANDS.some((c) => fs.existsSync(path.join(p.folder, i.skills, `speckit-${c}`))))
      .map((i) => i.key);
    if (!there.length) return { ok: false, error: 'notInstalled' };
    return { ok: true, value: await this.runAll(uvx, p.folder, this.uninstallArgv(there), 'removed') };
  }

  private async runAll(uvx: string, folder: string, runs: string[][], diff: 'added' | 'removed'): Promise<WorkflowReport> {
    this.busy = true;
    try {
      const before = hashes(folder);
      const listed = listing(folder);
      let failed: WorkflowReport['failed'];
      let out = '';
      for (const args of runs) {
        console.log(`[agty spec] spec kit: uvx ${args.slice(2).join(' ')} in the project's folder`);
        const r = await this.run(uvx, args, folder);
        out = r.out;
        if (r.code !== 0) {
          failed = r.timedOut ? 'timeout' : 'exit';
          break;
        }
      }
      const after = hashes(folder);
      const changed = UNTOUCHED.filter((f) => before.get(f) !== after.get(f));
      const now = listing(folder);
      const files = diff === 'added' ? [...now].filter((f) => !listed.has(f)) : [...listed].filter((f) => !now.has(f));
      files.sort();
      if (changed.length) console.warn(`[agty spec] spec kit changed files it was told to leave: ${changed.join(', ')}`);
      return {
        ok: !failed && !changed.length,
        files: files.slice(0, SPEC_KIT_REPORT_FILES_MAX),
        count: files.length,
        changed,
        ...(failed && { failed }),
        lines: failed || changed.length ? lastLines(out) : [],
      };
    } finally {
      this.busy = false;
    }
  }
}
