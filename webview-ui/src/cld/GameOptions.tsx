import { type ReactNode, useEffect, useRef, useState } from 'react';

import { openChangelog } from '../changelogOpen.js';
import { Button } from '../components/ui/Button.js';
import { Modal } from '../components/ui/Modal.js';
import { useIsMobile } from '../hooks/useIsMobile.js';
import { setLanguage, t, useLanguage } from '../i18n/index.js';
import { AgentRulesOption } from './AgentRulesOption.js';
import { AccessButton } from './auth/Access.js';
import { authFetch } from './auth/authApi.js';
import { SecurityButton } from './auth/SecurityPanel.js';
import { UpdateOption } from './auth/UpdateOption.js';
import { bypassReadOnly, chooseBypass, preferredBypassMode, useBypass } from './bypass.js';
import { isDesktopApp, pageFillsScreen, toggleAppFullscreen } from './desktopApp.js';
import { PixelSprite } from './ez/PixelSprite.js';
import { rankSprite } from './ez/rankSprites.js';
import { nameplatesOn, setNameplates } from './ez/useNameplates.js';
import { setStackedView, useFloors } from './floors.js';
import { setGameEffects, useGameEffects } from './game/gameMotion.js';
import { setBackdrop, useBackdrop } from './gfx/backdrop.js';
import { BackgroundOptions } from './gfx/BackgroundOption.js';
import { setTitleAtStart, useTitleScene } from './gfx/titleSceneState.js';
import { resetLayout } from './hud/hudStore.js';
import { setSummaryStyle, SUMMARY_STYLES, useSummaryStyle } from './hud/summaryStyle.js';
import { IsoOption } from './iso/IsoOption.js';
import { fromClock, setOfficeHours, toClock, useOfficeHours } from './officeHours.js';
import { useCldStore } from './officeStore.js';
import { OwnerPictureOption } from './OwnerPictureOption.js';
import { getRankStyle, RANK_STYLES, setRankStyle } from './rank.js';
import { type SettingHint, SettingHintContext, settingsKey } from './settingHint.js';
import { Choice, OnOff, SettingGroup, SettingRow } from './SettingRow.js';
import { setSettingsOpener, type SettingsTab } from './settingsOpen.js';
import { StartPolicyOption } from './StartPolicyOption.js';
import { setUiScale, UI_SCALES, useUiScale } from './uiScale.js';
import { setUiTheme, UI_THEMES, useUiTheme } from './uiTheme.js';
import { isEdgeScrollOn, setEdgeScroll } from './useGameControls.js';

const BYPASS_MODES = ['ask', 'bypass'] as const;

/** O4: the permission mode NEW agents start with; existing agents keep theirs (each agent's own settings change it). */
function BypassOption() {
  const { mode, error } = useBypass();
  const cld = useCldStore();
  if (bypassReadOnly(cld)) return null;
  const preferred = preferredBypassMode(mode);
  return (
    <SettingRow
      testId="bypass-option"
      title={t('settings.bypass.title')}
      help={t('settings.bypass.help')}
      note={
        error && (
          <p className="text-sm text-red-400" role="alert">
            {['read_only', 'stepup', 'write_failed'].includes(error) ? t('onboarding.bypass.refused') : error}
          </p>
        )
      }
    >
      <Choice
        label={t('settings.bypass.title')}
        options={BYPASS_MODES}
        value={preferred}
        onPick={chooseBypass}
        text={(m) =>
          m === 'ask' ? (
            t('settings.bypass.ask')
          ) : (
            <>
              {t('settings.bypass.allow')}
              <span className="text-xs" data-testid="settings-bypass-recommended">
                {t('settings.bypass.recommended')}
              </span>
            </>
          )
        }
      />
    </SettingRow>
  );
}

const WINDOW_MODES = ['window', 'fullscreen'] as const;

