import { execFile } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

import type { Page } from '@playwright/test';

import { configDirectory } from '../../server/src/agent-tycoon/configPath';
import {
  CLAUDE_PTY_PROVIDER,
  registryPath,
  saveRegistry,
} from '../../server/src/agent-tycoon/engine/registry';
import { ptyhostPaths } from '../../server/src/agent-tycoon/ptyhost/protocol';
import {
  assertPortFree,
  type Daemon,
  isFakeOf,
  killFakeSessions,
  makeEngineHome,
  makeFakeHome,
  pagePins,
  removeTestHome,
  REPO_ROOT,
  SPARE_PORTS,
  startDaemon,
  testDaemonPath,
  topBarReady,
  waitForDaemon,
} from '../../server/src/agent-tycoon/testHome';
import { arrangeNextClaudeInvocation, type ClaudeMockScenario } from './mock-claude';

export interface RecordedServerMessage {
  type: string;
  [key: string]: unknown;
}

export interface AgtyResult {
  code: number | null;
  stdout: string;
  stderr: string;
  /** stdout as JSON (`AGTY_OUTPUT=json`), or null when it is not. */
  json: unknown;
}

export interface StandaloneSession {
  tmpHome: string;
  port: number;
  hostUrl: string;
  /** The folder of a seeded agent (`<tmpHome>/work/<name>`). */
  agentFolder: (name: string) => string;
  /** A fresh login link of the daemon running now. */
  loginUrl: () => Promise<string>;
  /** `agent-tycoon/bin/agty` as a user of this HOME runs it (`AGTY_OUTPUT=json`), in `cwd` (the HOME by default). */
  agty: (args: string[], opts?: { cwd?: string }) => Promise<AgtyResult>;
  getHostLogs: () => string;
  drainMessages: () => Promise<RecordedServerMessage[]>;
  /** Stop the daemon (the PTY host and its agents live on, as after a real restart). */
  stopHost: () => Promise<void>;
  /** Start the daemon again on the same HOME and port; resolves once it answers. */
  startHost: () => Promise<void>;
  /** Resolves with the exit code once the daemon running now ends (by itself, e.g. AGTY_TEST_RESTART=exit). */
  hostExit: () => Promise<number | null>;
  cleanup: () => Promise<void>;
}

export interface SeededAgent {
  name: string;
  /** The room it sits in; 개발실 by default. */
  room?: string;
  /** Started with the daemon (default true); false is a stopped project. */
  running?: boolean;
}

export interface LaunchStandaloneOptions {
  /** Engine agents (claude-pty) in the registry before the daemon starts. */
  agents?: SeededAgent[];
  /** Scenarios in the mock queue before the daemon starts (`claudeScenario().forAgent(name)...build()`). */
  scenarios?: ClaudeMockScenario[];
  /** A new PC: neither the 접속 방식 nor the new agents' permission mode is chosen yet. */
  firstRun?: boolean;
  /** No Claude Code on PATH (the plain office). */
  noClaude?: boolean;
  /** Extra daemon flags after `--engine on --allow-actions --allow-chat`. */
  cliArgs?: string[];
  /** Extra daemon environment (AGTY_TEST_REMOTE, AGTY_TEST_RESTART, ...). */
  env?: Record<string, string>;
}

/** The phone shell: `test.use({ ...PHONE, standaloneOptions: { ... } })`. */
export const PHONE = {
  viewport: { width: 390, height: 844 },
  hasTouch: true,
  isMobile: true,
} as const;

/** One port per test: `AGTY_E2E_PORT` (a spare port, 18260 and up on this PC) when set, else one the OS
 *  hands out (never 18240 or 18443). */
async function testPort(): Promise<number> {
  const fixed = Number(process.env['AGTY_E2E_PORT']);
  if (fixed) {
    if (!SPARE_PORTS.includes(fixed)) throw new Error('AGTY_E2E_PORT must be 18256-18599');
    await assertPortFree(fixed);
    return fixed;
  }
  return await new Promise((resolve, reject) => {
    const server = net.createServer().once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() =>
        address && typeof address !== 'string'
          ? resolve(address.port)
          : reject(new Error('no free port')),
      );
    });
  });
}

/** Every incoming /ws frame, JSON-parsed, into window.__agentTycoonMessages (drainMessages reads it). */
async function installMessageRecorder(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const recorded: unknown[] = [];
    const Original = window.WebSocket;
    window.WebSocket = new Proxy(Original, {
      construct(target, args) {
        const socket = Reflect.construct(target, args) as WebSocket;
        socket.addEventListener('message', (event) => {
          if (typeof event.data !== 'string') return;
          try {
            recorded.push(JSON.parse(event.data));
          } catch {
            // Not JSON.
          }
        });
        return socket;
      },
    });
    (window as Window & { __agentTycoonMessages?: unknown[] }).__agentTycoonMessages = recorded;
  });
}

async function drainRecordedMessages(page: Page): Promise<RecordedServerMessage[]> {
  return await page.evaluate(() => {
    const store = (window as Window & { __agentTycoonMessages?: unknown[] }).__agentTycoonMessages;
    if (!Array.isArray(store)) return [];
    const drained = store.slice();
    store.length = 0;
    return drained as RecordedServerMessage[];
  });
}

