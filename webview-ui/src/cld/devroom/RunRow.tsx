/**
 * DV2 개발실 실행 (mockups devroom-plan D1's run row, D2, P2): the picked package.json scripts of the
 * selected worktree as buttons with their state, the 실행 pane (log, 멈추기, the dev server's address
 * to 미리보기) on the right of the agents, a 테스트 run in the bottom drawer, and the phone's 실행 page.
 * Nothing runs until the owner presses; the daemon decides what a button runs (devroomRuns.ts).
 * Logs are read only while a run is on screen, through the job panel's jobAction (jobStore.ts).
 */
import { type ReactNode, useEffect, useRef, useState } from 'react';

import type { OfficeJob, RunPick, RunRole } from '../../../../core/src/messages.js';
import { Button } from '../../components/ui/Button.js';
import { Modal } from '../../components/ui/Modal.js';
import { DEVROOM_RUN_DRAWER_PX, DEVROOM_RUN_LOG_MS } from '../../constants.js';
import { t } from '../../i18n/index.js';
import { transport } from '../../transport/index.js';
import { openExternal } from '../externalLinks.js';
import { Icon } from '../icons/Icon.js';
import { jobRequest, useJobStore } from '../jobStore.js';
import { messengerSend } from '../messenger/messengerStore.js';
import { cldToast, useCldStore } from '../officeStore.js';
import { useCanAct } from '../workbench/workbenchStore.js';
import { BODY, SMALL } from './devroomData.js';
import { pickKey, setDevroomTab, setPreviewUrl } from './devroomStore.js';
import { canPreviewHere, previewAddress } from './previewHost.js';
import { devUrlOf, failMessage, latestRun, ROLE_ORDER, roleLabel, runText, runTone, shortUrl, tailLines } from './runState.js';
import { bindRunWire, closeRun, openRun, requestScripts, startKey, startRun, useRunStore } from './runStore.js';

bindRunWire({
  send: (m) => transport.send(m),
  connected: () => transport.state === 'connected',
  toast: (text, tone) => cldToast('', text, tone),
});

const MONO = 'font-mono text-xs whitespace-pre-wrap break-all';
const DOT: Record<ReturnType<typeof runTone>, string> = {
  none: 'bg-text-muted',
  running: 'bg-devroom-blue',
  failed: 'bg-devroom-bad',
  ok: 'bg-devroom-ok',
  stopped: 'bg-text-muted',
};
const place = (role: RunRole): 'side' | 'drawer' => (role === 'test' ? 'drawer' : 'side');
const sorted = (picks: readonly RunPick[]) => [...picks].sort((a, b) => ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role));

function Dot({ job }: { job: OfficeJob | undefined }) {
  return <i className={`inline-block size-7 shrink-0 rounded-ui-pill ${DOT[runTone(job)]}`} aria-hidden="true" />;
}

const PlayGlyph = () => <Icon name="play" size={14} pixel={<span aria-hidden="true">▷</span>} />;
const StopGlyph = () => <Icon name="square" size={14} pixel={<span aria-hidden="true">■</span>} />;

/** The jobs and this worktree's answer. `task` '' = the project's own folder. */
function useRuns(project: string, task: string) {
  const jobs = useCldStore().officeJobs?.jobs ?? [];
  const { scripts, starting, open } = useRunStore();
  const key = pickKey(project, task);
  useEffect(() => requestScripts(project, task), [project, task]);
  const answer = scripts[key];
  const picks = answer && answer !== 'loading' && answer.ok ? sorted(answer.picks) : [];
  return { jobs, answer, picks, starting, open: open[key] ?? {} };
}

/** A run's log, read while it is on screen (again every few seconds while it runs, once more at its end). */
function useRunLog(job: OfficeJob | undefined): string | undefined {
  const { logs } = useJobStore();
  const id = job?.id ?? null;
  const running = !!job && !job.ended;
  useEffect(() => {
    if (!id) return;
    const read = () => jobRequest((m) => transport.send(m), 'log', id);
    read();
    if (!running) return;
    const timer = window.setInterval(read, DEVROOM_RUN_LOG_MS);
    return () => window.clearInterval(timer);
  }, [id, running]);
  return id ? logs[id]?.text : undefined;
}

