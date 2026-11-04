import type { PointerEvent as ReactPointerEvent } from 'react';
import { Fragment, useLayoutEffect, useMemo, useRef, useState } from 'react';

import { PartyButton, PartyPortrait } from '../cld/game/Party.js';
import { HudPanel, usePanelSlot } from '../cld/hud/fixedPanels.js';
import {
  CARD_BAR_MAX_VISIBLE,
  PARTY_FRAME_BAR_PX,
  PARTY_FRAME_EXPANDED_STORAGE_KEY,
  TERMINAL_SIDEBAR_WIDTH_PX,
} from '../constants.js';
import { t } from '../i18n/index.js';
import { swallowNextClick, withinTapSlop } from '../touch/touchPrimitives.js';
import type { AgentAppearance, TabStatus } from './AgentCard.js';
import { AgentCard } from './AgentCard.js';
import {
  type CardInfo,
  cardsExpanded,
  cardVariant,
  groupOrder,
  loadSavedOrder,
  mergeOrder,
  reorderByPointer,
  savedCardsExpanded,
  saveOrder,
} from './cardBar.js';

/** PARTY-FRAME: this device's choice, folded (portraits) unless it unfolded the bar. */
function loadExpanded(): boolean {
  try {
    return cardsExpanded(localStorage.getItem(PARTY_FRAME_EXPANDED_STORAGE_KEY));
  } catch {
    return false;
  }
}

interface AgentCardBarProps {
  /** Agents to show, top to bottom. */
  agentIds: number[];
  /** The agent whose terminal pane is showing (standalone). Its card gets the
   *  accent border. */
  activeAgentId?: number | null;
  /** The agent whose character is selected in the office. Its card gets the
   *  active background; `activeAgentId` wins when both name the same agent. */
  focusedAgentId?: number | null;
  getAppearance: (agentId: number) => AgentAppearance;
  statusFor: (agentId: number) => TabStatus | null;
  onSelect: (agentId: number) => void;
  onClose: (agentId: number) => void;
  showClose?: boolean;
  /** cld-gui (T-0036): each card's group and name. Given, the cards are
   *  grouped (with a small header per group) and named. */
  describeCard?: (agentId: number) => CardInfo | undefined;
  /** cld-gui (CH-4): a card's right-click opens 꾸미기 for its character. */
  onCustomize?: (agentId: number) => void;
  /** cld-gui (owner 10-24): the + at the container's bottom opens the add-orchestrator flow.
   *  Left out (read-only client), there is no +. */
  onAdd?: () => void;
}

/**
 * The column of agent cards along the office's right edge — one mug shot and
 * status dot per agent — shared by both desktop hosts.
 *
 * One bordered container (the group tags, the cards and the + button) drawn on
 * top of the office space: the column's negative margin exactly cancels its
 * width, so it takes no layout room and overlays the office's right edge as a
 * flex sibling of the office region. Pointer events pass through the empty
 * parts of the column so the office stays clickable underneath.
 *
 * Cards have a fixed size and sit in fixed slots; a mouse drag moves a card to
 * another slot of its group (the others shift) and the order is a per-device
 * preference shared with the phone's bar. A drag never selects the card.
 *
 * In standalone, TerminalDrawer owns the bar and the cards double as the
 * terminal panel's tabs (the panel opens to the bar's right). In VS Code the
 * bar stands alone and lists every agent in the office, external sessions
 * included; a card click raises that agent's editor terminal via focusAgent.
 */
