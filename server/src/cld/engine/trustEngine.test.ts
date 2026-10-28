/**
 * AUTO-TRUST through the engine (fake claude, real PTY): a person's 켜기 answers the folder trust
 * question once and starts the project; every failure keeps today's manual message; nothing but a
 * person's privileged office action (or the owner's `agty trust`) ever reaches the trust step.
 */
import * as fs from 'fs';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { koText } from '../../../../core/src/cld/serverText.js';
import type {
  EngineAction,
  EngineActionKind,
  EngineActionResult,
} from '../../../../core/src/messages.js';
import { engineCalls, killFakeSessions, makeEngineHome, removeTestHome } from '../testHome.js';
import { waitFor } from '../waitKit.js';
import { TRUST_NEEDED } from './agents/claude/claude.js';
import { Engine } from './engine.js';
import { TRUST_ARGS } from './trust.js';

vi.setConfig({ testTimeout: 90_000 });

let cleanup: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanup.reverse()) c();
  cleanup = [];
});

function setup(timing: Record<string, number> = {}) {
  const { home, claudePath } = makeEngineHome();
  const logs: string[] = [];
  const seen: boolean[] = [];
  let e: Engine | null = null;
  e = new Engine({
    claudePath,
    home,
    readOnly: false,
    systemdRun: null,
    log: (l) => logs.push(l),
    timing: { pollMs: 20, appearMs: 10_000, goneMs: 10_000, debounceMs: 50, watchMs: 0, ...timing },
    env: { ...process.env, HOME: home },
    binDir: null,
    trustTiming: { appearMs: 3_000, pastMs: 2_000 },
    changed: () => seen.push(!!e?.state().projects.some((p) => p.trusting)),
  });
  e.start();
  const engine = e;
  cleanup.push(() => {
    engine.dispose();
    killFakeSessions(home);
    removeTestHome(home);
  });
  let n = 0;
  const req = (
    action: EngineActionKind,
    name: string,
    fields: Partial<EngineAction> = {},
  ): EngineAction => ({
    type: 'engineAction',
    requestId: `r${++n}`,
    action,
    name,
    ...fields,
  });
  /** The office's /ws path, as a person's browser reaches it. */
  const office = (
    action: EngineActionKind,
    name: string,
    fields: Partial<EngineAction> = {},
    privileged = true,
  ) =>
    new Promise<EngineActionResult>((resolve) =>
      engine.handle(
        req(action, name, fields) as unknown as Record<string, unknown>,
        (m) => resolve(m as unknown as EngineActionResult),
        privileged,
      ),
    );
  /** The CLI's and the MCP tools' path (control.ts, mcpTools via office.ts). */
  const direct = (
    action: EngineActionKind,
    name: string,
    fields: Partial<EngineAction> = {},
    device = 'mcp',
  ) => engine.run(req(action, name, fields), true, device);
  const folder = (name: string, mode?: string) => {
    const d = path.join(home, 'work', name);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, '.fake-untrusted'), '');
    if (mode) fs.writeFileSync(path.join(d, '.fake-trust'), mode);
    return d;
  };
  const project = (name: string) => engine.state().projects.find((p) => p.name === name);
  /** Interactive `claude` runs (no arguments): the trust step. */
  const trustRuns = () => engineCalls(home).filter((c) => c.argv.join(' ') === TRUST_ARGS.join(' '));
  const bgRuns = () => engineCalls(home).filter((c) => c.argv[0] === '--bg');
  return { home, engine, office, direct, folder, project, trustRuns, bgRuns, logs, seen };
}

