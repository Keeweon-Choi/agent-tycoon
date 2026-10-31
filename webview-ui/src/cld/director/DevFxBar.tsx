/**
 * C1 dev trigger: open the office with `?fx=1` and a small bar (bottom left) plays each moment on
 * the selected character (else the followed one, else the first agent). The same page also gets
 * `window.__agtyFx` for the recording runner: `play(kind, id?, count?)` and `wav(kind)` (the
 * jingle rendered offline, mono samples). Nothing of this exists without the flag.
 */
import { Button } from '../../components/ui/Button.js';
import { FX_WAV_RATE } from '../../constants.js';
import { t } from '../../i18n/index.js';
import type { OfficeState } from '../../office/engine/officeState.js';
import { director } from './actions.js';
import { FX_KINDS, type FxKind } from './director.js';
import { renderJingle } from './sounds.js';

const fxDevOn =
  typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('fx') === '1';

declare global {
  interface Window {
    __agtyFx?: {
      play: (kind: FxKind, id?: number, count?: number) => number | null;
      wav: (kind: FxKind) => Promise<{ rate: number; samples: number[] }>;
    };
  }
}

function target(os: OfficeState): number | null {
  const pick = os.selectedAgentId ?? os.cameraFollowId;
  if (pick !== null && os.characters.has(pick)) return pick;
  for (const ch of os.characters.values()) if (!ch.isSubagent) return ch.id;
  return null;
}

function play(os: OfficeState, kind: FxKind, id?: number, count?: number): number | null {
  const who = id ?? target(os);
  if (who === null) return null;
  director.play(who, kind === 'coffee' ? { kind } : { kind, count: count ?? 1 });
  return who;
}

export function DevFxBar({ getOfficeState }: { getOfficeState: () => OfficeState }) {
  if (!fxDevOn) return null;
  window.__agtyFx ??= {
    play: (kind, id, count) => play(getOfficeState(), kind, id, count),
    wav: async (kind) => ({ rate: FX_WAV_RATE, samples: Array.from(await renderJingle(kind)) }),
  };
  return (
    <div
      className="fixed left-8 bottom-8 z-[86] flex items-center gap-4 border-2 border-border bg-bg px-4 py-4 text-xs text-text shadow-pixel"
      data-testid="fx-dev-bar"
    >
      <span className="px-4">{t('fx.dev.title')}</span>
      {FX_KINDS.map((kind) => (
        <Button key={kind} size="sm" onClick={() => play(getOfficeState(), kind)}>
          {t(`fx.dev.${kind}`)}
        </Button>
      ))}
    </div>
  );
}
