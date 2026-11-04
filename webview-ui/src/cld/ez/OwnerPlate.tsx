/** OWNER-HUD: the "나" plate over the owner's own character (no status bars: the owner has no
 *  fatigue or status). Drawn like an agent's plate, in its own colour, so the two never mix. */
import {
  CHARACTER_SITTING_OFFSET_PX,
  OVERLAY_LABEL_Z_INDEX,
  OWNER_PLATE_BG,
  OWNER_PLATE_FG,
  PHONE_CARD_OTHERS_ALPHA,
  TOOL_OVERLAY_VERTICAL_OFFSET,
} from '../../constants.js';
import { t } from '../../i18n/index.js';
import type { Bind } from '../../office/components/overlayPlacer.js';
import type { Character } from '../../office/types.js';
import { CharacterState } from '../../office/types.js';

export function OwnerPlate({
  ch,
  bind,
  lift,
  dim = false,
}: {
  ch: Character;
  bind: Bind;
  lift: number;
  /** UI-PHONE: an agent's summary card is open on the phone. */
  dim?: boolean;
}) {
  return (
    <div
      ref={bind('plate', (at) => ({
        x: at.toScreenX(ch.x),
        y: at.toScreenY(
          ch.y +
            (ch.state === CharacterState.TYPE ? CHARACTER_SITTING_OFFSET_PX : 0) -
            lift -
            TOOL_OVERLAY_VERTICAL_OFFSET,
        ),
      }))}
      className="absolute left-0 top-0 -translate-x-1/2 -translate-y-full pointer-events-none border-2 border-border px-6 py-1 text-xs font-bold leading-tight whitespace-nowrap shadow-pixel"
      style={{
        background: OWNER_PLATE_BG,
        color: OWNER_PLATE_FG,
        zIndex: OVERLAY_LABEL_Z_INDEX,
        ...(dim && { opacity: PHONE_CARD_OTHERS_ALPHA }),
      }}
      data-testid="owner-plate"
      data-agent-id={ch.id}
    >
      {t('owner.plate')}
    </div>
  );
}
