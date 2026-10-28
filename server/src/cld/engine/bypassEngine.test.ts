import * as fs from 'fs';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import { koText } from '../../../../core/src/cld/serverText.js';
import type { EngineAction, EngineActionKind, EngineActionResult } from '../../../../core/src/messages.js';
import { engineCalls, killFakeSessions, makeEngineHome, removeTestHome } from '../testHome.js';
import { BYPASS_ARGS } from './bypass.js';
import { Engine } from './engine.js';

let cleanup: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanup.reverse()) c();
  cleanup = [];
});

function setup() {
  const { home, claudePath } = makeEngineHome();
  const logs: string[] = [];
  const engine = new Engine({
    claudePath,
    home,
    readOnly: false,
    systemdRun: null,
    binDir: null,
    env: { ...process.env, HOME: home },
    log: (l) => logs.push(l),
    timing: { pollMs: 20, appearMs: 5_000, goneMs: 5_000, debounceMs: 50, watchMs: 0 },
    bypassTiming: { appearMs: 3_000, settleMs: 100, moveMs: 800, pastMs: 1_500, exitMs: 2_000, ctrlCGapMs: 80, pollMs: 25 },
  });
  engine.start();
  cleanup.push(() => {
    engine.dispose();
    killFakeSessions(home);
    removeTestHome(home);
  });
  let n = 0;
  const action = (action: EngineActionKind, name: string, fields: Partial<EngineAction> = {}) =>
    new Promise<EngineActionResult>((resolve) =>
      engine.handle(
        { type: 'engineAction', requestId: `r${++n}`, action, name, ...fields } as unknown as Record<string, unknown>,
        (m) => resolve(m as unknown as EngineActionResult),
        true,
      ),
    );
  const folder = (name: string) => {
    const d = path.join(home, 'work', name);
    fs.mkdirSync(d, { recursive: true });
    return d;
  };
  const bypassRuns = () => engineCalls(home).filter((c) => c.argv.join(' ') === BYPASS_ARGS.join(' '));
  const bgRuns = () => engineCalls(home).filter((c) => c.argv[0] === '--bg');
  return { action, folder, bypassRuns, bgRuns, logs };
}

describe('BYPASS-ACCEPT through the engine', () => {
  it('a bypass project refused for Claude’s warning gets one accepted dialog and one start retry', async () => {
    const s = setup();
    const folder = s.folder('alpha');
    fs.writeFileSync(path.join(folder, '.fake-bypass-needed'), '');
    expect(
      await s.action('add', 'alpha', { folder, permissionMode: 'bypassPermissions' }),
    ).toMatchObject({ ok: true });
    expect(await s.action('start', 'alpha')).toMatchObject({ ok: true, note: koText('bypass_answered') });
    expect(s.bgRuns()).toHaveLength(2);
    expect(s.bypassRuns()).toHaveLength(1);
    expect(s.bypassRuns()[0].cwd).toBe(folder);
    expect(fs.existsSync(path.join(folder, '.fake-bypass-needed'))).toBe(false);
    expect(s.logs).toContain('[cld engine] "alpha": Bypass Permissions warning answered; starting again');
  });

  it('a new bypass folder answers trust and Bypass together and reports both to the person', async () => {
    const s = setup();
    const folder = s.folder('alpha');
    fs.writeFileSync(path.join(folder, '.fake-untrusted'), '');
    fs.writeFileSync(path.join(folder, '.fake-bypass-needed'), '');
    expect(
      await s.action('add', 'alpha', { folder, permissionMode: 'bypassPermissions' }),
    ).toMatchObject({ ok: true });
    expect(await s.action('start', 'alpha')).toMatchObject({
      ok: true,
      note: koText('bypass_trust_answered'),
    });
    expect(s.bgRuns()).toHaveLength(2);
    expect(s.bypassRuns()).toHaveLength(1);
    expect(fs.existsSync(path.join(folder, '.fake-untrusted'))).toBe(false);
    expect(fs.existsSync(path.join(folder, '.fake-bypass-needed'))).toBe(false);
  });

  it('a non-bypass project never reaches the dialog, even when the start output names it', async () => {
    const s = setup();
    const folder = s.folder('alpha');
    fs.writeFileSync(path.join(folder, '.fake-bypass-refusal'), '');
    expect(await s.action('add', 'alpha', { folder })).toMatchObject({ ok: true });
    expect(await s.action('start', 'alpha')).toMatchObject({
      ok: false,
      error: expect.stringContaining(koText('session_start_failed')),
    });
    expect(s.bgRuns()).toHaveLength(1);
    expect(s.bypassRuns()).toHaveLength(0);
  });
});
