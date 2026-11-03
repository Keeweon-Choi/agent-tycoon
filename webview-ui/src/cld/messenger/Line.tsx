/** Messenger message lines and bubble actions. */
/* eslint-disable react-refresh/only-export-components */
import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent, ReactNode } from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import type { ChatItem, ChatReply } from '../../../../core/src/messages.js';
import { MESSAGE_ACTIONS_LONG_PRESS_MS } from '../../constants.js';
import { t } from '../../i18n/index.js';
import { writeClipboardText } from '../../terminal/clipboard.js';
import { withinTapSlop } from '../../touch/touchPrimitives.js';
import { Markdown } from '../markdown.js';
import { cldOwnToast, ezContext, useCldStore } from '../officeStore.js';
import { serverLine } from '../serverText.js';
import { ATTACHMENT_ACTION_ERROR_DURATION, ATTACHMENT_ACTION_SUCCESS_DURATION } from './attachmentActions.js';
import { useAttachmentTarget, useOpenAttachment } from './attachmentGallery.js';
import { splitAttachmentText } from './attachments.js';
import { BubbleAttachments, sentFiles } from './BubbleAttachments.js';
import { FACE_COLUMN, FACE_GAP, FACE_GUTTER_LEFT, FACE_GUTTER_RIGHT, OwnerFace, SenderFace } from './Faces.js';
import { foldBubble } from './longMessage.js';
import { copyText, replyChipText, replyDraft, replyIdOf, replySenderOf } from './messageActions.js';
import { bubbleClock } from './parts.js';
import type { PeekView } from './quotePeek.js';
import { noticeEmployee, noticeName, shellDone } from './senderFace.js';
import { toolLineLabel } from './toolLine.js';

// ── MSG-ACTIONS: 복사 and 답글 on every bubble ──────────────────────

/** 복사: the clipboard module's one write, its outcome as a short toast (why, when it fails). */
export function copyMessage(text: string): void {
  void writeClipboardText(text).then((ok) =>
    cldOwnToast(
      t('messenger.title'),
      ok ? t('messenger.copied') : t('messenger.copyFailed'),
      ok ? 'ok' : 'error',
      ok ? ATTACHMENT_ACTION_SUCCESS_DURATION : ATTACHMENT_ACTION_ERROR_DURATION,
    ),
  );
}

/** What a bubble offers: its copy text, and 답글 when the conversation can reply. */
export interface BubbleActions {
  copy: string;
  reply?: () => void;
}

/** A phone's hold on a bubble: one finger, still (the app's one tap slop), for
 *  MESSAGE_ACTIONS_LONG_PRESS_MS. A scroll cancels it (pointercancel or a move); links,
 *  buttons, images and fields keep their own touch. The click a fired hold ends with is eaten. */
/** F2: a gesture belongs to the innermost bubble (a room member's reply sits inside the post's):
 *  its press claims the native event on the way up, and the outer ones skip it. */
const claimed = new WeakSet<Event>();

export function useLongPress(fire: () => void) {
  const timer = useRef<number | undefined>(undefined);
  const origin = useRef<{ x: number; y: number } | null>(null);
  const fired = useRef(false);
  const cancel = () => {
    window.clearTimeout(timer.current);
    origin.current = null;
  };
  useEffect(() => () => window.clearTimeout(timer.current), []);
  return {
    onPointerDown: (e: ReactPointerEvent<HTMLElement>) => {
      fired.current = false;
      if (e.pointerType !== 'touch') return;
      const target = e.target as Element;
      if (target.closest('a,img,video,input,textarea,button:not([data-press-through])')) return;
      if (claimed.has(e.nativeEvent)) return;
      claimed.add(e.nativeEvent);
      origin.current = { x: e.clientX, y: e.clientY };
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => {
        origin.current = null;
        fired.current = true;
        fire();
      }, MESSAGE_ACTIONS_LONG_PRESS_MS);
    },
    onPointerMove: (e: ReactPointerEvent<HTMLElement>) => {
      const o = origin.current;
      if (o && !withinTapSlop(e.clientX - o.x, e.clientY - o.y)) cancel();
    },
    onPointerUp: cancel,
    onPointerCancel: cancel,
    onClickCapture: (e: ReactMouseEvent) => {
      if (!fired.current) return;
      fired.current = false;
      e.preventDefault();
      e.stopPropagation();
    },
  };
}

