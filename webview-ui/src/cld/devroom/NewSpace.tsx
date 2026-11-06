/**
 * DV4: M1 새 워크트리 (the sheet the rail's `+` opens) and M2 앉히기 (the agent tray at the rail's
 * foot: drag a chip onto a worktree card; on a phone, hold it and pick the worktree). Both send
 * one worktreeNew with `seat` (seatStore.ts); the daemon does the rest through the engine's paths.
 */
import { useState } from 'react';

import { Button } from '../../components/ui/Button.js';
import { Modal } from '../../components/ui/Modal.js';
import { t } from '../../i18n/index.js';
import { transport } from '../../transport/index.js';
import { capsOf } from '../engine.js';
import { useEngineStore } from '../engineStore.js';
import { openWindow } from '../hud/hudStore.js';
import { Icon } from '../icons/Icon.js';
import { useLongPress } from '../messenger/Line.js';
import { useCldStore } from '../officeStore.js';
import { resultToast } from '../repo/repoText.js';
import { AddWorker } from '../workbench/AgentActions.js';
import { BODY, type Group, SMALL, TINY } from './devroomData.js';
import { baseChoices, folderOf, type SeatAgent, seatAgents, taskOf, titleFor } from './devroomState.js';
import { answered, seatNow, seatOn, seatSend, setSeatUi, useSeatUi } from './seatStore.js';
import { Face } from './WorktreeRail.js';

const field = `w-full bg-bg border-ui border-border rounded-ui-card px-10 py-6 ${BODY}`;
const label = `flex flex-col gap-5 ${BODY}`;

/** The project's Workers with their state (`here`: the card being seated, not "another"). */
function useSeatAgents(group: Group | undefined, here: string | null = null): SeatAgent[] {
  const state = useEngineStore().state;
  const { officeSnapshot } = useCldStore();
  if (!group) return [];
  return seatAgents(
    group.project,
    state?.projects ?? [],
    officeSnapshot?.orchestrators ?? [],
    group.rows.map((r) => r.wt),
    (p) => capsOf(state, p),
    here,
  );
}

const stateText = (a: SeatAgent) =>
  `${t(`devroom.newSpace.state.${a.state}`)}${a.elsewhere ? t('devroom.newSpace.elsewhere') : ''}`;

