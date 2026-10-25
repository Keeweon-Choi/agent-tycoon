import { useEffect, useState } from 'react';

import { Button } from '../components/ui/Button.js';
import { Modal } from '../components/ui/Modal.js';
import { t } from '../i18n/index.js';
import { openLooks } from './characters/looks.js';
import { chatTarget } from './chat.js';
import { useEngineProject } from './engineStore.js';
import { LevelBar } from './ez/Fatigue.js';
import { stateLabel, timeAgo } from './format.js';
import { openMessenger } from './messenger/messengerStore.js';
import { eventIcon, isFeedNoise } from './notify/newsList.js';
import { offDutyFacts, openOffDuty, recentJobs, useOffDutyId } from './offDuty.js';
import { useCldStore, virtualAgentId } from './officeStore.js';
import { jobStatus } from './panels/jobs.js';
import { serverLine } from './serverText.js';
import { useStaff } from './staff.js';

const EVENTS_SHOWN = 5;
/** The "3분 전" times refresh this often while the sheet is open. */
const CLOCK_MS = 30_000;

/** What the office knows about an orchestrator that is home or off (U-10), and the way to its chat (U-27). */
export function OffDutySheet() {
  const id = useOffDutyId();
  const store = useCldStore();
  const staff = useStaff();
  const row =
    id === null
      ? undefined
      : store.officeSnapshot?.orchestrators.find(
          (o) => (o.agentId ?? virtualAgentId(`orch:${o.name}`)) === id,
        );
  const project = useEngineProject(row?.name ?? '');
  const [now, setNow] = useState(() => Date.now());
  const showing = id !== null;
  useEffect(() => {
    if (!showing) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), CLOCK_MS);
    return () => window.clearInterval(timer);
  }, [showing]);
  if (id === null || !row) return null;
  const close = () => openOffDuty(null);
  const facts = offDutyFacts(row, project, !!staff.away[id]);
  const events = store.events.filter((e) => e.name === row.name && !isFeedNoise(e.kind)).slice(0, EVENTS_SHOWN);
  const jobs = recentJobs(store.officeJobs?.jobs, row.name);
  const canChat = !!chatTarget(id, store.officeSnapshot);
  const provider = row.provider ?? (project ? 'engine' : 'claude');
  const field = (label: string, value: string | null) =>
    value ? (
      <>
        <dt className="text-text-muted">{label}</dt>
        <dd className="min-w-0 truncate" title={value}>
          {value}
        </dd>
      </>
    ) : null;
  return (
    <Modal isOpen onClose={close} title={row.name}>
      <div
        className="px-10 pb-8 text-sm space-y-8 w-[min(384px,100%)]"
        data-testid="off-duty-sheet"
        data-agent-id={id}
      >
        <p className="text-text-muted" data-testid="off-duty-state">
          {facts.away ? t('offDuty.away') : t('offDuty.off')} · {stateLabel(row.state, row.busy)}
        </p>
        <dl className="grid grid-cols-[auto_1fr] gap-x-8 gap-y-4 text-xs">
          {field(
            t('offDuty.provider'),
            provider === 'engine' ? t('status.engineBadge') : t('offDuty.claude'),
          )}
          {field(t('offDuty.model'), facts.model)}
          {field(t('offDuty.room'), facts.room)}
          {field(t('offDuty.folder'), facts.folder)}
          {field(t('offDuty.session'), facts.session)}
          {field(t('offDuty.down'), facts.downNote)}
          {field(t('offDuty.trust'), facts.needsTrust ? t('offDuty.trustNeeded') : null)}
        </dl>
        {row.level && <LevelBar level={row.level} />}
        <div>
          <p className="text-text-muted text-xs">{t('status.recent')}</p>
          {events.length ? (
            <ol className="space-y-2 mt-2 text-xs" data-testid="off-duty-events">
              {events.map((event, i) => (
                <li key={`${event.ts}-${i}`} className="flex gap-8 min-w-0">
                  <span aria-hidden="true">{eventIcon(event.kind)}</span>
                  <span className="truncate flex-1 min-w-0">{serverLine(event.summary)}</span>
                  <span className="text-text-muted shrink-0">{timeAgo(event.ts, now)}</span>
                </li>
              ))}
            </ol>
          ) : (
            <p className="text-text-muted text-xs mt-2">{t('status.noneYet')}</p>
          )}
        </div>
        {jobs.length > 0 && (
          <div>
            <p className="text-text-muted text-xs">{t('offDuty.jobs')}</p>
            <ul className="space-y-2 mt-2 text-xs" data-testid="off-duty-jobs">
              {jobs.map((job) => (
                <li key={job.id} className="truncate">
                  {job.label} · {jobStatus(job, now).text}
                </li>
              ))}
            </ul>
          </div>
        )}
        {!store.officeReadOnly && (
          <Button
            variant="ghost"
            size="sm"
            className="text-xs"
            data-testid="off-duty-looks"
            onClick={() => {
              close();
              openLooks(row.name);
            }}
          >
            {t('looks.open')}
          </Button>
        )}
        {canChat && (
          <div className="space-y-4">
            <Button
              variant="accent"
              size="sm"
              className="text-xs"
              data-testid="off-duty-chat"
              onClick={() => {
                close();
                openMessenger(id);
              }}
            >
              {t('offDuty.chat')}
            </Button>
            <p className="text-xs text-text-muted">{t('offDuty.wakeHint')}</p>
          </div>
        )}
      </div>
    </Modal>
  );
}
