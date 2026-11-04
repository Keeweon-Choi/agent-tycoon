import { Fragment, useEffect, useLayoutEffect, useRef, useState } from 'react';

import { lookNameOf } from '../../cld/characters/looks.js';
import { employeeFatigue, employeeOf } from '../../cld/employees.js';
import { describeActivity } from '../../cld/ez/activity.js';
import { CharacterLabel } from '../../cld/ez/CharacterLabel.js';
import { FatigueBar, RestBubble } from '../../cld/ez/Fatigue.js';
import { fatigueRules } from '../../cld/ez/fatigueState.js';
import { offAlpha } from '../../cld/ez/nameplate.js';
import { OwnerPlate } from '../../cld/ez/OwnerPlate.js';
import { nameplatesOn, useNameplatePass } from '../../cld/ez/useNameplates.js';
import { characterVisual, publishCharacterRing, publishCharacterVisual, RING_WORDS } from '../../cld/ez/visuals.js';
import { characterKind, characterName, showsNameLabel } from '../../cld/kinds.js';
import { OfficeBadges } from '../../cld/OfficeBadges.js';
import { cldGetSnapshot, ezContext, fatigueFor, identityForAgent } from '../../cld/officeStore.js';
import { Button } from '../../components/ui/Button.js';
import {
  BUBBLE_FADE_DURATION_SEC,
  BUBBLE_SITTING_OFFSET_PX,
  BUBBLE_VERTICAL_OFFSET_PX,
  CHARACTER_SITTING_OFFSET_PX,
  CONTEXT_CRITICAL_THRESHOLD,
  CONTEXT_DANGER_THRESHOLD,
  CONTEXT_GAUGE_BG,
  CONTEXT_GAUGE_COLOR_CRITICAL,
  CONTEXT_GAUGE_COLOR_DANGER,
  CONTEXT_GAUGE_COLOR_OK,
  CONTEXT_GAUGE_COLOR_WARN,
  CONTEXT_GAUGE_HEIGHT_PX,
  CONTEXT_GAUGE_WIDTH_PX,
  CONTEXT_WARN_THRESHOLD,
  EZ_MOOD_ICON_OFFSET_X,
  EZ_MOOD_ICON_OFFSET_Y,
  OFF_OVERLAY_ALPHA,
  OVERLAY_BUBBLE_Z_INDEX,
  OVERLAY_CONTENT_MS,
  OVERLAY_LABEL_SELECTED_Z_INDEX,
  OVERLAY_LABEL_Z_INDEX,
  OWNER_CHARACTER_ID,
  TEAM_LEAD_COLOR,
  TEAM_ROLE_COLOR,
  TOOL_OVERLAY_VERTICAL_OFFSET,
} from '../../constants.js';
import type { SubagentCharacter } from '../../hooks/useExtensionMessages.js';
import { onOfficeDrawn } from '../engine/gameLoop.js';
import type { OfficeState } from '../engine/officeState.js';
import { overlayProjection } from '../projection.js';
import { getCachedSprite } from '../sprites/spriteCache.js';
import {
  BUBBLE_PERMISSION_SPRITE,
  BUBBLE_WAITING_SPRITE,
  characterLift,
} from '../sprites/spriteData.js';
import type { Character, ToolActivity } from '../types.js';
import { CharacterState } from '../types.js';
import type { Bind } from './overlayPlacer.js';
import { createPlacer } from './overlayPlacer.js';

// Both turn-end states show the green checkmark bubble. A finished turn (Stop)
// shows ONLY the checkmark (the label falls through to its normal idle text);
// going idle waiting on the user (Notification(idle_prompt)) additionally
// surfaces this label. Driven by Character.waitingAwaitingInput.
const WAITING_INPUT_ACTIVITY_TEXT = 'Waiting for input';