/** M1: 기준 브랜치, 새 브랜치 이름, 이슈 연결, 폴더, 에이전트 앉히기, 첫 지시. */
export function NewSpaceSheet({ group, onClose }: { group: Group; onClose: () => void }) {
  const { taskBoard } = useCldStore();
  const project = group.project;
  const bases = baseChoices(group.repo?.branch ?? undefined, group.rows.map((r) => r.wt));
  const issues = (taskBoard?.tasks ?? []).filter(
    (x) => x.project === project && x.status !== 'done' && !group.rows.some((r) => r.wt.taskId === x.id),
  );
  const agents = useSeatAgents(group);
  const [base, setBase] = useState(bases[0]);
  const [branch, setBranch] = useState('');
  const [issue, setIssue] = useState('');
  const [who, setWho] = useState('');
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const chosen = agents.find((a) => a.name === who);
  const make = () => {
    const name = branch.trim();
    setConfirm(false);
    setError(null);
    const issueTask = issues.find((x) => x.id === issue);
    const ok = seatSend(
      (m) => transport.send(m),
      transport.state === 'connected',
      {
        project,
        branch: name,
        base,
        seat: true,
        ...(issueTask ? { taskId: issueTask.id } : { title: titleFor(text, name) }),
        ...(who && { assignee: who }),
        ...(text.trim() && { text: text.trim() }),
      },
      (msg) => {
        setSending(false);
        if (!msg.ok) return setError(resultToast(msg).text);
        answered(project, msg, taskOf(name), who || null);
        onClose();
      },
    );
    if (ok) setSending(true);
    else setError(t('messenger.error.disconnectedSend'));
  };
  return (
    <>
      <div className="absolute inset-0 z-30 bg-bg/60" aria-hidden="true" onClick={onClose} />
      <section
        className="absolute z-40 top-10 bottom-10 left-310 w-532 max-w-[calc(100%-320px)] flex flex-col bg-devroom-box border-ui border-devroom-box-line rounded-ui-win shadow-pixel"
        role="dialog"
        aria-label={t('devroom.newSpace.title')}
        data-testid="newspace-sheet"
        onKeyDown={(e) => {
          if (e.key === 'Escape') onClose();
        }}
      >
        <header className="h-54 shrink-0 flex items-center gap-9 px-16 border-b-ui border-devroom-card-line">
          <span className="text-accent-text flex">
            <Icon name="plus" pixel="+" />
          </span>
          <h2 className={`font-(--ui-weight-strong) ${BODY}`}>{t('devroom.newSpace.title')}</h2>
          <Button size="icon_md" variant="ghost" className="ml-auto" aria-label={t('devroom.newSpace.cancel')} onClick={onClose}>
            <Icon name="x" pixel="×" />
          </Button>
        </header>
        <form
          className="flex-1 min-h-0 overflow-y-auto flex flex-col gap-12 px-16 py-15"
          onSubmit={(e) => {
            e.preventDefault();
            if (!branch.trim() || sending) return;
            if (chosen?.restarts) setConfirm(true);
            else make();
          }}
        >
          <label className={label}>
            {t('devroom.newSpace.base')}
            <select className={field} value={base} data-testid="newspace-base" onChange={(e) => setBase(e.target.value)}>
              {bases.map((b) => (
                <option key={b} value={b}>
                  {b}
                </option>
              ))}
            </select>
          </label>
          <label className={label}>
            {t('devroom.newSpace.branch')}
            <input
              className={`${field} font-mono`}
              value={branch}
              autoFocus
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              placeholder={t('devroom.newSpace.branchPlaceholder')}
              data-testid="newspace-branch"
              aria-invalid={!!error || undefined}
              onChange={(e) => {
                setBranch(e.target.value);
                setError(null);
              }}
            />
            <span className={`text-text-muted ${SMALL}`}>{t('devroom.newSpace.branchHelp')}</span>
          </label>
          <label className={label}>
            <span>
              {t('devroom.newSpace.issue')} <span className={`text-text-muted ${SMALL}`}>{t('devroom.newSpace.optional')}</span>
            </span>
            <select className={field} value={issue} data-testid="newspace-issue" onChange={(e) => setIssue(e.target.value)}>
              <option value="">{t('devroom.newSpace.noIssue')}</option>
              {issues.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.id} {x.title}
                </option>
              ))}
            </select>
          </label>
          <div className={label}>
            {t('devroom.newSpace.folder')}
            <code className={`px-9 py-7 bg-bg-dark rounded-ui-card text-accent-text break-all ${SMALL}`} data-testid="newspace-folder">
              {folderOf(branch || t('devroom.newSpace.branchPlaceholder'))}
            </code>
          </div>
          <fieldset className={label}>
            <legend className="mb-5">
              {t('devroom.newSpace.agents')} <span className={`text-text-muted ${SMALL}`}>{t('devroom.newSpace.agentsHint')}</span>
            </legend>
            <div className="border-ui border-devroom-card-line rounded-ui-card overflow-hidden">
              {[null, ...agents].map((a) => (
                <label
                  key={a?.name ?? ''}
                  className="flex items-center gap-8 min-h-44 px-9 border-b-ui border-devroom-card-line cursor-pointer"
                  data-testid="newspace-agent"
                  data-agent={a?.name}
                >
                  <input type="radio" name="newspace-agent" className="accent-accent" checked={who === (a?.name ?? '')} onChange={() => setWho(a?.name ?? '')} />
                  {a && <Face agentId={null} name={a.name} />}
                  <span className="min-w-0 flex-1">
                    <b className="block font-(--ui-weight-strong) truncate">{a?.name ?? t('devroom.newSpace.nobody')}</b>
                    {a && <span className={`block text-text-muted ${SMALL}`}>{stateText(a)}</span>}
                  </span>
                </label>
              ))}
              <div className="flex items-center min-h-44 px-9">
                <AddWorker project={group.project} label={t('devroom.newSpace.newAgent')} className={`text-accent-text hover:underline ${BODY}`} />
              </div>
            </div>
          </fieldset>
          <label className={label}>
            {t('devroom.newSpace.first')}
            <textarea
              className={`${field} h-61 resize-y`}
              value={text}
              placeholder={t('devroom.newSpace.firstPlaceholder')}
              data-testid="newspace-text"
              disabled={!who}
              onChange={(e) => setText(e.target.value)}
            />
          </label>
          {error && (
            <p role="alert" className={`text-devroom-bad break-words ${SMALL}`} data-testid="newspace-error">
              {error}
            </p>
          )}
          <div className="mt-auto flex items-center gap-7">
            <Button type="submit" size="md" variant="accent" disabled={!branch.trim() || sending} data-testid="newspace-make">
              {sending ? t('devroom.newSpace.making') : t('devroom.newSpace.make')}
            </Button>
            <Button type="button" size="md" onClick={onClose}>
              {t('devroom.newSpace.cancel')}
            </Button>
            <span className={`ml-4 text-text-muted ${SMALL}`}>{t('devroom.newSpace.note')}</span>
          </div>
        </form>
      </section>
      {confirm && chosen && <RestartAsk agent={chosen} onYes={make} onNo={() => setConfirm(false)} />}
    </>
  );
}

