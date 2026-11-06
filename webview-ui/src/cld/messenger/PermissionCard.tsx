/**
 * PERM-PROMPT: a lead's session waits on a Claude Code permission dialog. The card says so, names
 * the asking sub-agent and the open call (tool, its description or its command's first line), and
 * offers 허용 / 거부 (privileged; the daemon presses a key only when the dialog on screen is about
 * that call) and 터미널에서 보기. A view-only client sees the card without the buttons.
 * PERM-CARD-FIT: the command sits in a box with its own scroll (a share of the visible height on
 * a phone, keyboard included) and folds behind a toggle (long ones start folded on a phone); the
 * buttons stay sticky at the card's foot so they never scroll away.
 * GAME-UI-1 G1 (ideas/messenger 02): drawn as a quest card (requester, request, reward). Only an answer
 * the daemon confirms (`answered`) gets the stamp (purple 허용함, dim 거부함); the stamped card then folds
 * into a one-line record in the conversation. The buttons are the only way to answer (no keyboard shortcut: a key
 * typed elsewhere must never answer a permission). A question wait (QuestionCard) is the same card; its answer is the composer.
 * MOBILE-QUEST (owner 11-04 19:40): the question card folds to its head line (who waits, on what) and opens again;
 * on a phone 답하기 folds it too, so the composer and the keyboard have the screen. Its request is Markdown, as the bubble.
 */
import { type ReactNode, useEffect, useState } from 'react';

import type { PermissionWait } from '../../../../core/src/messages.js';
import { Button } from '../../components/ui/Button.js';
import { MSG_QUEST_FOLD_MS, MSG_QUEST_HOLD_MS } from '../../constants.js';
import { useIsMobile } from '../../hooks/useIsMobile.js';
import { t } from '../../i18n/index.js';
import { transport } from '../../transport/index.js';
import { employeeName } from '../employees.js';
import { useGameMotion } from '../game/gameMotion.js';
import { PixelIcon, Stamp } from '../game/parts.js';
import { Markdown } from '../markdown.js';
import { useCldStore } from '../officeStore.js';
import { serverLine } from '../serverText.js';
import { AGENT_GUTTER_RIGHT, FACE_GUTTER_LEFT, SenderFace } from './Faces.js';
import type { QuestRecord } from './gameMessenger.js';
import { foldQuest, messengerAnswerPermission, useMessenger } from './messengerStore.js';
import { bubbleClock, useRow } from './parts.js';
import { permissionDetailMaxHeight, permissionStartsFolded } from './permissionFit.js';

/** The card's frame: 퀘스트 · kind, the requester's portrait and title, the request, the reward, the foot. */
function Quest({
  agentId,
  name,
  kind,
  title,
  asker,
  request,
  foot,
  stamped,
  folding,
  stamp,
  testId,
  fold,
}: {
  agentId: number;
  name: string;
  kind: string;
  title: string;
  asker?: string;
  request: ReactNode;
  foot: ReactNode;
  stamped?: boolean;
  folding?: boolean;
  stamp?: ReactNode;
  testId: string;
  /** A card the owner can fold to its head line (who waits, on what) and open again. */
  fold?: { folded: boolean; toggle: () => void };
}) {
  const row = useRow(agentId);
  const { tempStaff } = useCldStore();
  const employee = asker ? tempStaff.find((e) => e.nameId === asker) : undefined;
  const meta = [
    asker ? employeeName({ nameId: asker }) : name,
    row?.level && t('character.level', { level: row.level.level }),
    row && 'tab' in row && row.tab ? serverLine(row.tab) : '',
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <div
      className="quest mb-6 text-xs"
      role="status"
      data-testid={testId}
      data-stamped={stamped || undefined}
      data-folding={folding || undefined}
      data-folded={fold?.folded || undefined}
    >
      <div className="quest-head">
        <PixelIcon name="bell" />
        <span className="quest-kind">{t('game.msg.quest')}</span>
        {kind}
        {fold?.folded && <span className="min-w-0 flex-1 truncate text-text">{title}</span>}
        {fold && (
          <Button
            size="sm"
            variant="ghost"
            className="ml-auto shrink-0"
            aria-expanded={!fold.folded}
            data-testid="quest-fold"
            onClick={fold.toggle}
          >
            {fold.folded ? t('mquest.unfold') : t('mquest.fold')}
          </Button>
        )}
      </div>
      {!fold?.folded && (
        <>
          <div className="quest-who">
            <SenderFace name={name} agentId={employee ? undefined : agentId} employee={employee} portrait />
            <div className="min-w-0">
              <div className="text-sm [overflow-wrap:anywhere]">{title}</div>
              <div className="text-text-muted truncate">{meta}</div>
            </div>
          </div>
          <div className="quest-row">
            <span className="quest-lab">{t('game.msg.request')}</span>
            {request}
          </div>
          <div className="quest-row">
            <span className="quest-lab">{t('game.msg.reward')}</span>
            <span className="flex flex-wrap items-center gap-8 min-w-0">
              <span className="quest-goal" data-testid="quest-goal">
                <PixelIcon name="play" size={12} />
                {t('game.msg.resume')}
              </span>
              <span className="text-text-muted">{t('game.msg.resumeNote', { name })}</span>
            </span>
          </div>
          <div className="quest-foot" data-testid="permission-actions">
            {foot}
          </div>
        </>
      )}
      {stamp}
    </div>
  );
}

