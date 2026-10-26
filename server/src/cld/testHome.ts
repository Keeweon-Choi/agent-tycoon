/**
 * Isolated HOME with the fake `claude` (cld/test/) for unit and integration
 * tests: an empty transcript for every session the fixtures name. Never used
 * at runtime.
 */
import type { Browser, LaunchOptions, Page } from '@playwright/test';
import { chromium } from '@playwright/test';
import type { ChildProcess } from 'child_process';
import { execFileSync, spawn } from 'child_process';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';

import { normalizeProjectPath } from '../../../core/src/normalizeProjectPath.js';
import { registryPath, saveRegistry } from './engine/registry.js';
import { findOnPath } from './providers/claudeProvider.js';

export const REPO_ROOT = path.resolve(__dirname, '../../..');
export const FAKE_CLAUDE = path.join(REPO_ROOT, 'cld/test/fake-claude');

export interface FakeHome {
  home: string;
  claudeLog: string;
  claudePath: string;
  /** Env for processes using this home (fake scenarios + logs). */
  env: Record<string, string>;
}

/** O4: the first-run Intro asks which permission mode new agents start with, to any viewer that is not
 *  read-only (a daemon with --allow-actions), and its dialog covers the office. By default the question
 *  is answered ('ask'); run-o4 tests the question itself. A reused home keeps its own answer. */
export function answerNewAgentChoice(home: string): void {
  const file = path.join(home, '.config/cld-gui/new-agent-permission.json');
  if (fs.existsSync(file)) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ mode: 'ask' }));
}

