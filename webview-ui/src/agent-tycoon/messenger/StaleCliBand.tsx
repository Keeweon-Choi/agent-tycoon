/**
 * STALE-CLI (T-82, owner 11-10): the slim band at the top of an agent's conversation while its live
 * session runs an older CLI than the one installed now (the daemon's `cliUpdate`). One button: Restart,
 * which restarts it in the same conversation once its turn and background sub-agents are over (the
 * daemon waits at most `waitMin` minutes); while it waits, Cancel. Clicks only, no key.
 */
import { Button } from '../../components/ui/Button.js';
import { t } from '../../i18n/index.js';
import { transport } from '../../transport/index.js';
import { engineRestartWhenIdle, useEngineStore } from '../engineStore.js';
import { useCanAct } from '../useCanAct.js';

export function StaleCliBand({ name }: { name: string }) {
  const { state, busy } = useEngineStore();
  const canAct = useCanAct();
  const p = state?.projects.find((x) => x.name === name);
  if (!p?.cliUpdate) return null;
  const waiting = p.restartWhenIdle === 'waiting';
  const min = p.cliUpdate.waitMin;
  const text = waiting
    ? t('staleCli.waiting')
    : p.restartWhenIdle === 'timedOut'
      ? t('staleCli.timedOut', { min })
      : t('staleCli.band', { from: p.cliUpdate.running, to: p.cliUpdate.installed });
  return (
    <div
      role="status"
      data-testid="stale-cli-band"
      data-wait={p.restartWhenIdle}
      className="shrink-0 mx-12 mt-6 border-ui rounded-ui-card border-accent bg-bg-dark px-8 py-4 text-xs flex flex-wrap items-center gap-8"
    >
      <span className="flex-1 min-w-0 break-words">{text}</span>
      {canAct && (
        <Button
          size="sm"
          variant={waiting ? 'default' : 'accent'}
          className="shrink-0"
          title={waiting ? undefined : t('staleCli.restartTitle', { min })}
          disabled={busy[name] !== undefined}
          data-testid="stale-cli-restart"
          onClick={() =>
            engineRestartWhenIdle((m) => transport.send(m), transport.state === 'connected', name, waiting ? 'cancel' : 'wait')
          }
        >
          {waiting ? t('staleCli.cancel') : t('staleCli.restart')}
        </Button>
      )}
    </div>
  );
}
