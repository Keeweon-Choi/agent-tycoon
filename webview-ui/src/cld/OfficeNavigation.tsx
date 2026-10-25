import { type ReactNode, useRef } from 'react';

import type { AgentAppearance, TabStatus } from '../components/AgentCard.js';
import { Button } from '../components/ui/Button.js';
import { t } from '../i18n/index.js';
import type { OfficeState } from '../office/engine/officeState.js';
import type { ToolActivity } from '../office/types.js';
import { closeLooks, looksTitle, useLooksUi } from './characters/looks.js';
import { LooksBody } from './characters/LooksWindow.js';
import { desktopTabs, panelTitle } from './format.js';
import { closeWindow, leaveNoticesWindow, showOffice, useHud, usePageStyle } from './hud/hudStore.js';
import { HudWindow } from './hud/HudWindow.js';
import type { WindowId } from './hud/layout.js';
import { Messenger } from './messenger/Messenger.js';
import { closeMessenger } from './messenger/messengerStore.js';
import { NoticePanel, type OpenTarget } from './notify/NoticeLayer.js';
import { OfficePanelContent } from './panels/OfficePanels.js';
import { TerminalWorkspace } from './terminal/TerminalWorkspace.js';
import { Workbench } from './workbench/Workbench.js';

interface PanelProps {
  agentTools: Record<number, ToolActivity[]>;
}

/** The 현황판 window's body: its tabs, then the open tab. */
function OfficeWindowBody({ agentTools }: PanelProps) {
  const { officeTab } = useHud();
  return (
    <>
      {/* UI-C1: the 파일 mode (the folder icon) has no tab strip; the 현황판 has 현황판 and HW. */}
      {officeTab !== 'files' && (
        <nav className="flex gap-4 overflow-x-auto pb-8 shrink-0" aria-label={t('nav.officeMenu')}>
          {desktopTabs.map((tab) => (
            <Button
              key={tab.id}
              size="sm"
              variant={officeTab === tab.id ? 'active' : 'default'}
              onClick={() => showOffice(tab.id)}
            >
              {t(`nav.tab.${tab.id}`)}
            </Button>
          ))}
        </nav>
      )}
      <div className="overflow-y-auto min-h-0 flex-1">
        <OfficePanelContent panel={officeTab} agentTools={agentTools} />
      </div>
    </>
  );
}

interface DesktopWindowsProps extends PanelProps {
  statusFor: (agentId: number) => TabStatus | null;
  getAppearance: (agentId: number) => AgentAppearance;
  getOfficeState: () => OfficeState;
  onOpenNotice: OpenTarget;
}

/** The desktop's floating windows (T-0077): 현황판, 메신저, 알림 and 터미널, each only while open. */
export function DesktopWindows({
  agentTools,
  statusFor,
  getAppearance,
  getOfficeState,
  onOpenNotice,
}: DesktopWindowsProps) {
  const hud = useHud();
  const looksFor = useLooksUi().picker;
  const terminalMounted = useRef(false);
  if (hud.open.terminal) terminalMounted.current = true;
  return (
    // Their room (clamping, snapping, maximizing) is this box: the whole HUD layer under the top
    // bar (WINDOW-LAYERS). Nothing is reserved at the bottom: a window may go under the dock row.
    <div
      data-hud-work
      className="absolute inset-0 pointer-events-none"
    >
      {hud.open.office && (
        <HudWindow
          id="office"
          title={hud.officeTab === 'files' ? t('nav.tab.files') : t('nav.officeInfo')}
          landmark
          closeLabel={t('nav.officeClose')}
          onClose={() => closeWindow('office')}
          wide={hud.officeTab === 'files'}
        >
          <OfficeWindowBody agentTools={agentTools} />
        </HudWindow>
      )}
      {hud.open.workbench && (
        <HudWindow
          id="workbench"
          title={t('nav.workbench')}
          closeLabel={t('nav.workbenchClose')}
          onClose={() => closeWindow('workbench')}
        >
          <Workbench />
        </HudWindow>
      )}
      {hud.open.looks && looksFor !== null && (
        <HudWindow
          id="looks"
          title={looksTitle(looksFor)}
          closeLabel={t('looks.close')}
          onClose={closeLooks}
        >
          <LooksBody key={looksFor} name={looksFor} inWindow />
        </HudWindow>
      )}
      {hud.open.messenger && (
        <HudWindow
          id="messenger"
          title={t('nav.messenger')}
          closeLabel={t('nav.messengerClose')}
          onClose={closeMessenger}
        >
          <Messenger mobile={false} statusFor={statusFor} getAppearance={getAppearance} />
        </HudWindow>
      )}
      {hud.open.notices && (
        <HudWindow
          id="notices"
          title={t('nav.notices')}
          closeLabel={t('nav.noticesClose')}
          onClose={() => closeWindow('notices')}
        >
          <NoticePanel
            getOfficeState={getOfficeState}
            onOpen={onOpenNotice}
            onClose={leaveNoticesWindow}
            inWindow
          />
        </HudWindow>
      )}
      {/* Mounted from its first opening on and then only hidden: the shells' sockets and tabs stay. */}
      {terminalMounted.current && (
        <HudWindow
          id="terminal"
          title={t('nav.terminal')}
          closeLabel={t('nav.terminalClose')}
          open={hud.open.terminal}
          onClose={() => closeWindow('terminal')}
        >
          {/* Hidden, it shows no tab: notices of an agent whose tab it holds are not "looked at". */}
          <div className="min-h-0 flex-1">
            <TerminalWorkspace onScreen={hud.open.terminal && !hud.minimized.terminal} />
          </div>
        </HudWindow>
      )}
    </div>
  );
}

