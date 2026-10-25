import { spawn } from 'child_process';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';

import { CliArgsError, parseArgs } from '../src/cli.js';
import { CLAUDE_HOOK_EVENTS } from '../src/providers/hook/claude/constants.js';
import { resolvePtyModule } from '../src/terminal/ptyModule.js';

const CLI_BUNDLE = path.join(__dirname, '../../dist/cli.js');
const CLI_START_TIMEOUT_MS = 10_000;

async function getFreePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('Failed to allocate a test port'));
        return;
      }
      server.close((error) => {
        if (error) reject(error);
        else resolve(address.port);
      });
    });
  });
}

async function waitForCondition(check: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + CLI_START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Timed out waiting for bundled CLI startup');
}

async function stopChild(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([
    new Promise<void>((resolve) => child.once('close', () => resolve())),
    new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
  ]);
  if (child.exitCode === null) child.kill('SIGKILL');
}

/** Run the real bundled CLI as a subprocess, returns exit code + output. */
function runCli(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn('node', [CLI_BUNDLE, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 5000,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

describe('parseArgs', () => {
  // 1. No --port -> ephemeral default (unset), never a hardcoded port
  it('defaults port to undefined (ephemeral) when --port is omitted', () => {
    const args = parseArgs([]);
    expect(args.port).toBeUndefined();
    expect(args.host).toBe('127.0.0.1');
  });

  // 2. Valid --port is accepted
  it('accepts a valid --port', () => {
    expect(parseArgs(['--port', '3100']).port).toBe(3100);
    expect(parseArgs(['-p', '8080']).port).toBe(8080);
  });

  // 3. Boundary values are accepted
  it('accepts the boundary ports 1 and 65535', () => {
    expect(parseArgs(['--port', '1']).port).toBe(1);
    expect(parseArgs(['--port', '65535']).port).toBe(65535);
  });

  // 4. Non-numeric --port is rejected (would otherwise become NaN)
  it('rejects a non-numeric --port instead of producing NaN', () => {
    expect(() => parseArgs(['--port', 'not-a-number'])).toThrow(CliArgsError);
  });

  // 5. Zero is rejected (0 means "ephemeral" internally; not a valid explicit choice)
  it('rejects --port 0', () => {
    expect(() => parseArgs(['--port', '0'])).toThrow(CliArgsError);
  });

  // 6. Out-of-range (too high) is rejected
  it('rejects --port 70000 (out of TCP range)', () => {
    expect(() => parseArgs(['--port', '70000'])).toThrow(CliArgsError);
  });

  // 7. Negative is rejected
  it('rejects a negative --port', () => {
    expect(() => parseArgs(['--port', '-1'])).toThrow(CliArgsError);
  });

  // 8. Non-integer (decimal) is rejected
  it('rejects a decimal --port', () => {
    expect(() => parseArgs(['--port', '3100.5'])).toThrow(CliArgsError);
  });

  // 9. A port option without its required operand is rejected, not ignored
  it.each(['--port', '-p'])('rejects %s when its value is missing', (option) => {
    expect(() => parseArgs([option])).toThrow(CliArgsError);
    expect(() => parseArgs([option])).toThrow(/Missing value/);
  });

  // 10. --host is parsed independently of --port
  it('parses --host', () => {
    expect(parseArgs(['--host', '0.0.0.0']).host).toBe('0.0.0.0');
  });

  // 11. ADR-0009 makes the retained --no-terminal switch a harmless no-op.
  it('always disables the standalone terminal', () => {
    expect(parseArgs([]).terminal).toBe(false);
  });

  it('disables the terminal with --no-terminal, independently of other flags', () => {
    expect(parseArgs(['--no-terminal']).terminal).toBe(false);
    expect(parseArgs(['--no-terminal', '--port', '3100'])).toMatchObject({
      terminal: false,
      port: 3100,
    });
  });

  // 12. --allowed-host is repeatable and validated; --rotate-token is a switch
  it('collects repeated --allowed-host values', () => {
    expect(parseArgs([]).allowedHosts).toEqual([]);
    expect(
      parseArgs(['--allowed-host', 'mac.tailnet.ts.net', '--allowed-host', 'other.example'])
        .allowedHosts,
    ).toEqual(['mac.tailnet.ts.net', 'other.example']);
  });

  it('rejects a missing, malformed or wildcard --allowed-host', () => {
    expect(() => parseArgs(['--allowed-host'])).toThrow(/Missing value/);
    expect(() => parseArgs(['--allowed-host', 'evil@127.0.0.1'])).toThrow(CliArgsError);
    expect(() => parseArgs(['--allowed-host', '0.0.0.0'])).toThrow(CliArgsError);
  });

  it('parses --rotate-token', () => {
    expect(parseArgs([]).rotateToken).toBe(false);
    expect(parseArgs(['--rotate-token']).rotateToken).toBe(true);
  });

  it('accepts retired Tailscale trust flags but ignores their identities', () => {
    expect(parseArgs([
      '--trust-tailscale-user',
      'alice@localhost',
      '--trust-tailscale-user',
      'bob@localhost',
    ])).toMatchObject({ legacyTailscaleTrust: true });
    expect(parseArgs(['--trust-tailscale-user'])).toMatchObject({ legacyTailscaleTrust: true });
  });
});

// The TTY consent prompt is gone: first-run consent is asked in the app, as
// one step of the Intro (the server's hooksConsentRequest → the webview's
// IntroBubble, whose consent step renders it verbatim). Its two pinned
// semantics moved with it: "junk must never be read as approval" now lives in
// consentFlow.test.ts (an unrecognized hooksConsentResponse choice
// writes nothing), and the disclosure-content pins live in consentCopy.test.ts
// plus the handshake test asserting the request carries that copy verbatim.

/**
 * These spawn the real bundled dist/cli.js (built by esbuild), not the TS
 * source -- unlike the parseArgs tests above (which only prove importing the
 * module for its exports is side-effect-free), these prove the
 * `require.main === module` guard added to cli.ts still lets `main()` run
 * when the file IS executed directly, i.e. production behavior is intact.
 * Requires `npm run compile` (or `node esbuild.js`) to have produced
 * dist/cli.js first; reported as a loud skip if it hasn't.
 */
describe('dist/cli.js entry-point guard', () => {
  /** These tests spawn the BUNDLED CLI, so they need `npm run compile` to have
   *  run. Reported as a loud skip rather than an early `return`, which Vitest
   *  shows as PASSED with no message — a false green over a test that never
   *  exercised anything. */
  const itBuilt = it.skipIf(!fs.existsSync(CLI_BUNDLE));
  /** The login link prints only when stdout is a terminal: these run the CLI
   *  under a pseudo-terminal, as an operator does by hand. */
  const pty = resolvePtyModule().module;
  const itBuiltTty = it.skipIf(!fs.existsSync(CLI_BUNDLE) || !pty);

  // 11. Direct execution still runs main() (--help exits 0 with usage)
  itBuilt('runs main() when executed directly: --help prints usage and exits 0', async () => {
    const { code, stdout } = await runCli(['--help']);
    expect(code).toBe(0);
    expect(stdout).toContain('Usage: pixel-agents');
  });

  // 12. Direct execution still runs main()'s port validation (rejects before listen())
  itBuilt(
    'runs main() when executed directly: invalid --port exits 1 without starting a server',
    async () => {
      const { code, stderr } = await runCli(['--port', 'not-a-number']);
      expect(code).toBe(1);
      expect(stderr).toContain('Invalid --port');
    },
  );

  /** Spawn the real bundled CLI against an isolated HOME, wait for /api/health,
   *  and hand back its output for assertions. Callers seed `tmpHome` first.
   *  `host` is the literal `--host` operand, so a caller can exercise a wildcard
   *  bind; readiness is always probed over loopback, which every bind serves. */
  async function runCliServer(
    tmpHome: string,
    body: (ctx: { output: () => string; port: number }) => Promise<void>,
    host = '127.0.0.1',
    tty = false,
  ): Promise<void> {
    const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-cli-workspace-'));
    const port = await getFreePort();
    const argv = [CLI_BUNDLE, '--port', port.toString(), '--host', host];
    const env = { ...process.env, HOME: tmpHome, USERPROFILE: tmpHome };
    let output = '';
    let exited = false;
    let stop: () => Promise<void>;
    if (tty) {
      const term = pty!.spawn(process.execPath, argv, {
        name: 'xterm',
        cols: 200,
        rows: 50,
        cwd: workspaceDir,
        env: Object.fromEntries(
          Object.entries(env).filter((e): e is [string, string] => e[1] !== undefined),
        ),
      });
      const gone = new Promise<void>((resolve) => term.onExit(() => resolve()));
      term.onData((data) => (output += data));
      void gone.then(() => (exited = true));
      stop = async () => {
        if (!exited) term.kill();
        await Promise.race([gone, new Promise((resolve) => setTimeout(resolve, 2_000))]);
      };
    } else {
      const child = spawn(process.execPath, argv, {
        cwd: workspaceDir,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()));
      child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()));
      child.on('exit', () => (exited = true));
      stop = () => stopChild(child);
    }
    try {
      await waitForCondition(async () => {
        if (exited) {
          throw new Error(`Bundled CLI exited before startup:\n${output}`);
        }
        try {
          return (await fetch(`http://127.0.0.1:${port.toString()}/api/health`)).ok;
        } catch {
          return false;
        }
      });
      await body({ output: () => output, port });
    } finally {
      await stop();
      fs.rmSync(tmpHome, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
      fs.rmSync(workspaceDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    }
  }

  /** The one line a standalone operator ever sees. Kept as a real regex over
   *  the real stdout, because a helper that reassembled the URL from parts
   *  would be testing the helper. The trailing `\s` makes it wait for a
   *  complete line: stdout arrives in chunks, and a half-delivered URL still
   *  parses as a URL (`http://127.0.0.1:501`). */
  const URL_LINE = /Pixel Agents login: (\S+)\s/;

  function printedUrl(output: string): URL {
    const match = URL_LINE.exec(output);
    if (!match?.[1]) throw new Error(`No server URL in CLI output:\n${output}`);
    return new URL(match[1]);
  }

  /** The token the server actually minted, read from its own discovery file —
   *  an independent witness, so a printed token that drifts from it fails. */
  function mintedToken(tmpHome: string): string {
    const raw = fs.readFileSync(path.join(tmpHome, '.pixel-agents', 'server.json'), 'utf-8');
    return (JSON.parse(raw) as { token: string }).token;
  }

  // The printed URL is the ONLY channel by which a real browser obtains the
  // token, and the token is the whole privilege gate (httpServer.ts
  // standaloneTokenValid). A bare URL, or one carrying the wrong token, ships a
  // silently read-only session: the office renders, and the hooks toggle is
  // refused with no way for the operator to find out why. Nothing else in this
  // repo reads the CLI's stdout, so nothing else can catch that.
  itBuiltTty('prints a URL carrying the token the server actually minted', async () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-cli-url-'));
    await runCliServer(
      tmpHome,
      async ({ output, port }) => {
        await waitForCondition(() => URL_LINE.test(output()));
        const url = printedUrl(output());

        // T-0002: a one-time login code, never the long-lived token.
        expect(url.searchParams.get('token')).toBeNull();
        expect(output()).not.toContain(mintedToken(tmpHome));
        expect(url.pathname).toBe('/login');
        expect(url.port).toBe(port.toString());
        const response = await fetch(url, { redirect: 'manual' });
        expect(response.status).toBe(303);
        expect(response.headers.get('set-cookie')).toContain('cld_session=');
      },
      '127.0.0.1',
      true,
    );
  });

  // Under systemd or nohup stdout is a log file or the journal: a login code,
  // single-use and short-lived as it is, never goes there.
  itBuilt('prints no login code when stdout is not a terminal', async () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-cli-notty-'));
    await runCliServer(tmpHome, async ({ output }) => {
      await waitForCondition(() => output().includes('Login link not printed'));
      expect(output()).not.toMatch(/code=|Pixel Agents login:/);
    });
  });

  // `--host 0.0.0.0` is a BIND target, not an address to browse to: printing
  // `http://0.0.0.0:PORT` hands the operator a URL that is dead on Windows and
  // merely accidental elsewhere (macOS happens to route it to loopback, so
  // "does it load" alone would not catch this — hence the explicit check that
  // the DISPLAYED host is a loopback address). `::` and `''` take the same
  // branch and are left untested here: binding them needs IPv6 on the runner,
  // which is not a property of ours to depend on.
  itBuiltTty('prints a reachable loopback host when bound to the 0.0.0.0 wildcard', async () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-cli-wildcard-'));
    await runCliServer(
      tmpHome,
      async ({ output }) => {
        await waitForCondition(() => URL_LINE.test(output()));
        const url = printedUrl(output());

        expect(url.hostname).not.toBe('0.0.0.0');
        expect(['127.0.0.1', 'localhost', '[::1]', '::1']).toContain(url.hostname);
        expect((await fetch(url, { redirect: 'manual' })).status).toBe(303);
      },
      '0.0.0.0',
      true,
    );
  });

  // Without consent the CLI must start normally and touch nothing — the ask
  // happens in the browser UI, never at startup. This is the inverse of the
  // seeded test below: it pins that the gate actually gates, rather than the
  // install happening to work.
  itBuilt('starts without touching settings.json when consent has not been given', async () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-cli-noconsent-'));
    await runCliServer(tmpHome, async ({ output }) => {
      // Give the startup consent/install path time to have run (it is awaited
      // before the "server running" line, which health readiness follows).
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(fs.existsSync(path.join(tmpHome, '.claude', 'settings.json'))).toBe(false);
      expect(output()).toContain('Hooks disabled in cld-gui');
    });
  });

  // An existing user whose hooks a pre-consent version installed gets ZERO
  // friction: no prompt, just the migration. The startup install is the 14 -> 12
  // migration and it only ever REDUCES scope (UserPromptSubmit and TaskCreated,
  // the two events that forwarded prompt text, go away), so asking would buy
  // this user nothing they do not already have. What it must NOT do is take the
  // opportunity to touch anything else: unrelated settings keys and a
  // third-party hook sharing one of our entries both survive intact.
  // CON-011: standalone cld-gui never installs hooks.
  it.skip('migrates a pre-consent install to 12 events with no prompt', async () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-cli-legacy-'));
    const settingsPath = path.join(tmpHome, '.claude', 'settings.json');
    fs.mkdirSync(path.join(tmpHome, '.claude'), { recursive: true });
    // A legacy install: our command on every event we install today, plus the
    // two we no longer do.
    const ourCommand = `node "${path.join(tmpHome, '.pixel-agents', 'hooks', 'claude-hook.js')}"`;
    const thirdPartyCommand = 'node /elsewhere/other-tool.js';
    const legacyEvents = [...CLAUDE_HOOK_EVENTS, 'UserPromptSubmit', 'TaskCreated'];
    const hooks = Object.fromEntries(
      legacyEvents.map((event) => [
        event,
        [{ matcher: '', hooks: [{ type: 'command', command: ourCommand, timeout: 5 }] }],
      ]),
    ) as Record<string, Array<{ matcher: string; hooks: Array<{ command: string }> }>>;
    // A third-party hook sharing the entry of an event we are dropping: the
    // sweep must take ours out of it and leave theirs.
    hooks['UserPromptSubmit'][0].hooks.unshift({ command: thirdPartyCommand });
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({ permissions: { allow: ['Bash(ls:*)'] }, hooks }, null, 2),
    );

    await runCliServer(tmpHome, async ({ output }) => {
      await waitForCondition(() => output().includes('[Pixel Agents] Hooks installed'));
      const after = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')) as {
        permissions?: unknown;
        hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
      };
      const ourEvents = Object.entries(after.hooks)
        .filter(([, entries]) => entries.some((e) => e.hooks.some((h) => h.command === ourCommand)))
        .map(([event]) => event)
        .sort();
      expect(ourEvents).toEqual([...CLAUDE_HOOK_EVENTS].sort());
      expect(ourEvents).not.toContain('UserPromptSubmit');
      expect(ourEvents).not.toContain('TaskCreated');
      // Untouched neighbours: an unrelated top-level key, and the third-party
      // hook that shared the entry we swept.
      expect(after.permissions).toEqual({ allow: ['Bash(ls:*)'] });
      expect(after.hooks['UserPromptSubmit'][0].hooks).toEqual([{ command: thirdPartyCommand }]);
      // TaskCreated held only ours -> emptied and the key removed entirely.
      expect(after.hooks['TaskCreated']).toBeUndefined();

      const configPath = path.join(tmpHome, '.pixel-agents', 'config.json');
      const consent = (
        JSON.parse(fs.readFileSync(configPath, 'utf-8')) as {
          hooksConsent?: Record<string, string>;
        }
      ).hooksConsent?.claude;
      expect(consent).toBe('granted');

      // ZERO friction: nothing that reads as a question or a deferral was
      // printed. The prompt headline, the [Y/n/never] question, and both
      // no-consent notices would each be a prompt this user must not see.
      expect(output()).not.toContain('needs to add its hooks');
      expect(output()).not.toContain('[Y/n/never]');
      expect(output()).not.toContain('needs one-time approval');
      expect(output()).not.toContain('asked again next time');
    });
  });

  // W5: the hook script is copied BEFORE the settings entries, and a failed
  // copy aborts the install. An entry pointing at a script that does not exist
  // makes Claude Code spawn a dead `node` for every event — worse than nothing.
  // A regular file where the hooks DIRECTORY belongs makes the copy fail
  // (ENOTDIR) without touching the repo's real dist/.
  // CON-011: standalone cld-gui never installs hooks.
  it.skip('writes no hook entries when the hook script cannot be copied', async () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-cli-nocopy-'));
    fs.mkdirSync(path.join(tmpHome, '.pixel-agents'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpHome, '.pixel-agents', 'config.json'),
      JSON.stringify({ hooksConsent: { claude: 'granted' } }),
    );
    // hooks/ is a FILE, so copying into hooks/claude-hook.js fails.
    fs.writeFileSync(path.join(tmpHome, '.pixel-agents', 'hooks'), 'not a directory');

    await runCliServer(tmpHome, async ({ output }) => {
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(fs.existsSync(path.join(tmpHome, '.claude', 'settings.json'))).toBe(false);
      expect(output()).toContain('Hooks NOT installed');
      expect(output()).not.toContain('[Pixel Agents] Hooks installed');
    });
  });

  // CON-011: standalone cld-gui never installs hooks.
  it.skip('installs the bundled hook script from the package root on startup', async () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-cli-home-'));
    const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-cli-workspace-'));
    // The spawned CLI has no TTY, and without prior consent the first-run gate
    // (rightly) skips hook installation there — seed consent so this test can
    // exercise the actual install path.
    fs.mkdirSync(path.join(tmpHome, '.pixel-agents'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpHome, '.pixel-agents', 'config.json'),
      JSON.stringify({ hooksConsent: { claude: 'granted' } }),
    );
    const port = await getFreePort();
    const child = spawn(
      process.execPath,
      [CLI_BUNDLE, '--port', port.toString(), '--host', '127.0.0.1'],
      {
        cwd: workspaceDir,
        env: { ...process.env, HOME: tmpHome, USERPROFILE: tmpHome },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()));

    try {
      await waitForCondition(async () => {
        if (child.exitCode !== null) {
          throw new Error(`Bundled CLI exited before startup:\n${output}`);
        }
        try {
          return (await fetch(`http://127.0.0.1:${port.toString()}/api/health`)).ok;
        } catch {
          return false;
        }
      });

      const installedHook = path.join(tmpHome, '.pixel-agents', 'hooks', 'claude-hook.js');
      await waitForCondition(() => fs.existsSync(installedHook));
      expect(fs.readFileSync(installedHook, 'utf-8')).toContain('#!/usr/bin/env node');
      if (process.platform !== 'win32') {
        expect(fs.statSync(installedHook).mode & 0o100).toBeTruthy();
      }

      const settingsPath = path.join(tmpHome, '.claude', 'settings.json');
      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')) as Record<
        string,
        unknown
      >;
      expect(JSON.stringify(settings)).toContain(installedHook);
    } finally {
      await stopChild(child);
      fs.rmSync(tmpHome, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
      fs.rmSync(workspaceDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    }
  });
});