/** Who a failed run's lines go to: the worktree's agent, the Lead on the project's own folder. */
function useRunAgent(project: string, task: string, assignee: string | undefined): { name: string; agentId: number } | null {
  const orchs = useCldStore().officeSnapshot?.orchestrators ?? [];
  const name = task ? assignee : project;
  const o = name ? orchs.find((x) => x.name === name && x.agentId != null) : undefined;
  return o && o.agentId != null ? { name: o.name, agentId: o.agentId } : null;
}

/** D1: the row under the tabs. */
export function RunRow({ project, task }: { project: string; task: string }) {
  const canAct = useCanAct();
  const { jobs, answer, picks, starting, open } = useRuns(project, task);
  const { logs } = useJobStore();
  const [picking, setPicking] = useState(false);
  const loaded = answer && answer !== 'loading';
  return (
    <div className={`h-40 shrink-0 flex items-center gap-7 px-14 bg-devroom-foot border-b-ui border-border whitespace-nowrap ${SMALL}`} data-testid="run-row">
      <small className="text-text-muted shrink-0">{t('devroom.run.label')}</small>
      {/* The chips scroll on a narrow window; 고치기 stays in sight. */}
      <div className="flex-1 min-w-0 flex items-center gap-7 overflow-x-auto">
      {!loaded ? (
        <span className="text-text-muted">{t('devroom.run.loading')}</span>
      ) : !answer.ok ? (
        <span className="text-text-muted truncate" data-testid="run-row-error">
          {answer.error}
        </span>
      ) : (
        picks.map((p) => {
          const job = latestRun(jobs, project, task, p.script);
          const running = runTone(job) === 'running';
          const label = roleLabel(p.role, p.script);
          const on = open[place(p.role)] === p.script;
          const url = job?.id ? devUrlOf(logs[job.id]?.text) : null;
          return (
            <Button
              key={p.script}
              size="sm"
              variant={on ? 'active' : 'default'}
              className="shrink-0 gap-7"
              data-testid="run-chip"
              data-script={p.script}
              data-state={p.changed ? 'changed' : runTone(job)}
              title={p.changed ? t('devroom.run.changedTitle') : t('devroom.run.cmd', { script: p.script })}
              disabled={!canAct || !!starting[startKey(project, task, p.script)]}
              onClick={() => {
                if (p.changed) setPicking(true);
                else if (running) openRun(project, task, p.script, place(p.role));
                else startRun(project, task, p.script, place(p.role));
                setDevroomTab('terminal');
              }}
            >
              {running ? <StopGlyph /> : <PlayGlyph />}
              {label}
              <span className="h-14 border-l-ui border-border" aria-hidden="true" />
              {p.changed ? (
                <span className="text-devroom-conf">{t('devroom.run.changed')}</span>
              ) : (
                <span className="flex items-center gap-5">
                  <Dot job={job} />
                  {runText(job, url)}
                </span>
              )}
            </Button>
          );
        })
      )}
      </div>
      {loaded && answer.ok && canAct && (
        <button type="button" className="shrink-0 text-text-muted underline" data-testid="run-pick-open" onClick={() => setPicking(true)}>
          {picks.length ? t('devroom.run.read') : t('devroom.run.pickFirst')}
        </button>
      )}
      {picking && loaded && answer.ok && (
        <RunPicker project={project} task={task} scripts={answer.scripts} picks={answer.picks} onClose={() => setPicking(false)} />
      )}
    </div>
  );
}