/** Desktop: 복사 · 답글 beside the time, shown on hover or keyboard focus (a phone holds instead). */
export function ActionRow({
  actions,
  post = false,
  before = false,
}: {
  actions: BubbleActions;
  post?: boolean;
  /** MSG-ALIGN: left of the time (the boss's side), so the time stays on the bubble's right edge. */
  before?: boolean;
}) {
  return (
    <span
      className={`${before ? 'mr-6' : 'ml-6'} inline-flex gap-6 opacity-0 ${post ? 'group-hover/post:opacity-100' : 'group-hover/msg:opacity-100'} focus-within:opacity-100 pointer-coarse:hidden`}
      role="group"
      aria-label={t('messenger.messageActions')}
      data-testid="message-actions"
    >
      <button
        type="button"
        className="underline text-accent-text"
        onClick={() => copyMessage(actions.copy)}
      >
        {t('messenger.copy')}
      </button>
      {actions.reply && (
        <button type="button" className="underline text-accent-text" onClick={actions.reply}>
          {t('messenger.reply')}
        </button>
      )}
    </span>
  );
}

/** Phone: the action sheet a held bubble opens, above everything (a portal on document.body). */
export function ActionSheet({ actions, close }: { actions: BubbleActions; close: () => void }) {
  const run = (act: () => void) => {
    close();
    act();
  };
  return createPortal(
    <div className="fixed inset-0 z-[84] flex flex-col justify-end" data-testid="message-sheet">
      <div className="absolute inset-0 bg-black/50" onClick={close} aria-hidden="true" />
      <div
        role="menu"
        aria-label={t('messenger.messageActions')}
        className="relative pixel-panel flex flex-col text-sm pb-[var(--cld-safe-bottom)]"
      >
        <button
          type="button"
          role="menuitem"
          autoFocus
          className="min-h-52 px-16 text-left border-b border-border"
          onClick={() => run(() => copyMessage(actions.copy)) /* still in the tap's gesture */}
        >
          {t('messenger.copy')}
        </button>
        {actions.reply && (
          <button
            type="button"
            role="menuitem"
            className="min-h-52 px-16 text-left border-b border-border"
            onClick={() => run(actions.reply!)}
          >
            {t('messenger.reply')}
          </button>
        )}
        <button type="button" className="min-h-52 px-16 text-left" onClick={close}>
          {t('common.cancel')}
        </button>
      </div>
    </div>,
    document.body,
  );
}

/** The quote a reply bubble shows above its text: a tap goes to the original. */
export function ReplyQuote({ reply, open }: { reply: ChatReply; open?: (id: string) => void }) {
  const sender = reply.sender ? serverLine(reply.sender) : t('messenger.replyYou');
  return (
    <button
      type="button"
      data-testid="reply-quote"
      data-reply-id={reply.id}
      disabled={!open}
      aria-label={t('messenger.replyQuote', { text: `${sender}: ${reply.text}` })}
      className="block w-full min-w-0 max-w-full text-left border-l-2 border-accent pl-6 mb-4 text-2xs text-text-muted truncate enabled:hover:text-text"
      onClick={() => open?.(reply.id)}
    >
      ↩ <strong>{sender}</strong> {reply.text}
    </button>
  );
}

/** MSG-POLISH: the original of the draft's reply, over the composer: its whole text (scrolls inside
 *  itself), its files by name, who wrote it and when. A button press keeps the box focused. */
