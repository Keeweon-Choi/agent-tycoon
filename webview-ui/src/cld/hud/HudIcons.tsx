/**
 * hud-v3 P0 (owner 11-04 23:37, 11-05 00:04): the PC office's HUD around the canvas. The top bar is gone:
 * the dock floats at the bottom centre (사무실 · 메신저 · 프로젝트 · 현황판 · 파일 · 터미널; the issue board is
 * the 현황판's, owner 11-06 17:23: no 퀘스트 button), the
 * top-right corner holds the CPU heat over the party, the control center sits at the bottom left
 * (ControlCenter.tsx: notifications, usage, what runs, the clock and the menu's tiles). A maximized
 * window keeps the whole room; the dock then folds to a handle with the unread count, which opens 알림.
 * Normal windows keep clear of the dock's band (HudWindow), so it never covers a composer or a button.
 */
import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react';

import { HUD_Z } from '../../constants.js';
import { t } from '../../i18n/index.js';
import { HeatGauge } from '../game/GameHud.js';
import { GameOptions } from '../GameOptions.js';
import { useUnreadTotal } from '../messenger/messengerStore.js';
import { unreadCount, useNotices } from '../notify/notices.js';
import { panelAvailable, useCldStore } from '../officeStore.js';
import { toastSlot } from '../toastSlot.js';
import { measurePanels, setFixedPanels, setPanelSlot } from './fixedPanels.js';
import {
  BoardGlyph,
  BubbleGlyph,
  CommandGlyph,
  FolderGlyph,
  HomeGlyph,
  TerminalGlyph,
} from './glyphs.js';
import { goHome, panelToFront, pressIcon, useHud } from './hudStore.js';
import type { WindowId } from './layout.js';
import { iconStatus, layerZ, PANEL_IDS, type PanelId, status, type WinStatus } from './windowModel.js';

/** WINMODEL, a Windows taskbar: gray = closed, filled = in front, outline = behind or minimized. */
const LOOK: Record<WinStatus, string> = {
  closed: 'border-border bg-btn-bg text-text-muted hover:text-text hover:border-border-hi',
  front: 'border-accent bg-accent text-white',
  behind: 'border-accent bg-active-bg text-accent-text hover:border-devroom-accent-line',
  minimized: 'border-accent bg-active-bg text-accent-text hover:border-devroom-accent-line',
};

function DockButton({
  hudId,
  name,
  label,
  ariaLabel,
  state,
  badge = 0,
  badgeTestId,
  testId,
  onPress,
  children,
}: {
  /** The old icon id: `[data-hud-id="icon:…"] button` finds it on both shells (runners). */
  hudId: string;
  /** The accessible name and the title. */
  name: string;
  /** The short word under the glyph. */
  label: string;
  ariaLabel?: string;
  state: WinStatus;
  badge?: number;
  badgeTestId?: string;
  testId?: string;
  onPress: () => void;
  children: ReactNode;
}) {
  return (
    <span className="flex flex-col items-center gap-2" data-hud-id={`icon:${hudId}`}>
      <button
        type="button"
        data-testid={testId}
        data-window={state}
        aria-label={`${ariaLabel ?? name}${state === 'minimized' ? t('hud.minimizedSuffix') : ''}`}
        title={name}
        aria-pressed={state !== 'closed'}
        className={`relative flex items-center justify-center w-40 h-40 rounded-ui-card border-ui ui-raise ${LOOK[state]}`}
        onClick={onPress}
      >
        {children}
        <Badge count={badge} testId={badgeTestId} />
      </button>
      <span className="text-2xs leading-none text-text-muted whitespace-nowrap" aria-hidden="true">
        {label}
      </span>
    </span>
  );
}

/** An icon's count (unread, waiting), in its top-right corner. */
export function Badge({ count, testId }: { count: number; testId?: string }) {
  if (count <= 0) return null;
  return (
    <span
      data-testid={testId}
      className="absolute -top-6 -right-6 min-w-16 px-2 ui-badge ui-notch text-2xs leading-[14px] text-center"
    >
      {count > 99 ? '99+' : count}
    </span>
  );
}