export function PermissionCard({
  agentId,
  name,
  card,
  canAnswer,
  openTerminal,
  visualViewportHeight,
}: {
  agentId: number;
  /** The lead's name as the conversation shows it. */
  name: string;
  card: PermissionWait;
  canAnswer: boolean;
  openTerminal: (() => void) | null;
  visualViewportHeight?: number | null;
}) {
  const phone = useIsMobile();
  const motion = useGameMotion();
  // The owner's toggle belongs to one call; a new call starts from the default again.
  const [toggled, setToggled] = useState<{ toolId: string; folded: boolean } | null>(null);
  const folded =
    toggled?.toolId === card.toolId
      ? toggled.folded
      : permissionStartsFolded(card.detail, phone);
  const answer = useMessenger().permissionAnswers[agentId];
  const mine = answer?.toolId === card.toolId ? answer : undefined;
  const busy = !!mine && !mine.result && !mine.error;
  // A folded answer has had its stamp; if the daemon still reports the wait, the card is a plain one again.
  const stamped = mine?.result === 'answered' && !mine.folded;
  const answerable = canAnswer && !!card.toolId && !stamped;
  // FIX-PERM-RESTART: an answer goes only over a live connection (the transport never keeps one for later).
  const [link, setLink] = useState(transport.state);
  useEffect(() => {
    setLink(transport.state);
    return transport.onStateChange(setLink);
  }, []);
  const online = link === 'connected';
  const press = (allow: boolean, optionId?: string) => {
    if (online) messengerAnswerPermission((m) => transport.send(m), agentId, card, allow, optionId);
  };
  const [folding, setFolding] = useState(false);

  // The stamp shows a moment, then the card folds into its record (at once without game motion).
  useEffect(() => {
    if (!stamped) return;
    if (!motion) {
      foldQuest(agentId, card.toolId);
      return;
    }
    const fold = window.setTimeout(() => setFolding(true), MSG_QUEST_HOLD_MS);
    const done = window.setTimeout(() => foldQuest(agentId, card.toolId), MSG_QUEST_HOLD_MS + MSG_QUEST_FOLD_MS);
    return () => {
      window.clearTimeout(fold);
      window.clearTimeout(done);
    };
  }, [stamped, motion, agentId, card.toolId]);

  return (
    <Quest
      agentId={agentId}
      name={name}
      kind={t('game.msg.questPermission')}
      title={t('permPrompt.noticeSub', { name: card.asker ? employeeName({ nameId: card.asker }) : name })}
      asker={card.asker}
      stamped={stamped}
      folding={folding && stamped}
      testId="permission-card"
      request={
        card.tool ? (
          <span className="quest-call" data-testid="permission-call">
            <span className="text-text-muted [overflow-wrap:anywhere]">{card.tool}</span>
            {card.detail && !folded && (
              <span
                className="quest-code text-sm whitespace-pre-wrap [overflow-wrap:anywhere] max-h-256 overflow-y-auto"
                style={{
                  maxHeight: permissionDetailMaxHeight(phone, visualViewportHeight ?? undefined, window.innerHeight),
                }}
                data-testid="permission-detail"
                tabIndex={0}
              >
                {card.detail}
              </span>
            )}
          </span>
        ) : (
          <span className="text-text-muted">{t('permPrompt.unknownCall')}</span>
        )
      }
      stamp={
        stamped && (
          <span className="quest-stamp" data-testid="quest-stamp" data-answer={mine.allow === false ? 'deny' : 'allow'}>
            <Stamp tone={mine.allow === false ? 'muted' : 'accent'} sub={mine.at ? bubbleClock(mine.at) : undefined}>
              {mine.allow === false ? t('game.msg.denied') : t('game.msg.allowed')}
            </Stamp>
            <span className="quest-ink" aria-hidden="true" />
          </span>
        )
      }
      foot={
        <>
          {stamped ? (
            <span className="text-text-muted" data-testid="permission-result">
              {t('game.msg.answeredAt', { time: mine.at ? bubbleClock(mine.at) : '' })}
            </span>
          ) : (
            mine &&
            (busy || mine.error || mine.result !== 'answered') && (
              <span className={`w-full ${mine.error ? 'text-danger' : 'text-text-muted'}`} data-testid="permission-result">
                {busy ? t('permPrompt.sending') : (mine.error ?? t(`permPrompt.result.${mine.result!}`))}
              </span>
            )
          )}
          {answerable && !online && (
            <span className="w-full text-text-muted" data-testid="permission-offline">
              {t('permNotice.offline')}
            </span>
          )}
          {answerable && card.options?.length ? (
            // ACP-1: one button per option the agent offers; its own words are the tooltip.
            card.options.map((o) => {
              const allow = o.kind.startsWith('allow');
              return (
                <Button
                  key={o.optionId}
                  size="sm"
                  variant={o.kind === 'allow_once' ? 'accent' : undefined}
                  disabled={busy || !online}
                  title={o.name}
                  data-testid="permission-option"
                  data-kind={o.kind}
                  onClick={() => press(allow, o.optionId)}
                >
                  {o.kind === 'allow_once' && <PixelIcon name="check" size={12} />}
                  {t(`acp.option.${o.kind}`)}
                </Button>
              );
            })
          ) : (
            answerable && (
              <>
                <Button size="sm" variant="accent" disabled={busy || !online} onClick={() => press(true)}>
                  <PixelIcon name="check" size={12} />
                  {t('permPrompt.allow')}
                </Button>
                <Button size="sm" disabled={busy || !online} onClick={() => press(false)}>
                  {t('permPrompt.deny')}
                </Button>
              </>
            )
          )}
          {card.detail && !stamped && (
            <Button
              size="sm"
              aria-expanded={!folded}
              data-testid="permission-fold"
              onClick={() => setToggled({ toolId: card.toolId, folded: !folded })}
            >
              {folded ? t('permPrompt.expand') : t('permPrompt.collapse')}
            </Button>
          )}
          {openTerminal && !stamped && (
            <Button size="sm" className="ml-auto" onClick={openTerminal}>
              <PixelIcon name="term" size={12} />
              {t('permPrompt.terminal')}
            </Button>
          )}
        </>
      }
    />
  );
}