export function makeFakeHome(opts: {
  home?: string;
  claude?: string | null;
  /** The claude scenario's agents.json is the session list: the daemon reads `claude agents --json`
   *  instead of ~/.claude/sessions (T-0013), via one live session file in a shape it
   *  cannot read, which is what its fallback is for. */
  agentsJson?: boolean;
  /** False leaves the 접속 방식 unchosen, so the host's first open shows T-0074's start screen
   *  (run-access tests it). By default the choice is made: the screen would cover the office. */
  accessChosen?: boolean;
  /** False leaves the new agents' permission mode unanswered (run-o4 tests the Intro's question). */
  newAgentChoice?: boolean;
}): FakeHome {
  const home = opts.home ?? fs.mkdtempSync(path.join(os.tmpdir(), 'cld-home-'));
  const sub = (p: string) => path.join(home, p);
  const env: Record<string, string> = {
    HOME: home,
    FAKE_CLAUDE_LOG: sub('fake-claude.log'),
  };
  // A reused home (opts.home) keeps the config.json it has.
  if (opts.accessChosen !== false && !fs.existsSync(sub('.config/cld-gui/config.json'))) {
    fs.mkdirSync(sub('.config/cld-gui'), { recursive: true });
    fs.writeFileSync(sub('.config/cld-gui/config.json'), JSON.stringify({ accessChosen: true }));
  }
  if (opts.newAgentChoice !== false) answerNewAgentChoice(home);
  const texts: string[] = [];
  if (opts.claude) {
    env.FAKE_CLAUDE_SCENARIO = path.join(FAKE_CLAUDE, opts.claude);
    texts.push(fs.readFileSync(path.join(env.FAKE_CLAUDE_SCENARIO, 'agents.json'), 'utf-8'));
    if (opts.agentsJson) {
      // Alive for as long as the test runs: the runner's own pid.
      const unreadable = { pid: process.pid, sessionId: 'fixture', cwd: '/', kind: 'unreadable' };
      fs.mkdirSync(sub('.claude/sessions'), { recursive: true });
      fs.writeFileSync(
        sub('.claude/sessions/' + process.pid + '.json'),
        JSON.stringify(unreadable),
      );
    }
  }
  // Transcripts named by the scenario (@HOME@/...jsonl) and by claude sessions (cwd + id).
  for (const t of texts) {
    for (const m of t.matchAll(/@HOME@(\/\.claude\/projects\/[^"]+\.jsonl)/g)) {
      touch(path.join(home, m[1]));
    }
    try {
      const rows = JSON.parse(t.replace(/@PPID@/g, '0')) as Array<{
        cwd?: string;
        sessionId?: string;
      }>;
      if (Array.isArray(rows)) {
        for (const r of rows) {
          if (r.cwd && r.sessionId) {
            const dir = normalizeProjectPath(r.cwd);
            touch(path.join(home, '.claude/projects', dir, `${r.sessionId}.jsonl`));
          }
        }
      }
    } catch {
      /* ls.json is an object */
    }
  }
  return {
    home,
    claudeLog: env.FAKE_CLAUDE_LOG,
    claudePath: path.join(FAKE_CLAUDE, fakeBin('claude')),
    env,
  };
}

/** A fake CLI's file name: on Windows its `.cmd` wrapper (Windows cannot run the Node script itself). */
export const fakeBin = (name: string, platform: NodeJS.Platform = process.platform): string =>
  platform === 'win32' ? `${name}.cmd` : name;

function touch(file: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (!fs.existsSync(file)) fs.writeFileSync(file, '');
}

/** The headless Chromium the runners drive (installed by Playwright, not the system's). */
export const CHROME = path.join(
  os.homedir(),
  '.cache/ms-playwright/chromium_headless_shell-1248/chrome-headless-shell-linux64/chrome-headless-shell',
);

/** The browser reports software rendering only: no real GPU device, no GPU compositing. */
export async function assertNoGpu(browser: Browser): Promise<void> {
  const session = await browser.newBrowserCDPSession();
  const { gpu } = (await session.send('SystemInfo.getInfo' as never)) as {
    gpu: { devices: Array<{ deviceString?: string }>; featureStatus: Record<string, string> };
  };
  await session.detach();
  const real = gpu.devices.filter((d) => !/SwiftShader/i.test(d.deviceString ?? ''));
  if (real.length || !String(gpu.featureStatus.gpu_compositing).startsWith('disabled'))
    throw new Error(`headless Chromium is using the GPU: ${JSON.stringify(gpu.devices)}`);
}

/** localStorage key of the per-browser office hours (webview-ui/src/cld/officeHours.ts). */
const OFFICE_HOURS_KEY = 'cld.office-hours';
/** localStorage key that keeps a terminal pane on xterm's DOM renderer (webview-ui/src/terminal/webglRenderer.ts). */
export const TERMINAL_RENDERER_KEY = 'cld.terminal-renderer';
/** webview-ui/src/cld/cameraMode.ts CAMERA_MODE_KEY (the server does not import the webview). */
export const CAMERA_MODE_KEY = 'cld.camera-mode';
/** webview-ui/src/cld/gfx/titleScene.ts TITLE_KEY. */
export const TITLE_SCENE_KEY = 'cld.title-scene';
/** webview-ui/src/cld/notify/push.ts DISMISSED_KEY: a time stamp, the banner stays away a week from it. */
const PUSH_BANNER_DISMISSED_KEY = 'cld.push-banner-dismissed';

/** T-0108: a desktop starts with the floating icons only. Opens the 현황판 window
 *  through its icon and waits for it; does nothing when it is already open (a stored
 *  layout remembers it), so the icon never toggles it shut. */
export async function openOfficeWindow(page: Page): Promise<void> {
  const win = page.locator('[data-hud-window="office"]');
  const icon = page.locator('[data-hud-id="icon:office"] button');
  await icon.waitFor(); // the icons and the restored windows render in the same commit
  if (await win.isVisible()) return;
  await icon.click();
  await win.waitFor();
}

/** UI-C1: the 작업실 (desktop window or the phone's Dock page) on `tab` (its button's name:
 *  '에이전트', 'Task', ...), and on `project` when given ('?none' is 프로젝트 없음). Opens it
 *  through its icon only while it is not showing, so the icon never toggles it shut. */
export async function openWorkbenchTab(
  page: Page,
  tab: string,
  opts: { project?: string; tap?: boolean } = {},
): Promise<void> {
  const win = page.locator('[data-hud-window="workbench"], [aria-label="작업실 화면"]');
  const icon = page.locator('[data-hud-id="icon:workbench"] button').first();
  if (!(await win.isVisible())) {
    await icon.waitFor();
    await (opts.tap ? icon.tap() : icon.click());
    await win.waitFor();
  }
  if (opts.project)
    await win.getByRole('combobox', { name: '작업실 프로젝트' }).selectOption(opts.project);
  const button = win.getByRole('button', { name: tab, exact: true });
  await (opts.tap ? button.tap() : button.click());
}

/** The one way tests start Chromium: always --disable-gpu (the GPU belongs to
 *  other workloads on this PC), merged with the runner's own args, and checked.
 *  Terminal panes draw with the DOM renderer (the runners read .xterm-rows).
 *  Office hours (T-0041) are off in every context it opens, so a runner does not
 *  depend on the clock (after 18:00 and on weekends idle characters go home);
 *  `officeHours: true` leaves them as the page defaults, for a runner that tests them.
 *  The "notifications are off here" banner starts dismissed (it floats over the
 *  lower screen for a while); `pushBanner: true` keeps it, for a runner that tests it.
 *  Contexts use Korean so the runners' Korean selectors remain stable; a runner
 *  may explicitly request another locale. */
export async function launchBrowser(
  opts: LaunchOptions & { officeHours?: boolean; pushBanner?: boolean } = {},
): Promise<Browser> {
  const { officeHours, pushBanner, ...launch } = opts;
  const browser = await chromium.launch({
    executablePath: CHROME,
    ...launch,
    args: ['--disable-gpu', ...(launch.args ?? [])],
  });
  try {
    await assertNoGpu(browser);
  } catch (err) {
    await browser.close();
    throw err;
  }
  const defaults: Array<[string, string]> = [
    // The runners read the screen from xterm's DOM rows (.xterm-rows); a pane
    // otherwise draws with WebGL (webview-ui/src/terminal/webglRenderer.ts).
    [TERMINAL_RENDERER_KEY, 'dom'],
    // GFX: the runners written before the camera modes click where the upstream camera puts
    // things ('off': no auto framing, a click follows); run-gfx.ts sets its own mode.
    [CAMERA_MODE_KEY, 'off'],
    // GFX: no title scene over the office the runners click on (run-gfx.ts opens it itself).
    [TITLE_SCENE_KEY, 'off'],
  ];
  if (!officeHours) defaults.push([OFFICE_HOURS_KEY, '{"on":false}']);
  if (!pushBanner) defaults.push([PUSH_BANNER_DISMISSED_KEY, String(Date.now())]);
  const newContext = browser.newContext.bind(browser);
  browser.newContext = async (options) => {
    const ctx = await newContext({ locale: 'ko-KR', ...options });
    await ctx.addInitScript((pairs) => {
      for (const [key, value] of pairs)
        try {
          if (!localStorage.getItem(key)) localStorage.setItem(key, value);
        } catch {
          // No storage in this page: the page's defaults stay.
        }
    }, defaults);
    return ctx;
  };
  const newPage = browser.newPage.bind(browser);
  browser.newPage = (options) => newPage({ locale: 'ko-KR', ...options });
  return browser;
}

/** The spare ports tests may use (other agents share them). */
export const SPARE_PORTS = [18256, 18257, 18258, 18259];

/** A spare port from `process.argv[index]`; anything else is refused. */
export function sparePort(index = 2): number {
  const port = Number(process.argv[index]);
  if (!SPARE_PORTS.includes(port)) throw new Error('port must be 18256-18259');
  return port;
}

/** Refuse a port someone listens on: another run's daemon is not ours to talk to. */
export async function assertPortFree(...ports: number[]): Promise<void> {
  for (const port of ports) {
    const free = await new Promise<boolean>((resolve) => {
      const probe = net.createServer().once('error', () => resolve(false));
      probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)));
    });
    if (!free) throw new Error(`port ${port} is taken`);
  }
}

