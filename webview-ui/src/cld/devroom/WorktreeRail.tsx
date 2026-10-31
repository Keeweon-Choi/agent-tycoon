/**
 * P4 개발실 (W1b): the left rail. Every git project's task worktrees hang off its trunk (the base
 * branch, the project's Lead), like Orca's worktree list; a filter narrows it to one project.
 * Each card: its assignee's face, its Task's title, the `…` menu, the assignee and a chip. Below:
 * "+ 새 작업 맡기기" (a message to the Lead) and "합쳐진 작업 정리". The data hook and the small
 * pieces (Face, StatusChip, the menu) are shared with the phone's list (DevRoomPhone.tsx).
 */
import { type MouseEvent, useContext, useState } from 'react';

import { CharacterMugShot } from '../../components/CharacterMugShot.js';
import { Button } from '../../components/ui/Button.js';
import { Modal } from '../../components/ui/Modal.js';
import {
  DEVROOM_FACE_PX,
  DEVROOM_MENU_GAP_PX,
  DEVROOM_MENU_H_PX,
  DEVROOM_MENU_W_PX,
} from '../../constants.js';
import { t } from '../../i18n/index.js';
import { transport } from '../../transport/index.js';
import { openExplorer } from '../files/explorerState.js';
import { BranchGlyph } from '../hud/glyphs.js';
import { messengerSend } from '../messenger/messengerStore.js';
import { cldToast, useCldStore } from '../officeStore.js';
import { repoAsk, useRepoStore } from '../repo/repoStore.js';
import { useRepoView } from '../repo/useRepoView.js';
import { useCanAct } from '../workbench/workbenchStore.js';
import { BIG, BODY, DevroomLooks, type Group, type Row, SMALL, TINY } from './devroomData.js';
import { type Chip, shownProject } from './devroomState.js';
import {
  pickKey,
  pickWorktree,
  setDevroomFilter,
  setDevroomTab,
  syncWorktree,
  toggleGroup,
  toggleMenu,
  useDevroom,
} from './devroomStore.js';

/** Watch one project's repository while the dev room shows it. */
// ponytail: one repoView per project until the daemon's devroomView handler (S1) watches them all; then delete.
export function RepoWatch({ project }: { project: string }) {
  useRepoView(project);
  return null;
}

/** An agent's mug shot, or its initial in the same square. */
export function Face({ agentId, name, size = DEVROOM_FACE_PX }: { agentId: number | null; name?: string; size?: number }) {
  const looks = useContext(DevroomLooks);
  const look = agentId !== null && looks ? looks.getAppearance(agentId) : null;
  return (
    <span className="shrink-0 flex items-center justify-center text-text-muted" style={{ width: size, height: size }} aria-hidden="true">
      {look ? <CharacterMugShot palette={look.palette} hueShift={look.hueShift} size={size} /> : [...(name ?? '?')][0]}
    </span>
  );
}

const CHIP_LOOK: Record<Chip, string> = {
  conflict: 'text-devroom-conf border-devroom-conf-line bg-devroom-conf-bg',
  approve: 'text-devroom-conf border-devroom-conf-line bg-devroom-conf-bg',
  review: 'text-devroom-review border-devroom-review-line bg-devroom-review-bg',
  fixing: 'text-devroom-review border-devroom-review-line bg-devroom-review-bg',
  working: 'text-devroom-blue border-devroom-work-line bg-devroom-work-bg',
  idle: 'text-text-muted border-border bg-bg-dark',
  merged: 'text-text-muted border-border bg-devroom-done-bg',
};

export function StatusChip({ row }: { row: Row }) {
  return (
    <span
      className={`inline-flex items-center whitespace-nowrap border-2 px-5 py-1 leading-[1.2] ${TINY} ${CHIP_LOOK[row.chip]}`}
      data-testid="devroom-chip"
      data-chip={row.chip}
    >
      {t(`devroom.chip.${row.chip}`, { count: row.wt.conflicts?.length ?? 0 })}
    </span>
  );
}