/** WINDOW-MODE: window / full screen in the desktop app only (a browser has its own F11). Same command as the app's F11. */
function WindowModeOption() {
  const [full, setFull] = useState(pageFillsScreen);
  useEffect(() => {
    const update = () => setFull(pageFillsScreen());
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, []);
  if (!isDesktopApp()) return null;
  const choose = (wantFull: boolean) => {
    if (wantFull !== full) toggleAppFullscreen();
  };
  return (
    <SettingRow testId="window-mode-option" title={t('windowMode.title')} help={t('windowMode.help')} badge={t('windowMode.shortcut')}>
      <Choice
        label={t('windowMode.title')}
        options={WINDOW_MODES}
        value={full ? 'fullscreen' : 'window'}
        onPick={(mode) => choose(mode === 'fullscreen')}
        text={(mode) => t(`windowMode.${mode}`)}
        attr="data-window-mode"
      />
    </SettingRow>
  );
}

/** The settings' sections, in order; the last one picked is remembered per browser. */
const SETTINGS_TABS = ['general', 'display', 'access', 'security', 'advanced'] as const satisfies readonly SettingsTab[];
const SETTINGS_TAB_KEY = 'cld.settings-tab';

function readTab(): SettingsTab {
  try {
    const saved = localStorage.getItem(SETTINGS_TAB_KEY);
    return SETTINGS_TABS.find((id) => id === saved) ?? 'general';
  } catch {
    return 'general';
  }
}

/** Over the office's overlays and panels, like the other cld dialogs. */
const OPTIONS_Z_INDEX = 60;

/** OPTIONS-3A: a game options screen on a desktop, one size whatever the tab (960 x 768 or the
 *  screen, less its margin); the whole screen on a phone. The tabs and the hint line stay, a tab
 *  scrolls only when it does not fit (a large 화면 크기). */
const OPTIONS_FRAME = 'w-[min(960px,100%)] h-[min(768px,100%)] flex! flex-col overflow-hidden!';
const OPTIONS_FRAME_PHONE = 'w-full h-full flex! flex-col overflow-hidden!';
/** The desktop's tab column: an icon and the name. */
const TAB_ICONS = {
  general: 'star',
  display: 'desktop_windows',
  access: 'power',
  security: 'shield',
  advanced: 'build',
} as const satisfies Record<SettingsTab, string>;

/** Rows outside a tab (the install hint): the tab panel's own side padding. */
const bar = 'flex items-center gap-8 px-10 pb-8';
/** The hint line. A desktop's holds two lines (the 화면 tab's longest help), so hovering moves no
 *  row; a phone's is one fixed size that scrolls, as a tap picks the row before its click lands
 *  and a growing line would move the button away. */
const HINT = 'flex min-h-78 shrink-0 items-start gap-12 border-t-2 border-border px-12 py-8 text-sm';
const HINT_PHONE = 'flex h-112 shrink-0 flex-col gap-2 overflow-y-auto border-t-2 border-border px-12 py-8 text-sm';
/** A tab's content: rows touch (each has its height), one side padding for every tab. */
const panelClass = 'flex flex-col px-10 pb-6';
/** A time or number field: the height of a small button. */
const field = 'h-28 bg-bg border-2 border-border px-4 text-sm pointer-coarse:min-h-44';
const INSTALL_HINT_KEY = 'cld.install-hint-dismissed';

interface InstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
}

let pendingInstallPrompt: InstallPromptEvent | null = null;
let appWasInstalled = false;
const installStateListeners = new Set<() => void>();
if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    pendingInstallPrompt = event as InstallPromptEvent;
    installStateListeners.forEach((listener) => listener());
  });
  window.addEventListener('appinstalled', () => {
    appWasInstalled = true;
    pendingInstallPrompt = null;
    installStateListeners.forEach((listener) => listener());
  });
}

function isIosSafari(): boolean {
  const ua = navigator.userAgent;
  const ios =
    /iPhone|iPad|iPod/.test(ua) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  return ios && /Safari/.test(ua) && !/CriOS|FxiOS|EdgiOS/.test(ua);
}