function hostToken(home: string): string | undefined {
  for (const file of ['server.json', 'standalone-token']) {
    try {
      const value = fs.readFileSync(path.join(home, '.pixel-agents', file), 'utf-8').trim();
      if (file === 'standalone-token') return value;
      const server = JSON.parse(value) as { token?: unknown };
      if (typeof server.token === 'string' && server.token) return server.token;
    } catch {
      // The daemon may not have created its token yet.
    }
  }
  return undefined;
}

/** Wait until `/api/health` on `port` is answered by process `pid`, and by no
 *  one else: a daemon of another run may hold a shared spare port. */
/** `/api/health` as the host sees it: since S9, pid and uptime come only with the host token. */
export async function hostHealth(port: number, home: string): Promise<{ pid?: number; uptime?: number }> {
  const token = hostToken(home);
  const res = await fetch(`http://127.0.0.1:${port}/api/health`, {
    ...(token ? { headers: { Authorization: `Bearer ${token}` } } : {}),
  });
  return (await res.json()) as { pid?: number; uptime?: number };
}

export async function waitForDaemon(
  port: number,
  pid: number,
  timeoutMs = 30_000,
  home?: string,
): Promise<void> {
  for (const deadline = Date.now() + timeoutMs; ;) {
    let theirs: number | undefined;
    try {
      const token = hostToken(home ?? os.homedir());
      const res = await fetch(`http://127.0.0.1:${port}/api/health`, {
        ...(token ? { headers: { Authorization: `Bearer ${token}` } } : {}),
      });
      if (res.ok) {
        theirs = ((await res.json()) as { pid?: number }).pid;
        if (theirs === pid) return;
      }
    } catch {
      // Not listening yet.
    }
    if (theirs !== undefined)
      throw new Error(`port ${port} answers for pid ${theirs}, not ours (${pid})`);
    if (Date.now() > deadline) throw new Error(`no daemon on port ${port}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** Wait for OUR daemon (`pid`) on `port`, then mint a login URL with the server
 *  token in `home` -- what the installer does, since the daemon prints no
 *  login link when its stdout is not a terminal. */
export async function daemonLoginUrl(
  home: string,
  port: number,
  pid: number,
  timeoutMs = 30_000,
): Promise<string> {
  await waitForDaemon(port, pid, timeoutMs, home);
  const base = `http://127.0.0.1:${port}`;
  const token = hostToken(home);
  if (!token) throw new Error('daemon did not create its host token');
  const res = await fetch(`${base}/api/login-code`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  });
  const { code } = (await res.json()) as { code: string };
  return `${base}/login?code=${encodeURIComponent(code)}`;
}

export interface Daemon {
  child: ChildProcess;
  /** stdout and stderr, in order. */
  log: string[];
  /** A fresh login link; rejects, with the log, if the daemon exits first. */
  loginUrl(): Promise<string>;
  /** SIGTERM and wait for the exit (SIGKILL after 10 s). */
  stop(): Promise<void>;
}

/** The agent CLIs a test daemon must never find for real: only the fakes it is given. */
const REAL_AGENT_BINS = ['codex', 'claude'];

/** D5 (F7): a test daemon's PATH: `fakes` first (the fake claude or codex folders, as given),
 *  then the caller's PATH without any folder that holds a real `codex` or `claude` (the user's
 *  ~/.local/bin on this PC): a test never reaches the real CLIs, not even for `--version`. */
export function testDaemonPath(fakes: string[], callerPath = process.env.PATH ?? ''): string {
  const given = fakes.filter(Boolean);
  const isFake = (dir: string) => given.some((f) => path.resolve(f) === path.resolve(dir));
  // findOnPath: on Windows also claude.exe, claude.cmd...
  const holdsReal = (dir: string) => !isFake(dir) && REAL_AGENT_BINS.some((bin) => findOnPath(bin, dir) !== null);
  const rest = callerPath.split(path.delimiter).filter((d) => d && path.isAbsolute(d) && !holdsReal(d));
  return [...given, ...rest].join(path.delimiter);
}

/** dist/cli.js on `port` in an isolated HOME (the fake `claude` first on PATH, no
 *  systemd user manager in reach), spoken to only through its own pid. */
export function startDaemon(
  fake: { home: string; env?: Record<string, string>; claudePath?: string },
  port: number,
  args: string[],
  extraEnv: Record<string, string> = {},
  /** Only HOME, XDG_RUNTIME_DIR and `extraEnv` (PATH included): nothing of the caller's environment. */
  strictEnv = false,
  /** Another build's cli.js (run-gfx.ts compares against a baseline build). */
  cli = path.join(REPO_ROOT, 'dist/cli.js'),
): Daemon {
  const child = spawn(
    process.execPath,
    [cli, '--port', String(port), ...args],
    {
      env: strictEnv
        ? { HOME: fake.home, XDG_RUNTIME_DIR: fake.home, ...extraEnv }
        : {
            ...process.env,
            XDG_RUNTIME_DIR: fake.home,
            ...(fake.env ?? { HOME: fake.home }),
            ...extraEnv,
            PATH: testDaemonPath([
              ...(extraEnv.PATH ? extraEnv.PATH.split(path.delimiter) : []),
              ...(fake.claudePath ? [path.dirname(fake.claudePath)] : []),
            ]),
          },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  const log: string[] = [];
  child.stdout.on('data', (b: Buffer) => log.push(b.toString()));
  child.stderr.on('data', (b: Buffer) => log.push(b.toString()));
  const exited = new Promise<never>((_, reject) =>
    child.once('exit', (c) => reject(new Error(`daemon exited ${c}\n${log.join('')}`))),
  );
  exited.catch(() => undefined); // only loginUrl listens
  return {
    child,
    log,
    loginUrl: () =>
      Promise.race([
        daemonLoginUrl(fake.home, port, child.pid!).catch((err: unknown) => {
          throw new Error(`${String(err)}\n${log.join('')}`);
        }),
        exited,
      ]),
    stop: async () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const done = new Promise((r) => child.once('exit', r));
      child.kill('SIGTERM');
      const force = setTimeout(() => child.kill('SIGKILL'), 10_000);
      await done;
      clearTimeout(force);
    },
  };
}

/** The engine's stateful fake `claude` (T-0018), as `<home>/bin/claude`. */
export function makeEngineHome(): { home: string; bin: string; claudePath: string } {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cld-engine-'));
  const bin = path.join(home, 'bin');
  fs.mkdirSync(bin);
  // Windows: a symlink needs admin rights and a script needs a .cmd; engine.cjs accepts this wrapper.
  if (process.platform === 'win32')
    fs.writeFileSync(
      path.join(bin, 'claude.cmd'),
      `@echo off\r\nnode "${path.join(FAKE_CLAUDE, 'engine.cjs')}" %*\r\n`,
    );
  else fs.symlinkSync(path.join(FAKE_CLAUDE, 'engine.cjs'), path.join(bin, 'claude'));
  fs.mkdirSync(path.join(home, '.config/cld-gui'), { recursive: true });
  fs.writeFileSync(
    path.join(home, '.config/cld-gui/config.json'),
    JSON.stringify({ accessChosen: true }),
  );
  answerNewAgentChoice(home);
  return { home, bin, claudePath: path.join(bin, fakeBin('claude')) };
}

/**
 * `pid` is a process of the test HOME `home`: its environment says so (Linux), or, without
 * /proc, its argv ends with it (macOS `ps`; the fake session puts its HOME there). Anything
 * else, Windows included, is never ours to kill.
 */
export function isFakeOf(pid: number, home: string, platform: NodeJS.Platform = process.platform): boolean {
  try {
    if (platform === 'linux')
      return fs.readFileSync(`/proc/${pid}/environ`, 'utf-8').split('\0').includes(`HOME=${home}`);
    if (platform !== 'darwin') return false;
    const args = execFileSync('ps', ['-o', 'args=', '-p', String(pid)], { encoding: 'utf-8' }).trim();
    return args.startsWith('sh -c ') && args.endsWith(` fake-claude-session ${home}`);
  } catch {
    return false; // gone, or not ours to read
  }
}

/** Kill the fake's session processes in a test HOME (a "reboot": files stay). */
export function killFakeSessions(home: string): void {
  // The account's home, not $HOME (tests point HOME at their temp dir).
  if (path.resolve(home) === path.resolve(os.userInfo().homedir)) {
    throw new Error('not a test HOME');
  }
  const dir = path.join(home, '.claude', 'sessions');
  for (const f of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
    const pid = Number(f.replace(/\.json$/, ''));
    if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid) continue;
    // Only a fake of this home: a dead fake's pid may belong to someone else by now.
    if (!isFakeOf(pid, home)) continue;
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* gone */
    }
  }
}

