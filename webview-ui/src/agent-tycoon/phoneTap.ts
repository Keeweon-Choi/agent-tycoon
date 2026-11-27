/**
 * FIX-PHONE-CHARACTER-TAP (T-106): what a tap on a character does on the phone's office. The first
 * tap only selects and follows it (the walking pad then walks it, and nothing covers the pad); the
 * information sheet opens by a second, clear action: another tap on the same character, the chip
 * (SelectionChip) or a long press. The owner's own character has no sheet (its menu is its own).
 */
import type { OfficeState } from '../office/engine/officeState.js';

export type PhoneTapResult = 'select' | 'info';

/** Apply a tap on character `id` to the office. */
export function phoneTapCharacter(os: OfficeState, id: number): PhoneTapResult {
  if (os.selectedAgentId === id) {
    if (os.characters.get(id)?.agtyOwner) return 'select';
    os.setInfoAgent(id);
    return 'info';
  }
  os.selectedAgentId = id;
  os.cameraFollowId = id;
  return 'select';
}
