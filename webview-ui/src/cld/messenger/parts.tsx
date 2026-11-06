/** Shared messenger presentation atoms. */
/* eslint-disable react-refresh/only-export-components */
import type { ChatSearchHit, MessengerContact, OfficeOrchestrator } from '../../../../core/src/messages.js';
import type { AgentAppearance, TabStatus } from '../../components/AgentCard.js';
import { CharacterMugShot } from '../../components/CharacterMugShot.js';
import { Button } from '../../components/ui/Button.js';
import { t } from '../../i18n/index.js';
import { transport } from '../../transport/index.js';
import { presenceOf } from '../officeHours.js';
import { useCldStore, virtualAgentId } from '../officeStore.js';
import { serverLine } from '../serverText.js';
import { useStaff } from '../staff.js';
import type { AttachmentChip } from './attachments.js';
import type { LeadState } from './messengerStore.js';
import { leadPresence, leadState, messengerPin, useMessenger } from './messengerStore.js';

export const MUG_PX = 32;
export const NO_CHIPS: AttachmentChip[] = [];
let requestSeq = 0;
export const nextRequestId = () => `history-${++requestSeq}`;

export interface MessengerProps {
  mobile: boolean;
  /** The visual viewport height on a phone; changes while its keyboard animates. */
  visualViewportHeight?: number | null;
  /** The terminal drawer's per-agent activity (working / attention / idle). */
  statusFor: (agentId: number) => TabStatus | null;
  getAppearance: (agentId: number) => AgentAppearance;
}

/** The officeState row of a lead (an engine project or Claude session). */
export function useRow(agentId: number): OfficeOrchestrator | undefined {
  const { officeSnapshot: officeState } = useCldStore();
  return officeState?.orchestrators.find(
    (o) => (o.agentId ?? virtualAgentId(`orch:${o.name}`)) === agentId,
  );
}

/** Who the last message in the list is from, when not the boss's own words. */
export function senderLabel(c: Pick<MessengerContact, 'lastKind' | 'lastFrom' | 'lastFromName'>): string {
  if (c.lastKind !== 'user') return '';
  if (c.lastFrom === 'peer')
    return c.lastFromName
      ? t('messenger.sender.otherName', { name: serverLine(c.lastFromName) })
      : t('messenger.sender.other');
  return c.lastFrom === 'system' ? t('messenger.sender.system') : t('messenger.sender.me');
}