export function QuotePeek({
  view,
  maxHeight,
  jump,
  close,
}: {
  view: PeekView;
  maxHeight: number;
  jump: () => void;
  close: () => void;
}) {
  // No preventDefault on pointerdown: WebKit then drops the click of a touch. The mouse-down
  // default (a focus change) is cancelled instead, and the conversation refocuses the box.
  const keep = { onMouseDown: (event: ReactMouseEvent) => event.preventDefault() };
  return (
    <section
      data-quote-peek
      data-testid="quote-peek"
      role="dialog"
      aria-label={t('messenger.peekTitle')}
      className="absolute bottom-full left-12 right-12 mb-6 flex flex-col border-2 border-accent bg-bg shadow-pixel z-10"
      style={{ maxHeight }}
    >
      <header className="flex shrink-0 items-center gap-8 border-b-2 border-border px-8 py-2 text-2xs text-text-muted">
        <strong className="min-w-0 truncate text-text">
          {view.sender ? serverLine(view.sender) : t('messenger.replyYou')}
        </strong>
        {view.at !== undefined && <time dateTime={new Date(view.at).toISOString()}>{bubbleClock(view.at)}</time>}
        <span className="flex-1" />
        <button
          type="button"
          className="shrink-0 underline text-accent-text pointer-coarse:min-h-44"
          {...keep}
          onClick={jump}
        >
          {t('messenger.peekGoto')}
        </button>
        <button
          type="button"
          aria-label={t('common.close')}
          className="shrink-0 px-4 pointer-coarse:min-h-44 pointer-coarse:min-w-44"
          {...keep}
          onClick={close}
        >
          ✕
        </button>
      </header>
      <div data-testid="quote-peek-text" className="min-h-0 flex-1 overflow-y-auto px-8 py-4 text-sm">
        <p className="whitespace-pre-wrap break-words">{view.text}</p>
        {view.files.length > 0 && (
          <p className="flex flex-wrap gap-4 pt-4" aria-label={t('messenger.attachments')}>
            {view.files.map((name, i) => (
              <span key={i} className="border border-border px-4 text-2xs break-all">
                {name}
              </span>
            ))}
          </p>
        )}
        {!view.loaded && <p className="pt-4 text-2xs text-text-muted">{t('messenger.peekNotLoaded')}</p>}
      </div>
    </section>
  );
}

/** The composer's reply chip: `↩ <sender> · <text…>` and ✕. */
export function ReplyChip({
  reply,
  cancel,
  open,
  peek,
  peekOpen,
}: {
  reply: ChatReply;
  cancel?: () => void;
  open?: (id: string) => void;
  /** MSG-POLISH: a tap shows the original over the composer (the draft's own chip). */
  peek?: () => void;
  peekOpen?: boolean;
}) {
  const text = replyChipText(reply, t('messenger.replyYou'));
  return (
    <div
      className="mb-6 flex items-center gap-8 border-l-2 border-accent bg-bg-dark px-8 py-2 text-xs"
      role="status"
      aria-label={t('messenger.replyChip')}
      data-testid="reply-chip"
    >
      {peek ? (
        <button
          type="button"
          className="flex-1 min-w-0 truncate text-left enabled:hover:text-text pointer-coarse:min-h-44"
          aria-label={t('messenger.peekOpen', { text })}
          aria-expanded={!!peekOpen}
          onMouseDown={(event) => event.preventDefault()}
          onClick={peek}
        >
          {text}
        </button>
      ) : open ? (
        <button
          type="button"
          className="flex-1 min-w-0 truncate text-left enabled:hover:text-text"
          aria-label={t('messenger.replyQuote', { text })}
          onClick={() => open(reply.id)}
        >
          {text}
        </button>
      ) : (
        <span className="flex-1 min-w-0 truncate">{text}</span>
      )}
      {cancel && (
        <button
          type="button"
          aria-label={t('messenger.replyCancel')}
          className="shrink-0 px-4 pointer-coarse:min-h-44 pointer-coarse:min-w-44"
          onClick={cancel}
        >
          ✕
        </button>
      )}
    </div>
  );
}