/** `package.json 에서 읽었어요 · 고치기`: which scripts become buttons, and what each is for. */
function RunPicker({
  project,
  task,
  scripts,
  picks,
  onClose,
}: {
  project: string;
  task: string;
  scripts: ReadonlyArray<{ name: string; cmd: string }>;
  picks: readonly RunPick[];
  onClose: () => void;
}) {
  const [roles, setRoles] = useState<Record<string, RunRole | ''>>(() => Object.fromEntries(picks.map((p) => [p.script, p.role])));
  const save = () => {
    const next = scripts.flatMap((s) => (roles[s.name] ? [{ script: s.name, role: roles[s.name] as RunRole }] : []));
    requestScripts(project, task, next);
    onClose();
  };
  return (
    <Modal isOpen onClose={onClose} title={t('devroom.run.picker.title')}>
      <div className="flex flex-col gap-8 px-10 pb-10 max-w-[560px]" data-testid="run-picker">
        <p className={`text-text-muted whitespace-normal ${SMALL}`}>{t('devroom.run.picker.note')}</p>
        {scripts.length === 0 && <p className={BODY}>{t('devroom.run.picker.empty')}</p>}
        {scripts.map((s) => (
          <label key={s.name} className="flex items-center gap-8 min-w-0">
            <select
              className={`shrink-0 bg-bg border-ui border-border rounded-ui-card px-4 py-2 ${SMALL}`}
              aria-label={t('devroom.run.picker.roleOf', { script: s.name })}
              data-script={s.name}
              value={roles[s.name] ?? ''}
              onChange={(e) => setRoles({ ...roles, [s.name]: e.target.value as RunRole | '' })}
            >
              <option value="">{t('devroom.run.roleNone')}</option>
              {ROLE_ORDER.map((r) => (
                <option key={r} value={r}>
                  {t(`devroom.run.role.${r}`)}
                </option>
              ))}
            </select>
            <b className={`shrink-0 font-normal ${BODY}`}>{s.name}</b>
            <code className={`min-w-0 truncate text-text-muted ${MONO}`} title={s.cmd}>
              {s.cmd}
            </code>
          </label>
        ))}
        <Button size="md" variant="accent" data-testid="run-pick-save" onClick={save}>
          {t('devroom.run.picker.save')}
        </Button>
      </div>
    </Modal>
  );
}

/** The agents tab's body with the open runs: the 실행 pane on the right, a 테스트 run in the bottom drawer. */
export function RunArea({ project, task, assignee, children }: { project: string; task: string; assignee?: string; children: ReactNode }) {
  const { jobs, picks, open } = useRuns(project, task);
  const side = picks.find((p) => p.script === open.side);
  const drawer = picks.find((p) => p.script === open.drawer);
  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <div className="flex-1 min-h-0 flex">
        <div className="flex-1 min-w-0 min-h-0 flex flex-col">{children}</div>
        {side && (
          <RunPane project={project} task={task} assignee={assignee} pick={side} job={latestRun(jobs, project, task, side.script)} where="side" />
        )}
      </div>
      {drawer && (
        <RunPane project={project} task={task} assignee={assignee} pick={drawer} job={latestRun(jobs, project, task, drawer.script)} where="drawer" />
      )}
    </div>
  );
}