function useInstallApp() {
  const [promptEvent, setPromptEvent] = useState<InstallPromptEvent | null>(pendingInstallPrompt);
  const [installed, setInstalled] = useState(appWasInstalled);
  const [hintDismissed, setHintDismissed] = useState(() => {
    try {
      return localStorage.getItem(INSTALL_HINT_KEY) === '1';
    } catch {
      return true;
    }
  });
  const iosSafari = isIosSafari();

  useEffect(() => {
    const media = window.matchMedia('(display-mode: standalone)');
    const syncInstalled = () =>
      setInstalled(
        appWasInstalled ||
          media.matches ||
          (navigator as Navigator & { standalone?: boolean }).standalone === true,
      );
    const syncPrompt = () => {
      setPromptEvent(pendingInstallPrompt);
      syncInstalled();
    };
    installStateListeners.add(syncPrompt);
    syncPrompt();
    media.addEventListener('change', syncInstalled);
    if (window.isSecureContext && 'serviceWorker' in navigator) {
      void navigator.serviceWorker
        .register(new URL('sw.js', document.baseURI))
        .catch((error: unknown) =>
          console.warn('[cld install] service worker registration failed', error),
        );
    }
    return () => {
      installStateListeners.delete(syncPrompt);
      media.removeEventListener('change', syncInstalled);
    };
  }, []);

  const dismissHint = () => {
    setHintDismissed(true);
    try {
      localStorage.setItem(INSTALL_HINT_KEY, '1');
    } catch {
      // The install button remains available if storage is blocked.
    }
  };
  const install = async () => {
    if (!promptEvent) return;
    await promptEvent.prompt();
    await promptEvent.userChoice;
    pendingInstallPrompt = null;
    setPromptEvent(null);
    dismissHint();
  };

  return { promptEvent, installed, hintDismissed, iosSafari, dismissHint, install };
}

type InstallAppState = ReturnType<typeof useInstallApp>;

function InstallAppOptions({ promptEvent, installed, iosSafari, install }: InstallAppState) {
  const instructions = installed
    ? t('settings.install.running')
    : iosSafari
      ? t('settings.install.ios')
      : promptEvent
        ? t('settings.install.available')
        : t('settings.install.manual');

  return (
    <SettingRow
      testId="install-app-option"
      title={t('settings.install.title')}
      help={instructions}
      note={
        iosSafari &&
        !installed && (
            // FIX-PHONE-UI-TEXT: the words are text, not SVG text at 11 viewBox units (7 px drawn).
            <span
              role="img"
              aria-label={t('settings.install.share')}
              className="mt-6 inline-flex items-center gap-12 px-12 py-6 border-ui border-current rounded-ui-card text-2xs text-text-muted"
            >
              <span className="inline-flex items-center gap-4">
                <svg viewBox="0 0 16 16" className="w-16 h-16" aria-hidden="true">
                  <path d="M7 14V2m-5 5 5-5 5 5m-10 5h10" fill="none" stroke="currentColor" strokeWidth="2" />
                </svg>
                {t('settings.install.shareShort')}
              </span>
              <span className="inline-flex items-center gap-4">
                <svg viewBox="0 0 20 20" className="w-16 h-16" aria-hidden="true">
                  <path d="M1 10h18m-9-9v18" stroke="currentColor" strokeWidth="2" />
                </svg>
                {t('settings.install.homeScreen')}
              </span>
            </span>
        )
      }
    >
      <Button
        size="sm"
        onClick={install}
        disabled={installed || (!!promptEvent === false && !iosSafari)}
      >
        {t('settings.install.title')}
      </Button>
    </SettingRow>
  );
}


/** MHO 3.6: this host's display name (hostInfo.hostName), saved by the daemon; '' = the machine's name. */
function HostNameOption() {
  const { hostInfo } = useCldStore();
  const [draft, setDraft] = useState<string | null>(null);
  const [note, setNote] = useState('');
  if (!hostInfo?.hostName) return null;
  const save = async () => {
    try {
      await authFetch('/api/cld/host-name', { method: 'POST', body: { name: (draft ?? '').trim() } });
      setDraft(null);
      setNote(t('hostName.saved'));
    } catch (err) {
      setNote(err instanceof Error ? err.message : String(err));
    }
  };
  return (
    <SettingRow
      testId="host-name-option"
      title={t('hostName.title')}
      help={t('hostName.help')}
      note={note && <p className="text-sm text-text-muted" role="status">{note}</p>}
    >
      <input
        type="text"
        maxLength={40}
        className={`${field} w-160`}
        aria-label={t('hostName.title')}
        data-testid="host-name-input"
        value={draft ?? hostInfo.hostName}
        onChange={(e) => {
          setDraft(e.target.value);
          setNote('');
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && draft !== null) void save();
        }}
      />
      <Button size="sm" disabled={draft === null} onClick={() => void save()}>
        {t('hostName.save')}
      </Button>
    </SettingRow>
  );
}

