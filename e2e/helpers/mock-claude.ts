import fs from 'fs';
import path from 'path';

const DEFAULT_HOLD_OPEN_MS = 30_000;
const SCENARIO_SCHEMA_VERSION = 1;

export interface ClaudeMockSessionDefinition {
  alias: string;
  sessionIdTemplate: string;
  cwdTemplate?: string;
  transcriptPathTemplate?: string;
  sidecarPathTemplate?: string;
  sidecarJson?: Record<string, unknown>;
}

export interface ClaudeMockAppendJsonlAction {
  kind: 'appendJsonl';
  atMs: number;
  session: string;
  record: Record<string, unknown>;
}

export interface ClaudeMockEmitHookAction {
  kind: 'emitHook';
  atMs: number;
  payload: Record<string, unknown>;
}

export interface ClaudeMockWriteJsonAction {
  kind: 'writeJson';
  atMs: number;
  filePath: string;
  value: Record<string, unknown>;
}

export interface ClaudeMockDeletePathAction {
  kind: 'deletePath';
  atMs: number;
  filePath: string;
}

export interface ClaudeMockExitAction {
  kind: 'exit';
  atMs: number;
  code?: number;
}

export type ClaudeMockAction =
  | ClaudeMockAppendJsonlAction
  | ClaudeMockEmitHookAction
  | ClaudeMockWriteJsonAction
  | ClaudeMockDeletePathAction
  | ClaudeMockExitAction;

/** An `onPrompt` group: its steps run, timed from the prompt, when a submitted prompt contains `match`. */
export interface ClaudeMockTurn {
  match: string;
  actions: ClaudeMockAction[];
}

export interface ClaudeMockScenario {
  schemaVersion: number;
  name?: string;
  /** `forAgent`: played by the engine session started as `claude -n <agent>` (and kept for its restarts). */
  agent?: string;
  prompts?: ClaudeMockTurn[];
  autoInit: boolean;
  holdOpenMs: number;
  sessions: ClaudeMockSessionDefinition[];
  actions: ClaudeMockAction[];
}

class TimedScenarioStepBuilder {
  constructor(
    private readonly scenario: ClaudeMockScenarioBuilder,
    private readonly atMs: number,
  ) {}

  appendJsonl(
    record: Record<string, unknown>,
    options?: { session?: string },
  ): ClaudeMockScenarioBuilder {
    this.scenario.pushAction({
      kind: 'appendJsonl',
      atMs: this.atMs,
      session: options?.session ?? 'self',
      record,
    });
    return this.scenario;
  }

  emitHook(payload: Record<string, unknown>): ClaudeMockScenarioBuilder {
    this.scenario.pushAction({
      kind: 'emitHook',
      atMs: this.atMs,
      payload,
    });
    return this.scenario;
  }

  writeJson(filePath: string, value: Record<string, unknown>): ClaudeMockScenarioBuilder {
    this.scenario.pushAction({
      kind: 'writeJson',
      atMs: this.atMs,
      filePath,
      value,
    });
    return this.scenario;
  }

  deletePath(filePath: string): ClaudeMockScenarioBuilder {
    this.scenario.pushAction({
      kind: 'deletePath',
      atMs: this.atMs,
      filePath,
    });
    return this.scenario;
  }

  exit(code = 0): ClaudeMockScenarioBuilder {
    this.scenario.pushAction({
      kind: 'exit',
      atMs: this.atMs,
      code,
    });
    return this.scenario;
  }
}

export class ClaudeMockScenarioBuilder {
  private autoInit = true;
  private holdOpenMs = DEFAULT_HOLD_OPEN_MS;
  private readonly sessions: ClaudeMockSessionDefinition[] = [];
  private readonly actions: ClaudeMockAction[] = [];
  private agent?: string;
  private readonly prompts: ClaudeMockTurn[] = [];

  constructor(private readonly name?: string) {}

  /** Played by the engine agent `name` (agent-tycoon/test/fake-claude/pty-tui.cjs), not by a launched mock:
   *  steps before any `onPrompt` run once its session is up, every restart again. */
  forAgent(name: string): ClaudeMockScenarioBuilder {
    this.agent = name;
    return this;
  }

  /** The `.at(ms)` steps after this run when a submitted prompt contains `text`, counted from that
   *  prompt; the session is busy until the last one. An `.emitHook(permissionRequest(...))` among them
   *  waits for 허용 / 거부 (the clock stops) and `{{permission}}` is the answer after it. */
  onPrompt(text: string): ClaudeMockScenarioBuilder {
    this.prompts.push({ match: text, actions: [] });
    return this;
  }

  defineSession(
    alias: string,
    sessionIdTemplate: string,
    options?: {
      cwdTemplate?: string;
      transcriptPathTemplate?: string;
      sidecarPathTemplate?: string;
      sidecarJson?: Record<string, unknown>;
    },
  ): ClaudeMockScenarioBuilder {
    this.sessions.push({
      alias,
      sessionIdTemplate,
      cwdTemplate: options?.cwdTemplate,
      transcriptPathTemplate: options?.transcriptPathTemplate,
      sidecarPathTemplate: options?.sidecarPathTemplate,
      sidecarJson: options?.sidecarJson,
    });
    return this;
  }

  withoutAutoInit(): ClaudeMockScenarioBuilder {
    this.autoInit = false;
    return this;
  }

  holdOpenFor(ms: number): ClaudeMockScenarioBuilder {
    this.holdOpenMs = ms;
    return this;
  }

  at(ms: number): TimedScenarioStepBuilder {
    return new TimedScenarioStepBuilder(this, ms);
  }

  exitAt(ms: number, code = 0): ClaudeMockScenarioBuilder {
    this.pushAction({
      kind: 'exit',
      atMs: ms,
      code,
    });
    return this;
  }

  pushAction(action: ClaudeMockAction): void {
    (this.prompts.at(-1)?.actions ?? this.actions).push(action);
  }

  build(): ClaudeMockScenario {
    const byTime = (left: ClaudeMockAction, right: ClaudeMockAction) => left.atMs - right.atMs;
    return {
      schemaVersion: SCENARIO_SCHEMA_VERSION,
      name: this.name,
      ...(this.agent && {
        agent: this.agent,
        prompts: this.prompts.map((p) => ({ match: p.match, actions: [...p.actions].sort(byTime) })),
      }),
      autoInit: this.autoInit,
      holdOpenMs: this.holdOpenMs,
      sessions: [...this.sessions],
      actions: [...this.actions].sort(byTime),
    };
  }
}

export function claudeScenario(name?: string): ClaudeMockScenarioBuilder {
  return new ClaudeMockScenarioBuilder(name);
}

function getScenarioQueuePath(tmpHome: string): string {
  return path.join(tmpHome, '.claude-mock', 'scenario-queue.json');
}

function readScenarioQueue(tmpHome: string): ClaudeMockScenario[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(getScenarioQueuePath(tmpHome), 'utf8')) as unknown;
    return Array.isArray(parsed) ? (parsed as ClaudeMockScenario[]) : [];
  } catch {
    return [];
  }
}

/** Queue a scenario for the fake Claude of this HOME (setup, before the agent starts). */
export async function arrangeNextClaudeInvocation(
  tmpHome: string,
  scenario: ClaudeMockScenario,
): Promise<void> {
  const queue = readScenarioQueue(tmpHome);
  queue.push(scenario);
  const queuePath = getScenarioQueuePath(tmpHome);
  fs.mkdirSync(path.dirname(queuePath), { recursive: true });
  fs.writeFileSync(queuePath, JSON.stringify(queue, null, 2));
}
