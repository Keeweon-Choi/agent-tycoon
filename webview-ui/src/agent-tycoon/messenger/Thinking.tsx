/** Messenger: the agent's thinking bubble, a line of the same grid as its replies (face, name, a small box of three dots). */
import { t } from '../../i18n/index.js';
import { SenderFace } from './Faces.js';
import { DialogueBox } from './Line.js';

/** Three dots in a compact box (CSS steps, off under reduced motion); the words only for a screen reader. */
export function Thinking({ name }: { name: string }) {
  return (
    <div
      className="msg-line"
      data-side="agent"
      role="status"
      aria-label={`${name} ${t('messenger.state.thinking')}`}
      data-testid="typing"
    >
      <SenderFace name={name} portrait />
      <div className="msg-lane">
        <span className="dlg-plate text-sm">
          <span className="dlg-name">{name}</span>
        </span>
        <DialogueBox kind="lead">
          <span className="dlg-dots" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
        </DialogueBox>
      </div>
    </div>
  );
}
