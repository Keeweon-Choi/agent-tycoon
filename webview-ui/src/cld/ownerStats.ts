/**
 * OWNER-STATS: the owner's steps (tiles its character walked) and the time this page was shown,
 * reported to the daemon at most every OWNER_REPORT_MS (a privileged connection only; the daemon
 * clamps both). The rest of the owner's stats the daemon counts itself.
 */
import { OWNER_REPORT_MS } from '../constants.js';
import { transport } from '../transport/index.js';
import { cldGetSnapshot } from './officeStore.js';

let steps = 0;
let tile: string | null = null;
let shownMs = 0;
let shownSince: number | null = null;
let started = false;

/** Each frame, the owner's tile: a change is a step (a ride to another floor counts one). The
 *  first call starts the reports, which then run for the page's life (also while the phone's
 *  Dock covers the office), each one sent only by a connection that may act. */
export function noteOwnerTile(col: number, row: number): void {
  const key = `${col},${row}`;
  if (tile !== null && key !== tile) steps++;
  tile = key;
  if (!started) startReports();
}

function noteShown(): void {
  const now = performance.now();
  if (shownSince !== null) shownMs += now - shownSince;
  shownSince = document.visibilityState === 'visible' ? now : null;
}

function startReports(): void {
  started = true;
  document.addEventListener('visibilitychange', noteShown);
  noteShown();
  window.setInterval(() => {
    noteShown();
    if (cldGetSnapshot().officeReadOnly) {
      shownMs = steps = 0; // a viewer that may not act counts nothing
      return;
    }
    const seconds = Math.floor(shownMs / 1000);
    if (!seconds && !steps) return;
    shownMs -= seconds * 1000;
    transport.send({ type: 'ownerActivity', steps, seconds });
    steps = 0;
  }, OWNER_REPORT_MS);
}
