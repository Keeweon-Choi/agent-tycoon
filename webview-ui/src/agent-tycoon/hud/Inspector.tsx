/**
 * hud-v3 P0 (owner 11-04 23:37 §2.3), FEAT-PARTY-V2: the member card's frame. On the PC it is portalled into
 * the party's slot beside the selected portrait; without a slot (the phone) it is a bottom sheet on the body.
 * A title bar (에이전트 정보, the card's ⋯ tools, ×), the body that scrolls, and the footer's big buttons.
 * One selection (the office's): a click on the figure and on its portrait both set it, × clears it. On the PC
 * its head drags it like a window (cardDrag.ts, kept on screen, forgotten with the selection).
 */
import '../party/party.css';

import { type ReactNode, useRef } from 'react';
import { createPortal } from 'react-dom';

import { MEMBER_SHEET_Z } from '../../constants.js';
import { t } from '../../i18n/index.js';
import { PixelIcon } from '../game/parts.js';
import { Icon } from '../icons/Icon.js';
import { useCardDrag } from './cardDrag.js';
import { CloseGlyph } from './glyphs.js';

export function Inspector({
  into,
  agentId,
  name,
  onClose,
  tools,
  footer,
  children,
}: {
  into: HTMLElement | null;
  agentId: number;
  name: string;
  onClose: () => void;
  tools?: ReactNode;
  footer?: ReactNode;
  children: ReactNode;
}) {
  const sheet = into === null;
  const ref = useRef<HTMLElement>(null);
  const drag = useCardDrag(ref, !sheet);
  return createPortal(
    <aside
      ref={ref}
      className={`mc ${sheet ? 'mc-sheet' : 'game-inspector'} pixel-panel ui-window pointer-events-auto`}
      style={
        sheet
          ? { zIndex: MEMBER_SHEET_Z }
          : drag.off
            ? { transform: `translate(${drag.off.x}px, ${drag.off.y}px)` }
            : undefined
      }
      data-dragged={drag.off ? '' : undefined}
      aria-label={t('hudpc.inspector.label', { name })}
      data-testid="inspector"
      data-agent-id={agentId}
      data-sheet={sheet || undefined}
    >
      <div
        className={`mc-title ${sheet ? '' : 'touch-none cursor-move'}`}
        data-testid="inspector-head"
        onPointerDown={drag.begin}
      >
        <Icon name="user" size={16} pixel={<PixelIcon name="person" size={14} />} />
        <span className="mc-title-text">{t('partyV2.card.title')}</span>
        {tools}
        <button
          type="button"
          className="mc-icon-btn"
          aria-label={t('hudpc.inspector.close')}
          title={t('hudpc.inspector.close')}
          data-testid="inspector-close"
          onClick={onClose}
        >
          <CloseGlyph />
        </button>
      </div>
      <div className="mc-scroll">{children}</div>
      {footer}
    </aside>,
    into ?? document.body,
  );
}