/** Wraps a bubble root: the hold and the sheet. */
export function Actionable({
  actions,
  className,
  children,
  as: Tag = 'div',
  ...data
}: {
  actions: BubbleActions;
  className?: string;
  children: ReactNode;
  as?: 'div' | 'article';
} & Record<`data-${string}`, string | undefined>) {
  const [sheet, setSheet] = useState(false);
  const press = useLongPress(() => setSheet(true));
  return (
    <Tag
      // On a phone a hold opens our sheet only: no native text selection spreading over the page
      // and no iOS/Android callout on top of it (owner 10-24 18:57).
      className={`${Tag === 'article' ? 'group/post' : 'group/msg'} pointer-coarse:select-none pointer-coarse:[-webkit-touch-callout:none] ${className ?? ''}`}
      onContextMenu={(e) => {
        if (window.matchMedia('(pointer: coarse)').matches) e.preventDefault();
      }}
      {...data}
      {...press}
    >
      {children}
      {sheet && <ActionSheet actions={actions} close={() => setSheet(false)} />}
    </Tag>
  );
}

/** BUBBLE-TAIL + MSG-ALIGN: the bubble sits on the guide line; on a run's first bubble the pixel tail
 *  pokes out of its corner toward the face (look: `.bubble-tail` in index.css). */
const BUBBLE_TAIL_COLORS = {
  lead: '[--tail-border:var(--color-border)] [--tail-fill:var(--color-bg)]',
  peer: '[--tail-border:var(--color-peer-border)] [--tail-fill:var(--color-peer-bg)]',
  boss: '[--tail-border:var(--color-accent)] [--tail-fill:var(--color-active-bg)]',
} as const;

export function BubbleBox({
  side,
  tail,
  kind,
  children,
}: {
  side: 'l' | 'r' | null;
  tail: boolean;
  kind: keyof typeof BUBBLE_TAIL_COLORS;
  children: ReactNode;
}) {
  if (!side) return <>{children}</>;
  return (
    <div className={`bubble-box ${BUBBLE_TAIL_COLORS[kind]}`}>
      {children}
      {tail && <span className={`bubble-tail bubble-tail-${side}`} aria-hidden="true" data-testid="bubble-tail" />}
    </div>
  );
}

