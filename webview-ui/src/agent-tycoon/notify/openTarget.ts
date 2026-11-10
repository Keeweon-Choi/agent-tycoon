/**
 * T-0043 (10-22 01:3x): a notice's click opens where it came from — a lead's
 * conversation in the messenger, a job card or a Codex run in the 현황판's 실행 tab, or the
 * character. The same for the toast, the bell's list and a Web Push's url.
 */
import type { NoticeTarget } from '../../../../core/src/agent-tycoon/notices.js';
import { openSecurity } from '../auth/securityOpen.js';
import { openPreview } from '../devroom/devroomStore.js';
import { openJobs } from '../game/openJobs.js';
import { openMessenger, showRoomById } from '../messenger/messengerStore.js';
import { agtyGetSnapshot, virtualAgentId } from '../officeStore.js';
import { openWorkbench, setWorkbenchTab } from '../workbench/workbenchStore.js';

export const FOCUS_MS = 4_000;
const FIND_TRIES = 20;

export interface OpenDeps {
  /** False when the character could not be followed yet (held out of sight while the page settles). */
  goToAgent: (agentId: number) => boolean;
  officeHas: (agentId: number) => boolean;
}

/** The character of lead `name` (an engine project or Claude session), or null. */
function leadId(name: string): number | null {
  const office = agtyGetSnapshot().officeSnapshot;
  const orch = office?.orchestrators.find((o) => o.name === name);
  return orch ? (orch.agentId ?? virtualAgentId(`orch:${orch.name}`)) : null;
}

/** Scroll card `id` of the 작업실's job list or Codex runs into view and mark it for a moment (once it is drawn). */
function reveal(panel: 'job' | 'codex', id: string, tries = FIND_TRIES): void {
  if (typeof document === 'undefined') return;
  const el = document.querySelector<HTMLElement>(`[data-${panel}-ref="${CSS.escape(id)}"]`);
  if (!el) {
    // T-0047 folds old jobs per project, UI-C1 old Codex runs: open the fold that holds it.
    const fold = [...document.querySelectorAll<HTMLButtonElement>(`[data-${panel}-refs]`)].find(
      (b) =>
        b.getAttribute('aria-expanded') !== 'true' &&
        b.dataset[`${panel}Refs`]?.split(' ').includes(id),
    );
    fold?.click();
    if (tries > 0) window.setTimeout(() => reveal(panel, id, tries - 1), 100);
    return;
  }
  el.scrollIntoView({ block: 'center' });
  el.dataset.focused = 'true';
  window.setTimeout(() => delete el.dataset.focused, FOCUS_MS);
}

/** Open `t`; false while what it names is not there yet (the office still loading). */
export function openTarget(t: NoticeTarget, deps: OpenDeps): boolean {
  const snap = agtyGetSnapshot();
  switch (t.open) {
    case 'office':
      return true;
    case 'security':
      return openSecurity();
    case 'preview':
      openPreview(t.project, t.task, t.url);
      return true;
    case 'workbench':
      setWorkbenchTab('tasks');
      openWorkbench(t.project);
      return true;
    case 'agent':
      if (!deps.officeHas(t.agentId)) return false;
      return deps.goToAgent(t.agentId);
    case 'chat': {
      const id = snap.officeSnapshot?.chat ? leadId(t.lead) : null;
      if (id === null) return false;
      openMessenger(id, { terminal: t.terminal === true, at: t.at, id: t.id });
      return true;
    }
    case 'room':
      return showRoomById(t.room);
    case 'job':
    case 'codex': {
      if (!(t.open === 'job' ? snap.officeJobs : snap.codexTasks)) return false;
      // The 실행 tab on every project, so the run is in the list whatever was filtered before.
      openJobs();
      if (t.id) reveal(t.open, t.id);
      return true;
    }
  }
}