export function AgentCardBar({
  agentIds,
  activeAgentId = null,
  focusedAgentId = null,
  getAppearance,
  statusFor,
  onSelect,
  onClose,
  showClose = true,
  describeCard,
  onCustomize,
  onAdd,
}: AgentCardBarProps) {
  const [savedOrder, setSavedOrder] = useState<number[]>(loadSavedOrder);
  const [draggingId, setDraggingId] = useState<number | null>(null);
  const [expanded, setExpanded] = useState(loadExpanded);
  // PARTY-FRAME (owner 11-04 (나)): the cld bar folds to a column of portraits; upstream's stays as it was.
  const folded = !!describeCard && !expanded;
  const width = folded ? PARTY_FRAME_BAR_PX : TERMINAL_SIDEBAR_WIDTH_PX;
  const fold = (next: boolean) => {
    setExpanded(!next);
    try {
      localStorage.setItem(PARTY_FRAME_EXPANDED_STORAGE_KEY, savedCardsExpanded(!next));
    } catch {
      // Storage blocked: the choice holds for this page.
    }
  };
  const cardRefs = useRef(new Map<number, HTMLElement>());
  // WINDOW-LAYERS: past CARD_BAR_MAX_VISIBLE cards the list scrolls (its tags and the + stay put).
  const listRef = useRef<HTMLDivElement>(null);
  const [listCap, setListCap] = useState<number | null>(null);
  const inHud = usePanelSlot() !== null;
  const groupOf = describeCard ? (id: number) => describeCard(id)?.group ?? 0 : undefined;
  const merged = useMemo(() => mergeOrder(savedOrder, agentIds), [savedOrder, agentIds]);
  const ids = groupOf ? groupOrder(merged, groupOf) : merged;
  // The window listeners below outlive a render: they read the latest order through these.
  const idsRef = useRef(ids);
  idsRef.current = ids;
  const groupOfRef = useRef(groupOf);
  groupOfRef.current = groupOf;
  // Runs after every render; a same-value set does not render again, so it settles at once.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useLayoutEffect(() => {
    const cards = listRef.current?.querySelectorAll<HTMLElement>('[data-agent-id]');
    const last = cards?.[CARD_BAR_MAX_VISIBLE - 1];
    setListCap(last && cards.length > CARD_BAR_MAX_VISIBLE ? last.offsetTop + last.offsetHeight : null);
  });
  if (agentIds.length === 0 && !onAdd) return null;

  // ponytail: a mouse (or pen) drags; a touch screen on the desktop layout keeps the click only.
  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.pointerType === 'touch' || e.button !== 0) return;
    const target = e.target as HTMLElement;
    const card = target.closest<HTMLElement>('[data-agent-id]');
    if (!card || target.closest('button')) return;
    const id = Number(card.dataset.agentId);
    const { pointerId, clientX: x0, clientY: y0 } = e;
    let lifted = false;
    const onMove = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      if (!lifted) {
        if (withinTapSlop(ev.clientX - x0, ev.clientY - y0)) return;
        lifted = true;
        setDraggingId(id);
      }
      const cur = idsRef.current;
      const next = reorderByPointer(
        cur,
        id,
        (other) => {
          const rect = cardRefs.current.get(other)?.getBoundingClientRect();
          return rect ? rect.top + rect.height / 2 : null;
        },
        ev.clientY,
        groupOfRef.current,
      );
      if (next.join(',') !== cur.join(',')) setSavedOrder(next);
    };
    const onEnd = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onEnd);
      window.removeEventListener('pointercancel', onEnd);
      if (!lifted) return;
      swallowNextClick(); // the drop must not also select the card
      saveOrder(idsRef.current);
      setDraggingId(null);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onEnd);
    window.addEventListener('pointercancel', onEnd);
  };

  return (
    <HudPanel>
    {/* In the HUD layer (cld desktop) the bar hangs from the room's top, as tall as its cards (PARTY-FRAME),
        over normal windows; elsewhere it stays the flex sibling that overlays the office's right edge. */}
    <div
      className={`flex flex-col items-center py-4 pointer-events-none ${inHud ? 'absolute top-0 right-0 max-h-full' : 'relative z-30 h-full shrink-0'}`}
      style={{
        width,
        ...(!inHud && { marginLeft: -width }),
      }}
    >
      <div
        className={`pixel-panel pointer-events-auto flex flex-col items-center min-h-0 max-h-full select-none ${folded ? 'gap-4 p-4' : 'gap-6 p-6'}`}
        style={{ width: width - (folded ? 4 : 8) }}
        data-folded={folded || undefined}
        data-testid="card-container"
        data-hud-fixed
        onPointerDown={onPointerDown}
      >
        {/* cld-gui (GAME-UI-1): the party roster opens from the bar's head. */}
        {describeCard && <PartyButton folded={folded} onFold={fold} />}
        {/* ponytail: a folded list that scrolls (past CARD_BAR_MAX_VISIBLE) clips the 기다림 tails; they
            hang outside it otherwise. */}
        <div
          ref={listRef}
          className={`relative flex flex-col items-center min-h-0 ${folded ? 'gap-4' : 'gap-6'} ${folded && listCap === null ? '' : 'overflow-y-auto'}`}
          style={listCap === null ? undefined : { maxHeight: listCap }}
        >
          {ids.map((agentId, i) => {
            const info = describeCard?.(agentId);
            const header =
              !folded && info && (i === 0 || describeCard?.(ids[i - 1])?.group !== info.group) ? (
                <span
                  className="sticky top-0 z-10 shrink-0 w-full truncate text-center bg-bg border-2 border-border px-2 text-[length:calc(14px*var(--ui-scale))] leading-tight text-text-muted"
                  title={info.groupLabel}
                  data-testid="card-group"
                >
                  {info.groupLabel}
                </span>
              ) : null;
            return (
              <Fragment key={agentId}>
                {header}
                <div
                  ref={(el) => {
                    if (el) cardRefs.current.set(agentId, el);
                    else cardRefs.current.delete(agentId);
                  }}
                  className={draggingId === agentId ? 'opacity-70' : undefined}
                >
                  {folded ? (
                    <PartyPortrait
                      id={agentId}
                      name={info?.name ?? `Agent ${agentId}`}
                      look={getAppearance(agentId)}
                      temps={info?.temps ?? 0}
                      variant={cardVariant(agentId, { activeId: activeAgentId, focusedId: focusedAgentId })}
                      onSelect={onSelect}
                      onCustomize={onCustomize}
                    />
                  ) : (
                    <AgentCard
                      large
                      agentId={agentId}
                      variant={cardVariant(agentId, {
                        activeId: activeAgentId,
                        focusedId: focusedAgentId,
                      })}
                      appearance={getAppearance(agentId)}
                      status={statusFor(agentId)}
                      onSelect={onSelect}
                      onClose={onClose}
                      showClose={showClose}
                      name={info?.name}
                      extra={info?.extra}
                      onCustomize={onCustomize}
                    />
                  )}
                </div>
              </Fragment>
            );
          })}
        </div>
        {onAdd && (
          <button
            type="button"
            className="shrink-0 w-full h-32 flex items-center justify-center border-2 border-border bg-btn-bg hover:bg-btn-hover text-lg leading-none rounded-none cursor-pointer"
            title={t('engine.addOrchestrator')}
            aria-label={t('engine.addOrchestrator')}
            data-testid="card-add"
            onClick={onAdd}
          >
            +
          </button>
        )}
      </div>
    </div>
    </HudPanel>
  );
}
