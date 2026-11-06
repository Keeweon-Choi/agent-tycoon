/** Messenger pending-send bubble. */
import { useState } from 'react';

import type { ChatReply } from '../../../../core/src/messages.js';
import { Button } from '../../components/ui/Button.js';
import { t } from '../../i18n/index.js';
import { splitAttachmentText } from './attachments.js';
import { BubbleAttachments } from './BubbleAttachments.js';
import { FaceSpacer } from './Faces.js';
import { Actionable, ActionRow, DialogueBox, FoldToggle, ReplyQuote } from './Line.js';
import { foldBubble } from './longMessage.js';
import { copyText, replyDraft } from './messageActions.js';
import type { PendingSend } from './messengerStore.js';
import { dismissSend, sendLabel } from './messengerStore.js';

export function Pending({
  p,
  agentId,
  sendNow,
  edit,
  cancel,
  approve,
  editingHere,
  project,
  projectRoot,
  permissionWait,
  onQuote,
  onReply,
}: {
  p: PendingSend;
  /** PERM-PROMPT: its lead waits on a permission dialog: a waiting message says why. */
  permissionWait?: boolean;
  agentId: number;
  sendNow: () => void;
  approve: () => void;
  /** This bubble is in the composer right now (its hold is shown there). */
  editingHere: boolean;
  edit: () => void;
  cancel: () => void;
  project?: string;
  projectRoot?: string;
  onQuote: (id: string) => void;
  /** 답글 on a waiting message, as on a sent one: it names the message's C2 id, which its prompt keeps. */
  onReply?: (reply: ChatReply) => void;
}) {
  const failed = p.state === 'failed';
  const cancelled = p.state === 'cancelled';
  const waiting = p.state === 'queued' || p.state === 'sending';
  // MSG-RECALL: lost to another prompt twice: 전달 실패 · 다시 보내기, never 대기 중 forever.
  const lost = p.state === 'queued' && !!p.lost;
  const actions = p.state === 'queued' && !!p.queueId && !p.editing && !p.cancelling;
  const approvable = actions && p.held && !editingHere;
  // MSG-RECALL: a 즉시 message waiting for the input box can be forced too; a lost one has 다시 보내기.
  const promotable =
    p.state === 'queued' &&
    !!p.queueId &&
    (!p.now || !!p.inputWait) &&
    !p.held &&
    !lost &&
    !p.text.trimStart().startsWith('/');
  const [open, setOpen] = useState(false);
  // Fold the words only; the attachment lines after them always show (as a sent bubble does).
  const body = splitAttachmentText(p.text).body;
  const fold = foldBubble(body, open);
  const copy = copyText({ kind: 'user', text: p.text });
  const bubbleActions = {
    copy,
    ...(onReply &&
      p.messageId &&
      !failed &&
      !cancelled && { reply: () => onReply(replyDraft(p.messageId!, undefined, copy)) }),
  };
  const hasActions = approvable || promotable || actions || failed;
  // Inside the box, at the right end of its 대기 중 row (owner 11-06 22:10): the same buttons, smaller.
  const head = (
    <>
      {approvable && (
        <Button size="sm" onClick={approve}>
          {t('messenger.approveOriginal')}
        </Button>
      )}
      {promotable && (
        <Button size="sm" disabled={p.promoting} onClick={sendNow}>
          {t('messenger.sendImmediately')}
        </Button>
      )}
      {/* Always shown, on the phone too: a queued message can be sent now, edited or cancelled (10-24 02:48). */}
      {actions && (
        <Button size="sm" onClick={edit}>
          {p.held && !editingHere ? t('messenger.continueEdit') : t('messenger.edit')}
        </Button>
      )}
      {actions && (
        <Button size="sm" className="text-danger" onClick={cancel}>
          {t('common.cancel')}
        </Button>
      )}
      {failed && (
        <Button size="sm" onClick={() => dismissSend(agentId, p.requestId)}>
          {t('messenger.dismiss')}
        </Button>
      )}
    </>
  );
  return (
    <div className="msg-line" data-side="mine" data-testid="pending" data-state={p.state}>
      <Actionable actions={bubbleActions} className="msg-lane">
        {/* The box of a sent message of mine; only a waiting one is fainter, and its 더보기 sits inside like every bubble's. */}
        <DialogueBox
          kind="boss"
          state={failed || lost ? 'failed' : waiting ? 'waiting' : undefined}
          head={hasActions ? head : undefined}
          fold={fold.long ? <FoldToggle open={open} toggle={() => setOpen((v) => !v)} /> : undefined}
        >
          <div className="text-sm whitespace-pre-wrap [overflow-wrap:anywhere] max-w-full overflow-hidden">
            {p.replyTo && <ReplyQuote reply={p.replyTo} open={onQuote} />}
            <BubbleAttachments
              text={p.text === body ? fold.shown : `${fold.shown}${p.text.slice(body.length)}`}
              project={project}
              projectRoot={projectRoot}
            />
          </div>
        </DialogueBox>
        <span className={`dlg-foot text-2xs ${failed || lost ? 'text-danger' : 'text-text-muted'}`} role="status">
          <ActionRow actions={bubbleActions} before />
          {failed ? (p.error ?? sendLabel('failed')) : lost ? t('messenger.recall.lost') : sendLabel(p.state)}
          {p.edited && !cancelled && t('messenger.editedSuffix')}
          {waiting && p.now && t('messenger.nowSuffix')}
          {p.state === 'queued' && permissionWait && t('permPrompt.queued')}
          {p.state === 'queued' &&
            !lost &&
            p.inputWait &&
            t(p.inputWaitLong ? 'messenger.recall.inputWaitLong' : 'messenger.recall.inputWait')}
          {lost && p.queueId && (
            <button
              type="button"
              className="ml-8 underline text-accent-text pointer-coarse:min-h-44"
              disabled={p.promoting}
              onClick={sendNow}
            >
              {t('messenger.recall.resend')}
            </button>
          )}
          {/* MSG-HOLD2: which decision applies to this message */}
          {p.state === 'queued' && p.held && !editingHere && t('messenger.heldSuffix')}
          {p.state === 'queued' && !p.held && p.holdNote === 'editCancelled' && t('messenger.editCancelledSuffix')}
          {p.state === 'queued' && !p.held && p.holdNote === 'approved' && t('messenger.approvedSuffix')}
          {(p.editing || p.cancelling) && t('messenger.processingSuffix')}
          {p.refusal && <span className="ml-8 text-danger">{p.refusal}</span>}
        </span>
      </Actionable>
      <FaceSpacer />
    </div>
  );
}