export function Line({
  item,
  received,
  project,
  projectRoot,
  highlightQuery,
  currentMatch = false,
  replyAs,
  onReply,
  onQuote,
  face,
}: {
  item: ChatItem;
  received: boolean;
  project?: string;
  projectRoot?: string;
  highlightQuery?: string;
  currentMatch?: boolean;
  /** MSG-ACTIONS: who an assistant item is from, in a reply's quote (the lead or room member). */
  replyAs?: string;
  /** MSG-ACTIONS: 답글 on this bubble; absent: copy only (the work sheet). */
  onReply?: (reply: ChatReply) => void;
  /** MSG-ACTIONS: a reply's quote was tapped: go to the original. */
  onQuote?: (id: string) => void;
  /** MSG-UI2: the sender's face beside the bubble (`show`: this message starts a run; later ones
   *  keep the column empty so the bubbles line up). Absent: no face column. */
  face?: { show: boolean; name: string };
}) {
  const [open, setOpen] = useState(false);
  const { tempStaff } = useCldStore();
  const copy = copyText(item);
  const actions: BubbleActions = {
    copy,
    ...(onReply && {
      reply: () => onReply(replyDraft(replyIdOf(item), replySenderOf(item, replyAs ?? ''), copy)),
    }),
  };
  const sent = useMemo(() => sentFiles(item), [item]);
  const targetFor = useAttachmentTarget(project, projectRoot);
  const openViewer = useOpenAttachment();
  if (item.kind === 'tool') {
    return (
      // On the bubbles' left line: past the sender's face column.
      <details className={`${FACE_GUTTER_LEFT} text-xs text-text-muted`}>
        <summary className="cursor-pointer truncate">{toolLineLabel(item, ezContext())}</summary>
        <p className="pl-16 break-all">{item.text}</p>
      </details>
    );
  }
  if (item.kind === 'result') {
    // A tool's output (the work view only), trimmed on the server.
    return (
      <details className={`${FACE_GUTTER_LEFT} text-2xs text-text-muted pl-16`}>
        <summary className="cursor-pointer">{t('messenger.result')}</summary>
        <pre className="[font-family:inherit] whitespace-pre-wrap break-all">{item.text}</pre>
      </details>
    );
  }
  const shell = shellDone(item);
  if (shell) {
    // One of the lead's command lines, folded like the others: the notice's text inside.
    return (
      <details
        className={`${FACE_GUTTER_LEFT} text-xs ${shell.code ? 'text-danger' : 'text-text-muted'}`}
        data-testid="shell-done"
        data-failed={shell.code ? 'true' : undefined}
      >
        <summary className="cursor-pointer truncate">
          {shell.code === null || shell.code === 0 ? '⏰' : '⚠️'}{' '}
          {t(shell.code ? 'messenger.shellFailed' : 'messenger.shellDone', { desc: shell.desc, code: shell.code ?? 0 })}
        </summary>
        <p className="pl-16 break-all whitespace-pre-wrap">{item.text.replaceAll('**', '')}</p>
      </details>
    );
  }
  const user = item.kind === 'user';
  if (user && item.from === 'system') {
    // A notice (Codex, recovery, an unnamed sender): one muted line, not a bubble. Tap to read it whole.
    return (
      <Actionable
        actions={actions}
        className="flex justify-center items-baseline gap-4 text-2xs text-text-muted"
        data-from="system"
      >
        <button
          type="button"
          data-press-through
          className={`text-left min-w-0 ${open ? 'whitespace-pre-wrap break-words' : 'truncate'}`}
          aria-expanded={open}
          title={item.text}
          onClick={() => setOpen((v) => !v)}
        >
          {item.text}
        </button>
        {item.at > 0 && (
          <time className="shrink-0" dateTime={new Date(item.at).toISOString()}>
            · {bubbleClock(item.at)}
          </time>
        )}
        <ActionRow actions={actions} />
      </Actionable>
    );
  }
  const peer = user && item.from === 'peer';
  const visibleText = user ? splitAttachmentText(item.text).body : item.text;
  const { long, shown } = foldBubble(visibleText, open);
  const quote = user && item.replyTo && <ReplyQuote reply={item.replyTo} open={onQuote} />;
  const faced = face && (peer || !user) ? face : null;
  // MSG-UI3: the boss gets the mirror column, so every bubble has one width.
  const bossFaced = face && user && !peer ? face : null;
  const inner = (
    <>
      {peer && (!faced || faced.show) && (
        <span className="text-2xs text-peer-name max-w-full truncate" data-testid="from-name">
          {item.fromName && noticeName(serverLine(item.fromName), noticeEmployee(item, tempStaff))}
        </span>
      )}
      {/* A run's first bubble names its side next to the face, the lead's and the boss's alike (owner 10-24 23:28). */}
      {!user && faced?.show && (
        <span className="block text-2xs text-peer-name max-w-full truncate" data-testid="from-name">
          {faced.name}
        </span>
      )}
      {bossFaced?.show && (
        <span className="text-2xs text-text-muted max-w-full truncate" data-testid="from-name">
          {t('msgui3.me')}
        </span>
      )}
      <BubbleBox
        side={faced ? 'l' : bossFaced ? 'r' : null}
        tail={!!(faced ?? bossFaced)?.show}
        kind={peer ? 'peer' : user ? 'boss' : 'lead'}
      >
      {user ? (
        <div
          className={`text-sm px-8 py-4 border max-w-full ${peer ? 'border-peer-border bg-peer-bg overflow-hidden' : 'border-accent bg-active-bg'}`}
        >
          {quote}
          {peer ? (
            // Another agent's words (an orchestrator, a task notice): Markdown, like a lead's reply.
            <Markdown text={shown} highlightQuery={highlightQuery} currentMatch={currentMatch} />
          ) : (
            <BubbleAttachments
              text={
                item.text === visibleText ? shown : `${shown}${item.text.slice(visibleText.length)}`
              }
              project={project}
              projectRoot={projectRoot}
              highlightQuery={highlightQuery}
              currentMatch={currentMatch}
            />
          )}
        </div>
      ) : item.attachments?.length ? (
        // Files the lead sent (T-0105): its caption, then thumbnails and chips; what could not be kept is a plain line.
        <div className="text-sm px-8 py-4 border border-border max-w-full overflow-hidden space-y-4">
          {shown && (
            <Markdown
              text={shown}
              highlightQuery={highlightQuery}
              currentMatch={currentMatch}
              projectRoot={projectRoot}
              fileLink={(path) => !!targetFor(path)}
              onOpenFile={openViewer ?? undefined}
            />
          )}
          <BubbleAttachments
            text=""
            attachments={sent}
            project={project}
            projectRoot={projectRoot}
          />
          {item.attachments
            .filter((file) => file.unavailable)
            .map((file, i) => (
              <p key={i} className="text-xs text-text-muted break-all">
                {t('messenger.fileUnavailable', { name: file.name })}
              </p>
            ))}
        </div>
      ) : (
        // The leads write Markdown (bold, tables, code); the boss's own lines stay plain.
        <Markdown
          text={shown}
          className="text-sm px-8 py-4 border border-border max-w-full overflow-hidden"
          highlightQuery={highlightQuery}
          currentMatch={currentMatch}
          projectRoot={projectRoot}
          fileLink={(path) => !!targetFor(path)}
          onOpenFile={openViewer ?? undefined}
        />
      )}
      </BubbleBox>
      {long && <FoldToggle open={open} toggle={() => setOpen((v) => !v)} />}
      <span className="text-2xs text-text-muted">
        {/* The boss's side mirrors the lead's: copy/답글 sit left of the time (MSG-ALIGN). */}
        {user && !peer && <ActionRow actions={actions} before />}
        {item.at > 0 && (
          <time dateTime={new Date(item.at).toISOString()}>{bubbleClock(item.at)}</time>
        )}
        {item.at > 0 && received && <span aria-hidden="true"> · </span>}
        {received && <span>{t('messenger.received')}</span>}
        {!(user && !peer) && <ActionRow actions={actions} />}
      </span>
    </>
  );
  return (
    <Actionable
      actions={actions}
      className={
        faced
          ? `${FACE_GUTTER_RIGHT} flex items-start ${FACE_GAP}`
          : bossFaced
            ? `${FACE_GUTTER_LEFT} flex items-start ${FACE_GAP}`
            : peer
            ? 'mr-24 flex flex-col items-start'
            : user
              ? 'ml-24 flex flex-col items-end'
              : 'mr-24'
      }
      data-from={user ? (peer ? 'peer' : 'boss') : undefined}
    >
      {faced ? (
        <>
          {faced.show ? (
            <SenderFace name={faced.name} employee={peer ? noticeEmployee(item, tempStaff) : undefined} />
          ) : (
            <span className={`shrink-0 ${FACE_COLUMN}`} aria-hidden="true" />
          )}
          {/* A column, so 더보기 and the time start their own lines on the guide line (MSG-ALIGN). */}
          <div className="min-w-0 flex-1 flex flex-col items-start">{inner}</div>
        </>
      ) : bossFaced ? (
        <>
          <div className="min-w-0 flex-1 flex flex-col items-end">{inner}</div>
          {bossFaced.show ? <OwnerFace /> : <span className={`shrink-0 ${FACE_COLUMN}`} aria-hidden="true" />}
        </>
      ) : (
        inner
      )}
    </Actionable>
  );
}

/** 더 보기 on a folded bubble, 접기 on an opened one (MSG-SPLIT: the owner's queued ones too). */
export function FoldToggle({ open, toggle }: { open: boolean; toggle: () => void }) {
  return (
    <button
      type="button"
      className="text-2xs text-accent-text mt-2 pointer-coarse:min-h-44"
      aria-expanded={open}
      data-testid="fold-toggle"
      onClick={toggle}
    >
      {open ? t('messenger.collapse') : t('messenger.showMore')}
    </button>
  );
}