/** Some window fills the room (maximized and in sight). */
const anyMaximized = (hud: ReturnType<typeof useHud>) =>
  (Object.keys(hud.open) as WindowId[]).some(
    (id) => hud.open[id] && !hud.minimized[id] && hud.layout.items[id]?.max === true,
  );

/** The dock: the screens' buttons in one floating row at the bottom centre. */
export function Dock({
  terminalWaiting,
}: {
  /** Terminals waiting on the user (permission or a question). */
  terminalWaiting: number;
}) {
  const store = useCldStore();
  const hud = useHud();
  const messages = useUnreadTotal();
  const notices = unreadCount(useNotices().items);
  const maxed = anyMaximized(hud);
  // Over a maximized window the dock folds to its handle; the handle unfolds it until the window goes.
  const [peek, setPeek] = useState(false);
  useEffect(() => setPeek(false), [maxed]);
  const folded = maxed && !peek;
  const nothingShown = (Object.keys(hud.open) as WindowId[]).every((id) => ['closed', 'minimized'].includes(status(hud, id)));
  return (
    <nav
      aria-label={t('hudpc.dock.label')}
      data-testid="hud-dock"
      data-folded={folded || undefined}
      className="absolute bottom-0 left-1/2 -translate-x-1/2 pointer-events-auto flex flex-col items-center"
      style={{ zIndex: maxed ? HUD_Z.dockOverMax : layerZ(hud, 'dock') }}
      data-hud-panel="dock"
    >
      {maxed && (
        <span className="flex items-stretch pixel-panel ui-window">
          <button
            type="button"
            className="flex items-center gap-4 px-8 h-24 text-xs text-text-muted hover:text-text"
            aria-expanded={!folded}
            aria-label={t(folded ? 'hudpc.dock.show' : 'hudpc.dock.hide')}
            title={t(folded ? 'hudpc.dock.show' : 'hudpc.dock.hide')}
            data-testid="hud-dock-handle"
            onClick={() => setPeek(!peek)}
          >
            {folded ? '▴' : '▾'} {t('hudpc.dock.handle')}
          </button>
          {notices > 0 && (
            <button
              type="button"
              className="px-6 h-24 ui-badge text-2xs"
              aria-label={t('hud.unreadNotices', { count: notices })}
              title={t('hud.notices')}
              data-testid="hud-dock-notices"
              onClick={() => pressIcon('notices')}
            >
              {notices > 99 ? '99+' : notices}
            </button>
          )}
        </span>
      )}
      {!folded && (
        <span className="flex items-start gap-6 px-8 pt-6 pb-4 mb-8 pixel-panel ui-window">
          <DockButton hudId="home" name={t('dock.office')} label={t('dock.office')} state={nothingShown ? 'front' : 'closed'} onPress={goHome}>
            <HomeGlyph />
          </DockButton>
          {store.officeSnapshot?.chat && (
            <DockButton
              hudId="messenger"
              name={t('hud.messenger')}
              label={t('hud.messenger')}
              ariaLabel={messages ? t('hud.unreadMessages', { count: messages }) : undefined}
              state={iconStatus(hud, 'messenger')}
              badge={messages}
              badgeTestId="messenger-unread"
              onPress={() => pressIcon('messenger')}
            >
              <BubbleGlyph />
            </DockButton>
          )}
          <DockButton
            hudId="devroom"
            name={t('hudpc.dock.projectTitle')}
            label={t('hudpc.dock.project')}
            state={iconStatus(hud, 'devroom')}
            onPress={() => pressIcon('devroom')}
          >
            <CommandGlyph />
          </DockButton>
          <DockButton
            hudId="office"
            name={t('hud.office')}
            label={t('hud.office')}
            state={iconStatus(hud, 'office')}
            onPress={() => pressIcon('office')}
          >
            <BoardGlyph />
          </DockButton>
          <DockButton hudId="files" name={t('hud.files')} label={t('hud.files')} state={iconStatus(hud, 'files')} onPress={() => pressIcon('files')}>
            <FolderGlyph />
          </DockButton>
          {panelAvailable('terminal', store) && (
            <DockButton
              hudId="terminal"
              name={t('hud.terminal')}
              label={t('hud.terminal')}
              ariaLabel={terminalWaiting ? t('hud.waitingTerminals', { count: terminalWaiting }) : undefined}
              state={iconStatus(hud, 'terminal')}
              badge={terminalWaiting}
              badgeTestId="terminal-waiting"
              onPress={() => pressIcon('terminal')}
            >
              <TerminalGlyph />
            </DockButton>
          )}
        </span>
      )}
    </nav>
  );
}

