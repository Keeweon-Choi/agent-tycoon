import { useContext } from 'react';

import type { TempEmployee } from '../../../../core/src/messages.js';
import type { AgentAppearance } from '../../components/AgentCard.js';
import { CharacterMugShot } from '../../components/CharacterMugShot.js';
import { MSG_PORTRAIT_FRAME_PAD_PX, MSG_PORTRAIT_PX } from '../../constants.js';
import { lookByName } from '../characters/looks.js';
import { employeeName } from '../employees.js';
import { useCldStore } from '../officeStore.js';
import { OWNER_PICTURE_SIDE, ownerPictureMissing, useOwnerPicture } from '../ownerPicture.js';
import { MessengerLooks } from './looksContext.js';
import { useMessenger } from './messengerStore.js';

export const FACE_PX = 32;
/** The face's column: its border (1 px a side) and the mug shot. */
export const FACE_COLUMN = 'w-[34px] h-[34px]';
/** GAME-UI-1 G1 (01): the agent's portrait frame (the mug shot, 4 px padding and a 2 px line a side). */
export const PORTRAIT_FRAME_PX = MSG_PORTRAIT_PX + MSG_PORTRAIT_FRAME_PAD_PX;
/** The gap between a face and its dialogue box. */
export const FACE_GAP = 'gap-[10px]';
/** The agent's command lines, 더보기 and times start on its dialogue box: the portrait frame (60) and the gap (10). */
export const FACE_GUTTER_LEFT = 'ml-[70px]';
/** Room the agent's lines leave on the right, and the boss's on the left (the mock's player side is narrower). */
export const AGENT_GUTTER_RIGHT = 'mr-[40px]';
export const OWNER_GUTTER_LEFT = 'ml-[64px]';

/**
 * A sender's face: the mug shot the agent cards draw (the look the office shows). `execution`
 * names a sub-agent run, whose temp employee's look it is; a sender with no character (a name
 * no one answers to) gets its initial in the same frame.
 */
export function SenderFace({
  name,
  agentId,
  employee,
  portrait,
}: {
  name: string;
  agentId?: number;
  employee?: Pick<TempEmployee, 'employeeId' | 'nameId'>;
  /** GAME-UI-1 G1: the dialogue's portrait frame (a bigger mug shot). */
  portrait?: boolean;
}) {
  const looks = useContext(MessengerLooks);
  const { contacts } = useMessenger();
  const { characterPresets } = useCldStore();
  let appearance: AgentAppearance | null = null;
  let label = name;
  if (employee) {
    label = employeeName(employee);
    appearance = lookByName(`emp:${employee.employeeId}`, characterPresets);
  } else {
    const id = agentId ?? contacts.find((c) => c.name === name)?.agentId;
    if (id !== undefined && looks) appearance = looks.getAppearance(id);
  }
  return (
    <span
      className={
        portrait
          ? 'dlg-pf flex items-center justify-center text-text-muted'
          : `shrink-0 ${FACE_COLUMN} border border-border flex items-center justify-center text-2xs text-text-muted`
      }
      style={portrait ? { width: PORTRAIT_FRAME_PX, height: PORTRAIT_FRAME_PX } : undefined}
      title={label}
      data-testid="sender-face"
      data-sender={label}
    >
      {appearance ? (
        <CharacterMugShot palette={appearance.palette} hueShift={appearance.hueShift} size={portrait ? MSG_PORTRAIT_PX : FACE_PX} />
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