const LANGUAGES = ['en', 'ko'] as const;
const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;

/** T-0041: office hours (cosmetic: when the staff go home) and how long temps linger. */
function OfficeHoursOptions() {
  const h = useOfficeHours();
  return (
    <div data-testid="office-hours-options">
      <SettingRow title={t('settings.hours.title')} help={t('settings.hours.help')}>
        <OnOff label={t('settings.hours.title')} on={h.on} onChange={(on) => setOfficeHours({ on })} />
      </SettingRow>
      {h.on && (
        <>
          <SettingRow title={t('opts.hours.time')} help={t('settings.hours.help')}>
            <input
              type="time"
              className={field}
              aria-label={t('settings.hours.start')}
              value={toClock(h.start)}
              onChange={(e) => {
                const v = fromClock(e.target.value);
                if (v !== null && v !== h.end) setOfficeHours({ start: v });
              }}
            />
            <span className="text-sm">~</span>
            <input
              type="time"
              className={field}
              aria-label={t('settings.hours.end')}
              value={toClock(h.end)}
              onChange={(e) => {
                const v = fromClock(e.target.value);
                if (v !== null && v !== h.start) setOfficeHours({ end: v });
              }}
            />
          </SettingRow>
          <SettingRow title={t('settings.hours.days')} help={t('settings.hours.help')}>
            <div className="flex gap-4" role="group" aria-label={t('settings.hours.days')}>
              {WEEKDAYS.map((name, day) => {
                const on = h.days.includes(day);
                return (
                  <Button
                    key={name}
                    size="sm"
                    variant={on ? 'active' : 'default'}
                    aria-pressed={on}
                    onClick={() =>
                      setOfficeHours({
                        days: on ? h.days.filter((d) => d !== day) : [...h.days, day],
                      })
                    }
                  >
                    {t(`settings.weekday.${name}`)}
                  </Button>
                );
              })}
            </div>
          </SettingRow>
        </>
      )}
      <SettingRow title={t('settings.hours.linger')} help={t('settings.hours.lingerHelp')}>
        <input
          type="number"
          min={0}
          max={240}
          className={`${field} w-64`}
          aria-label={t('settings.hours.minutesLabel')}
          value={h.lingerMin}
          onChange={(e) => {
            const v = Number(e.target.value);
            if (Number.isFinite(v) && v >= 0) setOfficeHours({ lingerMin: v });
          }}
        />
        <span className="text-sm">{t('settings.hours.minutes')}</span>
      </SettingRow>
    </div>
  );
}

/** GFX2: the title scene at start, and the city seen from above around the office (off: the plain background). */
function BackdropOptions() {
  const { on } = useBackdrop();
  const { atStart } = useTitleScene();
  return (
    <>
      <SettingRow testId="title-scene-option" title={t('gfx.titleOption.title')} help={t('gfx.titleOption.help')}>
        <OnOff label={t('gfx.titleOption.title')} on={atStart} onChange={setTitleAtStart} />
      </SettingRow>
      <SettingRow testId="backdrop-option" title={t('gfx.backdrop.title')} help={t('gfx.backdrop.help')}>
        <OnOff label={t('gfx.backdrop.title')} on={on} onChange={(want) => setBackdrop({ on: want })} />
      </SettingRow>
    </>
  );
}

/** What left the phone's top bar (owner 10-24), as rows of the tab it belongs to (UI-FONT: one tab row, no second one). */
export interface PhoneRows {
  access: ReactNode;
  display: ReactNode;
}

const FLOOR_VIEWS = [true, false] as const;

/** 설정: the window, its opener (openSettings) and the install note. `trigger={false}` draws no
 *  button of its own (the desktop top bar opens it from its 메뉴). */