interface ToolOverlayProps {
  officeState: OfficeState;
  agents: number[];
  agentTools: Record<number, ToolActivity[]>;
  subagentTools: Record<number, Record<string, ToolActivity[]>>;
  subagentCharacters: SubagentCharacter[];
  containerRef: React.RefObject<HTMLDivElement | null>;
  zoom: number;
  panRef: React.RefObject<{ x: number; y: number }>;
  onCloseAgent: (id: number) => void;
  alwaysShowOverlay: boolean;
  /** UI-PHONE: the phone shell: an open summary card dims every other plate. */
  phone?: boolean;
  /** UI-PHONE: the selected agent's menu is a row of its card (the phone, when menus are on). */
  cardMenu?: boolean;
}

/** Derive a short human-readable activity string from tools/status */
function getActivityText(
  agentId: number,
  agentTools: Record<number, ToolActivity[]>,
  isActive: boolean,
  bubbleType: 'permission' | 'waiting' | null,
  waitingAwaitingInput: boolean,
): string {
  if (bubbleType === 'permission') return 'Needs approval';
  // Only the idle case ("Waiting for input") gets a dedicated label. A finished
  // turn (Stop, waitingAwaitingInput=false) falls through so the checkmark alone
  // signals "done", same as the original behavior.
  if (bubbleType === 'waiting' && waitingAwaitingInput) return WAITING_INPUT_ACTIVITY_TEXT;

  const tools = agentTools[agentId];
  if (tools && tools.length > 0) {
    // Find the latest non-done tool
    const activeTool = [...tools].reverse().find((t) => !t.done);
    if (activeTool) {
      if (activeTool.permissionWait) return 'Needs approval';
      return activeTool.status;
    }
    // All tools done but agent still active (mid-turn) — keep showing last tool status
    if (isActive) {
      const lastTool = tools[tools.length - 1];
      if (lastTool) return lastTool.status;
    }
  }

  return 'Idle';
}

/** The raw tool status (and the file's basename, when the status does not already say it): the label's tooltip. */
function rawActivity(status: string, detail: string | undefined): string {
  return detail && !status.includes(detail) ? `${status} · ${detail}` : status;
}

function getFuelColor(ratio: number): string {
  if (ratio >= CONTEXT_CRITICAL_THRESHOLD) return CONTEXT_GAUGE_COLOR_CRITICAL;
  if (ratio >= CONTEXT_DANGER_THRESHOLD) return CONTEXT_GAUGE_COLOR_DANGER;
  if (ratio >= CONTEXT_WARN_THRESHOLD) return CONTEXT_GAUGE_COLOR_WARN;
  return CONTEXT_GAUGE_COLOR_OK;
}

/** A speech-bubble sprite blitted into a DOM canvas. Bubbles live in the DOM
 *  (not the office canvas) so they can stack ABOVE the status label panels —
 *  canvas content can never out-paint the DOM overlay. */
function OverlayBubble({ cached, dpr }: { cached: HTMLCanvasElement; dpr: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.width = cached.width;
    canvas.height = cached.height;
    canvas.getContext('2d')?.drawImage(cached, 0, 0);
  }, [cached]);
  return (
    <canvas
      ref={canvasRef}
      className="block"
      style={{ width: cached.width / dpr, height: cached.height / dpr }}
    />
  );
}

