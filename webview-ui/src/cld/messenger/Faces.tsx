import { useContext } from 'react';

import type { TempEmployee } from '../../../../core/src/messages.js';
import type { AgentAppearance } from '../../components/AgentCard.js';
import { CharacterMugShot } from '../../components/CharacterMugShot.js';
import { lookByName } from '../characters/looks.js';
import { employeeName } from '../employees.js';
import { useCldStore } from '../officeStore.js';
import { OWNER_PICTURE_SIDE, ownerPictureMissing, useOwnerPicture } from '../ownerPicture.js';
import { MessengerLooks } from './looksContext.js';
import { useMessenger } from './messengerStore.js';
import { employeePalette } from './senderFace.js';

export const FACE_PX = 32;
/** The face's column: its border (1 px a side) and the mug shot. */
export const FACE_COLUMN = 'w-[34px] h-[34px]';
/** The gap between a face and its bubble's guide line: room for the bubble's 8 px tail (BUBBLE-TAIL). */
export const FACE_GAP = 'gap-[14px]';
/** MSG-UI3 + MSG-ALIGN: every bubble leaves one face column plus its gap (34 + 14 px) on the side opposite
 *  its own, so all bubbles share one width and one guide line: the bubble's body (its border) sits on
 *  that line, the tail pokes out toward the face, and command lines, 더보기, times and actions start on it. */
export const FACE_GUTTER_RIGHT = 'mr-[48px]';
export const FACE_GUTTER_LEFT = 'ml-[48px]';

/**
 * A sender's face: the mug shot the agent cards draw (the look the office shows). `execution`
 * names a sub-agent run, whose temp employee's look it is; a sender with no character (a name
 * no one answers to) gets its initial in the same frame.
 */
export function SenderFace({
  name,
  agentId,
  employee,
}: {
  name: string;
  agentId?: number;
  employee?: Pick<TempEmployee, 'employeeId' | 'nameId'>;
}) {
  const looks = useContext(MessengerLooks);
  const { contacts } = useMessenger();
  const { characterPresets } = useCldStore();
  let appearance: AgentAppearance | null = null;
  let label = name;
  if (employee) {
    label = employeeName(employee);
    // ponytail: an employee with no pinned look gets a stable built-in palette, which may differ
    // from the temp character's own in the office; pin the office's pick if that ever matters.
    appearance = lookByName(`emp:${employee.employeeId}`, characterPresets) ?? {
      palette: employeePalette(employee.employeeId),
      hueShift: 0,
    };
  } else {
    const id = agentId ?? contacts.find((c) => c.name === name)?.agentId;
    if (id !== undefined && looks) appearance = looks.getAppearance(id);
  }
  return (
    <span
      className={`shrink-0 ${FACE_COLUMN} border border-border flex items-center justify-center text-2xs text-text-muted`}
      title={label}
      data-testid="sender-face"
      data-sender={label}
    >
      {appearance ? (
        <CharacterMugShot palette={appearance.palette} hueShift={appearance.hueShift} size={FACE_PX} />
      ) : (
        <span aria-hidden="true">{[...label][0]}</span>
      )}
    </span>
  );
}

/** MSG-UI3: the owner's face: the uploaded profile picture, else a plain bust drawn in code. */
export function OwnerFace() {
  const url = useOwnerPicture();
  return (
    <span
      className={`shrink-0 ${FACE_COLUMN} border border-border flex items-center justify-center overflow-hidden text-text-muted`}
      data-testid="owner-face"
      data-picture={url ? 'custom' : 'default'}
    >
      {url ? (
        <img
          src={url}
          alt=""
          width={OWNER_PICTURE_SIDE}
          height={OWNER_PICTURE_SIDE}
          className="w-full h-full object-cover"
          onError={ownerPictureMissing}
        />
      ) : (
        <svg
          viewBox="0 0 16 16"
          className="w-[24px] h-[24px]"
          fill="currentColor"
          shapeRendering="crispEdges"
          aria-hidden="true"
        >
          <rect x="5" y="2" width="6" height="6" />
          <rect x="3" y="10" width="10" height="4" />
        </svg>
      )}
    </span>
  );
}