export function GameOptions({ phoneRows, trigger = true }: { phoneRows?: PhoneRows; trigger?: boolean } = {}) {
  const language = useLanguage();
  const uiScale = useUiScale();
  const uiTheme = useUiTheme();
  const summary = useSummaryStyle();
  const gameEffects = useGameEffects();
  const [open, setOpen] = useState(false);
  const [edge, setEdge] = useState(isEdgeScrollOn);
  const [plates, setPlates] = useState(nameplatesOn);
  const [rankStyle, setRankStyleState] = useState(getRankStyle);
  const installApp = useInstallApp();
  const { stacked } = useFloors();
  const mobile = useIsMobile();
  const [tab, setTab] = useState(readTab);
  // OPTIONS-3A: the hint line shows the hovered row's help, else the picked row's.
  const [hovered, setHovered] = useState<SettingHint | null>(null);
  const [picked, setPicked] = useState<SettingHint | null>(null);
  const shown = hovered ?? picked;
  const frame = useRef<HTMLDivElement>(null);
  const chooseTab = (id: SettingsTab) => {
    setTab(id);
    setPicked(null);
    try {
      localStorage.setItem(SETTINGS_TAB_KEY, id);
    } catch {
      // No storage: the tab is only not remembered.
    }
  };
  // GFX: the title scene's menu opens this, on a tab.
  useEffect(
    () =>
      setSettingsOpener((id) => {
        if (id) setTab(id);
        setOpen(true);
      }),
    [],
  );
  // OPTIONS-3A: Esc closes, the arrow keys walk the rows (settingsKey), while this is the top
  // dialog (a window opened from a row, like 보안, keeps its own keys). Capture, so the office's
  // own arrow keys do not also move the camera.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      const root = frame.current;
      const mine = root?.closest('[role="dialog"]');
      const dialogs = document.querySelectorAll('[role="dialog"]');
      if (!root || !mine || dialogs[dialogs.length - 1] !== mine || e.isComposing) return;
      const typing = e.target instanceof Element && e.target.closest('input, textarea, select, [contenteditable="true"]');
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        if (typing && e.target instanceof HTMLElement) e.target.blur(); // a draft is not thrown away
        else setOpen(false);
        return;
      }
      if (!typing && settingsKey(e.key, root)) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open]);
  const showHint =
    !installApp.hintDismissed &&
    !!(installApp.promptEvent || installApp.iosSafari) &&
    !installApp.installed;
  const hintBody = (
    <>
      <span className="flex-1">
        {installApp.iosSafari
          ? t('settings.install.hintIos')
          : t('settings.install.hint')}
      </span>
      {installApp.promptEvent && (
        <Button size="sm" onClick={installApp.install}>
          {t('settings.install.button')}
        </Button>
      )}
      <button type="button" aria-label={t('settings.install.dismiss')} onClick={installApp.dismissHint}>
        ×
      </button>
    </>
  );
  const panel = (id: SettingsTab, body: ReactNode) => (
    <div
      role="tabpanel"
      id={`settings-panel-${id}`}
      aria-labelledby={`settings-tab-${id}`}
      hidden={tab !== id}
      className={panelClass}
      data-testid={`settings-panel-${id}`}
    >
      {body}
    </div>
  );
  return (
    <>
      {/* Desktop: a floating note under the top bar. A phone's top bar grows by the
          safe-area inset, so a floating note covered 설정 there (T-0097): on a phone the
          same note is the first row of the 설정 menu, and a dot on 설정 points to it. */}
      {showHint && !mobile && (
        <div
          className="fixed right-12 top-52 flex max-w-[300px] items-center gap-8 border border-border bg-bg p-8 text-sm shadow-lg"
          role="status"
        >
          {hintBody}
        </div>
      )}
      {trigger && (
        <Button
          size="icon_md"
          className="relative"
          aria-label={t('settings.title')}
          title={t('settings.title')}
          onClick={() => setOpen(true)}
        >
          <span className="material-symbols-sharp" aria-hidden="true">
            settings
          </span>
          {showHint && mobile && (
            <span
              data-testid="install-hint-dot"
              className="pointer-events-none absolute right-2 top-2 size-8 bg-accent-bright"
            />
          )}
        </Button>
      )}
      <Modal
        isOpen={open}
        onClose={() => setOpen(false)}
        title={
          <span className="flex items-baseline gap-16">
            {t('settings.title')}
            {!mobile && <span className="text-xs text-text-muted">{t('opts.escClose')}</span>}
          </span>
        }
        zIndex={OPTIONS_Z_INDEX}
        className={mobile ? OPTIONS_FRAME_PHONE : OPTIONS_FRAME}
      >
        {showHint && mobile && (
          <div className={bar} role="status" data-testid="install-hint">
            {hintBody}
          </div>
        )}
        <SettingHintContext.Provider
          value={{ picked: picked?.id ?? null, hover: setHovered, pick: setPicked, compact: mobile }}
        >
          <div ref={frame} className={`flex min-h-0 flex-1 ${mobile ? 'flex-col' : ''}`}>
            <div
              className={
                mobile
                  ? 'flex shrink-0 gap-4 overflow-x-auto px-10 pb-8'
                  : 'flex w-168 shrink-0 flex-col gap-4 border-r-2 border-border px-8'
              }
              role="tablist"
              aria-orientation={mobile ? 'horizontal' : 'vertical'}
              aria-label={t('settabs.label')}
              data-testid="settings-tabs"
            >
              {SETTINGS_TABS.map((id) => (
                <Button
                  key={id}
                  size={mobile ? 'sm' : 'md'}
                  role="tab"
                  id={`settings-tab-${id}`}
                  aria-selected={tab === id}
                  aria-controls={`settings-panel-${id}`}
                  variant={tab === id ? 'active' : 'default'}
                  className={mobile ? 'shrink-0' : 'w-full justify-start! gap-8'}
                  onClick={() => chooseTab(id)}
                >
                  {!mobile && (
                    <span className="material-symbols-sharp" aria-hidden="true">
                      {TAB_ICONS[id]}
                    </span>
                  )}
                  {t(`settabs.${id}`)}
                </Button>
              ))}
            </div>
            <div className="min-h-0 min-w-0 flex-1 overflow-y-auto" data-testid="settings-content">
              {panel(
                'general',
                <>
                  <InstallAppOptions {...installApp} />
                  <SettingRow testId="language-option" title={t('settings.language')} help={t('settings.language.help')}>
                    <Choice
                      label={t('settings.language')}
                      options={LANGUAGES}
                      value={language}
                      onPick={setLanguage}
                      text={(choice) => t(`settings.language.${choice === 'en' ? 'english' : 'korean'}`)}
                    />
                  </SettingRow>
                  <HostNameOption />
                  <OwnerPictureOption onPickLook={() => setOpen(false)} />
                  <OfficeHoursOptions />
                  <SettingRow testId="changelog-option" title={t('changelog.settingsTitle')} help={t('changelog.settingsHelp')}>
                    <Button size="sm" onClick={() => openChangelog()}>
                      {t('changelog.open')}
                    </Button>
                  </SettingRow>
                  <UpdateOption />
                </>,
              )}
              {panel(
                'display',
                <>
                  <SettingGroup title={t('opts.group.window')} />
                  <WindowModeOption />
                  {/* UI-SCALE: the whole UI's size, per browser (owner 10-24: the setting decides, not the screen). */}
                  <SettingRow testId="ui-scale-option" title={t('settings.uiScale')} help={t('settings.uiScale.help')}>
                    <Choice
                      label={t('settings.uiScale')}
                      options={UI_SCALES}
                      value={uiScale}
                      onPick={setUiScale}
                      text={(step) => t(`hud.${step}`)}
                      attr="data-ui-scale"
                    />
                  </SettingRow>
                  {/* FEAT-UI-MODERN-THEME 화면 스타일: 모던 or 픽셀 감성, per browser (owner 11-06 16:15; replaces 글꼴). */}
                  <SettingRow testId="ui-theme-option" title={t('uiTheme.title')} help={t('uiTheme.help')}>
                    <Choice
                      label={t('uiTheme.title')}
                      options={UI_THEMES}
                      value={uiTheme}
                      onPick={setUiTheme}
                      text={(choice) => t(`uiTheme.${choice}`)}
                      attr="data-ui-theme"
                    />
                  </SettingRow>
                  {/* FEAT-HUD-SUMMARY-STYLES: the PC's bottom-left summary, per browser (owner 11-06 22:23); the phone keeps its own shell. */}
                  {!mobile && (
                    <SettingRow testId="summary-style-option" title={t('summaryStyle.title')} help={t('summaryStyle.help')}>
                      <Choice
                        label={t('summaryStyle.title')}
                        options={SUMMARY_STYLES}
                        value={summary}
                        onPick={setSummaryStyle}
                        text={(choice) => t(`summaryStyle.${choice}`)}
                        attr="data-summary-style"
                      />
                    </SettingRow>
                  )}
                  {/* GAME-UI-0: one switch for every game animation (gameMotion.ts decides, with reduced motion). */}
                  <SettingRow testId="game-motion-option" title={t('game.motion.title')} help={t('game.motion.help')}>
                    <OnOff label={t('game.motion.title')} on={gameEffects} onChange={setGameEffects} />
                  </SettingRow>
                  <SettingGroup title={t('opts.group.office')} />
                  <SettingRow testId="floor-view-option" title={t('settings.floors.title')} help={t('settings.floors.help')}>
                    <Choice
                      label={t('settings.floors.title')}
                      options={FLOOR_VIEWS}
                      value={stacked}
                      onPick={setStackedView}
                      text={(all) => t(all ? 'settings.floors.all' : 'settings.floors.one')}
                    />
                  </SettingRow>
                  <BackdropOptions />
                  <BackgroundOptions />
                  <IsoOption />
                  <SettingGroup title={t('opts.group.overhead')} />
                  {phoneRows && (
                    <SettingRow testId="legend-option" title={t('settabs.legend.title')} help={t('settabs.legend.help')}>
                      {phoneRows.display}
                    </SettingRow>
                  )}
                  <SettingRow testId="nameplates-option" title={t('settings.nameplates.title')} help={t('settings.nameplates.help')}>
                    <OnOff
                      label={t('settings.nameplates.title')}
                      on={plates}
                      onChange={(on) => {
                        setNameplates(on);
                        setPlates(on);
                      }}
                    />
                  </SettingRow>
                  {/* RANK-LEVELS: how the rank icon beside a name is drawn, per browser. */}
                  <SettingRow testId="rank-icon-option" title={t('settings.rankIcon')} help={t('settings.rankIcon.help')}>
                    <Choice
                      label={t('settings.rankIcon')}
                      options={RANK_STYLES}
                      value={rankStyle}
                      onPick={(style) => {
                        setRankStyle(style);
                        setRankStyleState(style);
                      }}
                      text={(style) => (
                        <>
                          <PixelSprite sprite={rankSprite(style, 'manager')} scale={2} />
                          {t(`settings.rankIcon.${style}`)}
                        </>
                      )}
                      attr="data-rank-style"
                    />
                  </SettingRow>
                  <SettingGroup title={t('opts.group.controls')} />
                  <SettingRow className="pointer-coarse:hidden" title={t('settings.edge.title')} help={t('settings.edge.help')}>
                    <OnOff
                      label={t('settings.edge.title')}
                      on={edge}
                      onChange={(on) => {
                        setEdgeScroll(on);
                        setEdge(on);
                      }}
                    />
                  </SettingRow>
                  <SettingRow testId="hud-reset-option" title={t('settings.layoutReset.title')} help={t('settings.layoutReset.help')}>
                    <Button size="sm" onClick={resetLayout}>
                      {t('settings.layoutReset.button')}
                    </Button>
                  </SettingRow>
                </>,
              )}
              {panel(
                'access',
                <>
                  <SettingRow testId="access-option" title={t('settings.access.title')} help={t('settings.access.help')}>
                    <AccessButton />
                  </SettingRow>
                  <StartPolicyOption />
                  {phoneRows && (
                    <SettingRow testId="add-device-option" title={t('settabs.addDevice.title')} help={t('settabs.addDevice.help')}>
                      {phoneRows.access}
                    </SettingRow>
                  )}
                </>,
              )}
              {panel(
                'security',
                <>
                  <BypassOption />
                  <SettingRow testId="security-open-option" title={t('settabs.securityOpen.title')} help={t('settabs.securityOpen.help')}>
                    <SecurityButton />
                  </SettingRow>
                </>,
              )}
              {panel(
                'advanced',
                <>
                  <AgentRulesOption />
                </>,
              )}
            </div>
          </div>
          <div className={mobile ? HINT_PHONE : HINT} data-testid="settings-hint">
            {shown ? (
              <>
                <span className="shrink-0 text-accent-text">{shown.title}</span>
                <span className="min-w-0 text-text-muted">{shown.help}</span>
              </>
            ) : (
              <span className="text-text-muted">{t(mobile ? 'opts.hintTap' : 'opts.hintKeys')}</span>
            )}
          </div>
        </SettingHintContext.Provider>
      </Modal>
    </>
  );
}
