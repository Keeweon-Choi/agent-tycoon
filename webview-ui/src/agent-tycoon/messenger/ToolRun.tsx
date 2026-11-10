/** A run of the same tool's rows as one row that opens into the single rows (messenger, phone, 개발실 pane). */
import { type ReactNode, useState } from 'react';

import type { ChatItem } from '../../../../core/src/messages.js';
import { t } from '../../i18n/index.js';
import { ezContext } from '../officeStore.js';
import { AGENT_GUTTER_RIGHT, FACE_GUTTER_LEFT } from './Faces.js';
import { toolRowName } from './toolLine.js';

export function ToolRun({
  items,
  show,
  focusId,
}: {
  items: readonly ChatItem[];
  /** Draws the single row `items[offset]`. */
  show: (item: ChatItem, offset: number) => ReactNode;
  /** A search hit inside the run opens it. */
  focusId?: string;
}) {
  const [open, setOpen] = useState(false);
  const shown = open || (!!focusId && items.some((i) => i.id === focusId));
  return (
    <>
      <details
        open={shown}
        onToggle={(e) => setOpen(e.currentTarget.open)}
        className={`${FACE_GUTTER_LEFT} ${AGENT_GUTTER_RIGHT} text-xs text-text-muted`}
        data-testid="tool-run"
        data-count={items.length}
      >
        <summary className="cursor-pointer truncate">
          {t('messenger.mcp.run', {
            label: toolRowName(items[0], ezContext()),
            count: items.length,
          })}
        </summary>
      </details>
      {shown &&
        items.slice(1).map((item, i) => (
          <div key={item.id} data-chat-id={item.id}>
            {show(item, i + 1)}
          </div>
        ))}
    </>
  );
}
