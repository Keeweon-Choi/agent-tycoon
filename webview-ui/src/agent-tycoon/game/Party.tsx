/**
 * GAME-UI-1 G3, 05 (specs/ui-mock-1103/ideas/agents/05-party): the party's portraits (the desktop column and
 * the phone's strip). Every number is the app's own: the context fill (fatigue), the one waiting rule
 * (waiting.ts) and the card's activity.
 */
import type { AgentAppearance } from '../../components/AgentCard.js';
import type { CardVariant } from '../../components/cardBar.js';
import { CharacterMugShot } from '../../components/CharacterMugShot.js';
import { GAME_MINI_SEGMENTS } from '../../constants.js';
import { t } from '../../i18n/index.js';
import { useWaitReasons } from '../waiting.js';
import { STATE_ICON, useChangeKey, useGameLooks, useMember } from './gameLooks.js';
import { contextTone, type PartyState,partyState } from './gameState.js';
import { PixelIcon, SegBar } from './parts.js';

/** The state icon; it hops 2px once when the state changes. */
export function StateIcon({ state }: { state: PartyState }) {
  const hop = useChangeKey(state);
  return (
    <span key={hop} className="game-state" data-state={state} data-hop={hop ? '' : undefined}>
      <PixelIcon name={STATE_ICON[state]} />
    </span>
  );
}

/**
 * hud-v3 (owner 11-06 15:24): under the party's head, who waits on the owner (a question or a permission),
 * as a badge that reads at a glance ("기다림 2"): reachable with the billboard off camera. The same one rule
 * as each portrait (partyState). The working count is the control center's 실행 중 (hud/ControlCenter.tsx).
 */
export function PartyWaiting({ ids }: { ids: readonly number[] }) {
  const reasons = useWaitReasons();
  const looks = useGameLooks();
  const waiting = ids.filter((id) => {
    const s = partyState(reasons[id], looks?.statusFor(id) ?? null);
    return s === 'ask' || s === 'lock';
  }).length;
  if (waiting === 0) return null;
  return (
    <span
      className="game-party-waiting ui-badge ui-notch"
      role="status"
      title={t('hudpc.party.waiting', { count: waiting })}
      aria-label={t('hudpc.party.waiting', { count: waiting })}
      data-testid="party-waiting"
      data-count={waiting}
    >
      {t('hudUsage.waiting', { count: waiting })}
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
