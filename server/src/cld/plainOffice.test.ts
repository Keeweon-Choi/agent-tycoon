import * as path from 'path';
import { describe, expect, it } from 'vitest';

import { PlainOffice, restartDaemon } from './plainOffice.js';

const BIN_DIR = path.resolve(__dirname, '../../../cld/bin');

function setup(over: { claude?: string | null; ordered?: boolean; platform?: NodeJS.Platform } = {}) {
  const k = {
    claude: over.claude === undefined ? null : over.claude,
    finds: 0,
    restarts: 0,
    t: 1_000_000,
    sleeps: [] as number[],
    logs: [] as string[],
    sent: [] as Record<string, unknown>[],
  };
  const office = new PlainOffice({
    find: () => (k.finds++, k.claude),
    restart: async () => (k.restarts++, over.ordered ?? true),
    platform: over.platform ?? 'linux',
    now: () => k.t,
    sleep: async (ms) => void k.sleeps.push(ms),
    log: (line) => void k.logs.push(line),
  });
  const hooks = office.hooks();
  const send = (m: Record<string, unknown>) => void k.sent.push(m);
  const ready = async () => {
    hooks.onClientReady!(send);
    await new Promise((r) => setTimeout(r, 0));
  };
  const press = async (privileged: boolean) => {
    hooks.onClientMessage!({ type: 'agentCliRecheck' }, send, privileged);
    await new Promise((r) => setTimeout(r, 0));
  };
  return { k, office, ready, press, hooks, send };
}

describe('PlainOffice decision: plain to full', () => {
  it('a viewer connecting without claude gets the missing notice with this OS command, no restart', async () => {
    const { k, ready } = setup();
    await ready();
    expect(k.sent).toEqual([
      {
        type: 'agentCliState',
        state: 'missing',
        command:
          'curl -fsSL https://claude.ai/install.sh | bash && { case "$SHELL:$(uname)" in */zsh:*) p="$HOME/.zprofile";; */bash:Darwin) p="$HOME/.bash_profile";; *) p="$HOME/.profile";; esac; grep -q \'\\.local/bin\' "$p" 2>/dev/null || printf \'%s\\n\' \'export PATH="$HOME/.local/bin:$PATH" # Added by Agent Tycoon (Claude Code)\' >> "$p"; export PATH="$HOME/.local/bin:$PATH"; claude auth status >/dev/null 2>&1 || claude auth login; }',
      },
      // the install buttons open a shell in this home folder
      expect.objectContaining({ type: 'hostInfo', home: expect.any(String) }),
    ]);
    expect(k.restarts).toBe(0);
  });

  it('the Windows notice carries the PowerShell command', async () => {
    const { k, ready } = setup({ platform: 'win32' });
    await ready();
    expect(k.sent[0]).toMatchObject({ command: 'irm https://claude.ai/install.ps1 | iex' });
  });

  it('claude appearing before the next viewer restarts the daemon (and tells the viewer)', async () => {
    const { k, ready } = setup({ claude: '/h/.local/bin/claude' });
    await ready();
    expect(k.restarts).toBe(1);
    expect(k.sent.filter((m) => m.type === 'agentCliState').map((m) => m.state)).toEqual(['missing', 'restarting', 'failed']); // still alive after the wait
    expect(k.sleeps).toEqual([30_000]);
    expect(k.logs.join('\n')).toContain('restart did not take effect: plain pixel-agents office keeps running');
  });

  it('a restart that could not be ordered fails at once, without the wait', async () => {
    const { k, ready } = setup({ claude: '/c', ordered: false });
    await ready();
    expect(k.sleeps).toEqual([]);
    expect(k.sent.at(-1)).toMatchObject({ state: 'failed' });
  });

  it('viewers look at most once per gap; after a failed restart only the button tries again', async () => {
    const { k, ready, press, send, hooks } = setup({ claude: null });
    await ready();
    await ready();
    expect(k.finds).toBe(1);
    k.t += 6_000;
    hooks.onClientReady!(send);
    expect(k.finds).toBe(2);
    k.claude = '/c';
    k.t += 6_000;
    await press(true); // found: restart, fails
    expect(k.restarts).toBe(1);
    k.t += 60_000;
    await ready(); // failed: a viewer does not retry
    expect(k.restarts).toBe(1);
    await press(true);
    expect(k.restarts).toBe(2);
  });

  it('the button needs the privilege (negative control: an unprivileged press looks at nothing)', async () => {
    const { k, ready, press } = setup();
    await ready();
    const finds = k.finds;
    await press(false);
    expect(k.finds).toBe(finds);
    await press(true);
    expect(k.finds).toBe(finds + 1);
    expect(k.sent.at(-1)).toMatchObject({ state: 'missing', again: true });
  });

  it('a closed viewer hears nothing more', async () => {
    const { k, ready, hooks, send, press } = setup();
    await ready();
    hooks.onClientClosed!(send);
    const n = k.sent.length;
    await press(true);
    expect(k.sent.length).toBe(n);
  });
});

