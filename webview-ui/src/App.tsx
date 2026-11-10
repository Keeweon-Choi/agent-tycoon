import type { CSSProperties } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';

import { ActionLayer } from './agent-tycoon/ActionLayer.js';
import { AgentCliNotice } from './agent-tycoon/AgentCliNotice.js';
import { AuthLayer } from './agent-tycoon/auth/AuthLayer.js';
import { LobbyBoard } from './agent-tycoon/board/LobbyBoard.js';
import { WhiteboardMemos } from './agent-tycoon/board/WhiteboardMemos.js';
import { bypassReadOnly, useBypass } from './agent-tycoon/bypass.js';
import { lastFraming } from './agent-tycoon/cameraMode.js';
import { CameraModeControl } from './agent-tycoon/CameraModeControl.js';
import { useAgtyCards } from './agent-tycoon/cards.js';
import { CharacterMenu } from './agent-tycoon/characters/CharacterMenu.js';
import { lookNameOf, openLooks, useCharacterLooks } from './agent-tycoon/characters/looks.js';
import { DevroomTools } from './agent-tycoon/devroom/devroomData.js';
import { DevroomPalette } from './agent-tycoon/devroom/DevroomPalette.js';
import { DevFxBar } from './agent-tycoon/director/DevFxBar.js';
import { engineOpenForm } from './agent-tycoon/engineStore.js';
import { StatDetailSheet } from './agent-tycoon/ez/StatCard.js';
import { FloorLayer } from './agent-tycoon/FloorControls.js';
import { FurnitureArt } from './agent-tycoon/furniture/FurnitureArt.js';
import { publishGameLooks } from './agent-tycoon/game/gameLooks.js';
import { BootScreen } from './agent-tycoon/gfx/BootScreen.js';
import { TitleScene } from './agent-tycoon/gfx/TitleScene.js';
import { closeTitleScene } from './agent-tycoon/gfx/titleSceneState.js';
import { useOfficeWarmUp } from './agent-tycoon/gfx/warmUp.js';
import { ControlCenter, MobileUsage } from './agent-tycoon/hud/ControlCenter.js';
import { Dock, HudLayer } from './agent-tycoon/hud/HudIcons.js';
import {
  closePages,
  closeWindow,
  goHome,
  openWindow,
  saveWindowState,
  setPhone,
  showOffice,
  useHud,
} from './agent-tycoon/hud/hudStore.js';
import { MobileDock } from './agent-tycoon/hud/MobileDock.js';
import { showsAgentCards } from './agent-tycoon/hud/windowModel.js';
import { useIsoView } from './agent-tycoon/iso/isoView.js';
import { Joystick } from './agent-tycoon/Joystick.js';
import { uploadsInFlight } from './agent-tycoon/messenger/attachments.js';
import { Messenger } from './agent-tycoon/messenger/Messenger.js';
import { messengerGetSnapshot } from './agent-tycoon/messenger/messengerStore.js';
import { installAgtyMock, isAgtyMock } from './agent-tycoon/mock.js';
import { NoticePanel, NoticeToast } from './agent-tycoon/notify/NoticeLayer.js';
import { NoticePhonePage } from './agent-tycoon/notify/NoticePhonePage.js';
import type { NoticeTarget } from './agent-tycoon/notify/notices.js';
import { openTarget } from './agent-tycoon/notify/openTarget.js';
import { PushBanner } from './agent-tycoon/notify/PushBanner.js';
import { selectOrOpenInfo } from './agent-tycoon/offDuty.js';
import { DesktopWindows, MobileOfficePanel } from './agent-tycoon/OfficeNavigation.js';
import { useAgtyStore } from './agent-tycoon/officeStore.js';
import { MobileTopBar, type OfficePanel } from './agent-tycoon/panels/OfficePanels.js';
import { PerfReadout } from './agent-tycoon/PerfReadout.js';
import { RegionBoundary } from './agent-tycoon/RegionBoundary.js';
import { RepoActionLayer } from './agent-tycoon/repo/RepoActionLayer.js';
import {
  busyForStaleBuild,
  isStale,
  ownBuild,
  reloadDecision,
  requestStaleRecheck,
  shouldRecheckStaleBuild,
  subscribeStaleRecheck,
  typingForStaleBuild,
} from './agent-tycoon/staleBuild.js';
import { StaleBuildBanner } from './agent-tycoon/StaleBuildBanner.js';
import { TerminalWorkspace } from './agent-tycoon/terminal/TerminalWorkspace.js';
import { OPEN_TERMINAL_EVENT } from './agent-tycoon/terminal/workspaceStore.js';
import { waitingIds } from './agent-tycoon/waiting.js';
import { WorkSheet } from './agent-tycoon/work/WorkSheet.js';
import { OPEN_WORKBENCH_EVENT } from './agent-tycoon/workbench/workbenchStore.js';
import { toMajorMinor } from './changelogData.js';
import { setChangelogOpener } from './changelogOpen.js';
import { AgentCardBar } from './components/AgentCardBar.js';
import { BottomToolbar } from './components/BottomToolbar.js';
import { ChangelogModal } from './components/ChangelogModal.js';
import { ConnectionIndicator } from './components/ConnectionIndicator.js';
import { DebugView } from './components/DebugView.js';
import { DirectoryModal } from './components/DirectoryModal.js';
import { EditActionBar } from './components/EditActionBar.js';
import { IntroBubble } from './components/IntroBubble.js';
import { MigrationNotice } from './components/MigrationNotice.js';
import { SettingsModal } from './components/SettingsModal.js';
import { TerminalDrawer } from './components/TerminalDrawer.js';
import { Tooltip } from './components/Tooltip.js';
import { Button } from './components/ui/Button.js';
import { Modal } from './components/ui/Modal.js';
import { VersionIndicator } from './components/VersionIndicator.js';
import { ZoomControls } from './components/ZoomControls.js';
import { HD_TEST_MARKER_COLOR, OFFICE_CANVAS_TEST_ID } from './constants.js';
import { onboardingAsked } from './hooks/introTourState.js';
import { useDirectoryEditor } from './hooks/useDirectoryEditor.js';
import { useEditorActions } from './hooks/useEditorActions.js';
import { useEditorKeyboard } from './hooks/useEditorKeyboard.js';
import type { Directory } from './hooks/useExtensionMessages.js';
import { useExtensionMessages } from './hooks/useExtensionMessages.js';
import { useIntroTour } from './hooks/useIntroTour.js';
import { useIsMobile } from './hooks/useIsMobile.js';
import { useKeyboardViewport } from './hooks/useKeyboardViewport.js';
import { useTerminalDrawer } from './hooks/useTerminalDrawer.js';
import { t, useLanguage } from './i18n/index.js';
import { MobileShell } from './mobile/MobileShell.js';
import { useMobileShell } from './mobile/useMobileShell.js';
import { usePhoneTabs } from './mobile/usePhoneTabs.js';
import { OfficeCanvas } from './office/components/OfficeCanvas.js';
import { ToolOverlay } from './office/components/ToolOverlay.js';
import { EditorState } from './office/editor/editorState.js';
import { EditorToolbar } from './office/editor/EditorToolbar.js';
import { setOfficeCovered } from './office/engine/gameLoop.js';
import { OfficeState } from './office/engine/officeState.js';
import { exportLayoutToFile } from './office/layout/exportLayout.js';
import { isRotatable } from './office/layout/furnitureCatalog.js';
import { getCatalogEntry } from './office/layout/furnitureCatalog.js';
import { migrateLayoutColors } from './office/layout/layoutSerializer.js';
import { overlayProjection } from './office/projection.js';
import { getPetCount } from './office/sprites/petSpriteData.js';
import {
  getCharacterTemplates,
  getCustomCharacter,
  setCustomCharacter,
} from './office/sprites/spriteData.js';
import { EditTool, type OfficeLayout, TILE_SIZE } from './office/types.js';
import { isE2E } from './runtime.js';
import { isTypingInTerminal } from './terminal/terminalDom.js';
import { installTestHooks } from './testHooks.js';
import { transport } from './transport/index.js';