function RunPane({
  project,
  task,
  assignee,
  pick,
  job,
  where,
}: {
  project: string;
  task: string;
  assignee?: string;
  pick: RunPick;
  job: OfficeJob | undefined;
  where: 'side' | 'drawer';
}) {
  const canAct = useCanAct();
  const { stopping } = useJobStore();
  const log = useRunLog(job);
  const agent = useRunAgent(project, task, assignee);
  const pre = useRef<HTMLPreElement>(null);
  const tone = runTone(job);
  const label = roleLabel(pick.role, pick.script);
  const cmd = t('devroom.run.cmd', { script: pick.script });
  const url = devUrlOf(log);
  useEffect(() => {
    if (pre.current) pre.current.scrollTop = pre.current.scrollHeight;
  }, [log]);
  const text = log === undefined ? '' : where === 'drawer' && tone !== 'running' ? tailLines(log) : log;
  return (
    <section
      className={`min-w-0 min-h-0 flex flex-col border-ui border-border rounded-ui-card bg-devroom-card overflow-hidden ${where === 'side' ? 'flex-1 m-4' : 'shrink-0 mx-4 mt-4'}`}
      style={where === 'drawer' ? { height: DEVROOM_RUN_DRAWER_PX } : undefined}
      data-testid={where === 'side' ? 'run-pane' : 'run-drawer'}
      data-script={pick.script}
      data-state={tone}
      data-exit={job?.exit ?? undefined}
    >
      <header className={`h-40 shrink-0 flex items-center gap-8 px-10 border-b-ui border-border ${SMALL}`}>
        {where === 'side' && <PlayGlyph />}
        <b className={`shrink-0 font-normal text-devroom-title ${BODY}`}>
          {label} · {cmd}
        </b>
        <span className="flex items-center gap-5 min-w-0 truncate" data-testid="run-state">
          <Dot job={job} />
          {runText(job, null)}
        </span>
        <span className="flex-1" />
        {tone === 'running' && canAct && job?.id && (
          <Button size="sm" data-testid="run-stop" disabled={!!stopping[job.id]} onClick={() => jobRequest((m) => transport.send(m), 'stop', job.id!)}>
            <StopGlyph />
            {stopping[job.id] ? t('devroom.run.stopping') : t('devroom.run.stop')}
          </Button>
        )}
        {tone !== 'running' && canAct && (
          <Button size="sm" data-testid="run-again" onClick={() => startRun(project, task, pick.script, where)}>
            {t('devroom.run.again')}
          </Button>
        )}
        {tone === 'failed' && canAct && <SendFailed label={label} cmd={cmd} job={job!} log={log} agent={agent} />}
        <Button variant="ghost" size="icon_md" aria-label={t('devroom.run.close')} title={t('devroom.run.close')} onClick={() => closeRun(project, task, where)}>
          <Icon name="x" pixel={<span aria-hidden="true">×</span>} />
        </Button>
      </header>
      <pre ref={pre} className={`flex-1 min-h-0 overflow-auto m-0 px-14 py-8 bg-devroom-term text-text ${MONO}`} data-testid="run-log">
        {text || (job ? t('devroom.run.logEmpty') : '')}
      </pre>
      {url && <AddressOffer project={project} task={task} url={url} />}
    </section>
  );
}

function SendFailed({ label, cmd, job, log, agent }: { label: string; cmd: string; job: OfficeJob; log: string | undefined; agent: { name: string; agentId: number } | null }) {
  if (!agent) return null;
  return (
    <Button
      size="sm"
      data-testid="run-send"
      disabled={log === undefined}
      onClick={() => {
        // Only on this press: a failure is never sent by itself (owner 11-06).
        messengerSend((m) => transport.send(m), transport.state === 'connected', agent.agentId, agent.name, failMessage(label, cmd, job, log ?? ''));
        cldToast(agent.name, t('devroom.run.sent', { name: agent.name }), 'ok');
      }}
    >
      {t('devroom.run.sendTo', { name: agent.name })}
    </Button>
  );
}

/** D2: the run's own loopback address, offered to the 미리보기 (the PreviewTab's rules apply again). */
function AddressOffer({ project, task, url }: { project: string; task: string; url: string }) {
  const ok = previewAddress(url, window.location.port);
  if ('error' in ok) return null;
  return (
    <div className={`h-40 shrink-0 flex items-center gap-7 px-10 border-t-ui border-border bg-devroom-foot ${SMALL}`} data-testid="run-offer" data-url={ok.url}>
      <Icon name="eye" size={14} pixel={<span aria-hidden="true">◉</span>} />
      <span className="min-w-0 truncate">{t('devroom.run.offer', { url: shortUrl(ok.url) })}</span>
      <span className="flex-1" />
      {task && canPreviewHere() && (
        <Button
          size="sm"
          variant="accent"
          data-testid="run-open-preview"
          onClick={() => {
            setPreviewUrl(project, task, ok.url);
            setDevroomTab('preview');
          }}
        >
          {t('devroom.run.openPreview')}
        </Button>
      )}
      {canPreviewHere() && (
        <Button size="sm" onClick={() => openExternal(ok.url)}>
          {t('devroom.run.newWindow')}
        </Button>
      )}
    </div>
  );
}