interface MobileProps extends PanelProps {
  keyboardOpen?: boolean;
}

/** The phone's full-screen page chrome: a title and 사무실, the way back to the office (the page is kept,
 *  WINMODEL: a phone has no minimize and no close). */
export function MobilePage({
  id,
  title,
  onClose,
  children,
  label = t('nav.pageLabel', { title }),
  bare = false,
  hidden = false,
  tabs,
}: {
  /** Which window it is: shown while it is the phone's tab on screen. */
  id: WindowId;
  title: string;
  onClose: () => void;
  children: ReactNode;
  label?: string;
  /** No title bar (the terminal while the software keyboard leaves it few rows, T-0078). */
  bare?: boolean;
  /** Closed but kept mounted (the terminal's tabs and sockets stay). */
  hidden?: boolean;
  /** The page's own tabs, drawn in the title's place (a title that only repeats the selected tab is not shown twice). */
  tabs?: ReactNode;
}) {
  const page = usePageStyle(id);
  const style = hidden ? { display: 'none' } : page;
  return (
    <div
      className="absolute inset-x-0 top-0 bottom-0 z-50 bg-bg flex flex-col min-h-0 pl-(--cld-safe-left) pr-(--cld-safe-right)"
      style={style}
      aria-label={label}
    >
      {!bare && (
        <div className="shrink-0 border-b-2 border-border px-12 py-4 flex items-center justify-between gap-8">
          {tabs ?? <strong className="text-sm min-w-0 truncate">{title}</strong>}
          <button
            type="button"
            className="shrink-0 text-xs border border-border px-8 py-4 pointer-coarse:min-h-44"
            onClick={onClose}
          >
            {t('nav.office')}
          </button>
        </div>
      )}
      {children}
    </div>
  );
}

/**
 * The 현황판 (with its tabs, 파일 among them) and the 터미널 as pages of the phone: the
 * HUD's windows, full-screen, one Dock tab each (WINMODEL). The terminal stays mounted from its first
 * opening on, as on the desktop, so its tabs and sockets survive a switch.
 */
export function MobileOfficePanel({ agentTools, keyboardOpen }: MobileProps) {
  const hud = useHud();
  const looksFor = useLooksUi().picker;
  const terminalMounted = useRef(false);
  if (hud.open.terminal) terminalMounted.current = true;
  const panel = hud.officeTab;
  // The tabs take the title's place in the header: the title would only repeat the selected tab.
  const officeTabs =
    panel !== 'files' ? (
      <nav className="flex gap-4 overflow-x-auto min-w-0" aria-label={t('nav.workMenu')}>
        {desktopTabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            className={`text-xs whitespace-nowrap px-8 py-4 border pointer-coarse:min-h-44 ${panel === tab.id ? 'border-accent text-accent-text' : 'border-border text-text-muted'}`}
            onClick={() => showOffice(tab.id)}
          >
            {t(`nav.tab.${tab.id}`)}
          </button>
        ))}
      </nav>
    ) : undefined;
  return (
    <>
      {hud.open.office && (
        <MobilePage
          id="office"
          title={panelTitle(panel)}
          tabs={officeTabs}
          onClose={() => closeWindow('office')}
        >
          <div className="flex-1 min-h-0 overflow-y-auto px-8 py-8">
            <OfficePanelContent panel={panel} agentTools={agentTools} mobile />
          </div>
        </MobilePage>
      )}
      {hud.open.workbench && (
        <MobilePage
          id="workbench"
          title={t('nav.workbench')}
          onClose={() => closeWindow('workbench')}
        >
          <Workbench mobile />
        </MobilePage>
      )}
      {hud.open.looks && looksFor !== null && (
        <MobilePage id="looks" title={looksTitle(looksFor)} onClose={closeLooks}>
          <LooksBody key={looksFor} name={looksFor} />
        </MobilePage>
      )}
      {terminalMounted.current && (
        <MobilePage
          id="terminal"
          title={panelTitle('terminal')}
          onClose={() => closeWindow('terminal')}
          bare={keyboardOpen}
          hidden={!hud.open.terminal}
        >
          <div className="flex-1 min-h-0 px-4 py-4">
            <TerminalWorkspace
              mobile
              keyboardOpen={keyboardOpen}
              onScreen={hud.open.terminal && !hud.minimized.terminal}
            />
          </div>
        </MobilePage>
      )}
    </>
  );
}
