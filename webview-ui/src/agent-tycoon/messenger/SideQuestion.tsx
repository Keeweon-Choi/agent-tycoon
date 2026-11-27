/**
 * T-115 사이드 질문 (variant B): the drawer on the right of a Lead's conversation (a bottom sheet on a
 * phone). Its own input and model picker; each answer is a card marked as a side answer with the model
 * that answered, 리드에게 전달 and 닫기 (a failure: 다시 시도 and 닫기). The store is sideQuestionStore.ts.
 */
import { type KeyboardEvent, useEffect, useRef, useState } from 'react';

import { Button } from '../../components/ui/Button.js';
import { SIDE_QUESTION_MAX } from '../../constants.js';
import { t } from '../../i18n/index.js';
import { transport } from '../../transport/index.js';
import { Icon } from '../icons/Icon.js';
import { modelBadge } from '../modelBadges.js';
import { ModelBadge } from '../TempList.js';
import { clock } from './parts.js';
import {
  sideAsk,
  sideAsking,
  type SideCard,
  sideClose,
  sideDismiss,
  sideForward,
  sideModel,
  sideModelName,
  sidePickModel,
  sideRetry,
  useSideQuestion,
} from './sideQuestionStore.js';

const glyph = (name: string) => (
  <span className="material-symbols-sharp text-[16px]" aria-hidden="true">
    {name}
  </span>
);
const ForkIcon = () => <Icon name="git-branch" size={16} pixel={glyph('call_split')} />;

function ModelChip({ value }: { value: string }) {
  const badge = modelBadge(value);
  return (
    <span
      className="sideq-chip inline-flex items-center gap-4 px-6 text-2xs"
      data-testid="side-model"
    >
      {badge && <ModelBadge badge={badge} />}
      {sideModelName(value)}
    </span>
  );
}

function Card({
  card,
  agentId,
  name,
  canForward,
}: {
  card: SideCard;
  agentId: number;
  name: string;
  canForward: boolean;
}) {
  const send = (m: Parameters<typeof transport.send>[0]) => transport.send(m);
  return (
    <>
      <p className="sideq-q self-end max-w-[85%] px-10 py-6 text-sm whitespace-pre-wrap break-words">
        {card.question}
      </p>
      <article
        className="sideq-card flex flex-col gap-6 px-10 py-8 text-sm"
        data-state={card.state}
        data-testid="side-card"
        aria-busy={card.state === 'asking' || undefined}
      >
        <header className="flex flex-wrap items-center gap-6 text-2xs">
          <span
            className={`flex items-center gap-4 font-(--ui-weight-strong) ${card.state === 'failed' ? 'text-danger' : 'text-accent-text'}`}
          >
            {card.state === 'failed' ? (
              <Icon name="triangle-alert" size={14} pixel={glyph('warning')} />
            ) : (
              <ForkIcon />
            )}
            {card.state === 'failed' ? t('sideq.answerFailed') : t('sideq.answer')}
          </span>
          {card.state !== 'failed' && <ModelChip value={card.model} />}
          {card.state === 'answered' && (
            <span className="text-text-muted tabular-nums">{clock(card.at)}</span>
          )}
        </header>
        {card.state === 'asking' && (
          <p role="status" className="text-text-muted">
            <span className="sideq-dots" aria-hidden="true" /> {t('sideq.asking', { name })}
          </p>
        )}
        {card.state === 'answered' && (
          <>
            <p className="whitespace-pre-wrap break-words" data-testid="side-answer">
              {card.text}
            </p>
            <p className="flex items-center gap-4 text-2xs text-text-muted">
              <ForkIcon />
              {t('sideq.note', { name })}
            </p>
            <span className="flex gap-8">
              <Button
                size="sm"
                variant={card.forwarded || !canForward ? 'disabled' : 'accent'}
                disabled={card.forwarded || !canForward}
                onClick={() =>
                  sideForward(send, transport.state === 'connected', agentId, name, card.id)
                }
              >
                <Icon name="arrow-up-right" size={16} pixel={glyph('forward')} />
                {card.forwarded ? t('sideq.forwarded') : t('sideq.forward')}
              </Button>
              <Button size="sm" onClick={() => sideDismiss(agentId, card.id)}>
                {t('sideq.dismiss')}
              </Button>
            </span>
          </>
        )}
        {card.state === 'failed' && (
          <>
            <strong className="text-base">{t('sideq.failedTitle')}</strong>
            <p role="alert" className="text-text-muted">
              {card.error}
            </p>
            <span className="flex gap-8">
              <Button size="sm" variant="accent" onClick={() => sideRetry(send, agentId, card.id)}>
                <Icon name="rotate-ccw" size={16} pixel={glyph('refresh')} />
                {t('sideq.retry')}
              </Button>
              <Button size="sm" onClick={() => sideDismiss(agentId, card.id)}>
                {t('sideq.dismiss')}
              </Button>
            </span>
          </>
        )}
      </article>
    </>
  );
}

