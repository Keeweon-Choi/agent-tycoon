import type { Step } from './direct.js';
import type { RemoteTestResult } from './setupTest.js';

type SetupFact = import('../../../../core/src/remoteSetupPlan.mjs', { with: { 'resolution-mode': 'import' } }).SetupFact;
type SetupKind = import('../../../../core/src/remoteSetupPlan.mjs', { with: { 'resolution-mode': 'import' } }).SetupKind;
type RemoteChoice = import('../../../../core/src/remoteSetupPlan.mjs', { with: { 'resolution-mode': 'import' } }).RemoteChoice;

export interface SetupOutcome {
  ok: boolean;
  steps: Step[];
  url?: string;
  connector?: 'local' | 'lan' | 'direct' | 'duckdns' | 'tailscale' | 'funnel' | 'tunnel';
  pending?: boolean;
  test?: RemoteTestResult;
}

type Action = (kind: SetupKind, choice: RemoteChoice) => Promise<{ ok: boolean; url?: string; connector?: SetupOutcome['connector']; steps?: Step[] }>;

/** Both the settings button and the installer use this ordered execution. */
export async function runRemoteSetup(
  facts: SetupFact,
  choice: RemoteChoice,
  action: Action,
  selfTest: (url: string, kind: SetupKind) => Promise<RemoteTestResult>,
  onStep: (step: Step) => void = () => undefined,
): Promise<SetupOutcome> {
  const { remoteSetupPlan } = await import('../../../../core/src/remoteSetupPlan.mjs');
  const steps: Step[] = [];
  const add = (step: Step) => { steps.push(step); onStep(step); };
  for (const step of remoteSetupPlan(facts, choice)) {
    if (step.guide || step.suggest) {
      add({ ok: false, text: step.text, guide: step.guide, actions: step.actions, suggest: step.suggest, ...(step.admin ? { admin: step.admin } : {}), ...(step.confirm ? { confirm: true } : {}) });
      // A step the person confirms by hand is not re-checked on a timer: nothing could read its result.
      return { ok: false, pending: !step.suggest && !step.confirm, steps };
    }
    let result: Awaited<ReturnType<Action>>;
    try { result = await action(step.kind, choice); }
    catch (error) { result = { ok: false, steps: [{ ok: false, text: (error as Error).message }] }; }
    for (const line of result.steps ?? [{ ok: result.ok, text: step.text }]) add(line);
    if (step.kind === 'switch') return { ok: result.ok, steps, connector: result.connector };
    if (!result.ok || !result.url) continue;
    const test = await selfTest(result.url, step.kind);
    for (const line of test.steps) add(line);
    if (test.ok) return { ok: true, steps, url: result.url, connector: result.connector, test };
  }
  return { ok: false, steps };
}