/**
 * A temp HOME (testHome.ts: the engine fake as `<home>/bin/claude`), the daemon on its own port with the
 * engine on, and `page` logged in through the host's login link (what the installer does). The page is
 * ready when the top bar is up (the plain office of `noClaude` and the first-run screens have none: there
 * it is ready at `/`).
 */
export async function launchStandalone(
  page: Page,
  options: LaunchStandaloneOptions = {},
): Promise<StandaloneSession> {
  const made = options.noClaude ? makeFakeHome({ claude: null }) : makeEngineHome();
  const home = made.home;
  const claudePath = options.noClaude ? undefined : made.claudePath;
  const port = await testPort();
  const hostUrl = `http://127.0.0.1:${port}`;
  const config = configDirectory(home);
  // The port, or agty-login, agty-backup and agty-maintenance fall back to 18240 (the real daemon).
  fs.writeFileSync(
    path.join(config, 'config.json'),
    JSON.stringify(options.firstRun ? { port } : { accessChosen: true, port }),
  );
  if (options.firstRun) fs.rmSync(path.join(config, 'new-agent-permission.json'), { force: true });
  fs.mkdirSync(path.join(home, '.claude', 'sessions'), { recursive: true });
  const agentFolder = (name: string) => path.join(home, 'work', name);
  if (options.agents?.length) {
    saveRegistry(
      registryPath(home),
      options.agents.map((a) => {
        fs.mkdirSync(agentFolder(a.name), { recursive: true });
        return {
          name: a.name,
          folder: agentFolder(a.name),
          room: a.room ?? '개발실',
          wantRunning: a.running ?? true,
          provider: CLAUDE_PTY_PROVIDER,
        };
      }),
    );
  }
  for (const scenario of options.scenarios ?? []) await arrangeNextClaudeInvocation(home, scenario);

  const args = ['--engine', 'on', '--allow-actions', '--allow-chat', ...(options.cliArgs ?? [])];
  /** Every start of the daemon (a restart test reads both logs). */
  const daemons: Daemon[] = [];
  const boot = async () => {
    const daemon = startDaemon({ home, claudePath }, port, args, options.env ?? {});
    daemons.push(daemon);
    await waitForDaemon(port, daemon.child.pid!, 30_000, home);
  };
  const daemon = () => daemons[daemons.length - 1];
  const hostLogs = () => daemons.map((d) => d.log.join('')).join('\n--- daemon restarted ---\n');
  const stopHost = async () => {
    await daemon()?.stop();
  };
  const cleanup = async () => {
    await stopHost().catch(() => undefined);
    // The PTY host outlives the daemon on purpose: end it and the fake sessions, only those of this HOME.
    const hostLog = (() => {
      try {
        return fs.readFileSync(ptyhostPaths(home).log, 'utf-8');
      } catch {
        return '';
      }
    })();
    for (const m of hostLog.matchAll(/listening, pid (\d+)/g)) {
      const pid = Number(m[1]);
      if (isFakeOf(pid, home))
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // Gone.
        }
    }
    killFakeSessions(home);
    removeTestHome(home);
  };

  try {
    await boot();
    await page.addInitScript(() => {
      // The page's test-only hooks (window.__agentTycoonTestHooks).
      (window as unknown as { __AGENT_TYCOON_E2E?: boolean }).__AGENT_TYCOON_E2E = true;
    });
    await page.context().addInitScript((pairs) => {
      for (const [key, value] of pairs)
        try {
          if (!localStorage.getItem(key)) localStorage.setItem(key, value);
        } catch {
          // No storage in this page: its defaults stay.
        }
    }, pagePins());
    await installMessageRecorder(page);
    await page.goto(await daemon().loginUrl());
    await page.waitForURL(`${hostUrl}/`);
    if (!options.noClaude && !options.firstRun) await topBarReady(page, 30_000);
    await drainRecordedMessages(page);
  } catch (error) {
    const output = hostLogs();
    await cleanup();
    throw new Error(
      `launchStandalone failed: ${error instanceof Error ? error.message : String(error)}\n--- daemon output ---\n${output || '(none)'}`,
      { cause: error },
    );
  }

  return {
    tmpHome: home,
    port,
    hostUrl,
    agentFolder,
    loginUrl: () => daemon().loginUrl(),
    agty: (cliArgs, opts = {}) =>
      new Promise((resolve) => {
        execFile(
          process.execPath,
          [path.join(REPO_ROOT, 'agent-tycoon/bin/agty'), ...cliArgs],
          {
            cwd: opts.cwd ?? home,
            env: {
              HOME: home,
              PATH: testDaemonPath(claudePath ? [path.dirname(claudePath)] : []),
              AGTY_OUTPUT: 'json',
            },
            encoding: 'utf-8',
            timeout: 60_000,
          },
          (error, stdout, stderr) => {
            let json: unknown = null;
            try {
              json = JSON.parse(stdout);
            } catch {
              // Not JSON.
            }
            const code = error ? (typeof error.code === 'number' ? error.code : null) : 0;
            resolve({ code, stdout, stderr, json });
          },
        );
      }),
    getHostLogs: hostLogs,
    drainMessages: () => drainRecordedMessages(page),
    stopHost,
    startHost: boot,
    hostExit: () => {
      const child = daemon().child;
      if (child.exitCode !== null || child.signalCode !== null)
        return Promise.resolve(child.exitCode);
      return new Promise((resolve) => child.once('exit', (code) => resolve(code)));
    },
    cleanup,
  };
}