describe('restartDaemon', () => {
  const run = (answers: Record<string, boolean>) => {
    const cmds: string[] = [];
    return {
      cmds,
      run: async (c: string[]) => (cmds.push(c.join(' ')), answers[c[0]] ?? true),
    };
  };

  it('linux: checks the unit, then restarts it', async () => {
    const r = run({});
    let exited = 0;
    const ok = await restartDaemon({
      platform: 'linux',
      home: '/nonexistent-home',
      binDir: BIN_DIR,
      run: r.run,
      exitForSupervisor: () => void exited++,
    });
    expect(ok).toBe(true);
    expect(r.cmds).toEqual([
      'systemctl --user is-enabled cld-gui',
      'systemctl --user restart cld-gui',
    ]);
    expect(exited).toBe(0);
  });

  it('Windows: a hidden helper that waits for the daemon pid and runs the task is spawned BEFORE the daemon ends; no schtasks /Run from here', async () => {
    const r = run({});
    const order: string[] = [];
    let spawned: { cmd: string; args: string[]; opts: Record<string, unknown>; unref: number } | null = null;
    const fakeSpawn = ((cmd: string, args: string[], opts: Record<string, unknown>) => {
      order.push('spawn');
      spawned = { cmd, args, opts, unref: 0 };
      return { unref: () => void spawned!.unref++ };
    }) as never;
    const ok = await restartDaemon({
      platform: 'win32',
      home: 'C:\\nonexistent-home',
      binDir: BIN_DIR,
      run: r.run,
      spawn: fakeSpawn,
      systemRoot: 'C:\\Windows',
      pid: 4321,
      exitForSupervisor: () => void order.push('exit'),
    });
    expect(ok).toBe(true);
    expect(order).toEqual(['spawn', 'exit']);
    expect(r.cmds).toEqual(['schtasks /Query /TN cld-gui']);
    expect(spawned!.cmd).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
    expect(spawned!.args).toEqual([
      '-NoProfile',
      '-Command',
      "Wait-Process -Id 4321 -Timeout 30 -ErrorAction SilentlyContinue; " +
        "for ($i = 0; $i -lt 60 -and (Get-ScheduledTask -TaskName 'cld-gui' -ErrorAction SilentlyContinue).State -eq 'Running'; $i++) { Start-Sleep -Milliseconds 500 }; " +
        'schtasks /Run /TN cld-gui; Start-Sleep -Seconds 5; ' +
        "if ((Get-ScheduledTask -TaskName 'cld-gui' -ErrorAction SilentlyContinue).State -ne 'Running') { schtasks /Run /TN cld-gui }",
    ]);
    expect(spawned!.opts).toEqual({ detached: true, stdio: 'ignore', windowsHide: true });
    expect(spawned!.unref).toBe(1);
  });

  it('Windows negative control: a helper that cannot start leaves the daemon running (no exit)', async () => {
    let exited = 0;
    const ok = await restartDaemon({
      platform: 'win32',
      home: 'C:\\nonexistent-home',
      binDir: BIN_DIR,
      run: run({}).run,
      spawn: (() => {
        throw new Error('ENOENT');
      }) as never,
      exitForSupervisor: () => void exited++,
      log: () => {},
    });
    expect(ok).toBe(false);
    expect(exited).toBe(0);
  });

  it('no registered service: nothing restarted, nothing exited', async () => {
    for (const platform of ['linux', 'win32'] as const) {
      const r = run({ systemctl: false, schtasks: false });
      let exited = 0;
      const logs: string[] = [];
      expect(
        await restartDaemon({
          platform,
          home: '/nonexistent-home',
          binDir: BIN_DIR,
          run: r.run,
          spawn: (() => {
            throw new Error('must not spawn');
          }) as never,
          exitForSupervisor: () => void exited++,
          log: (l) => void logs.push(l),
        }),
      ).toBe(false);
      expect(exited).toBe(0);
      expect(r.cmds).toHaveLength(1);
      expect(logs[0]).toContain('not registered');
    }
  });

  it('no cld/bin: false', async () => {
    expect(
      await restartDaemon({ binDir: null, exitForSupervisor: () => {}, log: () => {} }),
    ).toBe(false);
  });
});