/** The `…` menu's four items (탐색기, 따라잡기, 병합, 정리), on the desktop and the phone. */
export function WorktreeMenu({ project, row, base }: { project: string; row: Row; base: string }) {
  const canAct = useCanAct();
  const { busy } = useRepoStore();
  const close = () => toggleMenu(null);
  const item = (
    id: string,
    label: string,
    hint: string,
    run: () => void,
    look = '',
    disabled = false,
  ) => (
    <button
      key={id}
      type="button"
      role="menuitem"
      data-item={id}
      disabled={disabled}
      className={`block w-full text-left px-11 py-7 border-b-2 border-devroom-menu-line last:border-b-0 ${BIG} hover:bg-active-bg disabled:opacity-(--btn-disabled-opacity) ${look}`}
      onClick={() => {
        close();
        run();
      }}
    >
      {label}
      <small className={`block mt-1 text-text-muted ${TINY}`}>{hint}</small>
    </button>
  );
  const task = row.wt.task;
  const writing = busy[project] !== undefined;
  return (
    <div role="menu" aria-label={t('devroom.more', { title: row.title })} data-testid="devroom-menu">
      {item('explorer', t('devroom.menu.explorer'), t('devroom.menu.explorerHint'), () => openExplorer(project, task))}
      {canAct &&
        item('sync', t('devroom.menu.sync'), t('devroom.menu.syncHint', { base }), () => syncWorktree(project, task, (msg) => transport.send(msg), transport.state === 'connected'), '', row.wt.behind === 0)}
      {canAct &&
        item('merge', t('devroom.menu.merge'), t('devroom.menu.mergeHint', { base }), () => {
          pickWorktree(project, task);
          setDevroomTab('merge');
        }, 'bg-active-bg text-white', row.chip === 'merged')}
      {canAct &&
        item('remove', t('devroom.menu.remove'), t('devroom.menu.removeHint'), () => repoAsk({ kind: 'worktreeRemove', project, worktree: row.wt }), 'text-devroom-bad', writing)}
    </div>
  );
}

/** Where the open `…` menu is drawn: under its button, inside the dev room (flipped up near the bottom). */
export interface MenuSpot {
  key: string;
  x: number;
  y: number;
}

function menuSpot(e: MouseEvent<HTMLButtonElement>, key: string): MenuSpot | null {
  const root = e.currentTarget.closest('[data-devroom-root]');
  if (!root) return null;
  const box = root.getBoundingClientRect();
  const b = e.currentTarget.getBoundingClientRect();
  const x = Math.min(b.right - box.left + DEVROOM_MENU_GAP_PX, box.width - DEVROOM_MENU_W_PX);
  const below = b.bottom - box.top;
  const y = below + DEVROOM_MENU_H_PX > box.height ? Math.max(0, b.top - box.top - DEVROOM_MENU_H_PX) : below;
  return { key, x, y };
}

function Card({ group, row, onMenu }: { group: Group; row: Row; onMenu: (spot: MenuSpot | null) => void }) {
  const { picked, menu } = useDevroom();
  const key = pickKey(group.project, row.wt.task);
  const on = picked?.project === group.project && picked.task === row.wt.task;
  const done = row.chip === 'merged';
  return (
    <div
      className={`relative ml-40 mt-8 h-68 px-8 py-6 border-2 flex flex-col justify-center gap-4 cursor-pointer ${on ? 'border-devroom-blue bg-devroom-pick shadow-pixel' : 'border-devroom-card-line bg-devroom-card'} ${done ? 'opacity-55' : ''}`}
      data-testid="devroom-card"
      data-project={group.project}
      data-task={row.wt.task}
      data-picked={on || undefined}
      onClick={() => pickWorktree(group.project, row.wt.task)}
    >
      {/* The branch's connector off the trunk and its square joint. */}
      <span className="absolute -left-26 top-30 w-24 h-4 bg-devroom-trunk" aria-hidden="true" />
      <span className="absolute -left-32 top-26 w-10 h-10 bg-accent-text border-2 border-devroom-rail" aria-hidden="true" />
      <span className="flex items-center gap-6 min-w-0">
        <Face agentId={row.agentId} name={row.wt.assignee} />
        <b className={`flex-1 min-w-0 truncate font-normal text-devroom-title ${SMALL}`} title={row.title}>
          {row.title}
        </b>
        <button
          type="button"
          aria-label={t('devroom.more', { title: row.title })}
          aria-expanded={menu === key}
          data-testid="devroom-more"
          className={`shrink-0 w-24 h-22 grid place-items-center border-2 leading-none ${SMALL} ${menu === key ? 'bg-active-bg border-accent-text text-white' : 'bg-btn-bg border-border'}`}
          onClick={(e) => {
            e.stopPropagation();
            toggleMenu(key);
            onMenu(menu === key ? null : menuSpot(e, key));
          }}
        >
          …
        </button>
      </span>
      <span className={`flex items-center gap-6 min-w-0 text-text-muted ${TINY}`}>
        <span className="truncate">{row.wt.assignee ?? t('devroom.nobody')}</span>
        <StatusChip row={row} />
      </span>
    </div>
  );
}

