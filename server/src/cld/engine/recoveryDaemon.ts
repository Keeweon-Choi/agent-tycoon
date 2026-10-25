import type { EngineAction } from '../../../../core/src/messages.js';
import { Engine } from './engine.js';

const home = process.env['CLD_RECOVERY_HOME'];
const claudePath = process.env['CLD_RECOVERY_CLAUDE'];
if (!home || !claudePath) throw new Error('recovery daemon needs its isolated HOME and fake claude');

const send = (message: Record<string, unknown>) => process.send?.(message);
const engine = new Engine({
  claudePath,
  home,
  readOnly: false,
  systemdRun: null,
  timing: {
    pollMs: 20,
    appearMs: 5_000,
    goneMs: 5_000,
    reviveGapMs: 10,
    safetyMs: 60_000,
    debounceMs: 20,
    watchMs: 0,
  },
  log: () => undefined,
  writeInbox: (name, text) => (send({ type: 'inbox', name, text }), true),
});

engine.start();
send({ type: 'ready' });

process.on('message', async (message: { type?: unknown; id?: unknown; action?: unknown }) => {
  if (typeof message.id !== 'number') return;
  if (message.type === 'state') return send({ type: 'state', id: message.id, state: engine.state() });
  if (message.type !== 'action' || !message.action || typeof message.action !== 'object') return;
  const result = await engine.run(message.action as EngineAction, true, 'test');
  send({ type: 'result', id: message.id, result });
});
