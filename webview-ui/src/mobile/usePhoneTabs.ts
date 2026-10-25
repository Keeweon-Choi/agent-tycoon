/**
 * WINMODEL: the phone's Dock is a tab bar (rules: cld/hud/windowModel.ts). This wires it to the
 * tabs' own stores (where each tab's sub-route lives) and to the browser's Back.
 */
import { useCallback, useEffect } from 'react';

import { hudGetSnapshot, pressBack, pressTab, showOffice, useHud } from '../cld/hud/hudStore.js';
import { activeTab, type Tab } from '../cld/hud/windowModel.js';
import {
  messengerGetSnapshot,
  showMessengerList,
  useMessenger,
} from '../cld/messenger/messengerStore.js';
import { WORKBENCH_TABS } from '../cld/workbench/workbench.js';
import {
  setWorkbenchTab,
  useWorkbench,
  workbenchGetSnapshot,
} from '../cld/workbench/workbenchStore.js';

/** The tab is on its root: the messenger's list, the 작업실's first tab, the 현황판's own tab. */
function atRoot(tab: Tab): boolean {
  if (tab === 'messenger') {
    const m = messengerGetSnapshot();
    return m.active === null && m.activeRoom === null;
  }
  if (tab === 'workbench') return workbenchGetSnapshot().tab === WORKBENCH_TABS[0];
  if (tab === 'board') return hudGetSnapshot().officeTab === 'status';
  return true;
}

function toRoot(tab: Tab | undefined): void {
  if (tab === 'messenger') showMessengerList();
  else if (tab === 'workbench') setWorkbenchTab(WORKBENCH_TABS[0]);
  else if (tab === 'board') showOffice('status');
}

/** The history entry that holds one Back press for us while the phone is away from home. */
const GUARD = 'cldTab';

const isAway = (tab: Tab): boolean => tab !== 'office' || !atRoot(tab);

function pushGuard(): void {
  try {
    if ((history.state as Record<string, unknown> | null)?.[GUARD] !== true)
      history.pushState({ [GUARD]: true }, '');
  } catch {
    // A webview without history: Back keeps leaving the page.
  }
}

export function usePhoneTabs(phone: boolean): { tab: Tab; pick: (tab: Tab) => void } {
  const tab = activeTab(useHud());
  // Re-render on the sub-routes too: whether Back has a step to take inside the tab.
  useMessenger();
  useWorkbench();
  const away = isAway(tab);

  // Away from home, one entry of ours sits on top: Back pops it and we take one step. Landing on
  // it means an overlay above it (an attachment, the board's full view) was popped: not ours.
  // ponytail: reaching home without Back leaves the entry, costing one Back press that does
  // nothing; taking it back (history.back()) raced the next push before (owner 10-24).
  useEffect(() => {
    if (phone && away) pushGuard();
  }, [phone, away]);
  useEffect(() => {
    if (!phone) return;
    const onPop = (e: PopStateEvent) => {
      if ((e.state as Record<string, unknown> | null)?.[GUARD] === true) return;
      toRoot(pressBack(atRoot(activeTab(hudGetSnapshot()))));
      if (isAway(activeTab(hudGetSnapshot()))) pushGuard(); // a step inside the tab: still away
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [phone]);

  const pick = useCallback((next: Tab) => toRoot(pressTab(next)), []);
  return { tab, pick };
}