/** The trunk: the base branch, standing for the project's Lead. */
function Trunk({ group }: { group: Group }) {
  const { picked } = useDevroom();
  const on = picked?.project === group.project && picked.task === null;
  const base = group.repo?.branch ?? 'main';
  return (
    <button
      type="button"
      className={`relative w-full flex items-center gap-6 h-34 pl-30 pr-8 text-left text-devroom-title ${BIG} ${on ? 'outline-2 outline-devroom-blue -outline-offset-2' : ''}`}
      data-testid="devroom-trunk"
      data-project={group.project}
      aria-pressed={on}
      title={t('devroom.lead', { lead: group.project })}
      onClick={() => pickWorktree(group.project, null)}
    >
      <span className="absolute left-5 top-6 w-22 h-22 grid place-items-center bg-devroom-main border-2 border-devroom-main-line text-accent-text" aria-hidden="true">
        <BranchGlyph />
      </span>
      <span className="ml-8 truncate">{base}</span>
      <small className={`ml-auto text-text-muted ${TINY}`}>{t('devroom.base')}</small>
    </button>
  );
}

function ProjectGroup({ group, all, onMenu }: { group: Group; all: boolean; onMenu: (spot: MenuSpot | null) => void }) {
  const { folded } = useDevroom();
  const shut = all && folded[group.project];
  const repo = group.repo;
  return (
    <section data-testid="devroom-group" data-project={group.project} className="mb-12">
      {all && (
        <button
          type="button"
          className={`w-full text-left text-devroom-title ${BODY} py-2`}
          aria-expanded={!shut}
          onClick={() => toggleGroup(group.project)}
        >
          {shut ? '▸' : '▾'} {group.project}
        </button>
      )}
      {!shut && (
        <>
          <p className={`mt-6 mb-6 ml-2 text-accent-text ${SMALL}`}>{t('devroom.graph')}</p>
          {!repo ? (
            <p className={`text-text-muted ${SMALL}`}>{t('devroom.loading')}</p>
          ) : !repo.ok ? (
            <p className={`text-text-muted ${SMALL}`}>{t('devroom.noRepo')}</p>
          ) : (
            <div className="relative pl-2">
              {group.rows.length > 0 && (
                <span className="absolute left-14 top-16 bottom-36 w-4 bg-devroom-trunk" aria-hidden="true" />
              )}
              <Trunk group={group} />
              {group.rows.map((row) => (
                <Card key={row.wt.task} group={group} row={row} onMenu={onMenu} />
              ))}
              {group.rows.length === 0 && (
                <p className={`ml-40 mt-8 text-text-muted ${SMALL}`}>{t('devroom.noWorktrees')}</p>
              )}
            </div>
          )}
        </>
      )}
    </section>
  );
}