describe('AUTO-TRUST: a person answers through the office, nobody else', () => {
  it('오케스트레이터 추가: the question answered, the start retried once and on', async () => {
    const s = setup();
    const f = s.folder('alpha');
    const r = await s.office('add', 'alpha', { folder: f });
    expect(r).toMatchObject({ ok: true, note: koText('trust_answered') });
    expect(s.trustRuns()).toHaveLength(1);
    expect(s.trustRuns()[0].cwd).toBe(f);
    expect(s.bgRuns()).toHaveLength(2);
    expect(fs.existsSync(path.join(f, '.fake-untrusted'))).toBe(false);
    expect(s.project('alpha')).toMatchObject({ live: true });
    expect(s.project('alpha')!.needsTrust).toBeUndefined();
    // The card could show 폴더 신뢰 중… while it ran.
    expect(s.seen).toContain(true);
    expect(s.project('alpha')!.trusting).toBeUndefined();
  });

  it('켜기 on a project marked needsTrust (added elsewhere) answers it', async () => {
    const s = setup();
    const f = s.folder('alpha');
    await s.direct('add', 'alpha', { folder: f }, 'cli');
    // Its first 켜기 in the office: not added here, not marked yet: today's message, marked.
    expect(await s.office('start', 'alpha')).toMatchObject({ ok: false, error: TRUST_NEEDED });
    expect(s.project('alpha')!.needsTrust).toBe(true);
    expect(s.trustRuns()).toHaveLength(0);
    expect(await s.office('start', 'alpha')).toMatchObject({
      ok: true,
      note: koText('trust_answered'),
    });
    expect(s.trustRuns()).toHaveLength(1);
  });

  it('every failure keeps the manual message: unknown screen, pre-approvals listed, crash, stuck', async () => {
    const s = setup();
    for (const mode of ['unknown', 'warn', 'crash', 'stuck']) {
      const name = `p-${mode}`;
      const f = s.folder(name, mode);
      expect(await s.office('add', name, { folder: f }), mode).toMatchObject({
        ok: false,
        error: TRUST_NEEDED,
      });
      expect(s.project(name), mode).toMatchObject({ live: false, needsTrust: true });
      expect(fs.existsSync(path.join(f, '.fake-untrusted')), mode).toBe(true);
    }
    // One try per press, and the start was not retried after a failed answer.
    expect(s.trustRuns()).toHaveLength(4);
    expect(s.bgRuns()).toHaveLength(4);
  });

  it('the CLI, an agent’s MCP tool and an unprivileged office client never reach the trust step', async () => {
    const s = setup();
    const f = s.folder('alpha');
    // A non-person add stays off, so each non-person start reaches the same
    // original trust refusal without being answered during add.
    await s.direct('add', 'alpha', { folder: f }, 'test');
    expect(await s.direct('start', 'alpha', {}, 'mcp')).toMatchObject({
      ok: false,
      error: TRUST_NEEDED,
    });
    expect(await s.direct('start', 'alpha', {}, 'cli')).toMatchObject({
      ok: false,
      error: TRUST_NEEDED,
    });
    expect(await s.office('start', 'alpha', {}, false)).toMatchObject({
      ok: false,
      error: koText('no_permission'),
    });
    expect(await s.office('restart', 'alpha', {}, false)).toMatchObject({ ok: false });
    expect(s.trustRuns()).toHaveLength(0);
    expect(s.project('alpha')!.needsTrust).toBe(true);
  });

  it('the watch reviving a session that died never answers it, even for a project added and marked here', async () => {
    const s = setup({ watchMs: 100, adoptMs: 500, reviveGapMs: 50 });
    const f = s.folder('alpha');
    fs.unlinkSync(path.join(f, '.fake-untrusted')); // trusted at first
    await s.office('add', 'alpha', { folder: f }); // added in the office: consented
    expect(await s.office('start', 'alpha')).toMatchObject({ ok: true });
    fs.writeFileSync(path.join(f, '.fake-untrusted'), ''); // Claude no longer trusts it
    const before = s.bgRuns().length;
    killFakeSessions(s.home); // the session died: the watch revives it
    await waitFor(() => expect(s.project('alpha')!.needsTrust).toBe(true), { timeout: 30_000, interval: 25 });
    expect(s.bgRuns().length).toBeGreaterThan(before);
    expect(s.logs.some((l) => l.includes('revive "alpha"'))).toBe(true);
    expect(s.trustRuns()).toHaveLength(0);
  });

  it('agty trust: the owner’s command answers it for a registered folder and can start it', async () => {
    const s = setup();
    const f = s.folder('alpha');
    await s.direct('add', 'alpha', { folder: f }, 'cli');
    expect(
      await s.engine.trustProject({ folder: path.join(f, '..', 'nope') }, false),
    ).toMatchObject({
      ok: false,
      code: 'unknown_project',
    });
    expect(s.trustRuns()).toHaveLength(0);
    const r = await s.engine.trustProject({ folder: f }, true);
    expect(r).toMatchObject({
      ok: true,
      name: 'alpha',
      worker: false,
      trust: { outcome: 'trusted' },
      start: { ok: true },
    });
    expect(s.project('alpha')).toMatchObject({ live: true });
    // Asked again: Claude shows its input line, nothing to answer.
    expect(await s.engine.trustProject({ name: 'alpha' }, false)).toMatchObject({
      ok: true,
      trust: { outcome: 'alreadyTrusted' },
    });
  });
});
