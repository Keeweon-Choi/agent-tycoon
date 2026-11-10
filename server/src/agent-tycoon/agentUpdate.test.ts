/**
 * AGENT-UPDATE: the owner's 업데이트 runs exactly the provider's declared update arguments with the
 * binary the engine resolved, without a shell, with a timeout, and reports `--version` before and
 * after and the CLI's own (capped, masked) last lines. Every CLI here is a fake: an injected run, or
 * a small script that records its argv. Nothing runs the real claude or codex.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  AGENT_CLI_UPDATE_KILL_GRACE_MS,
  AGENT_CLI_UPDATE_LINES,
  AGENT_CLI_UPDATE_TIMEOUT_MS,
  AGENT_CLI_VERSION_TIMEOUT_MS,
} from '../constants.js';
import { AgentUpdate, type AgentUpdateDeps, type CliRun, manualUpdate, runCli, updateLines } from './agentUpdate.js';
import { STEPUP_REQUIRED } from './shell/gate.js';

const tmps: string[] = [];
afterEach(() => {
  for (const d of tmps.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const BIN = '/opt/agents/bin/claude';
const HOME = '/home/owner';

function updater(over: Partial<AgentUpdateDeps> = {}, versions = ['2.1.319', '2.1.320']) {
  let v = 0;
  const run = vi.fn<CliRun>(async (_file, args) =>
    args[0] === '--version'
      ? { code: 0, output: `${versions[Math.min(v++, versions.length - 1)]} (Claude Code)\n` }
      : { code: 0, output: 'Updating...\nSuccessfully updated\n' },
  );
  const cli = vi.fn<AgentUpdateDeps['cli']>((agent) =>
    agent === 'claude' ? { bin: BIN, update: ['update'] } : null,
  );
  const updated = vi.fn();
  const u = new AgentUpdate({ cli, env: () => ({ PATH: '/usr/bin' }), home: HOME, run, updated, ...over });
  const sent: Array<Record<string, unknown>> = [];
  const send = (m: Record<string, unknown>) => {
    sent.push(m);
  };
  return { u, run, cli, sent, send, updated };
}
const owner = { privileged: true, readOnly: false };
const remote = (fresh: boolean) => ({ ...owner, stepUp: { remote: true, fresh: () => fresh } });

describe('AgentUpdate', () => {
  it("runs the provider's declared argv with the engine's binary, a timeout, and versions before and after", async () => {
    const { u, run, cli, sent, send, updated } = updater();
    // A client path or argv is ignored: only `agent` is read.
    await u.handle({ type: 'agentCliUpdate', agent: 'claude', bin: '/tmp/evil', args: ['rm'] }, send, owner);
    expect(cli).toHaveBeenCalledWith('claude');
    expect(run.mock.calls.map((c) => [c[0], c[1], c[2]])).toEqual([
      [BIN, ['--version'], AGENT_CLI_VERSION_TIMEOUT_MS],
      [BIN, ['update'], AGENT_CLI_UPDATE_TIMEOUT_MS],
      [BIN, ['--version'], AGENT_CLI_VERSION_TIMEOUT_MS],
    ]);
    expect(run.mock.calls[1][3]).toEqual({ PATH: '/usr/bin' });
    expect(sent).toEqual([
      { type: 'agentCliUpdateState', agent: 'claude', phase: 'running' },
      {
        type: 'agentCliUpdateState',
        agent: 'claude',
        phase: 'done',
        ok: true,
        before: '2.1.319',
        after: '2.1.320',
        lines: ['Updating...', 'Successfully updated'],
      },
    ]);
    expect(updated).toHaveBeenCalledTimes(1); // the engine re-reads the versions
  });

  it('reports a timed-out update as not ok with error timeout', async () => {
    const run = vi.fn<CliRun>(async (_f, args) =>
      args[0] === '--version' ? { code: 0, output: '0.156.1\n' } : { code: -1, output: 'downloading', timedOut: true },
    );
    const { u, sent, send } = updater({ run });
    await u.handle({ type: 'agentCliUpdate', agent: 'claude' }, send, owner);
    expect(sent.at(-1)).toMatchObject({ phase: 'done', ok: false, error: 'timeout', before: '0.156.1', after: '0.156.1' });
  });

  it('caps the output to its last lines, strips escape codes, masks secrets and shows home as ~', () => {
    const many = Array.from({ length: 50 }, (_, i) => `line ${i}`).join('\n');
    const lines = updateLines(`${many}\n\x1b[32mtoken=abcdef123456\x1b[0m\r\nrun npm i -g x in ${HOME}/lib\n`, HOME);
    expect(lines).toHaveLength(AGENT_CLI_UPDATE_LINES);
    expect(lines.at(-2)).toBe('token=***');
    expect(lines.at(-1)).toBe('run npm i -g x in ~/lib');
  });

  it('refuses a remote session without a fresh step-up, and runs with one (negative control)', async () => {
    const stale = updater();
    await stale.u.handle({ type: 'agentCliUpdate', agent: 'claude' }, stale.send, remote(false));
    expect(stale.sent).toEqual([{ type: 'agentCliUpdateState', agent: 'claude', phase: 'refused', error: STEPUP_REQUIRED }]);
    expect(stale.run).not.toHaveBeenCalled();
    expect(stale.updated).not.toHaveBeenCalled();

    const fresh = updater();
    await fresh.u.handle({ type: 'agentCliUpdate', agent: 'claude' }, fresh.send, remote(true));
    expect(fresh.sent.at(-1)).toMatchObject({ phase: 'done', ok: true });
    expect(fresh.run).toHaveBeenCalledTimes(3);
  });

  it('refuses a read-only daemon and an unprivileged connection', async () => {
    for (const ctx of [{ privileged: true, readOnly: true }, { privileged: false, readOnly: false }]) {
      const { u, run, sent, send } = updater();
      await u.handle({ type: 'agentCliUpdate', agent: 'claude' }, send, ctx);
      expect(sent).toEqual([{ type: 'agentCliUpdateState', agent: 'claude', phase: 'refused', error: 'read_only' }]);
      expect(run).not.toHaveBeenCalled();
    }
  });

  it('refuses a missing CLI and an agent without an update command', async () => {
    const { u, run, sent, send } = updater({
      cli: (agent) => (agent === 'codex' ? { bin: null, update: ['update'] } : null),
    });
    await u.handle({ type: 'agentCliUpdate', agent: 'codex' }, send, owner);
    await u.handle({ type: 'agentCliUpdate', agent: 'acp' }, send, owner);
    expect(sent.map((m) => m.error)).toEqual(['missing', 'unsupported']);
    expect(run).not.toHaveBeenCalled();
  });

  it('runs one update per CLI at a time', async () => {
    let finish!: () => void;
    const run = vi.fn<CliRun>((_f, args) =>
      args[0] === '--version'
        ? Promise.resolve({ code: 0, output: '1.0.0' })
        : new Promise((resolve) => (finish = () => resolve({ code: 0, output: 'ok' }))),
    );
    const { u, sent, send } = updater({ run });
    const first = u.handle({ type: 'agentCliUpdate', agent: 'claude' }, send, owner);
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
    await u.handle({ type: 'agentCliUpdate', agent: 'claude' }, send, owner);
    expect(sent.at(-1)).toMatchObject({ phase: 'refused', error: 'busy' });
    finish();
    await first;
    const second = u.handle({ type: 'agentCliUpdate', agent: 'claude' }, send, owner);
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(5)); // free again: the next update runs
    finish();
    await second;
  });
});

describe('manualUpdate', () => {
  it('finds a package-manager command or a "cannot update itself" line, and nothing in an up-to-date one', () => {
    expect(manualUpdate(['Codex was installed with npm.', 'Update it with your package manager: npm install -g @openai/codex@latest'])).toEqual({
      command: 'npm install -g @openai/codex@latest',
    });
    expect(manualUpdate(['Run `pnpm add -g @anthropic-ai/claude-code`.'])).toEqual({ command: 'pnpm add -g @anthropic-ai/claude-code' });
    expect(manualUpdate(['To update: brew upgrade claude-code'])).toEqual({ command: 'brew upgrade claude-code' });
    expect(manualUpdate(['scoop update codex'])).toEqual({ command: 'scoop update codex' });
    expect(manualUpdate(['This install is managed by your system.'])).toEqual({ command: null });
    expect(manualUpdate(['Current version: 2.1.320', 'Checking for updates...', 'Claude Code is up to date (2.1.320)'])).toBeNull();
    expect(manualUpdate([])).toBeNull();
  });

  it('marks an unchanged version with such a line manual, never a changed one', async () => {
    const say = (output: string, versions: string[]) => {
      let v = 0;
      return vi.fn<CliRun>(async (_f, args) =>
        args[0] === '--version' ? { code: 0, output: versions[Math.min(v++, versions.length - 1)] } : { code: 0, output },
      );
    };
    const npm = 'Claude Code is managed by npm.\nUpdate it with: npm i -g @anthropic-ai/claude-code\n';
    const same = updater({ run: say(npm, ['2.1.319', '2.1.319']) });
    await same.u.handle({ type: 'agentCliUpdate', agent: 'claude' }, same.send, owner);
    expect(same.sent.at(-1)).toMatchObject({ phase: 'done', ok: true, manual: true, command: 'npm i -g @anthropic-ai/claude-code' });

    const moved = updater({ run: say(npm, ['2.1.319', '2.1.320']) });
    await moved.u.handle({ type: 'agentCliUpdate', agent: 'claude' }, moved.send, owner);
    expect(moved.sent.at(-1)).not.toHaveProperty('manual');

    const latest = updater({ run: say('Claude Code is up to date (2.1.319)\n', ['2.1.319', '2.1.319']) });
    await latest.u.handle({ type: 'agentCliUpdate', agent: 'claude' }, latest.send, owner);
    expect(latest.sent.at(-1)).not.toHaveProperty('manual');
  });
});

describe.skipIf(process.platform === 'win32')('runCli (a fake CLI script)', () => {
  const fakeCli = (body: string) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agty-agent-update-'));
    tmps.push(dir);
    const file = path.join(dir, 'fake-cli');
    fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    return { dir, file };
  };

  it('passes the argv as written, no shell, and returns stdout with stderr', async () => {
    const { dir, file } = fakeCli(`printf '%s\\n' "$@" > "${'$'}{0%/*}/argv"; echo out; echo err >&2`);
    const r = await runCli(file, ['update', '$(touch pwned)', ';', 'x'], 5_000, { PATH: '/usr/bin:/bin' });
    expect(r.code).toBe(0);
    expect(r.output).toContain('out');
    expect(r.output).toContain('err');
    expect(fs.readFileSync(path.join(dir, 'argv'), 'utf8').split('\n').filter(Boolean)).toEqual([
      'update',
      '$(touch pwned)',
      ';',
      'x',
    ]);
    expect(fs.existsSync(path.join(dir, 'pwned'))).toBe(false);
  });

  it('a fake CLI that exits 0 but says a package manager owns it: manual, with its command', async () => {
    const { file } = fakeCli(
      `[ "$1" = --version ] && { echo '2.1.319 (Claude Code)'; exit 0; }\necho 'Claude Code was installed with pnpm and cannot update itself.'\necho 'Run: pnpm add -g @anthropic-ai/claude-code@latest'\nexit 0`,
    );
    const sent: Array<Record<string, unknown>> = [];
    const u = new AgentUpdate({
      cli: () => ({ bin: file, update: ['update'] }),
      env: () => ({ PATH: '/usr/bin:/bin' }),
      home: HOME,
    });
    await u.handle({ type: 'agentCliUpdate', agent: 'claude' }, (m) => void sent.push(m), owner);
    expect(sent.at(-1)).toMatchObject({
      phase: 'done',
      ok: true,
      before: '2.1.319',
      after: '2.1.319',
      manual: true,
      command: 'pnpm add -g @anthropic-ai/claude-code@latest',
    });
  });

  it('stops a CLI that outlives its timeout', async () => {
    const { file } = fakeCli('exec sleep 30');
    const started = Date.now();
    const r = await runCli(file, ['update'], 300, { PATH: '/usr/bin:/bin' });
    expect(r.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it('also ends a CLI that ignores SIGTERM while a child of it holds the pipes', async () => {
    const { file } = fakeCli("trap '' TERM\nsleep 8\necho late");
    const started = Date.now();
    const r = await runCli(file, ['update'], 200, { PATH: '/usr/bin:/bin' });
    expect(r.timedOut).toBe(true);
    expect(r.output).not.toContain('late');
    expect(Date.now() - started).toBeLessThan(AGENT_CLI_UPDATE_KILL_GRACE_MS + 3_000);
  }, 15_000);
});
