/**
 * FEAT-AGENTS-NEUTRAL-1: the UI turns features on by what an agent can do (engineState.agentCaps),
 * never by who it is; a missing capability reads the same sentence for every agent.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { beforeEach, describe, expect, it } from 'vitest';

import type { EngineAgentCaps } from '../../core/src/messages.js';
import {
  capsOf,
  choosesPermission,
  meteredTag,
  noLimitsText,
  takesDirectChat,
} from '../src/agent-tycoon/engine.js';
import { agentLogo, INITIAL_ONLY, KNOWN_AGENTS, markHue } from '../src/agent-tycoon/icons/agentLogos.js';
import { setLanguage } from '../src/i18n/index.js';

const session: EngineAgentCaps = {
  approvalPolicy: ['default', 'plan'],
  attach: 'pty',
  lifetime: 'session',
  limits: true,
  usageRefresh: false,
  context: true,
  billing: 'plan',
};
const run: EngineAgentCaps = {
  approvalPolicy: ['never'],
  lifetime: 'run',
  limits: false,
  usageRefresh: false,
  context: false,
  billing: 'metered',
};

describe('capability checks', () => {
  beforeEach(() => setLanguage('ko'));

  it('reads the provider an EngineProject names, Claude when it names none; nothing before the engine says', () => {
    const state = { agentCaps: { claude: session, anyone: run } };
    expect(capsOf(state, undefined)).toBe(session);
    expect(capsOf(state, 'anyone')).toBe(run);
    expect(capsOf(null, 'anyone')).toBeUndefined();
  });

  it('a missing capability shows the one neutral sentence; unknown caps keep every feature', () => {
    expect(noLimitsText(run)).toBe('이 에이전트는 한도를 알려 주지 않아요');
    expect(noLimitsText(session)).not.toBe(noLimitsText(run)); // reports limits, not read yet
    expect(noLimitsText(undefined)).toBe(noLimitsText(session));
    expect([takesDirectChat(session), takesDirectChat(run), takesDirectChat(undefined)]).toEqual([
      true,
      false,
      true,
    ]);
    expect([
      choosesPermission(session),
      choosesPermission(run),
      choosesPermission(undefined),
    ]).toEqual([true, false, true]);
  });

  it('an agent billed per use wears the 유료 API tag, by its billing capability alone', () => {
    expect(meteredTag(run)).toBe('유료 API');
    expect(meteredTag(session)).toBeNull();
    expect(meteredTag({ ...session, billing: 'unknown' })).toBeNull();
    expect(meteredTag(undefined)).toBeNull();
  });
});

describe("an agent's mark", () => {
  it('is its logo from the id -> logo map, else its initial on a hue made from its id', () => {
    expect(agentLogo('claude')?.path).toMatch(/^m4\.7144/); // Simple Icons' Claude path
    expect(agentLogo('claude-pty')).toBe(agentLogo('claude'));
    expect(agentLogo('codex')?.path).toMatch(/^M9\.205 8\.658/); // Lobe Icons' OpenAI blossom
    expect(agentLogo('nobody')).toBeUndefined();
    expect(markHue('codex')).not.toBe(markHue('copilot')); // same initial, own colour
    expect(markHue('codex')).toBe(markHue('codex'));
  });

  it('every known agent id has a logo or deliberately keeps its initial, so a new agent is a choice', () => {
    const agentsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../server/src/agent-tycoon/engine');
    const shipped = [
      ...readdirSync(path.join(agentsDir, 'agents'), { recursive: true, encoding: 'utf8' })
        .filter((f) => /\.ts$/.test(f) && !/\.test\.ts$/.test(f))
        .flatMap((f) => [...readFileSync(path.join(agentsDir, 'agents', f), 'utf8').matchAll(/readonly id = '([^']+)'/g)].map((m) => m[1])),
      readFileSync(path.join(agentsDir, 'registry.ts'), 'utf8').match(/CLAUDE_PTY_PROVIDER = '([^']+)'/)![1],
    ];
    expect(shipped.sort()).toEqual(expect.arrayContaining(['claude', 'claude-pty', 'codex']));
    for (const id of new Set([...shipped, ...KNOWN_AGENTS])) {
      const logo = agentLogo(id);
      expect(Boolean(logo) !== INITIAL_ONLY.includes(id), `${id}: a logo xor a deliberate initial`).toBe(true);
      expect(KNOWN_AGENTS, `${id} is in KNOWN_AGENTS`).toContain(id);
    }
  });
});

/** Files that still compare a provider's name, each with why (research G-items left for later steps). */
const LEFT: Record<string, string> = {
  'App.tsx': 'the hooks consent step is the Claude hook provider (data adapter, G17)',
  'components/IntroBubble.tsx':
    'the onboarding step that installs Claude hooks (data adapter, G17)',
  'agent-tycoon/modelBadges.ts': 'parses a Claude model id (data adapter)',
  'agent-tycoon/characters/compose.ts': "an office orchestrator's hook provider (data adapter)",
  'agent-tycoon/notify/newsList.ts': "the notice target open: 'codex' (G8, the run shape step)",
  'agent-tycoon/staff.ts': "the temporary character kind 'codex' (G1, the run shape step)",
  'agent-tycoon/taskboard/taskBoardState.ts': 'the task board (another task; G9)',
  'agent-tycoon/taskboard/TaskBoard.tsx': 'the task board (another task; G9)',
  'agent-tycoon/panels/OfficePanels.tsx': 'the dashboard (another task; G6)',
  'agent-tycoon/game/PartyWindow.tsx': 'the member card (another task rebuilds it; G7, G10)',
};
const NAME_CHECK =
  /[!=]==?\s*'(codex|claude|gemini|antigravity|copilot|cursor)'|'(codex|claude|gemini|antigravity|copilot|cursor)'\s*[!=]==?/;
const srcDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) return file === path.join(srcDir, 'i18n') ? [] : sourceFiles(file);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [file] : [];
  });
}

it('no UI file outside the listed data adapters turns a feature on by a provider name', () => {
  const found = sourceFiles(srcDir)
    .map((file) => path.relative(srcDir, file).split(path.sep).join('/'))
    .filter(
      (rel) => !(rel in LEFT) && NAME_CHECK.test(readFileSync(path.join(srcDir, rel), 'utf8')),
    );
  expect(found).toEqual([]);
});
