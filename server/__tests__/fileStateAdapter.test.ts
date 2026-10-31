import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PersistedAgent } from '../../core/src/schemas.js';

// Mock os.homedir() so the adapter resolves to an isolated temp dir on every
// platform. Overriding process.env.HOME is not portable: os.homedir() reads
// USERPROFILE on Windows, so a HOME-only override would still hit the real
// home directory.
let tempHome: string;
vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  return { ...actual, homedir: () => tempHome };
});

// Must import AFTER mock setup.
const { FileStateAdapter } = await import('../src/fileStateAdapter.js');
const { getHooksEnabled, setHooksEnabled } = await import('../src/configPersistence.js');
const { officeFile } = await import('../src/officeFolder.js');

describe('FileStateAdapter', () => {
  beforeEach(() => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-adapter-test-'));
  });

  afterEach(() => {
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  // ── Settings (shared config.json, per-namespace section) ────

  it('returns defaults when config file does not exist', () => {
    const adapter = new FileStateAdapter({ namespace: 'standalone' });
    expect(adapter.getSetting('agent-tycoon.soundEnabled', false)).toBe(true);
    expect(adapter.getSetting('agent-tycoon.watchAllSessions', true)).toBe(false);
    expect(adapter.getSetting('agent-tycoon.lastSeenVersion', 'x')).toBe('');
  });

  it('round-trips each namespaced setting key (hooksEnabled moved to the per-provider map)', () => {
    const adapter = new FileStateAdapter({ namespace: 'standalone' });

    adapter.setSetting('agent-tycoon.soundEnabled', false);
    adapter.setSetting('agent-tycoon.lastSeenVersion', '1.3');
    adapter.setSetting('agent-tycoon.alwaysShowLabels', true);
    adapter.setSetting('agent-tycoon.watchAllSessions', true);
    adapter.setSetting('agent-tycoon.hooksInfoShown', true);
    adapter.setSetting('agent-tycoon.bypassPermissions', true);

    expect(adapter.getSetting('agent-tycoon.soundEnabled', true)).toBe(false);
    expect(adapter.getSetting('agent-tycoon.lastSeenVersion', '')).toBe('1.3');
    expect(adapter.getSetting('agent-tycoon.alwaysShowLabels', false)).toBe(true);
    expect(adapter.getSetting('agent-tycoon.watchAllSessions', false)).toBe(true);
    expect(adapter.getSetting('agent-tycoon.hooksInfoShown', false)).toBe(true);

    // hooksEnabled is deliberately NOT an adapter key any more: it is
    // per-provider and machine-global, so the adapter ignores it and the
    // per-provider accessors own it.
    adapter.setSetting('agent-tycoon.hooksEnabled', false);
    expect(adapter.getSetting('agent-tycoon.hooksEnabled', true)).toBe(true);
    setHooksEnabled('claude', false);
    expect(getHooksEnabled('claude')).toBe(false);
    expect(adapter.getSetting('agent-tycoon.bypassPermissions', false)).toBe(true);
  });

  it('defaults bypassPermissions to off', () => {
    const standalone = new FileStateAdapter({ namespace: 'standalone' });

    expect(standalone.getSetting('agent-tycoon.bypassPermissions', true)).toBe(false);

    standalone.setSetting('agent-tycoon.bypassPermissions', true);

    expect(standalone.getSetting('agent-tycoon.bypassPermissions', false)).toBe(true);
  });

  it("reads the removed extension's vscode section and does not write it back", () => {
    fs.mkdirSync(path.join(tempHome, '.pixel-agents'), { recursive: true });
    fs.writeFileSync(
      path.join(tempHome, '.pixel-agents', 'config.json'),
      JSON.stringify({ vscode: { watchAllSessions: true }, standalone: { soundEnabled: false } }),
    );
    const standalone = new FileStateAdapter({ namespace: 'standalone' });
    expect(standalone.getSetting('agent-tycoon.soundEnabled', true)).toBe(false);

    standalone.setSetting('agent-tycoon.watchAllSessions', false);

    const parsed = JSON.parse(
      fs.readFileSync(officeFile('config.json', tempHome), 'utf-8'),
    ) as Record<string, Record<string, unknown>>;
    expect(parsed.vscode).toBeUndefined();
    expect(parsed.standalone).toMatchObject({ soundEnabled: false, watchAllSessions: false });
  });

  it('ignores unknown setting keys (returns default, does not write)', () => {
    const adapter = new FileStateAdapter({ namespace: 'standalone' });
    expect(adapter.getSetting('agent-tycoon.unknownKey', 'fallback')).toBe('fallback');
    adapter.setSetting('agent-tycoon.unknownKey', 'ignored');
    const configPath = officeFile('config.json', tempHome);
    expect(fs.existsSync(configPath)).toBe(false);
  });

  it('accepts setting keys with or without the agent-tycoon. prefix', () => {
    const adapter = new FileStateAdapter({ namespace: 'standalone' });
    adapter.setSetting('agent-tycoon.soundEnabled', false);
    expect(adapter.getSetting('soundEnabled', true)).toBe(false);
    adapter.setSetting('lastSeenVersion', '1.0');
    expect(adapter.getSetting('agent-tycoon.lastSeenVersion', '')).toBe('1.0');
  });

  it('persists settings under namespace in config.json with clean field names', () => {
    const adapter = new FileStateAdapter({ namespace: 'standalone' });
    adapter.setSetting('agent-tycoon.soundEnabled', false);
    const configPath = officeFile('config.json', tempHome);
    const raw = fs.readFileSync(configPath, 'utf-8');
    const parsed = JSON.parse(raw) as Record<string, Record<string, unknown>>;
    expect(parsed.standalone.soundEnabled).toBe(false);
    expect(parsed.standalone['agent-tycoon.soundEnabled']).toBeUndefined();
  });

  // ── Per-namespace state file (agents + seats) ───────────────

  it('returns empty arrays/objects when state file does not exist', () => {
    const adapter = new FileStateAdapter({ namespace: 'standalone' });
    expect(adapter.loadAgents()).toEqual([]);
    expect(adapter.loadSeats()).toEqual({});
  });

  it('round-trips agents to the namespace-specific state file', () => {
    const adapter = new FileStateAdapter({ namespace: 'standalone' });
    const agents: PersistedAgent[] = [
      {
        id: 1,
        sessionId: 'sess-1',
        terminalName: 'Claude Code #1',
        jsonlFile: '/tmp/sess-1.jsonl',
        projectDir: '/tmp/proj',
      },
    ];
    adapter.saveAgents(agents);
    expect(adapter.loadAgents()).toEqual(agents);
  });

  it('writes state at <office folder>/<namespace>-state.json', () => {
    const adapter = new FileStateAdapter({ namespace: 'standalone' });
    adapter.saveSeats({ '1': { palette: 2, hueShift: 45 } });
    expect(fs.existsSync(officeFile('standalone-state.json', tempHome))).toBe(true);
  });

  it('preserves seats when saving agents (and vice versa)', () => {
    const adapter = new FileStateAdapter({ namespace: 'standalone' });
    adapter.saveSeats({ '1': { palette: 3 } });
    adapter.saveAgents([{ id: 1, terminalName: 'x', jsonlFile: '/x.jsonl', projectDir: '/tmp' }]);
    expect(adapter.loadSeats()).toEqual({ '1': { palette: 3 } });
    expect(adapter.loadAgents()).toHaveLength(1);
  });
});
