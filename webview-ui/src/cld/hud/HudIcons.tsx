/**
 * T-0077: the floating icon buttons (현황판, 메신저, 알림, 터미널, and 파일 since 10-24) that
 * replace the text buttons and the phone's tab bar. Square pixel buttons with
 * a badge each; every one can be moved and sized (Movable).
 */
import { type ReactNode, useEffect, useRef, useState } from 'react';

import { HUD_PANELS_Z } from '../../constants.js';
import { t } from '../../i18n/index.js';
import { useUnreadTotal } from '../messenger/messengerStore.js';
import { unreadCount, useNotices } from '../notify/notices.js';
import { panelAvailable, useCldStore } from '../officeStore.js';
import { measurePanels, setFixedPanels, setPanelSlot } from './fixedPanels.js';
import {
  BellGlyph,
  BoardGlyph,
  BubbleGlyph,
  FolderGlyph,
  TerminalGlyph,
  WorkbenchGlyph,
} from './glyphs.js';
import { pressIcon, setHudBounds, useHud } from './hudStore.js';
import { EDGE_GAP_PX, RAIL_PX } from './layout.js';
import { Movable } from './Movable.js';
import { useBounds } from './useBounds.js';
import { type Icon, iconStatus } from './windowModel.js';

function IconButton({
  id,
  name,
  ariaLabel,
  badge = 0,
  badgeTestId,
  testId,
  children,
}: {
  id: Icon;
  /** The accessible name and the title. */
  name: string;
  /** The name with the count, when there is one. */
  ariaLabel?: string;
  badge?: number;
  badgeTestId?: string;
  testId?: string;
  children: ReactNode;
}) {
  // WINMODEL, a Windows taskbar: gray = closed, filled = in front, outline = behind or minimized.
  const state = iconStatus(useHud(), id);
  const look =
    state === 'closed'
      ? 'border-border bg-bg text-text-muted hover:text-text hover:bg-btn-hover'
      : state === 'front'
        ? 'border-accent bg-accent text-white'
        : 'border-accent bg-bg text-accent-text hover:bg-btn-hover';
  return (
    <Movable
      id={`icon:${id}`}
      label={name}
      className="relative z-10"
      z={10}
      flowInBottomPreset
    >
      <button
        type="button"
        data-testid={testId}
        data-window={state}
        aria-label={`${ariaLabel ?? name}${state === 'minimized' ? t('hud.minimizedSuffix') : ''}`}
        title={name}
        aria-pressed={state !== 'closed'}
        className={`relative flex items-center justify-center w-40 h-40 pointer-coarse:w-44 pointer-coarse:h-44 rounded-none border-2 shadow-pixel ${look}`}
        onClick={() => pressIcon(id)}
      >
        {children}
        <Badge count={badge} testId={badgeTestId} />
      </button>
    </Movable>
  );
}

/** An icon's count (unread, waiting), in its top-right corner. */
export function Badge({ count, testId }: { count: number; testId?: string }) {
  if (count <= 0) return null;
  return (
    <span
      data-testid={testId}
      className="absolute -top-6 -right-6 min-w-16 px-2 bg-danger text-text text-2xs leading-[16px] text-center"
    >
      {count > 99 ? '99+' : count}
    </span>
  );
}

