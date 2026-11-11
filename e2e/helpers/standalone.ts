import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { expect, type Page } from '@playwright/test';

import { type HookServerConfig, waitForHookServer } from './hooks';

const REPO_ROOT = path.join(__dirname, '../..');
const STANDALONE_CLI = path.resolve(REPO_ROOT, 'dist', 'cli.js');
const MOCK_CLAUDE_PATH = path.join(REPO_ROOT, 'e2e/fixtures/mock-claude');
const MOCK_CLAUDE_CMD_PATH = path.join(REPO_ROOT, 'e2e/fixtures/mock-claude.cmd');
const MOCK_CLAUDE_RUNNER_PATH = path.join(REPO_ROOT, 'e2e/fixtures/mock-claude-runner.cjs');
const TAIL_FOLLOW_PATH = path.join(REPO_ROOT, 'e2e/fixtures/tail-follow.cjs');

export interface RecordedServerMessage {
  type: string;
  [key: string]: unknown;
}

export interface StandaloneSession {
  tmpHome: string;
  workspaceDir: string;
  hostUrl: string;
  hookServerConfig: HookServerConfig;
  /** Invocation log the mock claude appends to (under tmpHome/.claude-mock).
   *  Only ever written when the session was launched with mockClaude: true. */
  mockLogFile: string;
  getHostLogs: () => string;
  cleanup: () => Promise<void>;
  drainMessages: () => Promise<RecordedServerMessage[]>;
  /** Stop the host process, breaking its WebSocket connections, without disposing
   *  the browser page or its recorded message buffer. Fallback for tests that need
   *  to observe a real connection drop when `context.setOffline` does not reliably
   *  close an already-open WebSocket (Chromium-version dependent). */
  stopHost: () => Promise<void>;
  /** Restart the host on the SAME port after `stopHost`, so the already-connected
   *  browser page's exponential-backoff retry succeeds again. */
  startHost: () => Promise<void>;
}

export interface LaunchStandaloneOptions {
  /** Reuse an existing isolated HOME (for cross-surface multi-server tests).
   *  A supplied directory is never removed by standalone cleanup. */
  homeDir?: string;
  /** Reuse an existing workspace. A supplied directory is never removed by
   *  standalone cleanup. */
  workspaceDir?: string;
  /** Pre-seed a granted Claude hooksConsent entry so the first-run dialog never
   *  covers the office (default). The consent specs opt out with `false` —
   *  they are the only ones that want the dialog. Never overwrites a
   *  config.json that already exists (a shared HOME was seeded by its owner). */
  seedHooksConsent?: boolean;
  /** Extra CLI flags appended to the host spawn (e.g. ['--no-terminal']). */
  cliArgs?: string[];
  /** Install the mock `claude` into an isolated bin dir and prepend it to the
   *  host's PATH, so agents launched from the browser spawn the scenario
   *  runner in the host's PTY instead of a real Claude CLI. */
  mockClaude?: boolean;
  /** Browser viewport (default 1280×800, the desktop shell). A phone-sized
   *  viewport renders the mobile shell instead. */
  viewport?: { width: number; height: number };
  /** Pre-seed `~/.pixel-agents/layout.json` before the host starts (see
   *  helpers/layout-seed.ts — it must carry a high layoutRevision). */
  seedLayout?: unknown;
  /** Extra top-level fields for the seeded `~/.pixel-agents/config.json`
   *  (e.g. `directories`), merged over the baseline (consent, and the start
   *  directory shown in the drawer). Ignored when the file already exists (a
   *  shared HOME was seeded by its owner). */
  seedConfig?: Record<string, unknown>;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getFreePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Failed to allocate a free port'));
        return;
      }
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(address.port);
      });
    });
  });
}

async function waitForHttpOk(url: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
      lastError = new Error(`GET ${url} returned ${response.status.toString()}`);
    } catch (error) {
      lastError = error;
    }
    await delay(100);
  }
  throw lastError instanceof Error ? lastError : new Error(`Timed out waiting for ${url}`);
}

