/**
 * P4 개발실 on the phone (mockups-1101/devroom-W5, left): the worktrees stacked full width on a
 * 4 px trunk rail. A tap shows a card's 터미널 / 변경 / 병합 / 미리보기; each opens a full-screen sub-page
 * with ‹ 뒤로. `합쳐진 작업 정리` at the bottom opens S4's view the same way.
 */
import type { AgentAppearance, TabStatus } from '../../components/AgentCard.js';
import { DEVROOM_PHONE_FACE_PX } from '../../constants.js';
import { t } from '../../i18n/index.js';
import { timeAgo } from '../format.js';
import { BranchGlyph } from '../hud/glyphs.js';
import { closeWindow } from '../hud/hudStore.js';
import { ChangesTab } from './ChangesTab.js';
import { TerminalSlot } from './DevRoom.js';
import {
  BIG,
  BODY,
  DevroomLooks,
  type Group,
  type Row,
  SMALL,
  TINY,
  useCurrentPick,
  useDevroomGroups,
  useDevroomView,
} from './devroomData.js';
import { shownProject } from './devroomState.js';
import {
  closeDevroomPage,
  type DevroomTab,
  expandCard,
  openDevroomPage,
  pickKey,
  toggleMenu,
  useDevroom,
} from './devroomStore.js';
import { MergeTab } from './MergeTab.js';
import { PreviewTab } from './PreviewTab.js';
import { Face, FilterBox, RepoWatch, StatusChip, WorktreeMenu } from './WorktreeRail.js';

const PAGES: readonly Exclude<DevroomTab, 'cleanup'>[] = ['terminal', 'changes', 'merge', 'preview'];
const button = `flex-1 min-h-44 border-2 shadow-pixel justify-center ${BIG}`;