/**
 * Remove a test HOME. A fake session can still write one last file (a job, a session record) while
 * it exits, so rmdir hits ENOTEMPTY under load; retry instead of failing the afterEach. Public CI
 * still hit it after 8 × 100 ms (10-26, workersOffice L1): a temp HOME left behind is no test failure.
 */
export function removeTestHome(home: string): void {
  try {
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  } catch (err) {
    // ponytail: a writer still busy after 5 s leaves its temp HOME to the OS temp cleanup
    console.warn(`[test] ${home} not removed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export interface EngineCall {
  argv: string[];
  cwd: string;
  /** Names of the variables it got. */
  env: string[];
  /** Engine starts use /dev/null: prompts must go through the messenger attach. */
  stdin?: string;
  t: number;
}

/** The fake engine claude's calls. */
export function engineCalls(home: string): EngineCall[] {
  try {
    return fs
      .readFileSync(path.join(home, 'fake-claude.log'), 'utf-8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as EngineCall);
  } catch {
    return [];
  }
}

/** First word of every logged argv line. */
export function loggedCommands(log: string): string[] {
  try {
    return fs
      .readFileSync(log, 'utf-8')
      .split('\n')
      .filter(Boolean)
      .map((l) => l.split(' ')[0]);
  } catch {
    return [];
  }
}

/** Engine projects (the registry file) in a test HOME: stopped, with their rooms. */
export function writeEngineProjects(
  home: string,
  projects: Array<{ name: string; folder: string; room?: string }>,
): void {
  saveRegistry(
    registryPath(home),
    projects.map((p) => ({ ...p, wantRunning: false })),
  );
}

/** A daemon reads its Claude sessions when the first viewer arrives, so a page opened first sees
 *  characters appear after its layout. Open and close a page once (logging the context in) so the
 *  next one starts from a loaded office. */
export async function warmUpOffice(
  ctx: { newPage(): Promise<Page> },
  daemon: Pick<Daemon, 'loginUrl'>,
  ms = 3_000,
): Promise<void> {
  const warm = await ctx.newPage();
  await warm.goto(await daemon.loginUrl());
  await warm.waitForTimeout(ms);
  await warm.close();
}

/**
 * An engine Codex task written straight into a test HOME's records. A running one needs `pid`, a
 * live process (the worker's job): the daemon then leaves it alone instead of starting a worker.
 */
export function seedCodexTask(
  home: string,
  t: {
    id: string;
    project: string;
    state: 'running' | 'limit' | 'done' | 'failed' | 'stopped';
    started: string;
    ended?: string | null;
    exit?: number | null;
    pid?: number;
    model?: string | null;
    spec?: string;
    title?: string;
    commits?: number | null;
    /** Where Codex works (its worktree); `/work/<project>` by default. */
    dir?: string;
  },
): void {
  const state = path.join(home, '.local/state/cld-gui');
  const jobs = path.join(state, 'jobs');
  const log = path.join(jobs, `${t.id}.log`);
  fs.mkdirSync(jobs, { recursive: true });
  fs.mkdirSync(path.join(state, 'codex'), { recursive: true });
  fs.writeFileSync(log, '');
  const ended = t.ended ?? null;
  if (t.pid) {
    const stat = fs.readFileSync(`/proc/${t.pid}/stat`, 'utf-8');
    fs.writeFileSync(
      path.join(jobs, `${t.id}.json`),
      JSON.stringify({
        id: t.id,
        pid: t.pid,
        pstart: stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19],
        boot: fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf-8').trim(),
        project: t.project,
        cmd: `codex ${t.spec ?? 'T-1.md'}`,
        dir: t.dir ?? `/work/${t.project}`,
        tab: null,
        tty: false,
        log,
        started: t.started,
        ended: null,
        exit: null,
        source: 'cli',
        kind: 'codex',
      }),
    );
  }
  fs.writeFileSync(
    path.join(state, 'codex', `${t.id}.json`),
    JSON.stringify({
      id: t.id,
      project: t.project,
      model: t.model ?? null,
      state: t.state,
      dir: t.dir ?? `/work/${t.project}`,
      worktree: null,
      branch: `codex/${t.id}`,
      base: null,
      spec: `tasks/${t.spec ?? 'T-1.md'}`,
      ...(t.title && { title: t.title }),
      started: t.started,
      ended,
      exit: t.exit ?? null,
      resetAt: null,
      sid: null,
      commits: t.commits ?? 0,
      jobId: t.id,
      log,
      pid: t.pid ?? null,
      source: 'cli',
    }),
  );
}

/**
 * An engine job record in a test HOME. A running one (`ended` unset) needs `pid`, a live process
 * (a `sleep` of the test): the daemon then keeps it running instead of settling it as vanished.
 */
export function seedJob(
  home: string,
  j: {
    pid: number;
    project: string | null;
    cmd: string;
    started: string;
    ended?: string | null;
    exit?: number | null;
    id?: string;
  },
): string {
  const dir = path.join(home, '.local/state/cld-gui/jobs');
  fs.mkdirSync(dir, { recursive: true });
  const id = j.id ?? `1022-${String(j.pid).padStart(6, '0')}-job`;
  const log = path.join(dir, `${id}.log`);
  fs.writeFileSync(log, '');
  let pstart: string | null = null;
  if (!j.ended) {
    const stat = fs.readFileSync(`/proc/${j.pid}/stat`, 'utf-8');
    pstart = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
  }
  fs.writeFileSync(
    path.join(dir, `${id}.json`),
    JSON.stringify({
      id,
      pid: j.pid,
      pstart,
      boot: fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf-8').trim(),
      project: j.project,
      cmd: j.cmd,
      dir: '/work',
      tab: null,
      tty: false,
      log,
      started: j.started,
      ended: j.ended ?? null,
      exit: j.exit ?? null,
      source: 'cli',
    }),
  );
  return id;
}
