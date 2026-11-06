/**
 * The usage panel's ↻ (owner 11-06 22:03), once in the panel's top row: it refreshes everything the panel
 * shows. Today that is the usage of the provider that can be re-read on demand (Codex: codexUsageCheck, one
 * minimal turn) and the newest CLI versions (agentCliLatest, past the daemon's hourly cache, at most every 30 s).
 */
import { Button } from '../../components/ui/Button.js';
import { t } from '../../i18n/index.js';
import { transport } from '../../transport/index.js';
import { useEngineStore } from '../engineStore.js';
import { codexUsageCheckStarted, useCldStore } from '../officeStore.js';
import { askAgentLatest } from './agentUpdate.js';
import { RefreshGlyph } from './glyphs.js';

export function UsageRefresh() {
  const { officeReadOnly, codexUsageChecking } = useCldStore();
  const caps = useEngineStore().state?.agentCaps;
  if (officeReadOnly) return null;
  // ponytail: the one provider with a refresh path is Codex (codexUsageCheck); the next needs usageCheck {provider}.
  const readsUsage = Object.values(caps ?? {}).some((c) => c.usageRefresh);
  return (
    <Button
      size="icon_md"
      title={t('usage.checkCodexTitle')}
      aria-label={t(codexUsageChecking ? 'usage.checkingCodex' : 'usage.checkCodex')}
      aria-busy={codexUsageChecking}
      data-testid="usage-refresh"
      disabled={codexUsageChecking}
      onClick={() => {
        if (readsUsage) {
          codexUsageCheckStarted();
          transport.send({ type: 'codexUsageCheck' });
        }
        askAgentLatest(true);
      }}
    >
      <span className={codexUsageChecking ? 'animate-spin' : 'flex'}>
        <RefreshGlyph />
      </span>
    </Button>
  );
}