function PhoneCard({ group, row }: { group: Group; row: Row }) {
  const { expanded, menu, tab } = useDevroom();
  const key = pickKey(group.project, row.wt.task);
  const open = expanded === key;
  return (
    <div
      className={`mx-12 my-8 px-10 py-9 border-2 ${open ? 'border-devroom-blue bg-devroom-pick shadow-pixel' : 'border-devroom-card-line bg-devroom-card'} ${row.chip === 'merged' ? 'opacity-55' : ''}`}
      data-testid="devroom-card"
      data-project={group.project}
      data-task={row.wt.task}
      data-open={open || undefined}
    >
      <div className="flex items-center gap-8 min-w-0" onClick={() => expandCard(key)}>
        <Face agentId={row.agentId} name={row.wt.assignee} size={DEVROOM_PHONE_FACE_PX} />
        <b className={`flex-1 min-w-0 truncate font-normal text-devroom-title ${BIG}`}>{row.title}</b>
        <button
          type="button"
          aria-label={t('devroom.more', { title: row.title })}
          aria-expanded={menu === key}
          data-testid="devroom-more"
          className={`shrink-0 w-24 h-22 grid place-items-center border-2 leading-none ${SMALL} ${menu === key || open ? 'bg-active-bg border-accent-text' : 'bg-btn-bg border-border'}`}
          onClick={(e) => {
            e.stopPropagation();
            toggleMenu(key);
          }}
        >
          …
        </button>
      </div>
      <div className={`mt-4 flex items-center gap-6 text-text-muted ${TINY}`} onClick={() => expandCard(key)}>
        <span className="truncate">{row.wt.assignee ?? t('devroom.nobody')}</span>
        <StatusChip row={row} />
      </div>
      {menu === key && (
        <div className="mt-8 bg-devroom-menu border-2 border-devroom-main-line">
          <WorktreeMenu project={group.project} row={row} base={row.wt.base} />
        </div>
      )}
      {open && (
        <div className="mt-9 grid grid-cols-4 gap-6">
          {PAGES.map((page) => (
            <button
              key={page}
              type="button"
              data-page={page}
              className={`${button} ${page === tab ? 'bg-accent border-accent text-white' : 'bg-btn-bg border-border'}`}
              onClick={() => openDevroomPage(group.project, row.wt.task, page)}
            >
              {t(`devroom.tab.${page}`)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function PhoneGroup({ group }: { group: Group }) {
  const base = group.repo?.branch ?? 'main';
  const open = group.rows.filter((r) => r.chip !== 'merged').length;
  const last = group.repo?.merges?.[0]?.at;
  return (
    <section data-testid="devroom-group" data-project={group.project}>
      <p className={`px-16 pt-8 pb-4 text-text-muted ${SMALL}`}>{t('devroom.phone.count', { base, count: open })}</p>
      {!group.repo ? (
        <p className={`px-16 text-text-muted ${SMALL}`}>{t('devroom.loading')}</p>
      ) : !group.repo.ok ? (
        <p className={`px-16 text-text-muted ${SMALL}`}>{t('devroom.noRepo')}</p>
      ) : (
        <div className="relative">
          <span className="absolute left-4 top-0 bottom-0 w-4 bg-devroom-trunk" aria-hidden="true" />
          <button
            type="button"
            className={`mx-12 my-8 w-[calc(100%-24px)] flex items-center gap-8 px-10 py-8 border-2 border-devroom-main-line bg-devroom-main text-devroom-title text-left ${BIG}`}
            data-testid="devroom-trunk"
            data-project={group.project}
            onClick={() => openDevroomPage(group.project, null, 'terminal')}
          >
            <span className="text-accent-text flex">
              <BranchGlyph />
            </span>
            <span className="truncate">{base}</span>
            <small className={`ml-auto text-text-muted ${TINY}`}>
              {last ? t('devroom.baseSince', { time: timeAgo(last) }) : t('devroom.base')}
            </small>
          </button>
          {group.rows.map((row) => (
            <PhoneCard key={row.wt.task} group={group} row={row} />
          ))}
          {group.rows.length === 0 && <p className={`px-16 py-8 text-text-muted ${SMALL}`}>{t('devroom.noWorktrees')}</p>}
        </div>
      )}
    </section>
  );
}

function Header({ title, onBack }: { title: string; onBack: () => void }) {
  return (
    <div className="shrink-0 h-46 flex items-center gap-8 px-8 bg-bg-dark border-b-2 border-border">
      <button type="button" className={`shrink-0 px-9 py-5 border-2 border-border bg-btn-bg shadow-pixel min-h-36 ${SMALL}`} onClick={onBack} data-testid="devroom-back">
        {t('devroom.back')}
      </button>
      <span className={`min-w-0 truncate text-text-muted ${BIG}`}>{title}</span>
    </div>
  );
}

export function DevRoomPhone({
  onScreen,
  getAppearance,
  statusFor,
}: {
  onScreen: boolean;
  getAppearance: (agentId: number) => AgentAppearance;
  statusFor: (agentId: number) => TabStatus | null;
}) {
  return (
    <DevroomLooks.Provider value={{ getAppearance, statusFor }}>
      <PhoneBody onScreen={onScreen} />
    </DevroomLooks.Provider>
  );
}

function PhoneBody({ onScreen }: { onScreen: boolean }) {
  useDevroomView(onScreen);
  const { projects, groups } = useDevroomGroups();
  const { filter, page } = useDevroom();
  const name = shownProject(projects, filter) ?? t('devroom.allProjects');
  const merged = groups.reduce((n, g) => n + g.rows.filter((r) => r.chip === 'merged').length, 0);
  const pick = useCurrentPick(groups);
  return (
    <div className="flex-1 min-h-0 flex flex-col" data-testid="devroom-phone">
      {groups.map((g) => (
        <RepoWatch key={g.project} project={g.project} />
      ))}
      {page !== null && pick ? (
        <>
          <Header title={`${pick.task ?? pick.project} · ${t(`devroom.tab.${page}`)}`} onBack={closeDevroomPage} />
          <div className="flex-1 min-h-0 flex flex-col" data-testid="devroom-page" data-page={page}>
            {page === 'changes' && pick.task ? (
              <ChangesTab project={pick.project} task={pick.task} />
            ) : page === 'merge' && pick.task ? (
              <MergeTab project={pick.project} task={pick.task} view="merge" phone />
            ) : page === 'preview' && pick.task ? (
              <PreviewTab project={pick.project} task={pick.task} phone />
            ) : page === 'cleanup' ? (
              <MergeTab project={pick.project} task={pick.task} view="cleanup" />
            ) : (
              <TerminalSlot />
            )}
          </div>
        </>
      ) : (
        <>
          <Header title={t('devroom.phone.title', { name })} onBack={() => closeWindow('devroom')} />
          <div className="flex-1 min-h-0 overflow-y-auto pb-12">
            {projects.length > 1 && <FilterBox projects={projects} className="mx-12 mt-8" />}
            {groups.length === 0 && <p className={`p-16 text-text-muted ${BODY}`}>{t('devroom.noProjects')}</p>}
            {groups.map((g) => (
              <PhoneGroup key={g.project} group={g} />
            ))}
            {pick && (
              <button
                type="button"
                className={`mx-12 mt-12 w-[calc(100%-24px)] py-12 border-2 border-border bg-btn-bg shadow-pixel ${BIG}`}
                data-testid="devroom-cleanup"
                onClick={() => openDevroomPage(pick.project, pick.task, 'cleanup')}
              >
                {t('devroom.cleanup', { count: merged })}
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
