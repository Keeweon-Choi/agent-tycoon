/**
 * WINMODEL: the phone's Dock is a tab bar (rules: cld/hud/windowModel.ts). This wires it to the
 * tabs' own stores (where each tab's sub-route lives) and to the browser's Back and Forward.
 */
import { useCallback, useEffect } from 'react';

import { closeDevroomPage, devroomGetSnapshot } from '../cld/devroom/devroomStore.js';
import { hudGetSnapshot, pressBack, pressTab, showOffice, useHud } from '../cld/hud/hudStore.js';
import { activeTab, type Tab } from '../cld/hud/windowModel.js';
import { messengerGetSnapshot, showMessengerList } from '../cld/messenger/messengerStore.js';
import { blocksEdgeSwipe, EDGE_TAP_TARGETS, GUARD, landing } from './phoneHistory.js';

/** The tab is on its root: the messenger's list, the 현황판's own tab (오케스트레이터). */
function atRoot(tab: Tab): boolean {
  if (tab === 'messenger') {
    const m = messengerGetSnapshot();
    return m.active === null && m.activeRoom === null;
  }
  if (tab === 'board') return hudGetSnapshot().officeTab === 'status';
  if (tab === 'devroom') return devroomGetSnapshot().page === null;
  return true;
}

function toRoot(tab: Tab | undefined): void {
  if (tab === 'messenger') showMessengerList();
  else if (tab === 'board') showOffice('status');
  else if (tab === 'devroom') closeDevroomPage();
}

function pushGuard(): void {
  try {
    if (landing(history.state) !== 'guard') history.pushState({ [GUARD]: true }, '');
  } catch {
    // A webview without history: Back keeps leaving the page.
  }
}

export function usePhoneTabs(phone: boolean): { tab: Tab; pick: (tab: Tab) => void } {
  const tab = activeTab(useHud());

  // MOBILE-SWIPE: one guard entry on top from load on (phoneHistory.ts has the rules).
  // ponytail: the guard outlives a phone-to-desktop resize, costing the desktop one Back press.
  useEffect(() => {
    if (!phone) return;
    pushGuard();
    const onPop = (e: PopStateEvent) => {
      const at = landing(e.state);
      // An overlay above the guard was popped: it closes itself.
      if (at === 'guard') return;
      // A Forward onto a closed overlay's entry: back down to the guard (nothing pushes meanwhile).
      if (at === 'overlay') {
        history.back();
        return;
      }
      toRoot(pressBack(atRoot(activeTab(hudGetSnapshot()))));
      pushGuard();
    };
    const onTouch = (e: TouchEvent) => {
      const touch = e.touches.length === 1 ? e.touches[0] : undefined;
      if (!touch || !e.cancelable) return;
      const onTap = e.target instanceof Element && e.target.closest(EDGE_TAP_TARGETS) !== null;
      if (blocksEdgeSwipe(touch.clientX, window.innerWidth, onTap)) e.preventDefault();
    };
    window.addEventListener('popstate', onPop);
    document.addEventListener('touchstart', onTouch, { capture: true, passive: false });
    return () => {
      window.removeEventListener('popstate', onPop);
      document.removeEventListener('touchstart', onTouch, { capture: true });
    };
  }, [phone]);

  const pick = useCallback((next: Tab) => toRoot(pressTab(next)), []);
  return { tab, pick };
}
