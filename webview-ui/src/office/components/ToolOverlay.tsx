import { Fragment, useEffect, useRef, useState } from 'react';

import { employeeFatigue, employeeOf } from '../../cld/employees.js';
import { describeActivity } from '../../cld/ez/activity.js';
import { CharacterLabel } from '../../cld/ez/CharacterLabel.js';
import { FatigueBar, RestBubble } from '../../cld/ez/Fatigue.js';
import { fatigueRules } from '../../cld/ez/fatigue.js';
import { offAlpha } from '../../cld/ez/nameplate.js';
import { nameplatesOn, useNameplatePass } from '../../cld/ez/useNameplates.js';
import { characterVisual, publishCharacterRing, publishCharacterVisual, RING_WORDS } from '../../cld/ez/visuals.js';
import { drawnShift } from '../../cld/floors.js';
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
  OVERLAY_LABEL_SELECTED_Z_INDEX,
  OVERLAY_LABEL_Z_INDEX,
  TEAM_LEAD_COLOR,
  TEAM_ROLE_COLOR,
  TOOL_OVERLAY_VERTICAL_OFFSET,
} from '../../constants.js';
import type { SubagentCharacter } from '../../hooks/useExtensionMessages.js';
import { frameDue } from '../engine/gameLoop.js';
import type { OfficeState } from '../engine/officeState.js';
import type { OverlayProjection } from '../projection.js';
import { overlayProjection } from '../projection.js';
import { getCachedSprite } from '../sprites/spriteCache.js';
import { BUBBLE_PERMISSION_SPRITE, BUBBLE_WAITING_SPRITE } from '../sprites/spriteData.js';
import type { Character, ToolActivity } from '../types.js';
import { CharacterState } from '../types.js';

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
}: ToolOverlayProps) {
  const [, setTick] = useState(0);
  // charpack v3 §6A: the nameplates' overlap pass (at once on a new focus or zoom).
  const plateSizes = useNameplatePass(
    containerRef,
    `${officeState.selectedAgentId}:${officeState.hoveredAgentId}:${zoom}:${nameplatesOn()}`,
  );
  useEffect(() => {
    let rafId = 0;
    // cld-gui (T-0025): on the canvas's frames only (≤60 fps, in step with it).
    const tick = (ts: number) => {
      if (frameDue(ts)) setTick((n) => n + 1);
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, []);

  const el = containerRef.current;
  if (!el) return null;
  // dpr is also needed to size the bubble canvases in CSS px (OverlayBubble).
  const dpr = window.devicePixelRatio || 1;
  const layout = officeState.getLayout();
  const bounds = el.getBoundingClientRect();
  const project = overlayProjection(layout, bounds, zoom, panRef.current, dpr);

  const selectedId = officeState.selectedAgentId;
  const hoveredId = officeState.hoveredAgentId;
  const officeSnapshot = cldGetSnapshot();

  const bubbleFor = (ch: Character, id: number, at: OverlayProjection, other: boolean) => {
    if (!ch.bubbleType || (!other && ch.bubbleType === 'waiting' && ch.waitingAwaitingInput))
      return null;
    const cachedBubble = getCachedSprite(
      ch.bubbleType === 'permission' ? BUBBLE_PERMISSION_SPRITE : BUBBLE_WAITING_SPRITE,
      zoom,
    );
    const bubbleSittingOff = ch.state === CharacterState.TYPE ? BUBBLE_SITTING_OFFSET_PX : 0;
    const alpha =
      ch.bubbleType === 'waiting' && ch.bubbleTimer < BUBBLE_FADE_DURATION_SEC
        ? ch.bubbleTimer / BUBBLE_FADE_DURATION_SEC
        : 1;
    return (
      <div
        key={id}
        className="absolute -translate-x-1/2 pointer-events-none"
        data-testid="agent-bubble"
        data-agent-id={id}
        data-bubble={ch.bubbleType}
        data-other-floor={other ? '' : undefined}
        style={{
          left: at.toScreenX(ch.x),
          top:
            at.toScreenY(ch.y + bubbleSittingOff - BUBBLE_VERTICAL_OFFSET_PX) -
            (cachedBubble.height + zoom) / dpr,
          opacity: alpha,
          zIndex: OVERLAY_BUBBLE_Z_INDEX,
        }}
      >
        <OverlayBubble cached={cachedBubble} dpr={dpr} />
      </div>
    );
  };

  // All character IDs
  const allIds = [...agents, ...subagentCharacters.map((s) => s.id)];

  // select-none (cld-gui T-0025/T-0045): a drag across the office never selects the labels.
  return (
    <div className="contents select-none">
      {allIds.map((id) => {
        const ch = officeState.characters.get(id);
        if (!ch) return null;
        const shift = drawnShift(layout, ch.y);
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
          const shifted = { ...project, toScreenY: (y: number) => project.toScreenY(y + shift) };
          return bubbleFor(ch, id, shifted, true);
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
          const leadId = subChar?.parentAgentId ?? ch.leadAgentId;
          const lead = leadId !== undefined ? officeState.characters.get(leadId) : undefined;
          return (
            <CharacterLabel
              key={id}
              ch={ch}
              kind={kind}
              name={characterName(ch, cldOffice, codexTasks, subChar?.label)}
              named={named}
              leadName={lead ? characterName(lead, cldOffice, codexTasks) : null}
              visual={visual}
              rawActivity={rawActivity(activityText, activity.detail)}
              fatigue={fatigue}
              identity={officeIdentity}
              hovered={isHovered}
              selected={isSelected}
              canClose={!isSub && !cldOffice.readOnly}
              onClose={() => onCloseAgent(id)}
              project={project}
              plateSize={plateSizes.get(id)}
              bounds={bounds}
            />
          );
        }
        publishCharacterVisual(id, undefined);
        // The head badge, on every character: left of the head (the prop is
        // on the right), clear of the bubble; a DOM node like OfficeBadges, so it
        // stays crisp at every zoom.
        const moodNode = (
          <span
            className="absolute -translate-x-full -translate-y-full pointer-events-none bg-bg border border-border px-4 text-xs leading-tight shadow-pixel"
            style={{
              left: project.toScreenX(ch.x + EZ_MOOD_ICON_OFFSET_X),
              top: project.toScreenY(
                ch.y +
                  (ch.state === CharacterState.TYPE ? CHARACTER_SITTING_OFFSET_PX : 0) -
                  EZ_MOOD_ICON_OFFSET_Y,
              ),
              zIndex: OVERLAY_LABEL_Z_INDEX,
            }}
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

        const bubbleNode = bubbleFor(ch, id, project, false);

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
        const sittingOffset = ch.state === CharacterState.TYPE ? CHARACTER_SITTING_OFFSET_PX : 0;
        const screenX = project.toScreenX(ch.x);
        const screenY = project.toScreenY(ch.y + sittingOffset - TOOL_OVERLAY_VERTICAL_OFFSET);

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
                className="absolute"
                style={{ left: screenX, top: screenY, pointerEvents: 'none' }}
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
              className="absolute flex flex-col items-center -translate-x-1/2 -translate-y-full"
              style={{
                left: screenX,
                // Grows upward from just above the head (rest bubble, name, 피로도).
                top: screenY,
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
    </div>
  );
}
