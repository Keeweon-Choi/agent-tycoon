import './touchTargets.css';

import type { ReactNode } from 'react';
import { useCallback, useLayoutEffect, useRef } from 'react';

import type { CardInfo } from '../components/cardBar.js';
import { MobileAgentBar } from '../components/MobileAgentBar.js';
import { MobileKeyBar } from '../components/MobileKeyBar.js';
import { submitTerminalLine } from '../components/mobileSend.js';
import { MobileTerminalPage } from '../components/MobileTerminalPage.js';
import type { TerminalInputHandle } from '../components/TerminalPane.js';
import { Button } from '../components/ui/Button.js';
import type { Directory } from '../hooks/useExtensionMessages.js';
import type { TerminalDrawerController } from '../hooks/useTerminalDrawer.js';
import { TRACK_TRANSITION, trackTransform, useEdgeSwipe } from './useEdgeSwipe.js';
import type { MobileShellController } from './useMobileShell.js';

interface MobileShellProps {
  /** The office region App builds for both shells. */
  office: ReactNode;
  shell: MobileShellController;
  drawer: TerminalDrawerController;
  /** Every top-level office agent, for the card bar. */
  agentIds: number[];
  terminalAgentIds: number[];
  focusedAgentId: number | null;
  terminalAvailable: boolean;
  terminalUnavailableReason: string | null;
  /** The + card's launch drawer. */
  directories: Directory[];
  onAddDirectory: () => void;
  onEditDirectory: (directory: Directory) => void;
  onCloseAgent: (agentId: number) => void;
  /** The software keyboard is up (useKeyboardViewport). */
  keyboardOpen: boolean;
  /** The card bar belongs only to the office home screen. */
  showAgentCards: boolean;
  hideActions?: boolean;
  /** cld-gui (T-0036): card groups and names (MobileAgentBar). */
  describeCard?: (agentId: number) => CardInfo | undefined;
  /** cld-gui (owner 10-24): what sits under the cards (the Dock, the usage line). It is the
   *  bottom-most band, so it, not the card bar, clears the home indicator. */
  bottom?: ReactNode;
}

/**
 * The phone layout: office and terminal as full-screen pages in a sliding
 * track, the agent cards in a bottom scroller, and the accessory key bar
 * above the software keyboard. Crossing the breakpoint (rotation, window
 * resize) remounts the terminal panes; their sockets reconnect and the
 * server replays the current screen.
 */
export function MobileShell({
  office,
  shell,
  drawer,
  agentIds,
  terminalAgentIds,
  focusedAgentId,
  terminalAvailable,
  terminalUnavailableReason,
  directories,
  onAddDirectory,
  onEditDirectory,
  onCloseAgent,
  keyboardOpen,
  showAgentCards,
  hideActions = false,
  describeCard,
  bottom,
}: MobileShellProps) {
  const shellRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  // The shell ends where the card bar starts: the toasts (ActionLayer,
  // EngineControls, AuthLayer) sit above it through --cld-toast-bottom.
  useLayoutEffect(() => {
    const shellElement = shellRef.current;
    if (!shellElement) return;
    const root = document.documentElement;
    const updateToastBottom = () => {
      const rect = shellElement.getBoundingClientRect();
      root.style.setProperty('--cld-toast-bottom', `${window.innerHeight - rect.bottom}px`);
    };
    updateToastBottom();
    const observer = new ResizeObserver(updateToastBottom);
    observer.observe(shellElement);
    window.addEventListener('resize', updateToastBottom);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', updateToastBottom);
      root.style.removeProperty('--cld-toast-bottom');
    };
  }, []);
  useEdgeSwipe(
    shellRef,
    trackRef,
    shell.view === 'terminal' ? 'office' : terminalAvailable ? 'terminal' : null,
    shell.toggleView,
  );

  const inputRef = useRef<TerminalInputHandle>(null);
  const handleKey = useCallback((sequence: string) => inputRef.current?.send(sequence), []);
  const handleSend = useCallback(() => {
    if (inputRef.current) submitTerminalLine(inputRef.current);
  }, []);

  return (
    <>
      {/* touch-none: drags on the track (canvas margins, safe-area strip,
          terminal padding) must never start an iOS page pan — with the
          keyboard up Safari pans the layout viewport on any vertical drag
          it gets to claim, making the whole app jump. The canvas and the
          terminal panes run their own touch handling; the card bar below
          is a sibling, so its horizontal scroll is unaffected. */}
      <div ref={shellRef} className="relative flex-1 min-h-0 overflow-hidden touch-none">
        {/* Sliding track: office and terminal side by side at 200% width;
            selecting a terminal slides one viewport-width left. Both pages
            keep real layout at all times (never display:none), so the
            canvas ResizeObserver and xterm's fit always see dimensions. */}
        <div
          ref={trackRef}
          className="absolute top-0 bottom-0 left-0 flex w-[200%]"
          style={{ transform: trackTransform(shell.view), transition: TRACK_TRANSITION }}
        >
          <div className="w-1/2 h-full relative overflow-hidden">{office}</div>
          <div className="w-1/2 h-full">
            <MobileTerminalPage
              agentIds={terminalAgentIds}
              shownAgentId={drawer.shownAgentId}
              onStatusChange={drawer.onStatusChange}
              inputRef={inputRef}
            />
          </div>
        </div>

        {/* View toggle — pinned outside the track so it never slides. */}
        {terminalAvailable && (
          <div className="absolute mobile-safe-top right-8 z-40">
            <Button
              size="sm"
              className="border-border! shadow-pixel"
              onClick={shell.toggleView}
              title={shell.view === 'office' ? 'Show terminal' : 'Show office'}
            >
              {shell.view === 'office' ? '>_' : 'Office'}
            </Button>
          </div>
        )}
      </div>

      {/* Hidden while typing: with the keyboard up the cards took the terminal's last rows (10-22 20:23). */}
      {showAgentCards && !keyboardOpen && (
        <MobileAgentBar
          agentIds={agentIds}
          focusedAgentId={focusedAgentId}
          // The accent border marks the showing pane, so it only exists on the
          // terminal page; the focused character keeps its tint on both.
          activeAgentId={shell.view === 'terminal' ? drawer.activeAgentId : null}
          onSelectAgent={shell.selectCard}
          onCloseAgent={onCloseAgent}
          onLaunchDirectory={shell.launch}
          directories={directories}
          onAddDirectory={onAddDirectory}
          onEditDirectory={onEditDirectory}
          canLaunch={terminalAvailable}
          launchUnavailableReason={terminalUnavailableReason}
          getAppearance={drawer.getAppearance}
          statusFor={drawer.statusFor}
          hideActions={hideActions}
          describeCard={describeCard}
          safeBottom={!bottom}
        />
      )}

      {/* The inset is padded once, here: the last row (the Dock's buttons, the usage line) ends
          at the inset's edge, never inside it (T-0008), and the band's background reaches the
          screen edge. */}
      {!keyboardOpen && bottom && (
        <div
          className="shrink-0 bg-bg touch-pan-x pb-[max(4px,var(--cld-safe-bottom))]"
          data-testid="mobile-bottom"
        >
          {bottom}
        </div>
      )}

      {/* Accessory keys for the TUI, only while the software keyboard is up —
          the last flex child, so it sits directly above the keyboard. */}
      {shell.view === 'terminal' && keyboardOpen && (
        <MobileKeyBar onKey={handleKey} onSend={handleSend} />
      )}
    </>
  );
}