export function ToolOverlay({
  officeState,
  agents,
  agentTools,
  subagentTools,
  subagentCharacters,
  containerRef,
  zoom,
  panRef,
  onCloseAgent,
  alwaysShowOverlay,
  phone = false,
  cardMenu = false,
}: ToolOverlayProps) {
  const [, setTick] = useState(0);
  // charpack v3 §6A: the nameplates' overlap pass (at once on a new focus or zoom).
  const plateSizes = useNameplatePass(
    containerRef,
    `${officeState.selectedAgentId}:${officeState.hoveredAgentId}:${zoom}:${nameplatesOn()}`,
  );
  // SMOOTH2-1104: positions move on every canvas frame straight in the DOM (overlayPlacer.ts); what
  // the plates SAY re-renders here only when it changed (the signature) and, as a net for state that
  // signals nothing (staff, fatigue, the status icon's blink), every OVERLAY_CONTENT_MS.
  const [placer] = useState(createPlacer);
  const [bounds] = useState({ width: 0, height: 0 }); // the container's size, kept by a ResizeObserver
  const live = useRef({ props: null as unknown as ToolOverlayProps });
  useLayoutEffect(() => {
    live.current.props = {
      officeState, agents, agentTools, subagentTools, subagentCharacters, containerRef,
      zoom, panRef, onCloseAgent, alwaysShowOverlay, phone, cardMenu,
    };
  });
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => {
      bounds.width = e.contentRect.width;
      bounds.height = e.contentRect.height;
    });
    ro.observe(el);
    let lastSig = '';
    let lastSnap: unknown;
    let snapVersion = 0;
    let lastContent = 0;
    const stop = onOfficeDrawn(() => {
      const p = live.current.props;
      const dpr = window.devicePixelRatio || 1;
      const layout = p.officeState.getLayout();
      placer.frame(overlayProjection(layout, bounds, p.zoom, p.panRef.current, dpr), layout, dpr);
      // The signature of what the plates say (not where they are).
      const snap = cldGetSnapshot();
      if (snap !== lastSnap) {
        lastSnap = snap;
        snapVersion++;
      }
      const os = p.officeState;
      let sig = `${snapVersion}|${os.selectedAgentId}|${os.hoveredAgentId}`;
      for (const id of [...p.agents, ...p.subagentCharacters.map((s) => s.id), OWNER_CHARACTER_ID]) {
        const ch = os.characters.get(id);
        if (!ch) continue;
        sig += `|${id}:${placer.viewOf(ch).shift}:${ch.bubbleType}:${ch.waitingAwaitingInput}:${ch.isActive}:${ch.contextTokens}:${ch.maxContextTokens}:${ch.palette}:${ch.hueShift}:${ch.isTeamLead}:${ch.agentName}:${ch.directoryName}`;
      }
      const now = performance.now();
      if (sig !== lastSig || now - lastContent >= OVERLAY_CONTENT_MS) {
        lastSig = sig;
        lastContent = now;
        setTick((n) => n + 1);
      }
      placer.run();
    });
    setTick((n) => n + 1); // the container exists now: the first render could not see it
    return () => {
      stop();
      ro.disconnect();
    };
  }, [containerRef, placer, bounds]);

  const el = containerRef.current;
  if (!el) return null;
  // dpr is also needed to size the bubble canvases in CSS px (OverlayBubble).
  const dpr = window.devicePixelRatio || 1;
  const layout = officeState.getLayout();
  if (!bounds.width) {
    const r = el.getBoundingClientRect(); // once; the observer keeps it after
    bounds.width = r.width;
    bounds.height = r.height;
  }
  placer.frame(overlayProjection(layout, bounds, zoom, panRef.current, dpr), layout, dpr);

  const selectedId = officeState.selectedAgentId;
  const hoveredId = officeState.hoveredAgentId;
  const officeSnapshot = cldGetSnapshot();
  const cardOpen = phone && selectedId !== null && selectedId !== OWNER_CHARACTER_ID;

  const bubbleFor = (ch: Character, id: number, bind: Bind, other: boolean) => {
    if (!ch.bubbleType || (!other && ch.bubbleType === 'waiting' && ch.waitingAwaitingInput))
      return null;
    const cachedBubble = getCachedSprite(
      ch.bubbleType === 'permission' ? BUBBLE_PERMISSION_SPRITE : BUBBLE_WAITING_SPRITE,
      zoom,
    );
    return (
      <div
        key={id}
        ref={bind('bubble', (at, px) => ({
          x: at.toScreenX(ch.x),
          y:
            at.toScreenY(
              ch.y +
                (ch.state === CharacterState.TYPE ? BUBBLE_SITTING_OFFSET_PX : 0) -
                BUBBLE_VERTICAL_OFFSET_PX -
                characterLift(ch.palette, ch.hueShift),
            ) -
            (cachedBubble.height + zoom) / px,
          opacity:
            ch.bubbleType === 'waiting' && ch.bubbleTimer < BUBBLE_FADE_DURATION_SEC
              ? ch.bubbleTimer / BUBBLE_FADE_DURATION_SEC
              : 1,
        }))}
        className="absolute left-0 top-0 -translate-x-1/2 pointer-events-none"
        data-testid="agent-bubble"
        data-agent-id={id}
        data-bubble={ch.bubbleType}
        data-other-floor={other ? '' : undefined}
        style={{ zIndex: OVERLAY_BUBBLE_Z_INDEX }}
      >
        <OverlayBubble cached={cachedBubble} dpr={dpr} />
      </div>
    );
  };

  // All character IDs
  const allIds = [...agents, ...subagentCharacters.map((s) => s.id)];

  // OWNER-HUD: the owner's character is no agent (not in allIds): its "나" plate, on its floor only.
  const ownerPlate = () => {
    const owner = officeState.characters.get(OWNER_CHARACTER_ID);
    if (!owner || !officeSnapshot.officeSnapshot) return null;
    if (placer.viewOf(owner).shift !== 0) return null;
    return (
      <OwnerPlate
        ch={owner}
        bind={(slot, fn) => placer.bind(`${OWNER_CHARACTER_ID}:${slot}`, owner, fn)}
        lift={characterLift(owner.palette, owner.hueShift)}
        dim={cardOpen}
      />
    );
  };

  // select-none (cld-gui T-0025/T-0045): a drag across the office never selects the labels.
  return (
    <div className="contents select-none">
      {allIds.map((id) => {
        const ch = officeState.characters.get(id);
        if (!ch) return null;
        // ISO-PILOT: in the isometric building, everything is placed from where it drew the
        // feet; a character off the floor in focus shows its bubble only.
        const { shift } = placer.viewOf(ch);
        const bind: Bind = (slot, fn) => placer.bind(`${id}:${slot}`, ch, fn);
        const isSelected = selectedId === id;
        const isHovered = hoveredId === id;
        const isSub = ch.isSubagent;
        const officeIdentity = identityForAgent(id, officeSnapshot.officeSnapshot, officeSnapshot.codexTasks);
        // cld: one friendly description per character, from the tool row
        // upstream's label shows (getActivityText; a sub-agent's own rows).
        // No row reads as idle, like upstream's "Idle": characters start
        // active and the office's synthetic ones never hear otherwise. The raw
        // status and the file's basename stay as the label's tooltip.
        const subChar = isSub ? subagentCharacters.find((s) => s.id === id) : undefined;
        const ezRows = subChar
          ? subagentTools[subChar.parentAgentId]?.[subChar.parentToolId]
          : agentTools[id];
        const ezTool = ezRows
          ? ([...ezRows].reverse().find((t) => !t.done) ??
            (ch.isActive ? ezRows.at(-1) : undefined))
          : undefined;
        const activity = describeActivity(
          {
            toolName: ezTool?.toolName,
            status: ezTool?.status,
            desc: ezTool?.desc,
            permission:
              ch.bubbleType === 'permission' || (!!ezTool?.permissionWait && !ezTool.done),
            waitingInput: ch.bubbleType === 'waiting' && !!ch.waitingAwaitingInput,
            idle: !ezTool && (!isSub || !ch.isActive), // cld T-0041: a lingering sub rests
            // A finished turn's checkmark beats a stale busy flag.
            busy: !!officeIdentity?.busy && ch.bubbleType !== 'waiting',
          },
          ezContext(officeSnapshot),
        );
        // The raw tool status (what the old 자세히 mode printed): the label's tooltip.
        const hasWaitingBubble = ch.bubbleType === 'waiting';
        const subHasPermission = isSub && ch.bubbleType === 'permission';
        let activityText: string;
        if (hasWaitingBubble && ch.waitingAwaitingInput) {
          // Idle, waiting on the user -> dedicated label. A finished turn (Stop)
          // shows only the checkmark and falls through to the normal idle text.
          activityText = WAITING_INPUT_ACTIVITY_TEXT;
        } else if (isSub) {
          if (subHasPermission) {
            activityText = 'Needs approval';
          } else {
            // Hover shows the subtask title; SELECTING the sub reveals its live
            // tool activity (watched sub-agents stream it via subagentToolStart).
            const sub = subagentCharacters.find((s) => s.id === id);
            const rows = sub ? subagentTools[sub.parentAgentId]?.[sub.parentToolId] : undefined;
            const activeRow =
              isSelected && rows ? [...rows].reverse().find((t) => !t.done) : undefined;
            activityText = activeRow?.status ?? (sub?.label || 'Subtask');
          }
        } else {
          activityText = getActivityText(
            id,
            agentTools,
            ch.isActive,
            ch.bubbleType,
            ch.waitingAwaitingInput ?? false,
          );
        }

        // cld T-0026: the ring, prop and head badge for this activity; the
        // canvas renderer draws the first two (cld office only).
        const visual = characterVisual(activity, !!officeIdentity?.off);
        // Every character's ring, on this floor or not: the staff rules (야근, 퇴근) read it.
        publishCharacterRing(id, visual.ring);
        if (shift === null) return null;
        if (shift !== 0) {
          publishCharacterVisual(id, undefined);
          return bubbleFor(ch, id, bind, true);
        }
        // TEMP-PLATES: a roster employee's 피로도 is its execution's own context (null: unknown).
        const employee = employeeOf(id, officeSnapshot);
        const fatigue =
          fatigueFor(id, officeSnapshot) ??
          (employee ? employeeFatigue(employee, fatigueRules(officeSnapshot.ezRules?.fatigue)) : null);
        // cld T-0036 + charpack v3 §6A: a nameplate on every named character
        // (kinds.ts showsNameLabel), details on hover or tap (cld/ez/CharacterLabel.tsx).
        if (officeSnapshot.officeSnapshot) {
          const { officeSnapshot: cldOffice, codexTasks } = officeSnapshot;
          const kind = characterKind(ch, cldOffice, codexTasks);
          const named = showsNameLabel(kind, alwaysShowOverlay, nameplatesOn(), !!employee);
          publishCharacterVisual(id, { ...visual, fatigue, headIcon: !named });
          return (
            <CharacterLabel
              key={id}
              ch={ch}
              kind={kind}
              name={characterName(ch, cldOffice, codexTasks, subChar?.label)}
              named={named}
              visual={visual}
              rawActivity={rawActivity(activityText, activity.detail)}
              fatigue={fatigue}
              identity={officeIdentity}
              hovered={isHovered}
              selected={isSelected}
              canClose={!isSub && !cldOffice.readOnly}
              onClose={() => onCloseAgent(id)}
              bind={bind}
              plateSizes={plateSizes}
              lift={characterLift(ch.palette, ch.hueShift)}
              bounds={bounds}
              menuName={cardMenu && isSelected ? lookNameOf(id, cldOffice) : undefined}
              dim={cardOpen && !isSelected}
            />
          );
        }
        publishCharacterVisual(id, undefined);
        // The head badge, on every character: left of the head (the prop is
        // on the right), clear of the bubble; a DOM node like OfficeBadges, so it
        // stays crisp at every zoom.
        const moodNode = (
          <span
            ref={bind('mood', (at) => ({
              x: at.toScreenX(ch.x + EZ_MOOD_ICON_OFFSET_X),
              y: at.toScreenY(
                ch.y +
                  (ch.state === CharacterState.TYPE ? CHARACTER_SITTING_OFFSET_PX : 0) -
                  EZ_MOOD_ICON_OFFSET_Y -
                  characterLift(ch.palette, ch.hueShift),
              ),
            }))}
            className="absolute left-0 top-0 -translate-x-full -translate-y-full pointer-events-none bg-bg border border-border px-4 text-xs leading-tight shadow-pixel"
            style={{ zIndex: OVERLAY_LABEL_Z_INDEX }}
            data-testid="ez-mood"
            data-agent-id={id}
            data-prop={visual.prop ?? ''}
            data-ring={visual.ring}
            role="img"
            aria-label={`${RING_WORDS[visual.ring]}: ${visual.text}`}
          >
            {visual.icon}
          </span>
        );

        const bubbleNode = bubbleFor(ch, id, bind, false);

        // Only show the label for hovered or selected agents (unless
        // always-show is on) — the bubble renders regardless.
        if (!officeIdentity && !alwaysShowOverlay && !isSelected && !isHovered) {
          return (
            <Fragment key={id}>
              {moodNode}
              {bubbleNode}
            </Fragment>
          );
        }

        // Position above character
        const labelAt = bind('label', (at) => ({
          x: at.toScreenX(ch.x),
          y: at.toScreenY(
            ch.y +
              (ch.state === CharacterState.TYPE ? CHARACTER_SITTING_OFFSET_PX : 0) -
              TOOL_OVERLAY_VERTICAL_OFFSET -
              characterLift(ch.palette, ch.hueShift),
          ),
        }));

        // A "Done" agent (finished turn: waiting bubble without awaitingInput)
        // shows ONLY its floating green checkmark bubble, never the label panel
        // (the panel would cover the bubble). Render an empty positioned marker
        // so overlay counts stay stable and hover/select can still bring the
        // panel back. When always-show is off, the early return above already
        // keeps the panel hidden for idle agents.
        const isDone = ch.bubbleType === 'waiting' && !ch.waitingAwaitingInput;
        if (isDone && !officeIdentity && !isSelected && !isHovered) {
          return (
            <Fragment key={id}>
              {moodNode}
              {bubbleNode}
              <div
                ref={labelAt}
                className="absolute left-0 top-0"
                style={{ pointerEvents: 'none' }}
                data-testid="agent-overlay"
                data-agent-id={id}
              />
            </Fragment>
          );
        }

        // Determine dot color
        const tools = agentTools[id];
        const hasPermission = subHasPermission || tools?.some((t) => t.permissionWait && !t.done);
        const hasActiveTools = tools?.some((t) => !t.done);
        const isActive = ch.isActive;
        const hasWaiting = ch.bubbleType === 'waiting';

        let dotColor: string | null = null;
        if (hasPermission || hasWaiting) {
          dotColor = 'var(--color-status-permission)';
        } else if (isActive && hasActiveTools) {
          dotColor = 'var(--color-status-active)';
        }

        // Team info
        const teamRoleLabel = ch.isTeamLead ? 'LEAD' : ch.agentName || null;

        // Context gauge. Every agent gets one — lead, teammate, adopted,
        // headless — as soon as it has taken a turn. Sub-agents never do: they
        // have no session of their own, so contextTokens stays 0.
        const contextRatio = ch.contextTokens / ch.maxContextTokens;
        const showContextGauge = !isSub && ch.contextTokens > 0;

        return (
          <Fragment key={id}>
            {moodNode}
            {bubbleNode}
            <div
              ref={labelAt}
              // Grows upward from just above the head (rest bubble, name, 피로도).
              className="absolute left-0 top-0 flex flex-col items-center -translate-x-1/2 -translate-y-full"
              style={{
                pointerEvents: isSelected ? 'auto' : 'none',
                opacity: officeIdentity?.off
                  ? offAlpha(true, isSelected || isHovered, OFF_OVERLAY_ALPHA)
                  : alwaysShowOverlay && !isSelected && !isHovered
                    ? isSub
                      ? 0.5
                      : 0.75
                    : 1,
                zIndex: isSelected ? OVERLAY_LABEL_SELECTED_Z_INDEX : OVERLAY_LABEL_Z_INDEX,
              }}
              data-testid="agent-overlay"
              data-agent-id={id}
            >
              {fatigue?.rest && <RestBubble className="mb-4" />}
              {officeIdentity && <OfficeBadges identity={officeIdentity} />}
              <div className="flex items-center border-border px-8 pt-2 pb-4 gap-5 pixel-panel whitespace-nowrap max-w-2xs">
                {dotColor && (
                  <span
                    className={`w-6 h-6 rounded-full shrink-0 ${isActive && !hasPermission && !hasWaiting ? 'pixel-pulse' : ''}`}
                    style={{ background: dotColor }}
                  />
                )}
                <div className="flex flex-col gap-0 overflow-hidden">
                  {officeIdentity && (
                    <span className="text-xs font-bold text-accent-text leading-tight truncate">
                      {officeIdentity.label}
                    </span>
                  )}
                  {teamRoleLabel && (
                    <span
                      className="overflow-hidden text-ellipsis block leading-none"
                      style={{
                        fontSize: '18px',
                        color: ch.isTeamLead ? TEAM_LEAD_COLOR : TEAM_ROLE_COLOR,
                        fontWeight: ch.isTeamLead ? 'bold' : undefined,
                      }}
                    >
                      {teamRoleLabel}
                    </span>
                  )}
                  {fatigue && <FatigueBar look={fatigue} />}
                  {/* The label is the name; the activity in words shows on
                      hover or tap (the badge carries it otherwise). */}
                  {(isSelected || isHovered || !(officeIdentity || teamRoleLabel)) && (
                    <span
                      className="overflow-hidden text-ellipsis block leading-none"
                      style={{
                        // Hangul falls back from the pixel font to a system face,
                        // which reads twice as large at the same size.
                        fontSize: isSub ? '16px' : '18px',
                        fontStyle: isSub ? 'italic' : undefined,
                      }}
                      title={rawActivity(activityText, activity.detail)}
                      data-testid="activity-text"
                    >
                      {`${visual.icon} ${visual.text}`}
                    </span>
                  )}
                  {ch.directoryName && !officeIdentity && (
                    <span className="text-2xs leading-none overflow-hidden text-ellipsis block">
                      {ch.directoryName}
                    </span>
                  )}
                </div>
                {isSelected && !isSub && (
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={(e) => {
                      e.stopPropagation();
                      onCloseAgent(id);
                    }}
                    title="Close agent"
                    className="ml-2 shrink-0 leading-none"
                  >
                    ×
                  </Button>
                )}
              </div>
              {showContextGauge && (
                <div
                  style={{
                    width: CONTEXT_GAUGE_WIDTH_PX,
                    height: CONTEXT_GAUGE_HEIGHT_PX,
                    background: CONTEXT_GAUGE_BG,
                    marginTop: 2,
                  }}
                  title={`${Math.round(contextRatio * 100)}% context used (${(ch.contextTokens / 1000).toFixed(0)}k of ${(ch.maxContextTokens / 1000).toFixed(0)}k tokens)`}
                  data-testid="context-gauge"
                  data-context-pct={Math.round(contextRatio * 100)}
                >
                  <div
                    style={{
                      width: `${Math.min(contextRatio * 100, 100)}%`,
                      height: '100%',
                      background: getFuelColor(contextRatio),
                    }}
                  />
                </div>
              )}
            </div>
          </Fragment>
        );
      })}
      {ownerPlate()}
    </div>
  );
}