/** P2: the phone's 실행 page, one card per picked script. */
export function PhoneRuns({ project, task, assignee }: { project: string; task: string; assignee?: string }) {
  const { jobs, answer, picks } = useRuns(project, task);
  const loaded = answer && answer !== 'loading';
  return (
    <div className="flex-1 min-h-0 overflow-y-auto p-12 flex flex-col gap-10" data-testid="run-phone">
      {!loaded ? (
        <p className={`text-text-muted ${BODY}`}>{t('devroom.run.loading')}</p>
      ) : !answer.ok ? (
        <p className={`text-text-muted ${BODY}`}>{answer.error}</p>
      ) : picks.length === 0 ? (
        <p className={`text-text-muted ${BODY}`}>{t('devroom.run.pickFirst')}</p>
      ) : (
        picks.map((p) => <PhoneRunCard key={p.script} project={project} task={task} assignee={assignee} pick={p} job={latestRun(jobs, project, task, p.script)} />)
      )}
      <p className={`text-text-muted ${SMALL}`}>{t('devroom.run.phoneNote')}</p>
    </div>
  );
}

function PhoneRunCard({ project, task, assignee, pick, job }: { project: string; task: string; assignee?: string; pick: RunPick; job: OfficeJob | undefined }) {
  const canAct = useCanAct();
  const { starting } = useRunStore();
  const { stopping } = useJobStore();
  const tone = runTone(job);
  const failed = tone === 'failed';
  // The log is read while this page shows a run that goes on or failed (its lines are shown).
  const log = useRunLog(tone === 'running' || failed ? job : undefined);
  const agent = useRunAgent(project, task, assignee);
  const [asked, setAsked] = useState(false);
  const label = roleLabel(pick.role, pick.script);
  const cmd = t('devroom.run.cmd', { script: pick.script });
  const url = devUrlOf(log);
  return (
    <section
      className={`p-12 border-ui rounded-ui-card flex flex-col gap-8 ${failed ? 'border-devroom-main-line bg-devroom-pick' : 'border-border bg-devroom-card'}`}
      data-testid="run-card"
      data-script={pick.script}
      data-state={pick.changed ? 'changed' : tone}
    >
      <div className="flex items-start gap-10">
        <div className="flex-1 min-w-0 flex flex-col gap-4">
          <b className={`font-normal text-devroom-title ${BODY}`}>{label}</b>
          <code className={`text-text-muted ${MONO}`}>{cmd}</code>
          <span className={`flex items-center gap-6 ${SMALL}`}>
            <Dot job={job} />
            {pick.changed ? t('devroom.run.changed') : runText(job, url)}
          </span>
        </div>
        {canAct && !pick.changed && (
          <Button
            size="icon_md"
            aria-label={tone === 'running' ? t('devroom.run.stop') : t('devroom.run.start', { label })}
            disabled={tone === 'running' ? !!(job?.id && stopping[job.id]) : !!starting[startKey(project, task, pick.script)]}
            onClick={() => (tone === 'running' && job?.id ? jobRequest((m) => transport.send(m), 'stop', job.id) : startRun(project, task, pick.script, place(pick.role)))}
          >
            {tone === 'running' ? <StopGlyph /> : <PlayGlyph />}
          </Button>
        )}
      </div>
      {tone === 'running' && url && task && (
        <p className={`text-text-muted ${SMALL}`}>
          {t('devroom.run.offerPhone')} ·{' '}
          <button
            type="button"
            className="text-accent-text underline"
            onClick={() => {
              transport.send({ type: 'previewAsk', project, task, url });
              setAsked(true);
            }}
          >
            {asked ? t('devroom.run.askedPc') : t('devroom.run.askPc')}
          </button>
        </p>
      )}
      {failed && (
        <>
          <pre className={`m-0 p-10 rounded-ui-card bg-devroom-term overflow-x-auto ${MONO}`} data-testid="run-log">
            {log === undefined ? '' : tailLines(log)}
          </pre>
          {canAct && (
            <div className="flex gap-8">
              <Button size="md" className="flex-1" onClick={() => startRun(project, task, pick.script, place(pick.role))}>
                {t('devroom.run.again')}
              </Button>
              <span className="flex-[2] flex [&>button]:flex-1">
                <SendFailed label={label} cmd={cmd} job={job!} log={log} agent={agent} />
              </span>
            </div>
          )}
        </>
      )}
    </section>
  );
}