export function HudIcons({
  terminalWaiting,
}: {
  /** Terminals waiting on the user (permission or a question). */
  terminalWaiting: number;
}) {
  const store = useCldStore();
  const messages = useUnreadTotal();
  const notices = unreadCount(useNotices().items);
  return (
    <>
      <IconButton id="office" name={t('hud.office')}>
        <BoardGlyph />
      </IconButton>
      {/* W1: the 작업실, right after the 현황판 it was split from. */}
      <IconButton id="workbench" name={t('hud.workbench')}>
        <WorkbenchGlyph />
      </IconButton>
      {store.officeSnapshot?.chat && (
        <IconButton
          id="messenger"
          name={t('hud.messenger')}
          ariaLabel={messages ? t('hud.unreadMessages', { count: messages }) : t('hud.messenger')}
          badge={messages}
          badgeTestId="messenger-unread"
        >
          <BubbleGlyph />
        </IconButton>
      )}
      <IconButton
        id="notices"
        name={t('hud.notices')}
        ariaLabel={notices ? t('hud.unreadNotices', { count: notices }) : t('hud.notices')}
        testId="notice-bell"
        badge={notices}
        badgeTestId="notice-unread"
      >
        <BellGlyph />
      </IconButton>
      {panelAvailable('terminal', store) && (
        <IconButton
          id="terminal"
          name={t('hud.terminal')}
          ariaLabel={terminalWaiting ? t('hud.waitingTerminals', { count: terminalWaiting }) : t('hud.terminal')}
          badge={terminalWaiting}
          badgeTestId="terminal-waiting"
        >
          <TerminalGlyph />
        </IconButton>
      )}
      {/* Owner 10-24: the file explorer (T-0050), the 현황판 window's 파일 tab. */}
      <IconButton id="files" name={t('hud.files')}>
        <FolderGlyph />
      </IconButton>
    </>
  );
}

/**
 * The layer the icons and the desktop windows live in: the office region's whole box (right under
 * the top bar), inert except for its children. WINDOW-LAYERS: one stacking context with three bands,
 * normal windows (1..n by order), the fixed panels (the `dock`, the card bar and the elevator panel,
 * which portal into the panel slot, HUD_PANELS_Z) and a maximized window (HUD_MAXIMIZED_Z, see
 * windowModel.windowZ). Isolated so its own z order never fights the office's labels and doors.
 * Right and work presets keep the dock column beside the card bar. The bottom preset ignores its
 * old saved pixel slots and flows the icons in a row centred on the whole window, so resizing
 * cannot leave the row centred on a previous window width.
 */
export function HudLayer({ dock, children }: { dock: ReactNode; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [slot, setSlot] = useState<HTMLDivElement | null>(null);
  const bottomDock = useHud().layout.preset === 'bottom';
  // The layer fills its parent: presets (설정) place things for this size.
  const bounds = useBounds(ref);
  useEffect(() => {
    setHudBounds(bounds);
    return () => setHudBounds(null);
  }, [bounds]);
  useEffect(() => {
    const layer = ref.current;
    if (!layer || !slot) return;
    setPanelSlot(slot);
    const watched = new Set<Element>();
    const resizes = new ResizeObserver(() => measure());
    function measure() {
      if (!layer || !slot) return;
      setFixedPanels(measurePanels(layer, slot));
    }
    // A panel that comes or goes (a card, the elevator once the building is known) re-arms its observer.
    const changes = new MutationObserver(() => {
      for (const el of slot.querySelectorAll('[data-hud-fixed]'))
        if (!watched.has(el)) {
          watched.add(el);
          resizes.observe(el);
        }
      measure();
    });
    changes.observe(slot, { childList: true, subtree: true });
    resizes.observe(layer);
    resizes.observe(slot);
    for (const el of slot.querySelectorAll('[data-hud-fixed]')) {
      watched.add(el);
      resizes.observe(el);
    }
    measure();
    return () => {
      changes.disconnect();
      resizes.disconnect();
      setFixedPanels([]);
      setPanelSlot(null);
    };
  }, [slot]);
  return (
    <div
      ref={ref}
      data-hud-layer
      className="absolute inset-0 pointer-events-none isolate"
      style={{ zIndex: HUD_LAYER_Z }}
    >
      {children}
      <div
        ref={setSlot}
        data-hud-panels
        className={`absolute inset-0 pointer-events-none flex gap-8 p-8 ${bottomDock ? 'flex-row items-end justify-center' : 'flex-col items-end justify-center'}`}
        style={{
          zIndex: HUD_PANELS_Z,
          ...(!bottomDock && { paddingRight: RAIL_PX + EDGE_GAP_PX }),
        }}
      >
        {dock}
      </div>
    </div>
  );
}

/** Over the labels (41-43), doors (46) and the elevator panel (47); under dialogs (50+). */
const HUD_LAYER_Z = 48;
