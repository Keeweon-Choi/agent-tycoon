/**
 * The phone's Dock (owner 10-24), a tab bar (WINMODEL): the floating icons' screens plus
 * 사무실 (home), in one fixed row under the agent cards and outside the sliding track, so no
 * page covers it and it never slides. The rules are windowModel.ts; usePhoneTabs runs them.
 */
import { type ReactNode, useEffect, useRef } from 'react';

import { t } from '../../i18n/index.js';
import { useUnreadTotal } from '../messenger/messengerStore.js';
import { unreadCount, useNotices } from '../notify/notices.js';
import { panelAvailable, useAgtyStore } from '../officeStore.js';
import {
  BellGlyph,
  BoardGlyph,
  BubbleGlyph,
  CommandGlyph,
  FolderGlyph,
  HomeGlyph,
  TerminalGlyph,
} from './glyphs.js';
import { Badge } from './HudIcons.js';
import type { Tab } from './windowModel.js';

interface Item {
  screen: Tab;
  /** The HUD icon it stands for (runners and the desktop share the id). */
  hudId?: string;
  name: string;
  /** FIX-PHONE-UI-TEXT: the word under the icon (short: the full name can be two lines in English). */
  label: string;
  ariaLabel?: string;
  badge?: number;
  badgeTestId?: string;
  glyph: ReactNode;
}

export function MobileDock({
  active,
  onPick,
  terminalWaiting,
}: {
  active: Tab;
  onPick: (screen: Tab) => void;
  /** Terminals waiting on the user (permission or a question). */
  terminalWaiting: number;
}) {
  const store = useAgtyStore();
  const messages = useUnreadTotal();
  const notices = unreadCount(useNotices().items);
  const nav = useRef<HTMLElement>(null);
  // UI-DASH: seven tabs fit from 360 px at 44 px each (7x44 + 6x4 gaps + 2x4 sides = 340), none cut
  // at the edge. A wider set would scroll sideways: the current page's button stays in view.
  useEffect(() => {
    nav.current
      ?.querySelector('[aria-current="page"]')
      ?.scrollIntoView({ inline: 'nearest', block: 'nearest' });
  }, [active]);
  const items: Item[] = [
    { screen: 'office', name: t('dock.office'), label: t('phoneText.dock.office'), glyph: <HomeGlyph /> },
    { screen: 'board', hudId: 'office', name: t('hud.office'), label: t('phoneText.dock.board'), glyph: <BoardGlyph /> },
    ...(store.officeSnapshot?.chat
      ? [
          {
            screen: 'messenger',
            hudId: 'messenger',
            name: t('hud.messenger'),
            label: t('phoneText.dock.messenger'),
            ariaLabel: messages ? t('hud.unreadMessages', { count: messages }) : undefined,
            badge: messages,
            badgeTestId: 'messenger-unread',
            glyph: <BubbleGlyph />,
          } satisfies Item,
        ]
      : []),
    { screen: 'files', hudId: 'files', name: t('hud.files'), label: t('phoneText.dock.files'), glyph: <FolderGlyph /> },
    {
      screen: 'notices',
      hudId: 'notices',
      name: t('hud.notices'),
      label: t('phoneText.dock.notices'),
      ariaLabel: notices ? t('hud.unreadNotices', { count: notices }) : undefined,
      badge: notices,
      badgeTestId: 'notice-unread',
      glyph: <BellGlyph />,
    },
    { screen: 'devroom', hudId: 'devroom', name: t('hud.devroom'), label: t('phoneText.dock.devroom'), glyph: <CommandGlyph /> },
    ...(panelAvailable('terminal', store)
      ? [
          {
            screen: 'terminal',
            hudId: 'terminal',
            name: t('hud.terminal'),
            label: t('phoneText.dock.terminal'),
            ariaLabel: terminalWaiting
              ? t('hud.waitingTerminals', { count: terminalWaiting })
              : undefined,
            badge: terminalWaiting,
            badgeTestId: 'terminal-waiting',
            glyph: <TerminalGlyph />,
          } satisfies Item,
        ]
      : []),
  ];
  return (
    <nav
      ref={nav}
      aria-label={t('dock.label')}
      data-testid="mobile-dock"
      className="flex gap-4 overflow-x-auto overscroll-x-contain [scrollbar-width:none] border-t-ui border-border pt-6 pl-[calc(var(--agty-safe-left)+4px)] pr-[calc(var(--agty-safe-right)+4px)]"
    >
      {items.map((item) => {
        const on = item.screen === active;
        return (
          // The wrapper carries the HUD icon's id: `[data-hud-id="icon:…"] button` finds it on both shells.
          <span
            key={item.screen}
            className="flex flex-1 min-w-44"
            data-hud-id={item.hudId && `icon:${item.hudId}`}
          >
            <button
              type="button"
              data-dock={item.screen}
              data-testid={item.screen === 'notices' ? 'notice-bell' : undefined}
              aria-label={item.ariaLabel ?? item.name}
              aria-current={on ? 'page' : undefined}
              title={item.name}
              className={`relative flex-1 min-w-44 min-h-44 py-4 flex flex-col items-center justify-center gap-3 rounded-ui-card border-ui ui-raise ${on ? 'ui-on text-accent-text bg-active-bg' : 'border-border bg-btn-bg text-text-muted'}`}
              onClick={() => onPick(item.screen)}
            >
              {item.glyph}
              <span className="max-w-full truncate px-2 text-2xs leading-none">{item.label}</span>
              <Badge count={item.badge ?? 0} testId={item.badgeTestId} />
            </button>
          </span>
        );
      })}
    </nav>
  );
}