/** The top-right corner over the party: the CPU heat (the notifications and the menu are the control center's). */
function HudCorner() {
  const z = layerZ(useHud(), 'corner');
  return (
    <div
      className="absolute top-0 right-0 flex items-center gap-6 p-4 pointer-events-auto"
      role="group"
      aria-label={t('hudpc.corner.label')}
      data-testid="hud-corner"
      data-hud-panel="corner"
      style={{ zIndex: z }}
      data-hud-fixed
    >
      <HeatGauge chip />
      {/* The settings window and the install note; the control center's 설정 opens it. */}
      <GameOptions trigger={false} />
    </div>
  );
}

/**
 * The layer the HUD and the desktop windows live in: the office region's whole box, inert except for
 * its children. WINDOW-LAYERS: one stacking context on one scale (constants HUD_Z): the pop-up notices, then one
 * stack of the windows and the panels (the corner, the party and the elevator column portal into the panel slot;
 * the dock and the control center), last pressed on top (windowModel.layerZ; a press on a `data-hud-panel` brings
 * it up, here), a maximized window over the stack and the dock's handle over that. Isolated so its own z order
 * never fights the office's labels and doors.
 */
export function HudLayer({ dock, children }: { dock: ReactNode; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [slot, setSlot] = useState<HTMLDivElement | null>(null);
  // UI-FIX 2: the pop-up notices' slot lives in the layer at the bottom, so open windows draw over a notice.
  useLayoutEffect(() => {
    const layer = ref.current;
    if (!layer) return;
    const toasts = toastSlot();
    toasts.style.zIndex = String(HUD_Z.toasts);
    layer.prepend(toasts);
    return () => {
      toasts.style.zIndex = '';
      document.body.append(toasts);
    };
  }, []);
  // WINDOW-LAYERS (owner 11-06 20:57): what was pressed last is in front. Only on a press: nothing moves on hover.
  useEffect(() => {
    const layer = ref.current;
    if (!layer) return;
    const press = (e: PointerEvent) => {
      const id = (e.target instanceof Element ? e.target.closest('[data-hud-panel]') : null)?.getAttribute('data-hud-panel');
      if (id && (PANEL_IDS as readonly string[]).includes(id)) panelToFront(id as PanelId);
    };
    layer.addEventListener('pointerdown', press, true);
    return () => layer.removeEventListener('pointerdown', press, true);
  }, []);
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
    // A panel that comes or goes (a card) re-arms its observer. SMOOTH-1104: only then: a change
    // inside a panel (a portrait's state, a clock) moves nothing the resize observer would not see.
    const fixedIn = (n: Node) =>
      n instanceof Element && (n.matches('[data-hud-fixed]') || n.querySelector('[data-hud-fixed]') !== null);
    const changes = new MutationObserver((records) => {
      if (!records.some((r) => [...r.addedNodes, ...r.removedNodes].some(fixedIn))) return;
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
      {/* No z of its own: no stacking context, so each panel in it ranks in the layer's one stack (HUD_Z). */}
      <div ref={setSlot} data-hud-panels className="absolute inset-0 pointer-events-none">
        <HudCorner />
      </div>
      {dock}
    </div>
  );
}

/** Over the labels (41-43) and doors (46); under dialogs (50+). The elevator column is in the layer (FloorControls). */
const HUD_LAYER_Z = 48;
