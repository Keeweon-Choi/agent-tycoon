import type { ReactNode } from 'react';

import { CARD_BAR_CARD_WIDTH_PX } from '../constants.js';
import type { CardVariant } from './cardBar.js';
import { CharacterMugShot } from './CharacterMugShot.js';
import { Button } from './ui/Button.js';

/** How a given agent's character looks, for the tab mug shot. */
export interface AgentAppearance {
  palette: number;
  hueShift: number;
}

/** Agent activity reflected by the tab's status dot. */
export type AgentActivity = 'idle' | 'working' | 'attention';

/** Activity plus the drawer-owned "connection broken" state. */
export type TabStatus = AgentActivity | 'disconnected';

const STATUS_DOT: Record<TabStatus, string> = {
  idle: 'bg-status-success', // green — turn complete, nothing pending
  working: 'bg-accent-bright', // blue — actively running
  attention: 'bg-status-permission', // yellow — needs permission or input
  disconnected: 'bg-status-error', // red — terminal socket dropped
};

const CARD_VARIANT: Record<CardVariant, string> = {
  default: 'bg-btn-bg border-transparent hover:bg-btn-hover',
  focused: 'bg-active-bg border-transparent',
  active: 'bg-active-bg border-accent',
};

interface AgentCardProps {
  agentId: number;
  variant: CardVariant;
  appearance: AgentAppearance;
  status: TabStatus | null;
  /** When false the × is invisible (not removed — the card keeps its width so
   *  the bar doesn't reflow). Mobile only shows it on the active terminal tab
   *  to keep a stray tap from killing an agent. */
  showClose?: boolean;
  onSelect: (agentId: number) => void;
  onClose: (agentId: number) => void;
  /** cld-gui (T-0036): the name under the mug shot (full name in the tooltip). */
  name?: string;
  /** cld-gui (T-0041): under the name ("+N" temps, 퇴근). */
  extra?: ReactNode;
  /** The phone's default (owner 10-24): one row, the mug shot beside the name and the
   *  status (dot and `status`); `extra` waits for the full card. */
  compact?: boolean;
  /** Beside the dot on a compact card (퇴근, 야근). */
  statusNote?: ReactNode;
  /** cld-gui (CH-4): right-click (desktop card) opens 꾸미기. */
  onCustomize?: (agentId: number) => void;
  /** The desktop bar's card (owner 10-24): a fixed width and bigger text; the face keeps its size. */
  large?: boolean;
}

/** One agent's card in the terminal sidebar — mug shot beside a
 *  close-button/status-dot column. The cards double as the terminal panel's
 *  tabs: clicking one selects that agent's pane. */
export function AgentCard({
  agentId,
  variant,
  appearance,
  status,
  showClose = true,
  onSelect,
  onClose,
  name,
  extra,
  compact = false,
  statusNote,
  onCustomize,
  large = false,
}: AgentCardProps) {
  if (compact)
    return (
      <div
        className={`pointer-events-auto flex items-center gap-4 h-44 pr-6 cursor-pointer border-2 shrink-0 max-w-[136px] ${CARD_VARIANT[variant]}`}
        onClick={() => onSelect(agentId)}
        title={name ?? `Agent ${agentId}`}
        data-testid="agent-card"
        data-agent-id={agentId}
        data-compact
      >
        <CharacterMugShot palette={appearance.palette} hueShift={appearance.hueShift} />
        <span className="flex flex-col gap-2 min-w-0">
          <span
            className="truncate text-[length:calc(10px*var(--ui-scale))] leading-tight"
            data-testid="card-name"
          >
            {name ?? `Agent ${agentId}`}
          </span>
          <span className="flex items-center gap-4 min-w-0">
            <span
              className={`size-6 shrink-0 ${status ? STATUS_DOT[status] : ''}`}
              data-testid="card-status"
              data-status={status ?? undefined}
            />
            {statusNote}
          </span>
        </span>
        {showClose && (
          <Button
            variant="ghost"
            size="icon"
            onClick={(e) => {
              e.stopPropagation();
              onClose(agentId);
            }}
            title="Close agent"
            className="leading-none self-start"
          >
            ×
          </Button>
        )}
      </div>
    );
  return (
    <div
      className={`pointer-events-auto flex flex-col p-1 cursor-pointer border-2 shrink-0 ${CARD_VARIANT[variant]}`}
      style={large ? { width: CARD_BAR_CARD_WIDTH_PX } : undefined}
      onClick={() => onSelect(agentId)}
      onContextMenu={
        onCustomize &&
        ((e) => {
          e.preventDefault();
          onCustomize(agentId);
        })
      }
      title={name ?? `Agent ${agentId}`}
      data-testid="agent-card"
      data-agent-id={agentId}
    >
      <div className={`flex items-stretch ${large ? 'justify-center gap-6' : 'gap-1'}`}>
        <CharacterMugShot palette={appearance.palette} hueShift={appearance.hueShift} />
        {/* Close on top, status dot at the bottom, both centred over the
          same column beside the mug shot. */}
        <div className="flex flex-col items-center justify-between shrink-0">
          <Button
            variant="ghost"
            size="icon"
            onClick={(e) => {
              // Don't also select the tab we're about to remove.
              e.stopPropagation();
              onClose(agentId);
            }}
            title="Close agent"
            className={`leading-none ${showClose ? '' : 'invisible'}`}
          >
            ×
          </Button>
          {/* 1px left: optically centres the solid square under the pixel-font ×
            glyph, which sits a hair left in its cell. mb (not pb) lifts it off
            the card's bottom edge: the span is a fixed-size empty box, so
            padding is invisible — only margin moves it. */}
          <span
            className={`size-6 shrink-0 relative -left-1 mb-2 ${status ? STATUS_DOT[status] : ''}`}
          />
        </div>
      </div>
      {name !== undefined && (
        // w-0 min-w-full: as wide as the card, never wider.
        <span
          className={`block w-0 min-w-full truncate text-center leading-tight ${large ? 'text-[length:calc(18px*var(--ui-scale))]' : 'text-[length:calc(10px*var(--ui-scale))]'}`}
          data-testid="card-name"
        >
          {name}
        </span>
      )}
      {large ? (
        <div className="w-full [&_*]:text-[length:calc(14px*var(--ui-scale))]!">{extra}</div>
      ) : (
        extra
      )}
    </div>
  );
}