/**
 * Copy the mock `claude` into a bin dir inside the isolated HOME. The wrapper
 * resolves its sibling scripts (mock-claude-runner.cjs, tail-follow.cjs)
 * relative to its own dir, so both must live alongside it. Returns the bin dir to
 * prepend to the host's PATH.
 */
function installMockClaudeBin(homeDir: string): string {
  const binDir = path.join(homeDir, 'mock-bin');
  fs.mkdirSync(binDir, { recursive: true });
  const binaryPath = path.join(binDir, process.platform === 'win32' ? 'claude.cmd' : 'claude');
  if (process.platform === 'win32') {
    fs.copyFileSync(MOCK_CLAUDE_CMD_PATH, binaryPath);
  } else {
    fs.copyFileSync(MOCK_CLAUDE_PATH, binaryPath);
    fs.chmodSync(binaryPath, 0o755);
  }
  fs.copyFileSync(MOCK_CLAUDE_RUNNER_PATH, path.join(binDir, 'mock-claude-runner.cjs'));
  fs.copyFileSync(TAIL_FOLLOW_PATH, path.join(binDir, 'tail-follow.cjs'));
  return binDir;
}

/**
 * Spawn our standalone CLI (dist/cli.js). The CLI serves both the SPA and the
 * /ws WebSocket on the same port; tests connect Playwright's chromium to that
 * single origin. Workspace dir is communicated via process.cwd() since our CLI
 * doesn't take a --workspace-dir flag.
 */
function spawnStandaloneHost(args: {
  homeDir: string;
  hostPort: number;
  workspaceDir: string;
  cliArgs?: string[];
  mockClaude?: boolean;
}): ChildProcessWithoutNullStreams {
  if (!fs.existsSync(STANDALONE_CLI)) {
    throw new Error(
      `Standalone CLI not built at ${STANDALONE_CLI}. Run 'npm run compile' before standalone e2e tests.`,
    );
  }
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: args.homeDir,
    USERPROFILE: args.homeDir,
    // Never the caller's Claude account: the usage reading takes the token from here.
    CLAUDE_CONFIG_DIR: path.join(args.homeDir, '.claude'),
  };
  if (args.mockClaude) {
    // The host's PTYs inherit its env, so a browser-launched `claude` resolves
    // to the mock. AGENT_TYCOON_NODE_BIN keeps the wrapper on this exact node.
    const binDir = installMockClaudeBin(args.homeDir);
    env.PATH = `${binDir}${path.delimiter}${process.env.PATH ?? ''}`;
    env.AGENT_TYCOON_NODE_BIN = process.execPath;
  }
  return spawn(
    process.execPath,
    [
      STANDALONE_CLI,
      '--port',
      args.hostPort.toString(),
      '--host',
      '127.0.0.1',
      ...(args.cliArgs ?? []),
    ],
    {
      cwd: args.workspaceDir,
      env,
      stdio: 'pipe',
    },
  );
}

async function stopProcess(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.killed) {
    return;
  }
  child.kill('SIGTERM');
  await Promise.race([
    new Promise<void>((resolve) => child.once('exit', () => resolve())),
    delay(2_000),
  ]);
  if (child.exitCode === null && !child.killed) {
    child.kill('SIGKILL');
    await Promise.race([
      new Promise<void>((resolve) => child.once('exit', () => resolve())),
      delay(1_000),
    ]);
  }
}

/**
 * Install a WebSocket recorder BEFORE page navigation. Proxies window.WebSocket
 * so every incoming message frame is JSON-parsed and pushed to
 * window.__agentTycoonMessages, which drainMessages() reads from.
 */
async function installMessageRecorder(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const recordedMessages: unknown[] = [];
    const OriginalWebSocket = window.WebSocket;
    const RecordingWebSocket = new Proxy(OriginalWebSocket, {
      construct(target, args) {
        const socket = Reflect.construct(target, args) as WebSocket;
        socket.addEventListener('message', (event) => {
          if (typeof event.data !== 'string') {
            return;
          }
          try {
            recordedMessages.push(JSON.parse(event.data));
          } catch {
            // Ignore non-JSON frames.
          }
        });
        return socket;
      },
    });
    window.WebSocket = RecordingWebSocket as typeof WebSocket;
    (window as Window & { __agentTycoonMessages?: unknown[] }).__agentTycoonMessages =
      recordedMessages;
  });
}

