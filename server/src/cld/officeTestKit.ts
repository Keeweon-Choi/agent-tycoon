/**
 * Test helper: an Office over engine projects (the registry written, stopped)
 * and, optionally, a fake `claude agents --json` scenario. The roster of the
 * old fixtures is `ROSTER`: eight projects in three rooms and one in the
 * 관리실. Stopped by itself after each test (or by `stop()`). Never used at runtime.
 */
import * as path from 'path';
import { afterEach } from 'vitest';

import { AgentRuntime } from '../agentRuntime.js';
import { AgentStateStore } from '../agentStateStore.js';
import { claudeProvider } from '../providers/hook/claude/claude.js';
import { Office, type OfficeOptions } from './office.js';
import { ClaudeAgentsSource, ClaudeSessions } from './providers/claudeProvider.js';
import { killFakeSessions, makeEngineHome, makeFakeHome, removeTestHome, writeEngineProjects } from './testHome.js';

type Project = { name: string; folder: string; room?: string };

/** Eight orchestrators in three rooms and the ops desk in the 관리실. */
export const ROSTER: Project[] = [
  ['alpha', 'orch-alpha'],
  ['beta', 'orch-alpha'],
  ['gamma', 'orch-alpha'],
  ['delta', 'orch-beta'],
  ['epsilon', 'orch-beta'],
  ['zeta', 'orch-beta'],
  ['eta', 'orch-gamma'],
  ['theta', 'orch-gamma'],
  ['ops-desk', '관리실'],
].map(([name, room]) => ({ name, folder: `/work/${name}`, room }));

const baseEnv = { ...process.env };
const stops: Array<() => void> = [];
const homes: string[] = [];
afterEach(() => {
  for (const s of stops.splice(0)) s();
  for (const h of homes.splice(0)) removeTestHome(h);
  // In place: os.homedir() reads the real environ, which a replaced process.env object loses.
  for (const k of Object.keys(process.env)) if (!(k in baseEnv)) delete process.env[k];
  Object.assign(process.env, baseEnv);
});

export async function startEngineOffice(
  opts: {
    projects?: Project[];
    /** Reuse a home (a restart); else a new engine home. */
    home?: string;
    /** A fake `claude agents --json` scenario (cld/test/fake-claude/<name>) as the Claude sessions. */
    claude?: string;
    readOnly?: boolean;
    chat?: boolean;
    extra?: Partial<OfficeOptions>;
  } = {},
) {
  const eh = opts.home ? null : makeEngineHome();
  const home = opts.home ?? eh!.home;
  const claudePath = path.join(home, 'bin', 'claude');
  if (opts.projects) writeEngineProjects(home, opts.projects);
  let claude: OfficeOptions['claude'];
  let engineClaude = claudePath;
  if (opts.claude) {
    const fake = makeFakeHome({ home, claude: opts.claude });
    Object.assign(process.env, fake.env);
    claude = new ClaudeAgentsSource(fake.claudePath);
    engineClaude = fake.claudePath;
  } else {
    process.env.HOME = home;
    process.env.XDG_RUNTIME_DIR = home; // no systemd user manager here: setsid
    claude = new ClaudeSessions(path.join(home, '.claude/sessions'), null);
  }
  const store = new AgentStateStore();
  const runtime = new AgentRuntime(store, claudeProvider);
  const messages: Array<Record<string, unknown>> = [];
  store.on('broadcast', (m) => messages.push(m));
  const office = new Office({
    runtime,
    store,
    readOnly: opts.readOnly ?? true,
    chat: opts.chat,
    claude,
    home,
    engineClaude,
    defaultLayout: { tiles: [1], furniture: [] },
    ...opts.extra,
  });
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    office.dispose();
    runtime.dispose();
    killFakeSessions(home);
  };
  stops.push(stop);
  await office.start();
  const last = (type: string) => [...messages].reverse().find((m) => m.type === type);
  const agentId = (name: string) =>
    office.officeState().orchestrators.find((o) => o.name === name)!.agentId!;
  if (eh) homes.push(home); // removed when the test is over (a home made here only)
  return { home, store, runtime, office, messages, last, agentId, stop };
}