/** A busy or running agent is asked about once: it restarts to sit in the new worktree. */
function RestartAsk({ agent, onYes, onNo }: { agent: SeatAgent; onYes: () => void; onNo: () => void }) {
  return (
    <Modal isOpen onClose={onNo} title={t('devroom.newSpace.restartTitle', { name: agent.name })} zIndex={70}>
      <div className={`px-10 pb-10 flex flex-col gap-8 w-[min(420px,calc(100vw-48px))] ${BODY}`} role="alertdialog" data-testid="newspace-restart">
        <p>{t('devroom.newSpace.restart', { name: agent.name })}</p>
        {agent.state === 'busy' && <p className="text-devroom-conf">{t('devroom.newSpace.restartBusy')}</p>}
        <div className="flex justify-end gap-8">
          <Button size="sm" variant="accent" data-testid="newspace-restart-yes" onClick={onYes}>
            {t('devroom.newSpace.restartYes')}
          </Button>
          <Button size="sm" onClick={onNo} autoFocus>
            {t('devroom.newSpace.cancel')}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

/** One agent chip: dragged on a desktop, held on a phone (then the work-space sheet). */
function Chip({ agent }: { agent: SeatAgent }) {
  const hold = useLongPress(() => setSeatUi({ picking: agent.name }));
  return (
    <button
      type="button"
      draggable
      data-press-through
      data-testid="seat-chip"
      data-agent={agent.name}
      title={stateText(agent)}
      className={`inline-flex items-center gap-5 px-7 h-28 max-w-full bg-btn-bg border-ui border-border rounded-ui-card cursor-grab touch-manipulation ${SMALL}`}
      onDragStart={(e) => {
        e.dataTransfer.setData('text/plain', agent.name);
        e.dataTransfer.effectAllowed = 'move';
        setSeatUi({ dragging: agent });
      }}
      onDragEnd={() => setSeatUi({ dragging: null })}
      onClick={() => setSeatUi({ picking: agent.name })}
      {...hold}
    >
      <Face agentId={null} name={agent.name} size={18} />
      <span className="truncate">{agent.name}</span>
    </button>
  );
}

/** M2's tray: `에이전트 · 관리`, the chips, the drop hint while one is dragged, the question and the pick sheet. */
export function AgentTray({ group }: { group: Group | undefined }) {
  const agents = useSeatAgents(group);
  const { dragging, asking, picking } = useSeatUi();
  if (!group) return null;
  const picked = agents.find((a) => a.name === picking);
  const cards = group.rows.filter((r) => r.chip !== 'merged');
  return (
    <div className="pt-8 border-t-ui border-devroom-card-line" data-testid="seat-tray">
      {dragging && (
        <p className={`mb-6 px-9 py-6 bg-devroom-box border-ui border-devroom-accent-line rounded-ui-card ${SMALL}`} data-testid="seat-hint">
          {t('devroom.newSpace.dropHint')}
        </p>
      )}
      <div className={`flex items-center px-4 mb-6 text-text-muted ${SMALL}`}>
        <span>{t('devroom.newSpace.tray')}</span>
        <button type="button" className="ml-auto hover:text-text" onClick={() => openWindow('office')}>
          {t('devroom.newSpace.manage')}
        </button>
      </div>
      <div className="flex flex-wrap gap-6">
        {agents.map((a) => (
          <Chip key={a.name} agent={a} />
        ))}
        {agents.length === 0 && <span className={`text-text-muted ${TINY}`}>{t('devroom.newSpace.noAgents')}</span>}
      </div>
      {asking && (
        <RestartAsk agent={asking.agent} onYes={() => seatNow((m) => transport.send(m), transport.state === 'connected', asking)} onNo={() => setSeatUi({ asking: null })} />
      )}
      {picked && (
        <Modal isOpen onClose={() => setSeatUi({ picking: null })} title={t('devroom.newSpace.pickTitle', { name: picked.name })} zIndex={65}>
          <div className={`px-10 pb-10 flex flex-col gap-6 w-[min(420px,calc(100vw-48px))] ${BODY}`} data-testid="seat-pick">
            <p className={`text-text-muted ${SMALL}`}>{stateText(picked)}</p>
            {cards.map((r) => (
              <Button key={r.wt.task} size="md" className="justify-start! min-w-0" disabled={r.wt.assignee === picked.name} onClick={() => seatOn((m) => transport.send(m), transport.state === 'connected', group, r, picked)}>
                <span className="truncate">
                  {r.title} · {r.wt.branch}
                </span>
              </Button>
            ))}
            {cards.length === 0 && <p className="text-text-muted">{t('devroom.newSpace.noSpaces')}</p>}
          </div>
        </Modal>
      )}
    </div>
  );
}