async function drainRecordedMessages(page: Page): Promise<RecordedServerMessage[]> {
  return await page.evaluate(() => {
    const store = (window as Window & { __agentTycoonMessages?: unknown[] }).__agentTycoonMessages;
    if (!Array.isArray(store)) {
      return [];
    }
    const drained = store.slice();
    store.length = 0;
    return drained as RecordedServerMessage[];
  });
}

/**
 * The URL an operator opens: the daemon's login link.
 *
 * The daemon no longer prints a URL (since 2026-10-21 it prints a login link only on a terminal,
 * and a code never goes into a log). The channels a real operator has are the installer's and
 * `agty-login`'s: POST /api/login-code with the host token, then follow `/login?code=` in the
 * browser, which trades the one-time code for a session cookie. This does exactly that.
 *
 * The host token is read from server.json (where the real hook script reads it too); the BROWSER
 * only ever gets what the code buys, never the host token itself, so the suite still fails over a
 * login that does not log a browser in.
 */
async function mintLoginUrl(hostUrl: string, token: string): Promise<string> {
  const response = await fetch(`${hostUrl}/api/login-code`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = (await response.json().catch(() => null)) as { code?: unknown } | null;
  if (!response.ok || typeof body?.code !== 'string') {
    throw new Error(`POST ${hostUrl}/api/login-code returned ${response.status.toString()}`);
  }
  return `${hostUrl}/login?code=${encodeURIComponent(body.code)}`;
}

/** Open the SPA the way the operator does: by following the login link. */
async function openStandalonePage(page: Page, loginUrl: string): Promise<void> {
  await page.goto(loginUrl);
  await expect(page.getByRole('button', { name: 'Settings' })).toBeVisible({ timeout: 30_000 });
}

export async function launchStandalone(
  page: Page,
  options: LaunchStandaloneOptions = {},
): Promise<StandaloneSession> {
  const ownsHome = options.homeDir === undefined;
  const ownsWorkspace = options.workspaceDir === undefined;
  const tmpHome =
    options.homeDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'pixel-standalone-e2e-home-'));
  const workspaceDir =
    options.workspaceDir ??
    fs.mkdtempSync(path.join(os.tmpdir(), 'pixel-standalone-e2e-workspace-'));
  fs.mkdirSync(tmpHome, { recursive: true });
  fs.mkdirSync(workspaceDir, { recursive: true });
  // Consent baseline: without it the CLI
  // asks over the tokened /ws handshake and the in-app dialog covers the
  // office in every spec. Only when the file does not exist yet — a shared
  // HOME (multi-server) was already seeded by the surface that owns it.
  const configPath = path.join(tmpHome, '.pixel-agents', 'config.json');
  if (!fs.existsSync(configPath)) {
    // The start directory is shown: the product hides host Directories by
    // default, and the launch specs click its drawer row. A spec about the
    // default overrides `standalone` through seedConfig.
    const seeded = {
      standalone: { showHostDirectories: true },
      ...((options.seedHooksConsent ?? true) ? { hooksConsent: { claude: 'granted' } } : {}),
      ...options.seedConfig,
    };
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify(seeded, null, 2));
  }
  // The first-run "Choose how to connect" screen covers the office on a host's first open on localhost;
  // an operator who picked a way (or "later") is not asked again. The access settings live in the
  // settings directory, next to the office folder (remote/index.ts accessChosen).
  const accessConfigPath = path.join(tmpHome, '.config', 'agent-tycoon', 'config.json');
  if (!fs.existsSync(accessConfigPath)) {
    fs.mkdirSync(path.dirname(accessConfigPath), { recursive: true });
    fs.writeFileSync(accessConfigPath, JSON.stringify({ accessChosen: true }, null, 2));
  }
  if (options.seedLayout !== undefined) {
    const layoutPath = path.join(tmpHome, '.pixel-agents', 'layout.json');
    fs.mkdirSync(path.dirname(layoutPath), { recursive: true });
    fs.writeFileSync(layoutPath, JSON.stringify(options.seedLayout, null, 2));
  }
  const hostPort = await getFreePort();
  const hostUrl = `http://127.0.0.1:${hostPort}`;

  let hostStdout = '';
  let hostStderr = '';
  function spawnAndAttach(): ChildProcessWithoutNullStreams {
    const proc = spawnStandaloneHost({
      homeDir: tmpHome,
      hostPort,
      workspaceDir,
      cliArgs: options.cliArgs,
      mockClaude: options.mockClaude,
    });
    proc.stdout.on('data', (chunk) => {
      hostStdout += chunk.toString();
    });
    proc.stderr.on('data', (chunk) => {
      hostStderr += chunk.toString();
    });
    return proc;
  }
  let hostProcess = spawnAndAttach();

  try {
    await page.setViewportSize(options.viewport ?? { width: 1280, height: 800 });
    // Mark this as the e2e harness before navigation so the standalone webview
    // installs its test-only observability hooks (window.__agentTycoonTestHooks).
    await page.addInitScript(() => {
      (window as unknown as { __AGENT_TYCOON_E2E?: boolean }).__AGENT_TYCOON_E2E = true;
    });
    await page.context().addInitScript(() => {
      try {
        // The specs read the terminal from xterm's DOM rows; a pane otherwise draws with WebGL.
        localStorage.setItem('agty.terminal-renderer', 'dom');
        // The specs click where the upstream camera puts things (no auto framing).
        localStorage.setItem('agty.camera-mode', 'off');
        localStorage.setItem('agty.title-scene', 'off'); // no title scene over the office
      } catch {
        // No storage (about:blank): nothing to pin there.
      }
    });
    await installMessageRecorder(page);
    await waitForHttpOk(`${hostUrl}/api/health`);
    // The hook-endpoint Bearer token is a different channel and legitimately
    // read from the registry — that is where the real hook script reads it too.
    // The BROWSER's capability may only come from the login link below.
    const hookServerConfig = await waitForHookServer(tmpHome);
    await openStandalonePage(page, await mintLoginUrl(hostUrl, hookServerConfig.token));
    await drainRecordedMessages(page);

    return {
      tmpHome,
      workspaceDir,
      hostUrl,
      hookServerConfig,
      mockLogFile: path.join(tmpHome, '.claude-mock', 'invocations.log'),
      getHostLogs: () =>
        [hostStdout.trim(), hostStderr.trim()].filter((value) => value.length > 0).join('\n'),
      drainMessages: () => drainRecordedMessages(page),
      stopHost: async () => {
        await stopProcess(hostProcess);
      },
      startHost: async () => {
        hostProcess = spawnAndAttach();
        await waitForHttpOk(`${hostUrl}/api/health`);
      },
      cleanup: async () => {
        await stopProcess(hostProcess);
        if (ownsHome) fs.rmSync(tmpHome, { recursive: true, force: true });
        if (ownsWorkspace) fs.rmSync(workspaceDir, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await stopProcess(hostProcess);
    if (ownsHome) fs.rmSync(tmpHome, { recursive: true, force: true });
    if (ownsWorkspace) fs.rmSync(workspaceDir, { recursive: true, force: true });
    // Setup failures never reach the fixture's log-attaching teardown, so fold
    // the host's output into the error itself — otherwise a host that dies at
    // boot on CI leaves nothing to diagnose but a connection-refused message.
    const hostLogs = [hostStdout.trim(), hostStderr.trim()]
      .filter((value) => value.length > 0)
      .join('\n');
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `launchStandalone failed: ${message}\n--- standalone host output ---\n${
        hostLogs.length > 0 ? hostLogs : '(none)'
      }`,
      { cause: error },
    );
  }
}