/** The filter box: `ᚠ shop-web · 프로젝트`, a list of 모든 프로젝트 and each project. */
export function FilterBox({ projects, className = '' }: { projects: string[]; className?: string }) {
  const { filter } = useDevroom();
  const [open, setOpen] = useState(false);
  const shown = shownProject(projects, filter);
  const pick = (project: string | null) => {
    setDevroomFilter(project);
    setOpen(false);
  };
  return (
    <div className={`relative ${className}`}>
      <button
        type="button"
        aria-label={t('devroom.filter')}
        aria-expanded={open}
        data-testid="devroom-filter"
        className={`w-full flex items-center gap-8 px-9 py-6 border-2 border-devroom-box-line bg-devroom-box text-devroom-title ${BIG}`}
        onClick={() => setOpen(!open)}
      >
        <span className="text-accent-text flex">
          <BranchGlyph />
        </span>
        <span className="truncate">{shown ?? t('devroom.allProjects')}</span>
        <span className={`ml-auto text-text-muted ${TINY}`}>{t('devroom.projectLabel')}</span>
      </button>
      {open && (
        <div role="menu" className="absolute z-10 left-0 right-0 top-full mt-2 bg-devroom-menu border-2 border-devroom-main-line shadow-pixel">
          {[null, ...projects].map((p) => (
            <button
              key={p ?? ''}
              type="button"
              role="menuitemradio"
              aria-checked={p === shown}
              className={`block w-full text-left px-10 py-6 border-b-2 border-devroom-menu-line last:border-b-0 ${BODY} ${p === shown ? 'bg-active-bg' : 'hover:bg-active-bg'}`}
              onClick={() => pick(p)}
            >
              {p ?? t('devroom.allProjects')}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** "+ 새 작업 맡기기": one line to the project's Lead, who picks the Worker and makes the worktree. */
export function NewTaskDialog({ projects, onClose }: { projects: string[]; onClose: () => void }) {
  const { filter } = useDevroom();
  const { officeSnapshot } = useCldStore();
  const [project, setProject] = useState(filter && projects.includes(filter) ? filter : (projects[0] ?? ''));
  const [text, setText] = useState('');
  // The messenger keys its sending bubbles by the Lead's character: a Lead the office does not show is away.
  const lead = officeSnapshot?.orchestrators.find((o) => o.name === project && o.agentId != null);
  const send = () => {
    if (!lead || lead.agentId == null || !text.trim()) return;
    messengerSend(
      (msg) => transport.send(msg),
      transport.state === 'connected',
      lead.agentId,
      lead.name,
      t('devroom.newTask.prompt', { text: text.trim() }),
    );
    cldToast(lead.name, t('devroom.newTask.sent', { lead: lead.name }), 'ok');
    onClose();
  };
  return (
    <Modal isOpen onClose={onClose} title={t('devroom.newTask.title')}>
      <form
        className="flex flex-col gap-8 min-w-0 px-10 pb-10"
        data-testid="devroom-new-task"
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
      >
        <label className="flex flex-col gap-2 text-xs">
          {t('devroom.projectLabel')}
          <select className="bg-bg border-2 border-border px-4 py-2 text-xs" value={project} onChange={(e) => setProject(e.target.value)}>
            {projects.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-2 text-xs">
          {t('devroom.newTask.what')}
          <input
            autoFocus
            className="bg-bg border-2 border-border px-6 py-4 text-xs"
            value={text}
            placeholder={t('devroom.newTask.placeholder')}
            onChange={(e) => setText(e.target.value)}
          />
        </label>
        <p className="text-2xs text-text-muted">
          {lead ? t('devroom.newTask.note', { lead: lead.name }) : t('devroom.newTask.away', { lead: project })}
        </p>
        <Button type="submit" size="md" variant="accent" disabled={!lead || !text.trim()}>
          {t('devroom.newTask.send')}
        </Button>
      </form>
    </Modal>
  );
}

const footButton = `w-full justify-center py-8 px-4 border-2 border-border bg-btn-bg hover:bg-btn-hover shadow-pixel ${BODY}`;

/** The desktop rail: filter, the groups, and the two buttons at its foot. */
export function WorktreeRail({ projects, groups, onMenu }: { projects: string[]; groups: Group[]; onMenu: (spot: MenuSpot | null) => void }) {
  const canAct = useCanAct();
  const { filter, tab } = useDevroom();
  const [asking, setAsking] = useState(false);
  const all = shownProject(projects, filter) === null;
  const merged = groups.reduce((n, g) => n + g.rows.filter((r) => r.chip === 'merged').length, 0);
  return (
    <aside
      className="w-300 shrink-0 flex flex-col min-h-0 p-10 bg-devroom-rail border-r-2 border-border"
      aria-label={t('devroom.graph')}
      data-testid="devroom-rail"
    >
      <FilterBox projects={projects} />
      <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden mt-6">
        {groups.length === 0 && <p className={`text-text-muted ${SMALL}`}>{t('devroom.noProjects')}</p>}
        {groups.map((g) => (
          <ProjectGroup key={g.project} group={g} all={all} onMenu={onMenu} />
        ))}
      </div>
      <div className="mt-auto pt-8 flex flex-col gap-8">
        {canAct && (
          <button type="button" className={footButton} data-testid="devroom-new" onClick={() => setAsking(true)} disabled={projects.length === 0}>
            {t('devroom.newTask')}
          </button>
        )}
        {/* ponytail: the count only; S4's 정리 view asks repoCleanupList for the sizes. */}
        <button
          type="button"
          className={`${footButton} ${tab === 'cleanup' ? 'bg-accent! border-accent' : ''}`}
          data-testid="devroom-cleanup"
          aria-pressed={tab === 'cleanup'}
          onClick={() => setDevroomTab(tab === 'cleanup' ? 'terminal' : 'cleanup')}
        >
          {t('devroom.cleanup', { count: merged })}
        </button>
      </div>
      {asking && <NewTaskDialog projects={projects} onClose={() => setAsking(false)} />}
    </aside>
  );
}
