import { useEffect, useState } from 'react';

import { CHARACTER_SITTING_OFFSET_PX } from '../../constants.js';
import { t } from '../../i18n/index.js';
import { frameDue } from '../../office/engine/gameLoop.js';
import type { OfficeState } from '../../office/engine/officeState.js';
import { overlayProjection } from '../../office/projection.js';
import { CharacterState } from '../../office/types.js';
import { ChatAction } from '../ChatAction.js';
import { useCldStore } from '../officeStore.js';
import { lookNameOf, openLooks } from './looks.js';

/** Above the overlay labels and bubbles (41-43), below modals. */
const MENU_Z_INDEX = 44;
/** CSS px between the character's feet and the menu. */
const MENU_GAP_PX = 4;

interface CharacterMenuProps {
  officeState: OfficeState;
  /** The selected character, or null. */
  agentId: number | null;
  containerRef: React.RefObject<HTMLDivElement | null>;
  zoom: number;
  panRef: React.RefObject<{ x: number; y: number }>;
}

/** The selected character's menu, under its feet (T-0014: 대화, CH-4: 꾸미기). */
export function CharacterMenu({
  officeState,
  agentId,
  containerRef,
  zoom,
  panRef,
}: CharacterMenuProps) {
  const { officeSnapshot } = useCldStore();
  const name = agentId !== null && officeSnapshot ? lookNameOf(agentId, officeSnapshot) : undefined;
  // Follow the character while it walks and the camera pans.
  const [, setTick] = useState(0);
  useEffect(() => {
    if (name === undefined) return;
    let raf = 0;
    const tick = (ts: number) => {
      if (frameDue(ts)) setTick((n) => n + 1); // the canvas's frames only
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [name]);

  const ch = agentId !== null ? officeState.characters.get(agentId) : undefined;
  const el = containerRef.current;
  if (name === undefined || !ch || !el) return null;
  const project = overlayProjection(
    officeState.getLayout(),
    el.getBoundingClientRect(),
    zoom,
    panRef.current,
    window.devicePixelRatio || 1,
  );
  const sitting = ch.state === CharacterState.TYPE ? CHARACTER_SITTING_OFFSET_PX : 0;
  return (
    <div
      className="absolute -translate-x-1/2 pixel-panel p-2"
      style={{
        left: project.toScreenX(ch.x),
        top: project.toScreenY(ch.y + sitting) + MENU_GAP_PX,
        zIndex: MENU_Z_INDEX,
      }}
      role="menu"
      aria-label={t('character.menu', { name })}
    >
      <ChatAction agentId={agentId!} variant="menu" />
      <button
        type="button"
        role="menuitem"
        className="text-sm whitespace-nowrap px-8 py-2 hover:bg-btn-hover"
        onClick={(e) => {
          e.stopPropagation();
          openLooks(name);
        }}
      >
        {t('looks.open')}
      </button>
    </div>
  );
}