// Game state lives outside React — updated imperatively by message handlers
const officeStateRef = { current: null as OfficeState | null };
const editorState = new EditorState();
const STALE_BUILD_RELOADED_FOR_KEY = 'agty.stale-build.reloaded-for';
const STALE_BUILD_RECHECK_MS = 15_000;

function reloadedForBuild(): string | undefined {
  try {
    return sessionStorage.getItem(STALE_BUILD_RELOADED_FOR_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

function markReloadedForBuild(build: string): void {
  try {
    sessionStorage.setItem(STALE_BUILD_RELOADED_FOR_KEY, build);
  } catch {
    // Private browsing may not allow storage; the regular reload remains safe.
  }
}

function hasVisibleStaleDialog(): boolean {
  return [...document.querySelectorAll<HTMLElement>('[role="dialog"], [role="alertdialog"], [aria-modal="true"]')]
    .some((element) => {
      const style = window.getComputedStyle(element);
      return style.display !== 'none' && style.visibility !== 'hidden' && element.getClientRects().length > 0;
    });
}

// Test-only observability hooks (message/sound logs, addAgent wrapper, selectAgent).
// Installed only under the e2e harness so they never patch prototypes or grow
// unbounded logs in a real user's session.
if (isE2E) installTestHooks(officeStateRef);

function getOfficeState(): OfficeState {
  if (!officeStateRef.current) {
    officeStateRef.current = new OfficeState();
  }
  return officeStateRef.current;
}

function App() {
  useLanguage();
  const isoView = useIsoView(); // ISO-PILOT: the board and memo overlays are top-down only
  const [showStaleBuildBanner, setShowStaleBuildBanner] = useState(false);
  const [staleBuildBusy, setStaleBuildBusy] = useState<ReturnType<typeof busyForStaleBuild>>(null);
  const editor = useEditorActions(getOfficeState, editorState);
  const isEditDirty = useCallback(
    () => editor.isEditMode && editor.isDirty,
    [editor.isEditMode, editor.isDirty],
  );
  const latestServerBuild = useRef<string | undefined>(undefined);
  const terminalLastKeyAt = useRef(0);
  const reviewStaleBuild = useCallback((serverBuild: string | undefined) => {
    latestServerBuild.current = serverBuild;
    const busy = busyForStaleBuild({
      typing: typingForStaleBuild(document.activeElement),
      terminal:
        isTypingInTerminal(document.activeElement) && Date.now() - terminalLastKeyAt.current < 30_000,
      unsaved: isEditDirty() || messengerGetSnapshot().editing !== null,
      dialog: hasVisibleStaleDialog(),
      upload: uploadsInFlight() > 0,
    });
    const decision = reloadDecision({
      stale: isStale(ownBuild(document), serverBuild),
      visible: document.visibilityState === 'visible',
      busy,
      reloadedFor: reloadedForBuild(),
      server: serverBuild,
    });
    if (decision === 'reload') {
      markReloadedForBuild(serverBuild!);
      window.location.reload();
      return;
    }
    setStaleBuildBusy(busy);
    setShowStaleBuildBanner(decision === 'banner');
  }, [isEditDirty]);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.target instanceof Element && isTypingInTerminal(event.target)) {
        terminalLastKeyAt.current = Date.now();
      }
    };
    const onBlur = (event: FocusEvent) => {
      if (event.target instanceof Element && isTypingInTerminal(event.target)) {
        window.setTimeout(requestStaleRecheck, 0);
      }
    };
    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('blur', onBlur, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      document.removeEventListener('blur', onBlur, true);
    };
  }, []);
  useEffect(() => {
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') reviewStaleBuild(latestServerBuild.current);
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => document.removeEventListener('visibilitychange', onVisibilityChange);
  }, [reviewStaleBuild]);
  useEffect(() => {
    if (!showStaleBuildBanner) return;
    const review = () => reviewStaleBuild(latestServerBuild.current);
    const unsubscribe = subscribeStaleRecheck(review);
    const onFocusOut = (event: FocusEvent) => {
      if (shouldRecheckStaleBuild('focusout', event.target, document.activeElement)) review();
    };
    const onBlur = (event: FocusEvent) => {
      if (shouldRecheckStaleBuild('blur', event.target, document.activeElement)) review();
    };
    const onInput = (event: Event) => {
      if (shouldRecheckStaleBuild('input', event.target, document.activeElement)) review();
    };
    document.addEventListener('focusout', onFocusOut);
    document.addEventListener('blur', onBlur, true);
    document.addEventListener('input', onInput);
    const dialogs = new MutationObserver(review);
    dialogs.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['aria-modal', 'class', 'hidden', 'role', 'style'],
    });
    const interval = window.setInterval(review, STALE_BUILD_RECHECK_MS);
    return () => {
      document.removeEventListener('focusout', onFocusOut);
      document.removeEventListener('blur', onBlur, true);
      document.removeEventListener('input', onInput);
      dialogs.disconnect();
      window.clearInterval(interval);
      unsubscribe();
    };
  }, [reviewStaleBuild, showStaleBuildBanner]);
  // Browser runtime (dev or static dist): dispatch mock messages after the
  // useExtensionMessages listener has been registered.
  useEffect(() => {
    // browserMock is for Vite dev mode only (UI prototyping without a server).
    // In standalone server mode, the server sends all state over WebSocket.
    if (import.meta.env.DEV || isAgtyMock) {
      void import('./browserMock.js').then(({ dispatchMockMessages }) => {
        dispatchMockMessages();
        if (isAgtyMock) installAgtyMock();
      });
    }
  }, []);

  const {
    agents,
    selectedAgent,
    agentTools,
    agentStatuses,
    agentQuestion,
    agentSeenActivity,
    subagentTools,
    subagentCharacters,
    layoutReady,
    layoutWasReset,
    loadedAssets,
    directories,
    directoryRejection,
    directorySaved,
    directorySuggestions,
    agentDirectoryNames,
    externalAssetDirectories,
    lastSeenVersion,
    extensionVersion,
    watchAllSessions,
    setWatchAllSessions,
    alwaysShowLabels,
    hooksEnabled,
    hooksInstalled,
    hooksStatusSeq,
    hooksInfoShown,
    consentRequest,
    dismissConsentRequest,
    areaMappings,
    setAreaMappings,
    showAreas,
    setShowAreas,
    bypassPermissions,
    setBypassPermissions,
    showHostDirectories,
    setShowHostDirectories,
    officeReadOnly,
    terminalAvailable,
    terminalUnavailableReason,
    terminalAgentIds,
  } = useExtensionMessages(getOfficeState, editor.setLastSavedLayout, isEditDirty, reviewStaleBuild);
  const { officeSnapshot, officeReadOnly: storeReadOnly, agentCli } = useAgtyStore();
  const agtyMode = officeSnapshot !== null;
  const [plainTerminalOpen, setPlainTerminalOpen] = useState(false);
  // The card container's + (owner 10-24): the same 오케스트레이터 추가 as the settings, for a client that may act.
  const addOrchestrator =
    officeSnapshot?.readOnly === false && !storeReadOnly ? () => engineOpenForm(null) : undefined;
  // agty chat (T-0014): a chat's terminal is a tab of the terminal workspace (T-0078), not a
  // pane of this drawer.
  const paneAgentIds = terminalAgentIds;
  const panesAvailable = terminalAvailable && !officeSnapshot?.readOnly;
  // agty: the office's own controls stay view-only; --allow-actions
  // (officeState.readOnly false) enables only the office action buttons (T-0010).
  const effectiveReadOnly = officeReadOnly || agtyMode;
  const hud = useHud(); // agty (T-0077, WINMODEL): the windows, the phone's tabs

  // Show migration notice once layout reset is detected
  const [migrationNoticeDismissed, setMigrationNoticeDismissed] = useState(false);
  const showMigrationNotice = layoutWasReset && !migrationNoticeDismissed;

  const [isChangelogOpen, setIsChangelogOpen] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isHooksInfoOpen, setIsHooksInfoOpen] = useState(false);
  const [hooksTooltipDismissed, setHooksTooltipDismissed] = useState(false);
  const [isDebugMode, setIsDebugMode] = useState(false);
  const [alwaysShowOverlay, setAlwaysShowOverlay] = useState(false);

  // Mobile shell (phones, touch tablets): office and terminal as sliding
  // full-screen pages with the cards in a bottom bar. Desktop keeps the
  // right-docked drawer.
  const isMobile = useIsMobile();
  // Software keyboard: whether it is up (the key bar shows), and the height
  // to clamp the shell to so the terminal shrinks (and the PTY resizes)
  // instead of hiding its input line under the keys (iOS only — Android
  // resizes the layout viewport itself).
  const keyboard = useKeyboardViewport(isMobile);
  // The desktop windows' open flags are remembered per browser; a phone's pages are not
  // (it starts on the office), so the phone shell never overwrites what a desktop left.
  useEffect(() => {
    if (!isMobile) saveWindowState(hud.open, hud.minimized);
  }, [hud.open, hud.minimized, isMobile]);
  // WINMODEL: one model, two shells (a phone shows one page at a time). The PC never takes the
  // browser's Back for its windows; the phone's Back steps inside its tab (usePhoneTabs).
  useEffect(() => setPhone(isMobile), [isMobile]);
  const phoneTabs = usePhoneTabs(isMobile);
  // A page over the office on the phone: the canvas under it draws nothing (the CPU/RAM budget, run-overlay-cost).
  useEffect(() => {
    setOfficeCovered(isMobile && phoneTabs.tab !== 'office');
    return () => setOfficeCovered(false);
  }, [isMobile, phoneTabs.tab]);
  // The office's imperative character selection, mirrored into React so the
  // card bars can restyle the focused agent's card on canvas taps.
  const focusedAgentId = useSyncExternalStore(
    useCallback((onChange: () => void) => getOfficeState().subscribeSelection(onChange), []),
    () => getOfficeState().selectedAgentId,
  );
  // agty (T-0017): characters wear the look chosen for their name.
  useCharacterLooks(getOfficeState, agents, layoutReady, subagentCharacters);
  // SHEET-IMPORT: the office's pictures built while the lobby shows (or in idle time)
  useOfficeWarmUp(getOfficeState, editor.zoom, layoutReady, isoView, isMobile);
  // agty (T-0036): cards grouped by kind and named, sub-agents included.
  const agtyCards = useAgtyCards(getOfficeState, agents, subagentCharacters);

  // Standalone only: every input here stays false/empty under VS Code. Owns the
  // active tab on both shells; the desktop-only bits (isOpen, width, resize)
  // are simply unread on mobile, where the sliding track plays the drawer.
  const terminalDrawer = useTerminalDrawer({
    terminalAgentIds: paneAgentIds,
    getOfficeState,
    agentTools,
    agentStatuses,
    agentQuestion,
    agentSeenActivity,
  });
  // GAME-UI-1: the party roster and the job runner draw the card bar's faces and states.
  useEffect(
    () => publishGameLooks({ getAppearance: terminalDrawer.getAppearance, statusFor: terminalDrawer.statusFor }),
    [terminalDrawer.getAppearance, terminalDrawer.statusFor],
  );

  const launchIntoDirectory = useCallback((directory: Directory) => {
    transport.send({ type: 'launchAgent', directoryPath: directory.path });
  }, []);
  const mobileShell = useMobileShell({
    getOfficeState,
    terminalAgentIds: paneAgentIds,
    drawer: terminalDrawer,
    focusedAgentId,
    launchAgent: launchIntoDirectory,
  });
  // agty (T-0043): the pages live on the office side of the sliding track.
  useEffect(() => {
    if (isMobile && phoneTabs.tab !== 'office' && mobileShell.view === 'terminal')
      mobileShell.toggleView();
    // Only when a page comes up: 터미널로 보기 from inside one slides to the terminal on purpose.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phoneTabs.tab]);
  // Owner 10-24: on a phone the HUD's windows are full-screen pages under one Dock; a phone
  // starts on the office, whatever a desktop session left open in this browser.
  useEffect(() => {
    if (isMobile) closePages();
    // Only at load: a later breakpoint crossing keeps what is open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // agty (T-0039): a notice's tap goes to its character (on a phone, back to the office).
  const goToAgent = useCallback(
    (id: number): boolean => {
      // False while the character is held out of sight (a page still settling): the caller asks again.
      if (!getOfficeState().selectAndFollow(id)) return false;
      if (isMobile) goHome();
      return true;
    },
    [isMobile],
  );
  // An office panel opens in front: a page (phone) or its floating window (desktop, T-0077).
  const handleOfficePanel = useCallback((panel: OfficePanel | null) => {
    if (panel === 'terminal') openWindow('terminal');
    else if (panel) showOffice(panel);
    else closeWindow('office');
  }, []);
  const closeNotices = () => closeWindow('notices');
  // 터미널로 보기 (T-0078): the agent's tab is in the workspace; bring the 터미널 panel forward
  // (on a phone the messenger is minimized under it, its conversation kept).
  useEffect(() => {
    const openTerminal = () => {
      if (agtyMode) handleOfficePanel('terminal');
      else setPlainTerminalOpen(true);
    };
    window.addEventListener(OPEN_TERMINAL_EVENT, openTerminal);
    return () => window.removeEventListener(OPEN_TERMINAL_EVENT, openTerminal);
  }, [agtyMode, handleOfficePanel]);
  // UI-DASH: a link that opened the 작업실 opens the 현황판 on its 개발 tab (window or Dock page).
  useEffect(() => {
    const openWorkbench = () => showOffice('dev');
    window.addEventListener(OPEN_WORKBENCH_EVENT, openWorkbench);
    return () => window.removeEventListener(OPEN_WORKBENCH_EVENT, openWorkbench);
  }, []);
  // The messenger it came from stays open behind it (switching windows keeps the others).
  useEffect(() => {
    const openFiles = () => handleOfficePanel('files');
    window.addEventListener('agty-open-files-tab', openFiles);
    return () => window.removeEventListener('agty-open-files-tab', openFiles);
  }, [handleOfficePanel]);
  // T-0043: a notice opens where it came from (a conversation, a job card, the character).
  const openNotice = useCallback(
    (t: NoticeTarget) => {
      closeTitleScene(); // GFX: a notice opened from behind the lobby is the office
      return openTarget(t, {
        goToAgent,
        officeHas: (id) => getOfficeState().characters.has(id),
      });
    },
    [goToAgent],
  );
  // The terminal icon's badge: agent terminals waiting on an answer; the lobby board's
  // 나를 기다림: every agent waiting on one.
  const terminalWaiting = waitingIds(paneAgentIds, terminalDrawer.reasons).length;
  const agentsWaiting = waitingIds(agents, terminalDrawer.reasons);

  const currentMajorMinor = toMajorMinor(extensionVersion);

  const handleWhatsNewDismiss = useCallback(() => {
    transport.send({ type: 'setLastSeenVersion', version: currentMajorMinor });
  }, [currentMajorMinor]);

  const handleOpenChangelog = useCallback(() => {
    setIsChangelogOpen(true);
    transport.send({ type: 'setLastSeenVersion', version: currentMajorMinor });
  }, [currentMajorMinor]);

  // Settings > 업데이트 소식 opens the same modal.
  useEffect(() => setChangelogOpener(handleOpenChangelog), [handleOpenChangelog]);

  // Sync alwaysShowOverlay from persisted settings
  useEffect(() => {
    setAlwaysShowOverlay(alwaysShowLabels);
  }, [alwaysShowLabels]);

  const directoryEditor = useDirectoryEditor({
    directories,
    directoryRejection,
    directorySaved,
    areaMappings,
    setAreaMappings,
    getOfficeState,
  });

  const handleToggleDebugMode = useCallback(() => setIsDebugMode((prev) => !prev), []);
  const handleToggleAlwaysShowOverlay = useCallback(() => {
    setAlwaysShowOverlay((prev) => {
      const newVal = !prev;
      transport.send({ type: 'setAlwaysShowLabels', enabled: newVal });
      return newVal;
    });
  }, []);

  const handleSelectAgent = useCallback((id: number) => {
    transport.send({ type: 'focusAgent', id });
  }, []);

  // The Intro's wire-facing state machine — which asks survive being mooted,
  // when a hooksStatus is this tour's install verdict — lives in useIntroTour
  // (pure reducer in introTourState.ts); the App only wires it to the bubble.
  const bypassState = useBypass();
  const {
    intro,
    onboarding,
    bypass,
    onBypass,
    installFailed,
    installPending,
    onChoice: handleConsentChoice,
    onClose: handleIntroClose,
  } = useIntroTour({
    consentRequest,
    hooksInstalled,
    hooksStatusSeq,
    dismissConsentRequest,
    // O4: asked once, of an owner who can answer (a read-only viewer has nothing to choose).
    bypassUnanswered: onboardingAsked({
      agtyMode,
      answered: bypassState.mode === null ? null : bypassState.mode !== '',
      readOnly: bypassReadOnly({ officeReadOnly, officeSnapshot }),
    }),
  });

  // The Settings surface renders one provider today; its checkbox binds to
  // the Claude row of the per-provider install-state map.
  const claudeHooksInstalled = hooksInstalled['claude'] === true;

  // Mutate Directory→Area mappings locally + send to server. Updates OfficeState in
  // the same tick so a follow-up agentCreated picks up the new mapping.
  const handleAreaMappingChange = useCallback(
    (directoryName: string, areaLabel: string, action: 'add' | 'remove') => {
      const current = areaMappings[directoryName] ?? [];
      let nextLabels: string[];
      if (action === 'add') {
        if (current.includes(areaLabel)) return;
        nextLabels = [...current, areaLabel];
      } else {
        nextLabels = current.filter((l) => l !== areaLabel);
      }
      const next = { ...areaMappings };
      if (nextLabels.length === 0) {
        delete next[directoryName];
      } else {
        next[directoryName] = nextLabels;
      }
      setAreaMappings(next);
      getOfficeState().setAreaMappings(next);
      transport.send({ type: 'saveAreaMappings', mappings: next });
    },
    [areaMappings, setAreaMappings],
  );

  // Toggle global Show Areas — persisted via setShowAreas message; runs server-
  // side through configPersistence.
  const onToggleShowAreas = useCallback(() => {
    const next = !showAreas;
    setShowAreas(next);
    transport.send({ type: 'setShowAreas', enabled: next });
  }, [showAreas, setShowAreas]);

  // When AREA_PAINT is active in the editor, force the overlay on even if the
  // user has toggled Show Areas off globally — they need to see what they're
  // editing. The selected area's overlay is alpha-bumped via activeAreaLabel.
  const isEditingAreas = editor.isEditMode && editorState.activeTool === EditTool.AREA_PAINT;
  const effectiveShowAreas = isEditingAreas || showAreas;
  const activeAreaLabel = isEditingAreas ? editor.selectedAreaLabel : null;

  // e2e: register the component-scoped editor-action drivers + the effective
  // show-areas gate on the test-hooks namespace (module-load installTestHooks
  // can't reach these React callbacks). The action drivers bypass canvas
  // pixel→tile geometry — the handlers still own undo/dirty/rebuild; for specs
  // that drive the real canvas gesture instead, getTileCenter projects a tile
  // to canvas CSS pixels with the renderer's own zoom + pan. Guarded on isE2E.
  useEffect(() => {
    if (!isE2E || typeof window === 'undefined') return;
    const hooks = (window.__agentTycoonTestHooks ??= {});
    hooks.editorTileAction = (col, row) => editor.handleEditorTileAction(col, row);
    hooks.editorEraseAction = (col, row) => editor.handleEditorEraseAction(col, row);
    hooks.editorDrop = (uid, col, row, duplicate = false) =>
      editor.handleDrop(uid, col, row, { duplicate });
    hooks.getTileCenter = (col, row) => {
      const canvas = document.querySelector(`[data-testid="${OFFICE_CANVAS_TEST_ID}"]`);
      if (!canvas) return null;
      const projection = overlayProjection(
        getOfficeState().getLayout(),
        canvas.getBoundingClientRect(),
        editor.zoom,
        editor.panRef.current,
        window.devicePixelRatio || 1,
      );
      return {
        x: projection.toScreenX((col + 0.5) * TILE_SIZE),
        y: projection.toScreenY((row + 0.5) * TILE_SIZE),
      };
    };
    hooks.getShowAreas = () => effectiveShowAreas;
    hooks.makeHdCharacter = (id) => {
      const ch = getOfficeState().characters.get(id);
      const templates = getCharacterTemplates();
      const base =
        ch && (getCustomCharacter(ch.palette)?.sheet ?? templates[ch.palette % templates.length]);
      if (!ch || !base || (base.density ?? 1) !== 1) return false;
      const double = (f: string[][]) => {
        const out = f.flatMap((row) => {
          const wide = row.flatMap((c) => [c, c]);
          return [wide, [...wide]];
        });
        out[41][15] = HD_TEST_MARKER_COLOR;
        return out;
      };
      setCustomCharacter(
        ch.palette,
        { down: base.down.map(double), up: base.up.map(double), right: base.right.map(double), density: 2 },
        null,
      );
      return true;
    };
    hooks.placeFurniture = (type, col, row) => {
      const os = getOfficeState();
      const layout = os.getLayout();
      if (!getCatalogEntry(type)) return false;
      const uid = `gfx-${type}-${col}-${row}`;
      os.rebuildFromLayout({ ...layout, furniture: [...layout.furniture, { uid, type, col, row }] });
      return true;
    };
    hooks.setZoom = (z) => editor.handleZoomChange(z);
    hooks.centerOn = (id) => {
      const ch = getOfficeState().characters.get(id);
      const canvas = document.querySelector<HTMLCanvasElement>('[data-testid="office-canvas"]');
      if (!ch || !canvas) return false;
      const { cols, rows } = getOfficeState().getLayout();
      const z = editor.zoom;
      // mapOffset: floor((canvas - map) / 2) + pan; the character to the canvas's middle
      editor.panRef.current = {
        x: canvas.width / 2 - ch.x * z - Math.floor((canvas.width - cols * TILE_SIZE * z) / 2),
        y: canvas.height / 2 - ch.y * z - Math.floor((canvas.height - rows * TILE_SIZE * z) / 2),
      };
      return true;
    };
    hooks.getCamera = () => {
      const { cols, rows } = getOfficeState().getLayout();
      return { zoom: editor.zoom, pan: { ...editor.panRef.current }, cols, rows, framing: lastFraming() };
    };
  }, [
    editor.handleEditorTileAction,
    editor.handleEditorEraseAction,
    editor.handleDrop,
    editor.zoom,
    editor.panRef,
    effectiveShowAreas,
  ]);

  const containerRef = useRef<HTMLDivElement>(null);

  const [editorTickForKeyboard, setEditorTickForKeyboard] = useState(0);
  useEditorKeyboard(
    editor.isEditMode,
    editorState,
    editor.handleDeleteSelected,
    editor.handleRotateSelected,
    editor.handleToggleState,
    editor.handleUndo,
    editor.handleRedo,
    useCallback(() => setEditorTickForKeyboard((n) => n + 1), []),
    editor.handleToggleEditMode,
  );

  const handleCloseAgent = useCallback(
    (id: number) => {
      if (effectiveReadOnly) return;
      transport.send({ type: 'closeAgent', id });
    },
    [effectiveReadOnly],
  );

  const { reveal: revealTerminal } = terminalDrawer;
  const { showTerminal: showMobileTerminal } = mobileShell;
  const handleClick = useCallback(
    (agentId: number) => {
      const os = getOfficeState();
      if (os.characters.get(agentId)?.agtyOwner) return; // OWNER-AVATAR: no terminal of its own
      // If clicked agent is a sub-agent, focus the parent's terminal instead
      const focusId = os.terminalOwnerOf(agentId);
      transport.send({ type: 'focusAgent', id: focusId });
      // Standalone: focusAgent is a no-op server-side (there's no editor to
      // raise a panel in), so focus is resolved here — reveal the agent's tab
      // (desktop drawer) and slide to the terminal page (mobile). A Teammate
      // without a terminal of its own runs in its Lead's, so it reveals that
      // one (VS Code resolves the same way server-side).
      const leadId = os.characters.get(focusId)?.leadAgentId;
      const terminalId = leadId !== undefined && !paneAgentIds.includes(focusId) ? leadId : focusId;
      if (paneAgentIds.includes(terminalId)) {
        revealTerminal(terminalId);
        if (isMobile) showMobileTerminal();
      }
    },
    [paneAgentIds, isMobile, revealTerminal, showMobileTerminal],
  );
  // Card click when there is no terminal pane to switch (VS Code, or a
  // watch-only standalone session): ask the host to raise the agent's own
  // terminal — VS Code shows the editor terminal, standalone has nothing to
  // show — and select its character so the office follows the click.
  const handleCardSelect = useCallback((agentId: number) => {
    transport.send({ type: 'focusAgent', id: agentId });
    selectOrOpenInfo(getOfficeState(), agentId);
  }, []);

  const officeState = getOfficeState();

  // Merged set of Directories the Areas dropdown can map: host-contributed ones plus
  // every distinct Directory an agent has run in this session (deduped by name; name
  // is the areaMappings key / seat-bias identity, path is only the React list key).
  const areaDirectories = useMemo(() => {
    const byName = new Map<string, { name: string; path: string }>();
    for (const f of directories) byName.set(f.name, f);
    for (const name of agentDirectoryNames) {
      if (!byName.has(name)) byName.set(name, { name, path: name });
    }
    return [...byName.values()];
  }, [directories, agentDirectoryNames]);

  // The Areas the office defines, offered as a multi-select in the Directory
  // modal. Read straight off the layout (imperative state) on each render, so a
  // layout that loaded — or an Area just added in the editor — is in the list
  // the next time the modal opens.
  const areaLabels = (officeState.getLayout().areas ?? []).map((area) => area.label);

  // Areas authoring is available when the layout already defines areas, or when
  // there is at least one mappable Directory. Decouples the Areas UI from VS Code
  // multi-root workspaces (fixes single-root VS Code AND standalone, where
  // directories is always empty).
  const areasAvailable =
    (officeState.getLayout().areas?.length ?? 0) > 0 || areaDirectories.length > 0;

  const handleExportLayout = useCallback(() => {
    exportLayoutToFile(getOfficeState().getLayout());
  }, []);

  const handleImportLayout = useCallback(
    (file: File) => {
      // Browser-native import (standalone): read + validate + apply directly,
      // bypassing the layoutLoaded message whose dirty guard would skip it.
      if (
        isEditDirty() &&
        !window.confirm('Replace the current layout? Unsaved edits will be lost.')
      ) {
        return;
      }
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const imported = JSON.parse(String(reader.result)) as Record<string, unknown>;
          // Match the VS Code guard, plus the furniture-array check VS Code omits
          // (migrate + rebuild iterate furniture and would throw on a non-array).
          if (
            imported.version !== 1 ||
            !Array.isArray(imported.tiles) ||
            !Array.isArray(imported.furniture)
          ) {
            window.alert('Invalid layout file.');
            return;
          }
          const migrated = migrateLayoutColors(imported as unknown as OfficeLayout);
          getOfficeState().rebuildFromLayout(migrated);
          editor.setLastSavedLayout(migrated);
          transport.send({
            type: 'saveLayout',
            layout: migrated as unknown as Record<string, unknown>,
          });
          editor.markClean();
          requestStaleRecheck();
        } catch {
          window.alert('Failed to read or parse layout file.');
        }
      };
      reader.readAsText(file);
    },
    [isEditDirty, editor],
  );

  // Force dependency on editorTickForKeyboard to propagate keyboard-triggered re-renders
  void editorTickForKeyboard;

  // Show "Press R to rotate" hint when a rotatable item is selected or being placed
  const showRotateHint =
    editor.isEditMode &&
    (() => {
      if (editorState.selectedFurnitureUid) {
        const item = officeState
          .getLayout()
          .furniture.find((f) => f.uid === editorState.selectedFurnitureUid);
        if (item && isRotatable(item.type)) return true;
      }
      if (
        editorState.activeTool === EditTool.FURNITURE_PLACE &&
        isRotatable(editorState.placingType)
      ) {
        return true;
      }
      return false;
    })();

  // BOOT-LOAD: the loading screen is the first child of both returns, so it stays mounted when the
  // layout comes in.
  const boot = <BootScreen layoutReady={layoutReady} />;
  if (!layoutReady) {
    return (
      <>
        {boot}
        <div className="w-full h-full flex items-center justify-center ">{t('upstream.loading')}</div>
      </>
    );
  }

  // The office region is shared by both shells: desktop mounts it as the
  // flexing left half of the split view (the terminal panel docks beside it);
  // mobile mounts it as the first page of the sliding track. containerRef
  // (ToolOverlay geometry) rides along either way.
  // WINDOW-TOP-1104: clip, not hidden. The office's overlays (the lobby board, the card bar's head) run past
  // its edges, and an overflow:hidden box is still a scroll container: a scrollIntoView or focus() inside a
  // window scrolled the whole region up, the windows' title bars under the top bar and a dead band below.
  const officeRegion = (
    <div
      ref={containerRef}
      className={`relative h-full overflow-clip ${isMobile ? 'w-full' : 'flex-1 min-w-0'}`}
    >
      <OfficeCanvas
        officeState={officeState}
        onClick={handleClick}
        isEditMode={editor.isEditMode}
        editorState={editorState}
        onEditorTileAction={editor.handleEditorTileAction}
        onEditorEraseAction={editor.handleEditorEraseAction}
        onEditorSelectionChange={editor.handleEditorSelectionChange}
        onDeleteSelected={editor.handleDeleteSelected}
        onRotateSelected={editor.handleRotateSelected}
        onDrop={editor.handleDrop}
        editorTick={editor.editorTick}
        zoom={editor.zoom}
        onZoomChange={editor.handleZoomChange}
        panRef={editor.panRef}
        showAreas={effectiveShowAreas}
        activeAreaLabel={activeAreaLabel}
        tapSelectsFirst={isMobile}
        backdrop={agtyMode}
      />

      {!isDebugMode ? (
        <>
          {/* Mobile: pinch replaces the zoom buttons, and the toolbar's
                jobs move to the card bar (+) and the floating Settings button. */}
          {!isMobile && !agtyMode && (
            <ZoomControls zoom={editor.zoom} onZoomChange={editor.handleZoomChange} />
          )}

          {/* Vignette overlay */}
          <div
            className="absolute inset-0 pointer-events-none"
            style={{ background: 'var(--vignette)' }}
          />

          {/* agty (T-0053): the agty office edits decor, so a privileged client gets the editor. */}
          {editor.isEditMode && editor.isDirty && !officeReadOnly && (
            <EditActionBar editor={editor} editorState={editorState} />
          )}

          {showRotateHint && (
            <div
              className="absolute left-1/2 -translate-x-1/2 z-11 bg-accent-bright text-white text-sm py-3 px-8 rounded-none border-2 border-accent shadow-pixel pointer-events-none whitespace-nowrap"
              style={{ top: editor.isDirty ? 64 : 8 }}
            >
              Rotate (R)
            </div>
          )}

          {editor.isEditMode &&
            !officeReadOnly &&
            (() => {
              const selUid = editorState.selectedFurnitureUid;
              const selItem = selUid
                ? officeState.getLayout().furniture.find((f) => f.uid === selUid)
                : undefined;
              const selColor = selItem?.color ?? null;
              return (
                <EditorToolbar
                  activeTool={editorState.activeTool}
                  selectedTileType={editorState.selectedTileType}
                  selectedFurnitureType={editorState.placingType}
                  selectedFurnitureUid={selUid}
                  selectedFurnitureColor={selColor}
                  floorColor={editorState.floorColor}
                  wallColor={editorState.wallColor}
                  selectedWallSet={editorState.selectedWallSet}
                  onToolChange={editor.handleToolChange}
                  onTileTypeChange={editor.handleTileTypeChange}
                  onFloorColorChange={editor.handleFloorColorChange}
                  onWallColorChange={editor.handleWallColorChange}
                  onWallSetChange={editor.handleWallSetChange}
                  onSelectedFurnitureColorChange={editor.handleSelectedFurnitureColorChange}
                  pickedFurnitureColor={editorState.pickedFurnitureColor}
                  onPickedFurnitureColorChange={editor.handlePickedFurnitureColorChange}
                  onColorPickToggle={editor.handleColorPickToggle}
                  onFurnitureTypeChange={editor.handleFurnitureTypeChange}
                  loadedAssets={loadedAssets}
                  activePetTypes={officeState.getActivePetTypes()}
                  petCount={getPetCount()}
                  petPlacingType={editorState.petPlacingType}
                  onPetToggle={editor.handlePetToggle}
                  carpetVariant={editor.carpetVariant}
                  carpetColor={editor.carpetColor}
                  carpetAccentColor={editor.carpetAccentColor}
                  onCarpetVariantChange={editor.handleCarpetVariantChange}
                  onCarpetColorChange={editor.handleCarpetColorChange}
                  onCarpetAccentColorChange={editor.handleCarpetAccentColorChange}
                  areas={officeState.getLayout().areas ?? []}
                  selectedAreaLabel={editor.selectedAreaLabel}
                  directories={areaDirectories}
                  areasAvailable={areasAvailable}
                  areaMappings={areaMappings}
                  onSelectArea={editor.handleSelectArea}
                  onAddArea={editor.handleAddArea}
                  onRemoveArea={editor.handleRemoveArea}
                  onRenameArea={editor.handleRenameArea}
                  onAreaColorChange={editor.handleAreaColorChange}
                  onAreaMappingChange={handleAreaMappingChange}
                  selectedFurnitureExtra={
                    agtyMode &&
                    selItem && (
                      <FurnitureArt
                        key={selItem.uid}
                        uid={selItem.uid}
                        type={selItem.type}
                        onSwitch={editor.handleFurnitureTypeSwitch}
                      />
                    )
                  }
                />
              );
            })()}

          <RegionBoundary region="hud" className="absolute left-1/2 top-8 -translate-x-1/2 z-30">
          <ToolOverlay
            officeState={officeState}
            agents={agents}
            agentTools={agentTools}
            subagentTools={subagentTools}
            subagentCharacters={subagentCharacters}
            containerRef={containerRef}
            zoom={editor.zoom}
            panRef={editor.panRef}
            onCloseAgent={handleCloseAgent}
            alwaysShowOverlay={alwaysShowOverlay}
            phone={isMobile}
          />
          </RegionBoundary>
          {/* HUD-1B: the desktop's camera strip is the elevator's (FloorControls). */}
          {agtyMode && isMobile && <CameraModeControl phone />}
          {/* JOYSTICK: the direction keys (walk the selected or the owner's character, or pan the
              free camera); the phone's office page only. */}
          {agtyMode && isMobile && (
            <Joystick
              enabled={
                !editor.isEditMode && phoneTabs.tab === 'office' && mobileShell.view === 'office'
              }
            />
          )}
          {agtyMode && <TitleScene phone={isMobile} />}
        </>
      ) : (
        <DebugView
          agents={agents}
          selectedAgent={selectedAgent}
          agentTools={agentTools}
          agentStatuses={agentStatuses}
          subagentTools={subagentTools}
          officeState={officeState}
          onSelectAgent={handleSelectAgent}
        />
      )}

      {/* Hooks first-run tooltip. Gated on hooksInstalled (the hooksStatus
          message), NOT the hooksEnabled preference: hooksEnabled defaults true
          while first-run consent is still pending, and announcing "Instant
          Detection Active" before anything is installed would be a lie. */}
      {!agtyMode &&
        hooksEnabled &&
        claudeHooksInstalled &&
        !hooksInfoShown &&
        !hooksTooltipDismissed && (
          <Tooltip
            title={t('upstream.instantDetectionActive')}
            position="top-right"
            onDismiss={() => {
              setHooksTooltipDismissed(true);
              transport.send({ type: 'setHooksInfoShown' });
            }}
          >
            <span className="text-sm text-text leading-none">
              Your agents now respond in real-time.{' '}
              <span
                className="text-accent-text cursor-pointer underline"
                onClick={() => {
                  setIsHooksInfoOpen(true);
                  setHooksTooltipDismissed(true);
                  transport.send({ type: 'setHooksInfoShown' });
                }}
              >
                View more
              </span>
            </span>
          </Tooltip>
        )}

      {effectiveReadOnly && !agtyMode && (
        <div className="absolute mobile-safe-top left-1/2 -translate-x-1/2 z-10 text-sm text-text-muted pointer-events-none select-none whitespace-nowrap">
          View only
        </div>
      )}

      {/* A read-only office gets no toolbar: launching, layout editing and every
          setting would be refused by the server anyway. */}
      {!isMobile && !effectiveReadOnly && (
        <BottomToolbar
          isEditMode={editor.isEditMode}
          onToggleEditMode={editor.handleToggleEditMode}
          isSettingsOpen={isSettingsOpen}
          onToggleSettings={() => setIsSettingsOpen((v) => !v)}
          directories={directories}
          onAddDirectory={directoryEditor.add}
          onEditDirectory={directoryEditor.edit}
          terminalAvailable={terminalAvailable}
          terminalUnavailableReason={terminalUnavailableReason}
        />
      )}

      {/* Mobile: Settings floats top-left (the layout editor stays desktop-
            only — its tools are drag/hover-driven). */}
      {isMobile && !isDebugMode && !effectiveReadOnly && (
        <div className="absolute mobile-safe-top left-8 z-20">
          <Button
            size="sm"
            variant={isSettingsOpen ? 'active' : 'default'}
            className="border-border! shadow-pixel"
            onClick={() => setIsSettingsOpen((v) => !v)}
          >
            Settings
          </Button>
        </div>
      )}

      <VersionIndicator
        floating={agtyMode}
        currentVersion={extensionVersion}
        lastSeenVersion={lastSeenVersion}
        hideUpdateNotice={officeReadOnly && !agtyMode}
        onDismiss={handleWhatsNewDismiss}
        onOpenChangelog={handleOpenChangelog}
      />

      {/* The hooks ask is the original (upstream) tour; the agty office has none, so there only O4's steps show
          (and the upstream surfaces get none of them: the remote step needs the agty login layer). */}
      {((!agtyMode && intro) || onboarding) && (
        <IntroBubble
          officeState={officeState}
          headline={intro?.headline ?? ''}
          disclosure={intro?.disclosure ?? ''}
          hasConsent={!agtyMode && intro !== null}
          onboarding={onboarding}
          bypass={bypass}
          onBypass={onBypass}
          containerRef={containerRef}
          zoom={editor.zoom}
          panRef={editor.panRef}
          installFailed={installFailed}
          installPending={installPending}
          onChoice={handleConsentChoice}
          onClose={handleIntroClose}
          escapeSuppressed={
            isSettingsOpen ||
            isChangelogOpen ||
            isHooksInfoOpen ||
            showMigrationNotice ||
            editor.isEditMode
          }
        />
      )}

      {/* agty (T-0046): the lobby's 전광판 on its board, and its full view. */}
      {agtyMode && !isDebugMode && !editor.isEditMode && (
        <LobbyBoard
          officeState={officeState}
          iso={isoView}
          containerRef={containerRef}
          zoom={editor.zoom}
          panRef={editor.panRef}
          agentTools={agentTools}
          phone={isMobile}
          waiting={agentsWaiting}
        />
      )}
      {/* agty (T-0065): the memos on the whiteboards; a tap opens one (not while decorating). */}
      {agtyMode && !isDebugMode && (!isoView || editor.isEditMode) && (
        <WhiteboardMemos
          officeState={officeState}
          containerRef={containerRef}
          zoom={editor.zoom}
          panRef={editor.panRef}
          interactive={!editor.isEditMode}
          readOnly={officeReadOnly}
        />
      )}
      {/* agty (T-0027): the elevator: floor panel (desktop) and doors. */}
      {agtyMode && !isDebugMode && (
        <FloorLayer
          officeState={officeState}
          decorate={{ on: editor.isEditMode, toggle: editor.handleToggleEditMode }}
        />
      )}

      {/* agty (T-0017): the owner's character's menu (an agent's is in its card or inspector). */}
      {agtyMode && !officeReadOnly && !editor.isEditMode && !isDebugMode && (
        <CharacterMenu
          officeState={officeState}
          agentId={focusedAgentId}
          containerRef={containerRef}
          zoom={editor.zoom}
          panRef={editor.panRef}
        />
      )}

      {/* agty (T-0077, hud-v3 P0): the dock, the corner, the control center and the windows (a phone has its Dock and pages). */}
      {agtyMode && !isMobile && (
        <RegionBoundary region="hud" className="absolute left-8 bottom-8 z-30">
        <HudLayer dock={<Dock terminalWaiting={terminalWaiting} />}>
          <DesktopWindows
            agentTools={agentTools}
            subagentTools={subagentTools}
            statusFor={terminalDrawer.statusFor}
            getAppearance={terminalDrawer.getAppearance}
          />
          {/* FEAT-HUD-CONTROL-CENTER (owner 11-06 17:12): notifications, usage, what runs, the clock, the menu. */}
          <RegionBoundary region="hud" className="absolute left-8 bottom-8 z-30">
            <ControlCenter
              ids={agtyCards.cardIds}
              onOpenNotice={openNotice}
              notices={<NoticePanel getOfficeState={getOfficeState} onOpen={openNotice} onClose={closeNotices} inWindow />}
            />
          </RegionBoundary>
        </HudLayer>
        </RegionBoundary>
      )}

      {!isAgtyMock && <ConnectionIndicator />}
    </div>
  );

  const mobileShowsAgentCards = showsAgentCards(phoneTabs.tab, mobileShell.view);

  // Desktop: split view — the office region flexes to fill the space left of
  // the terminal panel. Mobile: a column — the sliding office/terminal track
  // on top, the agent-card bar pinned along the bottom.
  return (
    <DevroomTools.Provider value={{ agentTools, subagentTools }}>
    {boot}
    <div
      className="w-full h-full relative overflow-clip flex flex-col"
      style={
        isMobile
          ? {
              ...(keyboard.clampHeight !== null && { height: keyboard.clampHeight }),
              // The software keyboard hides the top bar that clears the notch: the page clears it itself.
              ...(agtyMode && keyboard.keyboardOpen && { paddingTop: 'var(--agty-safe-top)' }),
            }
          : undefined
      }
    >
      {/* Typing on the phone: the keyboard leaves little height, the terminal or composer gets it (10-22 20:23).
          The PC has no top bar (hud-v3 P0): the office runs to the top, its HUD floats over it. */}
      {agtyMode && isMobile && !keyboard.keyboardOpen && <MobileTopBar />}
      {/* The phone's top bar already clears the top safe-area inset: below it,
          the phone's toggle and terminal pane must not add it again. */}
      <div
        className={`flex flex-1 min-h-0 overflow-clip ${isMobile ? 'flex-col' : ''}`}
        style={agtyMode ? ({ '--agty-safe-top': '0px' } as CSSProperties) : undefined}
      >
        {isMobile ? (
          <>
            <MobileShell
              office={
                <div className="relative h-full">
                  {officeRegion}
                  {agtyMode && (
                    <MobileOfficePanel
                      agentTools={agentTools}
                      subagentTools={subagentTools}
                      keyboardOpen={keyboard.keyboardOpen}
                      statusFor={terminalDrawer.statusFor}
                      getAppearance={terminalDrawer.getAppearance}
                    />
                  )}
                  {agtyMode && hud.open.messenger && (
                    <RegionBoundary region="messenger" className="absolute inset-x-8 top-8 z-50">
                      <Messenger
                        mobile
                        visualViewportHeight={keyboard.visualHeight}
                        statusFor={terminalDrawer.statusFor}
                        getAppearance={terminalDrawer.getAppearance}
                      />
                    </RegionBoundary>
                  )}
                  {agtyMode && hud.open.notices && (
                    <NoticePhonePage
                      getOfficeState={getOfficeState}
                      onOpen={openNotice}
                      onClose={closeNotices}
                    />
                  )}
                  {agtyMode && <WorkSheet mobile />}
                </div>
              }
              shell={mobileShell}
              drawer={terminalDrawer}
              agentIds={agtyCards.cardIds}
              describeCard={agtyCards.describeCard}
              terminalAgentIds={paneAgentIds}
              focusedAgentId={focusedAgentId}
              terminalAvailable={panesAvailable}
              terminalUnavailableReason={terminalUnavailableReason}
              directories={directories}
              onAddDirectory={directoryEditor.add}
              onEditDirectory={directoryEditor.edit}
              onCloseAgent={handleCloseAgent}
              keyboardOpen={keyboard.keyboardOpen}
              showAgentCards={mobileShowsAgentCards}
              hideActions={effectiveReadOnly}
              bottom={
                agtyMode ? (
                  <>
                    {/* The usage, folded to one line (owner 10-24; as the desktop control center's, 11-06), is the
                        last row of the page, above the tab bar: nothing sits under a phone's tab bar. */}
                    <MobileUsage />
                    <MobileDock
                      active={phoneTabs.tab}
                      onPick={phoneTabs.pick}
                      terminalWaiting={terminalWaiting}
                    />
                  </>
                ) : undefined
              }
            />
          </>
        ) : (
          <>
            {officeRegion}

            {/* Standalone with a terminal: terminalAvailable is only ever true when
              the server reports a working PTY to a tokened session, which VS
              Code's surface never does. In flow as a flex sibling so the office
              region reflows beside it instead of being overlaid.

              Otherwise (VS Code, or a watch-only standalone session) the card
              bar stands alone with every agent in the office, external sessions
              included — the at-a-glance "who needs attention" strip, with a
              click raising the agent's editor terminal where there is one. */}
            {panesAvailable ? (
              <TerminalDrawer
                agentIds={paneAgentIds}
                shownAgentId={terminalDrawer.shownAgentId}
                onSelectAgent={terminalDrawer.select}
                onCloseAgent={handleCloseAgent}
                isOpen={terminalDrawer.isOpen}
                onClosePanel={terminalDrawer.close}
                widthPx={terminalDrawer.widthPx}
                onResizeStart={terminalDrawer.onResizeStart}
                getAppearance={terminalDrawer.getAppearance}
                statusFor={terminalDrawer.statusFor}
                onStatusChange={terminalDrawer.onStatusChange}
                describeCard={agtyCards.describeCard}
                onAddCard={addOrchestrator}
              />
            ) : (
              !isDebugMode && (
                <RegionBoundary region="party" className="absolute right-8 top-1/2 -translate-y-1/2 z-30">
                  <AgentCardBar
                    agentIds={agtyCards.cardIds}
                    describeCard={agtyCards.describeCard}
                    onAdd={addOrchestrator}
                    focusedAgentId={focusedAgentId}
                    getAppearance={terminalDrawer.getAppearance}
                    statusFor={terminalDrawer.statusFor}
                    onSelect={handleCardSelect}
                    onClose={handleCloseAgent}
                    showClose={!effectiveReadOnly}
                    onCustomize={
                      agtyMode && !officeReadOnly
                        ? (id) => {
                            const name = officeSnapshot && lookNameOf(id, officeSnapshot);
                            if (name) openLooks(name);
                          }
                        : undefined
                    }
                  />
                </RegionBoundary>
              )
            )}
            {agtyMode && <WorkSheet mobile={false} />}
          </>
        )}
      </div>

      {agtyMode && <ActionLayer />}
      <PerfReadout />
      <DevFxBar getOfficeState={getOfficeState} />
      {agtyMode && <StatDetailSheet officeState={officeState} />}
      {agtyMode && <NoticeToast getOfficeState={getOfficeState} onOpen={openNotice} />}
      {agtyMode && <PushBanner />}
      {/* A plain office (no Claude Code) is not in agty mode: the notice is for exactly that one. */}
      <AgentCliNotice />
      {showStaleBuildBanner && (
        <StaleBuildBanner
          busy={staleBuildBusy}
          reloadedFor={reloadedForBuild()}
          server={latestServerBuild.current}
          onReload={() => {
            const serverBuild = latestServerBuild.current;
            if (serverBuild) markReloadedForBuild(serverBuild);
            window.location.reload();
          }}
        />
      )}
      {/* agty (T-0022): device approval and the passkey prompt; also in a plain office (no claude
          yet), whose terminal installs it and needs this device's key (CLI-TERMINAL). */}
      {(agtyMode || agentCli !== null) && !isAgtyMock && <AuthLayer />}
      {agtyMode && <RepoActionLayer />}
      {/* DV3: Ctrl+K from anywhere; top level, as the modals (a phone's track is a transformed ancestor). */}
      {agtyMode && <DevroomPalette phone={isMobile} />}

      {!agtyMode && (
        <Modal
          isOpen={plainTerminalOpen}
          onClose={() => setPlainTerminalOpen(false)}
          title={t('hud.terminal')}
          className="w-[min(960px,100%)] h-[min(680px,100%)]"
        >
          <div className="h-[600px] max-h-[calc(100vh-120px)] p-8">
            <TerminalWorkspace />
          </div>
        </Modal>
      )}

      {/* Hooks info modal. Top level, beside the other modals: inside the
          office region it would sit in the mobile shell's transformed track,
          and a transformed ancestor is the containing block of position:
          fixed — the modal would size to the 200%-wide track. */}
      <Modal
        isOpen={isHooksInfoOpen}
        onClose={() => setIsHooksInfoOpen(false)}
        title={t('upstream.instantDetectionOn')}
        zIndex={52}
      >
        <div className="text-base text-text px-10" style={{ lineHeight: 'calc(1.4 * var(--ui-lh))' }}>
          <p className="mb-8">{t('upstream.hooksIntro')}</p>
          <ul className="mb-8 pl-18 list-disc m-0">
            <li className="text-sm mb-2">{t('upstream.hooksPermission')}</li>
            <li className="text-sm mb-2">{t('upstream.hooksTurn')}</li>
            <li className="text-sm mb-2">{t('upstream.hooksSound')}</li>
          </ul>
          <p className="mb-12 text-text-muted">{t('upstream.hooksExplanation')}</p>
          <div className="text-center">
            <button
              onClick={() => setIsHooksInfoOpen(false)}
              className="py-4 px-20 text-lg bg-accent text-white border-2 border-accent rounded-none cursor-pointer shadow-pixel"
            >
              {t('upstream.gotIt')}
            </button>
          </div>
          <p className="mt-8 text-xs text-text-muted text-center">
            To disable, go to Settings {'>'} Instant Detection
          </p>
        </div>
      </Modal>
      {/* Rendered at the composition root, not inside a launch surface: the
          drawer that opens it lives in BottomToolbar on desktop and
          MobileAgentBar on mobile, and both close as soon as it appears. */}
      <DirectoryModal
        isOpen={directoryEditor.modal.open}
        editing={directoryEditor.modal.editing}
        error={directoryEditor.error}
        suggestions={directorySuggestions}
        areas={areaLabels}
        assignedAreas={directoryEditor.assignedAreas}
        onSubmit={directoryEditor.submit}
        onDelete={directoryEditor.remove}
        onClose={directoryEditor.close}
      />

      <ChangelogModal
        isOpen={isChangelogOpen}
        onClose={() => setIsChangelogOpen(false)}
        currentVersion={extensionVersion}
      />

      <RegionBoundary region="settings" className="fixed inset-0 m-auto h-fit w-fit z-60">
      <SettingsModal
        isOpen={isSettingsOpen}
        onClose={() => setIsSettingsOpen(false)}
        isDebugMode={isDebugMode}
        onToggleDebugMode={handleToggleDebugMode}
        alwaysShowOverlay={alwaysShowOverlay}
        onToggleAlwaysShowOverlay={handleToggleAlwaysShowOverlay}
        externalAssetDirectories={externalAssetDirectories}
        watchAllSessions={watchAllSessions}
        onToggleWatchAllSessions={() => {
          const newVal = !watchAllSessions;
          setWatchAllSessions(newVal);
          transport.send({ type: 'setWatchAllSessions', enabled: newVal });
        }}
        hooksInstalled={claudeHooksInstalled}
        onToggleHooksEnabled={() => {
          // Toggle the DISPLAYED state (actual install), not the preference: when the two disagree — preference on,
          // nothing installed while consent is pending — toggling the preference would turn hooks OFF for a user
          // asking for ON. No optimistic local update either; both backends answer with the truthful hooksStatus this
          // checkbox renders, so it lands correct instead of flickering when an install fails. The providerId is
          // ECHOED from that row (never originated here), so nothing sends until the row has arrived.
          const [rowProviderId] =
            Object.entries(hooksInstalled).find(([id]) => id === 'claude') ?? [];
          if (rowProviderId !== undefined) {
            transport.send({
              type: 'setHooksEnabled',
              providerId: rowProviderId,
              enabled: !claudeHooksInstalled,
            });
          }
        }}
        showAreas={showAreas}
        onToggleShowAreas={onToggleShowAreas}
        showAreasAvailable={areasAvailable}
        bypassPermissions={bypassPermissions}
        onToggleBypassPermissions={() => {
          const newVal = !bypassPermissions;
          setBypassPermissions(newVal);
          transport.send({ type: 'setBypassPermissions', enabled: newVal });
        }}
        showHostDirectories={showHostDirectories}
        onToggleShowHostDirectories={() => {
          const newVal = !showHostDirectories;
          setShowHostDirectories(newVal);
          transport.send({ type: 'setShowHostDirectories', enabled: newVal });
        }}
        onExportLayout={handleExportLayout}
        onImportLayout={handleImportLayout}
      />
      </RegionBoundary>

      {showMigrationNotice && (
        <MigrationNotice onDismiss={() => setMigrationNoticeDismissed(true)} />
      )}
    </div>
    </DevroomTools.Provider>
  );
}

export default App;