export function SideQuestion({
  agentId,
  name,
  phone,
  working,
  canForward,
}: {
  agentId: number;
  name: string;
  phone: boolean;
  working: boolean;
  canForward: boolean;
}) {
  const s = useSideQuestion();
  const cards = s.cards[agentId] ?? [];
  const asking = sideAsking(agentId, s);
  const [text, setText] = useState('');
  const list = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  const model = sideModel(s);
  const models = s.models.some((m) => m.value === model)
    ? s.models
    : [{ value: model, displayName: sideModelName(model) }, ...s.models];
  const lastState = cards.at(-1)?.state;
  useEffect(() => {
    list.current?.scrollTo({ top: list.current.scrollHeight });
  }, [cards.length, lastState]);
  useEffect(() => box.current?.focus(), []);
  const ask = () => {
    if (sideAsk((m) => transport.send(m), agentId, text)) setText('');
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      ask();
    }
  };
  return (
    <aside
      role="complementary"
      aria-label={t('sideq.title')}
      data-testid="side-question"
      className={`sideq flex flex-col min-h-0 ${phone ? 'sideq-sheet absolute inset-x-0 bottom-0 h-[88%] z-30' : 'sideq-side w-360 shrink-0'}`}
    >
      {phone && <span className="sideq-handle self-center mt-6" aria-hidden="true" />}
      <header className="msg-head shrink-0 flex items-center gap-10 px-12 py-8">
        <span className="text-accent-text">
          <ForkIcon />
        </span>
        <span className="flex-1 min-w-0 flex flex-col">
          <strong className="text-base truncate">{t('sideq.title')}</strong>
          <span className="text-2xs text-text-muted truncate">{t('sideq.subtitle', { name })}</span>
        </span>
        <Button size="icon_md" aria-label={t('sideq.close')} onClick={() => sideClose((m) => transport.send(m), agentId)}>
          <Icon name="x" size={16} pixel={glyph('close')} />
        </Button>
      </header>
      <p
        className="sideq-band shrink-0 flex items-center gap-6 px-12 py-6 text-2xs"
        data-working={working || undefined}
      >
        <span className="sideq-band-dot" aria-hidden="true" />
        {working ? t('sideq.working', { name }) : t('sideq.idle', { name })}
      </p>
      <label className="shrink-0 flex items-center gap-8 px-12 py-8 text-xs text-text-muted border-b-ui border-devroom-card-line">
        <span className="flex-1 whitespace-nowrap">{t('sideq.model')}</span>
        {modelBadge(model) && <ModelBadge badge={modelBadge(model)!} />}
        <select
          className="ui-input px-6 py-4 text-xs text-text max-w-[60%]"
          value={model}
          onChange={(e) => sidePickModel(e.target.value)}
          data-testid="side-model-picker"
        >
          {models.map((m) => (
            <option key={m.value} value={m.value}>
              {m.displayName}
            </option>
          ))}
        </select>
      </label>
      <div
        ref={list}
        className="flex-1 min-h-0 overflow-y-auto px-12 py-10 flex flex-col gap-10"
        aria-label={t('sideq.cards')}
      >
        {!cards.length && <p className="text-xs text-text-muted">{t('sideq.empty', { name })}</p>}
        {cards.map((card) => (
          <Card key={card.id} card={card} agentId={agentId} name={name} canForward={canForward} />
        ))}
      </div>
      <form
        className="shrink-0 px-12 pt-6 pb-10"
        onSubmit={(e) => {
          e.preventDefault();
          ask();
        }}
      >
        <div className="msg-composer flex flex-col">
          <textarea
            ref={box}
            rows={phone ? 1 : 2}
            aria-label={t('sideq.input')}
            className="block w-full px-10 pt-8 pb-4 text-sm resize-none placeholder:text-text-muted pointer-coarse:min-h-44"
            placeholder={
              cards.length ? t('sideq.placeholder') : t('sideq.placeholderFirst', { name })
            }
            value={text}
            maxLength={SIDE_QUESTION_MAX}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKey}
          />
          <span className="flex justify-end px-8 pb-8">
            <Button
              type="submit"
              size="sm"
              variant={asking || !text.trim() ? 'disabled' : 'accent'}
              disabled={asking || !text.trim()}
            >
              <ForkIcon />
              {t('sideq.ask')}
            </Button>
          </span>
        </div>
        {!phone && <p className="pt-4 text-2xs text-text-muted">{t('sideq.hint', { name })}</p>}
      </form>
    </aside>
  );
}
