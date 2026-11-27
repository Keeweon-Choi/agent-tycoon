/**
 * FIX-PHONE-CHARACTER-TAP (T-106): the phone's chip for the selected character (its face, its name
 * and 정보). A tap on a character only selects it, so the walking pad stays free; this chip, a
 * second tap on the character or a long press opens its information sheet. It sits right above the
 * pad (left edge), where it covers neither the pad, the dock nor the camera group.
 */
import { useCallback, useSyncExternalStore } from 'react';

import { CharacterMugShot } from '../components/CharacterMugShot.js';
import { Button } from '../components/ui/Button.js';
import {
  JOYSTICK_BOTTOM_PX,
  JOYSTICK_MARGIN_PX,
  JOYSTICK_SIZE_PX,
  JOYSTICK_Z_INDEX,
  SELECTION_CHIP_FACE_PX,
  SELECTION_CHIP_GAP_PX,
  SELECTION_CHIP_MAX_WIDTH_PCT,
} from '../constants.js';
import type { SubagentCharacter } from '../hooks/useExtensionMessages.js';
import { t } from '../i18n/index.js';
import type { OfficeState } from '../office/engine/officeState.js';
import { PixelIcon } from './game/parts.js';
import { useTitleScene } from './gfx/titleSceneState.js';
import { characterName } from './kinds.js';
import { useAgtyStore } from './officeStore.js';

/** `enabled`: the office is what the phone shows (the pad's own condition). */
export function SelectionChip({
  officeState,
  subagentCharacters,
  enabled,
}: {
  officeState: OfficeState;
  subagentCharacters: SubagentCharacter[];
  enabled: boolean;
}) {
  const lobby = useTitleScene().open;
  const { officeSnapshot, codexTasks } = useAgtyStore();
  // Re-render on a selection or a sheet change (one string: a stable snapshot).
  useSyncExternalStore(
    useCallback((on: () => void) => officeState.subscribeSelection(on), [officeState]),
    () => `${officeState.selectedAgentId}:${officeState.infoAgentId}`,
  );
  const id = officeState.selectedAgentId;
  const ch = id === null ? undefined : officeState.characters.get(id);
  if (!enabled || lobby || id === null || !ch || ch.agtyOwner) return null; // the owner has no sheet
  if (officeState.infoAgentId === id) return null; // its sheet is open
  const name = characterName(ch, officeSnapshot, codexTasks, subagentCharacters.find((s) => s.id === id)?.label);
  return (
    <div
      className="absolute"
      style={{
        left: `calc(var(--agty-safe-left) + ${JOYSTICK_MARGIN_PX}px)`,
        bottom: JOYSTICK_BOTTOM_PX + JOYSTICK_SIZE_PX + SELECTION_CHIP_GAP_PX,
        zIndex: JOYSTICK_Z_INDEX,
        maxWidth: `${SELECTION_CHIP_MAX_WIDTH_PCT}%`,
      }}
      data-hud-fixed=""
    >
      <Button
        size="md"
        className="max-w-full gap-6"
        data-testid="selection-chip"
        data-agent-id={id}
        aria-label={t('selectionChip.open', { name })}
        onClick={() => officeState.setInfoAgent(id)}
      >
        <CharacterMugShot palette={ch.palette} hueShift={ch.hueShift} size={SELECTION_CHIP_FACE_PX} />
        <span className="truncate">{name}</span>
        <span className="text-text-muted">{t('selectionChip.info')}</span>
        <PixelIcon name="right" />
      </Button>
    </div>
  );
}