/** GAME-UI-1 G1 (02): a question wait (WAITING-PERSIST) as the same quest card; 답하기 goes to the composer. */
export function QuestionCard({
  agentId,
  name,
  question,
  onAnswer,
}: {
  agentId: number;
  name: string;
  question: string;
  onAnswer: (() => void) | null;
}) {
  const phone = useIsMobile();
  // The owner's fold belongs to one question; a new one opens unfolded.
  const [fold, setFold] = useState<{ question: string; folded: boolean } | null>(null);
  const folded = fold?.question === question && fold.folded;
  return (
    <Quest
      agentId={agentId}
      name={name}
      kind={t('game.msg.questQuestion')}
      title={t('game.msg.questionTitle', { name })}
      testId="question-card"
      fold={{ folded, toggle: () => setFold({ question, folded: !folded }) }}
      request={
        <div className="quest-call" data-testid="question-request">
          <Markdown text={question} className="text-sm [overflow-wrap:anywhere]" />
        </div>
      }
      foot={
        onAnswer && (
          <Button
            size="sm"
            variant="accent"
            data-testid="question-answer"
            onClick={() => {
              // The phone's card would cover the composer once the keyboard is up: fold it first. The desktop's
              // card sits above the composer and never covers it, so it stays open there to be read while typing.
              if (phone) setFold({ question, folded: true });
              onAnswer();
            }}
          >
            {t('game.msg.answer')}
          </Button>
        )
      }
    />
  );
}

/** GAME-UI-1 G1 (02): an answered quest, folded: the small stamp, what was asked, when, and what follows. */
export function QuestRecordLine({ record }: { record: QuestRecord }) {
  return (
    <div className={`quest-done ${FACE_GUTTER_LEFT} ${AGENT_GUTTER_RIGHT} text-xs`} data-testid="quest-record" data-answer={record.allow ? 'allow' : 'deny'}>
      <span className="quest-mini" data-deny={record.allow ? undefined : ''}>
        {record.allow ? t('game.msg.allowed') : t('game.msg.denied')}
      </span>
      <span className="min-w-0 flex-1 truncate text-text">{record.label}</span>
      <time dateTime={new Date(record.at).toISOString()}>{bubbleClock(record.at)}</time>
      {record.allow && <span className="shrink-0">{t('game.msg.resume')}</span>}
    </div>
  );
}
