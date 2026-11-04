/**
 * GAME-UI-1 G3, 05 (specs/ui-mock-1103/ideas/agents/05-party): the party roster. The card bar keeps its
 * look and gains, under each name, a small 컨텍스트 남음 strip and the state icon; its 파티 button opens the
 * roster window (PartyWindow.tsx). Every number is the app's own: the context fill
 * (fatigue), the one waiting rule (waiting.ts) and the card's activity.
 */
import type { AgentAppearance } from '../../components/AgentCard.js';
import type { CardInfo, CardVariant } from '../../components/cardBar.js';
import { CharacterMugShot } from '../../components/CharacterMugShot.js';
import { GAME_MINI_SEGMENTS } from '../../constants.js';
import { t } from '../../i18n/index.js';
import { openParty, STATE_ICON, useChangeKey, useMember, usePartyOpen } from './gameLooks.js';
import { contextTone, type PartyState } from './gameState.js';
import { PixelIcon, SegBar } from './parts.js';
import { PartyWindow } from './PartyWindow.js';

/** The state icon; it hops 2px once when the state changes. */
export function StateIcon({ state }: { state: PartyState }) {
  const hop = useChangeKey(state);
  return (
    <span key={hop} className="game-state" data-state={state} data-hop={hop ? '' : undefined}>
      <PixelIcon name={STATE_ICON[state]} />
    </span>
  );
}

/** The card bar's mark under a name: a small context strip (refills on a compaction) and the state icon. */
export function PartyMark({ id }: { id: number }) {
  const { state, left } = useMember(id);
  const refill = useChangeKey(left, (a, b) => a !== null && b !== null && b > a);
  const label = t('game.party.mark', { state: t(`game.party.state.${state}`), left: left === null ? '—' : `${left}%` });
  return (
    <span className="game-mark" data-testid="party-mark" data-state={state} data-left={left ?? undefined} title={label} aria-label={label}>
      <SegBar value={left ?? 0} max={100} segments={GAME_MINI_SEGMENTS} tone={contextTone(left)} refill={refill} className="game-seg-mini" />
      <StateIcon state={state} />
    </span>
  );
}

/**
 * The card bar's head (PARTY-FRAME, owner 11-04 (나)): folded, one `◂ 파티` that unfolds the bar into
 * the full cards; unfolded, `▸` folds it back and 파티 opens the roster window as before.
 */
export function PartyButton({ folded, onFold }: { folded: boolean; onFold: (folded: boolean) => void }) {
  if (folded)
    return (
      <button
        type="button"
        className="game-party-btn"
        title={t('game.party.expand')}
        aria-label={t('game.party.expand')}
        aria-expanded={false}
        data-testid="party-fold"
        onClick={() => onFold(false)}
      >
        <PixelIcon name="play" size={8} className="game-flip" />
        {t('game.party.button')}
      </button>
    );
  return (
    <span className="game-party-head">
      <button
        type="button"
        className="game-party-btn game-party-fold"
        title={t('game.party.fold')}
        aria-label={t('game.party.fold')}
        aria-expanded
        data-testid="party-fold"
        onClick={() => onFold(true)}
      >
        <PixelIcon name="play" size={8} />
      </button>
      <button
        type="button"
        className="game-party-btn"
        title={t('game.party.open')}
        aria-label={t('game.party.open')}
        data-testid="party-open"
        onClick={() => openParty(true)}
      >
        {t('game.party.button')}
      </button>
    </span>
  );
}

/**
 * One member in the folded bar: the face, the state icon (top right), the temps (+N, top left) and
 * 컨텍스트 남음 as 8 cells. Working = the purple border; waiting on the owner (a question or a
 * permission) = the light purple border and a 기다림 tail to the left; resting = the face dimmed.
 * No blinking. The name is the hover title; a click and a right-click do what the full card's do.
 */
export function PartyPortrait({
  id,
  name,
  look,
  temps,
  variant,
  onSelect,
  onCustomize,
}: {
  id: number;
  name: string;
  look: AgentAppearance;
  temps: number;
  variant: CardVariant;
  onSelect: (id: number) => void;
  onCustomize?: (id: number) => void;
}) {
  const { state, left } = useMember(id);
  const refill = useChangeKey(left, (a, b) => a !== null && b !== null && b > a);
  const mark = t('game.party.mark', { state: t(`game.party.state.${state}`), left: left === null ? '—' : `${left}%` });
  const waits = state === 'ask' || state === 'lock';
  return (
    <div
      className="game-portrait pointer-events-auto"
      data-state={state}
      data-variant={variant}
      data-left={left ?? undefined}
      title={name}
      aria-label={`${name} · ${mark}`}
      data-testid="agent-card"
      data-agent-id={id}
      data-portrait
      onClick={() => onSelect(id)}
      onContextMenu={
        onCustomize &&
        ((e) => {
          e.preventDefault();
          onCustomize(id);
        })
      }
    >
      <span className="game-portrait-face">
        <CharacterMugShot palette={look.palette} hueShift={look.hueShift} />
      </span>
      {temps > 0 && <span className="game-portrait-temps game-data">+{temps}</span>}
      <StateIcon state={state} />
      <SegBar value={left ?? 0} max={100} segments={GAME_MINI_SEGMENTS} tone={contextTone(left)} refill={refill} className="game-seg-portrait" />
      {waits && (
        <span className="game-portrait-wait" data-testid="party-wait" aria-hidden="true">
          <PixelIcon name={STATE_ICON[state]} size={8} />
          {t('game.party.wait')}
        </span>
      )}
    </div>
  );
}

/** The roster window while it is open. ponytail: in the main bundle; a lazy chunk measured larger (the split's shared chunks). */
export function PartyHost(props: { ids: number[]; describeCard?: (id: number) => CardInfo | undefined }) {
  if (!usePartyOpen()) return null;
  return <PartyWindow {...props} onClose={() => openParty(false)} />;
}
