import type { PointerEvent as ReactPointerEvent } from 'react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import { PartyPortrait, PartyWaiting } from '../agent-tycoon/game/Party.js';
import { HudPanel, usePanelSlot } from '../agent-tycoon/hud/fixedPanels.js';
import { panelToFront, useHud } from '../agent-tycoon/hud/hudStore.js';
import { setInspectorSlot } from '../agent-tycoon/hud/inspectorSlot.js';
import { layerZ } from '../agent-tycoon/hud/windowModel.js';
import { usePartyColumn } from '../agent-tycoon/party/partyColumn.js';
import { staffSnapshot } from '../agent-tycoon/staff.js';
import {
  CARD_BAR_MAX_VISIBLE,
  HUD_BOTTOM_RESERVE_PX,
  HUD_CORNER_ROW_PX,
  PARTY_FRAME_BAR_PX,
  TERMINAL_SIDEBAR_WIDTH_PX,
} from '../constants.js';
import { t } from '../i18n/index.js';
import { swallowNextClick, withinTapSlop } from '../touch/touchPrimitives.js';
import type { AgentAppearance, TabStatus } from './AgentCard.js';
import { AgentCard } from './AgentCard.js';
import {
  type CardInfo,
  cardVariant,
  groupOrder,
  loadSavedOrder,
  mergeOrder,
  reorderByPointer,
  saveOrder,
} from './cardBar.js';

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
  /** agty (T-0036): each card's group and name. Given, the cards are
   *  grouped (with a small header per group) and named. */
  describeCard?: (agentId: number) => CardInfo | undefined;
  /** agty (CH-4): a card's right-click opens 꾸미기 for its character. */
  onCustomize?: (agentId: number) => void;
  /** agty (owner 10-24): the + at the container's bottom opens the add-orchestrator flow.
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
  // PARTY-FRAME (owner 11-04 (나)): the agty bar is a column of portraits (FEAT-PARTY-V2, owner 11-06 17:49:
  // no unfolding into the old orchestrator cards); upstream's stays as it was.
  const folded = !!describeCard;
  const width = folded ? PARTY_FRAME_BAR_PX : TERMINAL_SIDEBAR_WIDTH_PX;
  const cardRefs = useRef(new Map<number, HTMLElement>());
  // WINDOW-LAYERS: past CARD_BAR_MAX_VISIBLE cards the list scrolls (its tags and the + stay put).
  const listRef = useRef<HTMLDivElement>(null);
  const [listCap, setListCap] = useState<number | null>(null);
  const inHud = usePanelSlot() !== null;
  const groupOf = describeCard ? (id: number) => describeCard(id)?.group ?? 0 : undefined;
  const merged = useMemo(() => mergeOrder(savedOrder, agentIds), [savedOrder, agentIds]);
  // FEAT-PARTY-V2: the agty column shows the chosen party (everyone by default); its head picks and composes.
  const ordered = groupOf ? groupOrder(merged, groupOf) : merged;
  const party = usePartyColumn(ordered, describeCard && ((id) => describeCard(id)?.name));
  const ids = party.shown;
  const rows = party.rows;
  // The window listeners below outlive a render: they read the latest order through these. A drag reorders
  // the whole column (the cards another party hides are not laid out, so they keep their places).
  const idsRef = useRef(ordered);
  idsRef.current = ordered;
  const groupOfRef = useRef(groupOf);
  groupOfRef.current = groupOf;
  // Runs after every render; a same-value set does not render again, so it settles at once.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useLayoutEffect(() => {
    const cards = listRef.current?.querySelectorAll<HTMLElement>('[data-agent-id]');
    const last = cards?.[CARD_BAR_MAX_VISIBLE - 1];
    setListCap(last && cards.length > CARD_BAR_MAX_VISIBLE ? last.offsetTop + last.offsetHeight : null);
  });
  // hud-v3 (owner 11-06 15:26): the inspector opens beside the selected employee's portrait, its top on that
  // row, kept inside the room above the bottom HUD (the dock). A selection from the world scrolls the
  // party to its portrait first. Re-placed on the party's scroll, the inspector's size and a window resize.
  const wrapRef = useRef<HTMLDivElement>(null);
  const slotRef = useRef<HTMLDivElement | null>(null);
  const idCount = ids.length;
  useLayoutEffect(() => {
    const slot = slotRef.current;
    const wrap = wrapRef.current;
    const list = listRef.current;
    if (!slot || !wrap || !list || focusedAgentId === null) return;
    // A temp (a sub-agent, a teammate) has no portrait: its card opens beside its lead's, else at the top
    // (owner 11-06 20:22: a sub-agent's card kept the last portrait's place and ran below the window).
    const leadId = staffSnapshot().temps.find((x) => x.id === focusedAgentId)?.leadId;
    const card = cardRefs.current.get(focusedAgentId) ?? (leadId == null ? undefined : cardRefs.current.get(leadId));
    card?.scrollIntoView({ block: 'nearest' });
    const place = () => {
      const room = (wrap.offsetParent as HTMLElement | null)?.clientHeight ?? window.innerHeight;
      // The card is never taller than the room between the party's top inset and the bottom HUD.
      const fit = room - HUD_BOTTOM_RESERVE_PX - wrap.offsetTop;
      slot.style.setProperty('--mc-room', `${Math.max(0, Math.floor(fit))}px`);
      // A card the owner dragged stays where it was dropped (agent-tycoon/hud/Inspector.tsx keeps it on screen).
      const el = slot.firstElementChild as HTMLElement | null;
      if (el?.dataset.dragged !== undefined) return;
      const want = card ? card.getBoundingClientRect().top - wrap.getBoundingClientRect().top : 0;
      // The real height, up to a whole px (offsetHeight rounds a fraction down, past the band).
      const height = Math.ceil(el?.getBoundingClientRect().height ?? 0);
      slot.style.top = `${Math.floor(Math.max(0, Math.min(want, fit - height)))}px`;
    };
    place();
    const resizes = new ResizeObserver(place);
    resizes.observe(slot);
    list.addEventListener('scroll', place);
    window.addEventListener('resize', place);
    return () => {
      resizes.disconnect();
      list.removeEventListener('scroll', place);
      window.removeEventListener('resize', place);
    };
  }, [focusedAgentId, idCount]);
  // WINDOW-LAYERS: the member card rides with the party, so a card that opens (from a portrait or the world)
  // brings the party in front of the windows; a press on the party does too (HudLayer).
  const hud = useHud();
  const cards = describeCard !== undefined;
  useEffect(() => {
    if (inHud && cards && focusedAgentId !== null) panelToFront('party');
  }, [inHud, cards, focusedAgentId]);
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
    {/* In the HUD layer (agty desktop) the bar sits centred on the right edge (hud-v3 P0, FEAT-PARTY-V2), as tall as
        its cards (PARTY-FRAME), in the HUD's one stack (last pressed in front); elsewhere it stays the flex sibling that overlays the office's
        right edge. */}
    <div
      ref={wrapRef}
      // FEAT-PARTY-V2 (owner 11-06 18:14): in the HUD the party sits centred on the window's height however
      // many it lists (the same inset above and below; it scrolls inside when taller).
      className={`flex flex-col items-center py-4 pointer-events-none ${inHud ? 'absolute right-0 justify-center' : 'relative z-30 h-full shrink-0'}`}
      style={{
        width,
        ...(inHud
          ? { top: HUD_CORNER_ROW_PX, bottom: HUD_CORNER_ROW_PX, zIndex: layerZ(hud, 'party') }
          : { marginLeft: -width }),
      }}
      data-hud-panel={inHud ? 'party' : undefined}
    >
      {/* hud-v3 P0: the selected employee's inspector opens left of the bar (CharacterLabel draws into it),
          beside its portrait (the effect above sets its top), over the portraits' 기다림 tails. */}
      {inHud && describeCard && (
        <div
          ref={(el) => {
            slotRef.current = el;
            setInspectorSlot(el);
          }}
          className="absolute top-4 right-full mr-8 z-10 pointer-events-none"
          data-testid="inspector-slot"
        />
      )}
      <div
        className={`pixel-panel pointer-events-auto flex flex-col items-center min-h-0 max-h-full select-none ${inHud ? 'ui-window' : ''} ${folded ? 'gap-4 p-4' : 'gap-6 p-6'}`}
        style={{ width: width - (folded ? 4 : 8) }}
        data-folded={folded || undefined}
        data-testid="card-container"
        data-hud-fixed
        onPointerDown={onPointerDown}
      >
        {party.head}
        {party.card}
        {describeCard && <PartyWaiting ids={ids} />}
        {/* ponytail: a folded list that scrolls (past CARD_BAR_MAX_VISIBLE) clips the 기다림 tails; they
            hang outside it otherwise. */}
        <div
          ref={listRef}
          className={`relative flex flex-col items-center min-h-0 ${folded ? 'gap-4' : 'gap-6'} ${folded && listCap === null ? '' : 'overflow-y-auto'}`}
          style={listCap === null ? undefined : { maxHeight: listCap }}
        >
          {rows.map(({ id: agentId, depth }) => {
            const info = describeCard?.(agentId);
            return (
                <div
                  key={agentId}
                  data-depth={depth || undefined}
                  ref={(el) => {
                    if (el) cardRefs.current.set(agentId, el);
                    else cardRefs.current.delete(agentId);
                  }}
                  className={`${depth ? 'party-worker' : ''} ${draggingId === agentId ? 'opacity-70' : ''}`}
                >
                  {folded ? (
                    <PartyPortrait
                      id={agentId}
                      name={info?.name ?? `Agent ${agentId}`}
                      look={getAppearance(agentId)}
                      temps={info?.temps ?? 0}
                      variant={cardVariant(agentId, { activeId: activeAgentId, focusedId: focusedAgentId })}
                      onSelect={(id) => {
                        if (!party.press?.(id)) onSelect(id);
                      }}
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
                    />
                  )}
                  {party.subs(agentId)}
                </div>
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