/** "14:05" today, "10-21" before. */
export function clock(at: number): string {
  const d = new Date(at);
  const pad = (n: number) => String(n).padStart(2, '0');
  return d.toDateString() === new Date().toDateString()
    ? `${pad(d.getHours())}:${pad(d.getMinutes())}`
    : `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** A bubble's time (user 10-22 13:53): "14:05" today, "10-21 14:05" before. */
export function bubbleClock(at: number): string {
  const d = new Date(at);
  const pad = (n: number) => String(n).padStart(2, '0');
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return d.toDateString() === new Date().toDateString()
    ? hm
    : `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${hm}`;
}

/** FEAT-MESSENGER-GPT-LOOK: the timeline's day pill: "오늘 (금)", else "11월 5일 (목)". */
export function dayLabel(at: number): string {
  const d = new Date(at);
  const weekday = t('messengerLook.weekdays').split(',')[d.getDay()] ?? '';
  return d.toDateString() === new Date().toDateString()
    ? t('messengerLook.today', { weekday })
    : t('messengerLook.day', { month: d.getMonth() + 1, day: d.getDate(), weekday });
}

/** Whether line `index` opens a new day (the first dated line does): the pill goes over it. */
export function newDay(items: readonly { at: number }[], index: number): boolean {
  const at = items[index]?.at ?? 0;
  if (at <= 0) return false;
  for (let i = index - 1; i >= 0; i--)
    if (items[i].at > 0) return new Date(items[i].at).toDateString() !== new Date(at).toDateString();
  return true;
}

export function sessionClock(at: number): string {
  const d = new Date(at);
  return t('messenger.sessionClock', {
    month: d.getMonth() + 1,
    day: d.getDate(),
    time: `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`,
  });
}

export function SearchHitRow({
  hit,
  query,
  onClick,
}: {
  hit: ChatSearchHit;
  query: string;
  onClick: () => void;
}) {
  const index = hit.snippet.toLocaleLowerCase().indexOf(query.toLocaleLowerCase());
  return (
    <li>
      <button
        type="button"
        className="block w-full text-left border-b-ui border-border px-4 py-6 text-xs"
        onClick={onClick}
      >
        <span className="block text-2xs text-text-muted">
          {sessionClock(hit.at)}{' '}
          {hit.sender && <strong>{hit.sender} </strong>}
          {hit.session && (
            <span className="border border-border px-4">{t('messenger.previousSession')}</span>
          )}
        </span>
        <span className="block break-words">
          {index < 0 ? (
            hit.snippet
          ) : (
            <>
              {hit.snippet.slice(0, index)}
              <mark className="bg-search-match text-search-match-text px-px">
                {hit.snippet.slice(index, index + query.length)}
              </mark>
              {hit.snippet.slice(index + query.length)}
            </>
          )}
        </span>
      </button>
    </li>
  );
}

export function Mug({
  agentId,
  getAppearance,
}: {
  agentId: number;
  getAppearance: MessengerProps['getAppearance'];
}) {
  const a = getAppearance(agentId);
  return (
    <span className="shrink-0 border-ui rounded-ui-card border-devroom-card-line bg-(--surface-card)">
      <CharacterMugShot palette={a.palette} hueShift={a.hueShift} size={MUG_PX} />
    </span>
  );
}

export const DOT: Record<LeadState, string> = {
  working: 'bg-status-active',
  thinking: 'bg-accent-bright',
  waiting: 'bg-status-permission',
  resting: 'bg-status-success',
  off: 'bg-border',
};

export function StateDot({
  agentId,
  statusFor,
  withLabel,
}: {
  agentId: number;
  statusFor: MessengerProps['statusFor'];
  withLabel?: boolean;
}) {
  const held = useMessenger().contacts.find((x) => x.agentId === agentId)?.held === true;
  const presence = presenceOf(useStaff(), agentId);
  const { dot: s, word } = leadPresence(
    presence,
    leadState(useRow(agentId), statusFor(agentId), held),
  );
  return (
    <span className="shrink-0 flex items-center gap-4" title={word}>
      <span
        className={`inline-block w-8 h-8 ${DOT[s]}`}
        data-testid="lead-state"
        data-state={s}
        data-presence={presence ?? undefined}
      />
      {withLabel ? (
        <span className="text-2xs text-text-muted">{word}</span>
      ) : (
        <span className="sr-only">{word}</span>
      )}
    </span>
  );
}

/** MSG-SPLIT: a pane's × in its conversation header. */
export function PaneClose({ onClose }: { onClose: () => void }) {
  return (
    <Button
      size="icon_md"
      variant="ghost"
      aria-label={t('msgSplit.closePane')}
      title={t('msgSplit.closePane')}
      data-testid="split-pane-close"
      onClick={onClose}
    >
      ×
    </Button>
  );
}

/** U-30: the 즐겨찾기 toggle of one conversation row; a read-only client only sees the star. */
export function PinButton({
  id,
  pinned,
  readOnly,
  className,
}: {
  id: string;
  pinned: boolean;
  readOnly: boolean;
  className: string;
}) {
  if (readOnly && !pinned) return null;
  return (
    <Button
      size="icon_md"
      variant="ghost"
      className={`self-center mx-2 ${pinned ? 'text-accent-text!' : ''} ${className}`}
      aria-label={t(pinned ? 'messenger.unpin' : 'messenger.pin')}
      aria-pressed={pinned}
      title={t(pinned ? 'messenger.unpin' : 'messenger.pin')}
      disabled={readOnly}
      onClick={() => messengerPin((msg) => transport.send(msg), id, !pinned)}
    >
      {pinned ? '★' : '☆'}
    </Button>
  );
}
