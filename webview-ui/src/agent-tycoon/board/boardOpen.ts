/**
 * building-a-1104 (owner 11-04 20:28): the lobby board's full view, opened on a page from outside
 * it (the billboard's H/W and GPU pages, the HUD's heat gauge: the board's H/W reads better than
 * the 현황판's old HW tab, which is gone). LobbyBoard listens while it is mounted; with no board
 * (the editor), the 현황판 opens instead.
 */
import { showOffice } from '../hud/hudStore.js';
import type { BoardPage } from './board.js';

let handler: ((page: BoardPage) => void) | null = null;

/** LobbyBoard's own: open the full view on `page`. Returns the unsubscribe. */
export function onOpenBoard(fn: (page: BoardPage) => void): () => void {
  handler = fn;
  return () => {
    if (handler === fn) handler = null;
  };
}

/** Open the full board on `page` (its H/W or GPU screen, its projects). */
export function openBoard(page: BoardPage): void {
  if (handler) handler(page);
  else showOffice('status');
}
