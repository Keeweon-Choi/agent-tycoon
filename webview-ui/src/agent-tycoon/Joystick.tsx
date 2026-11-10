/**
 * JOYSTICK: the phone's walking pad, bottom-left of the office. It presses and releases the
 * direction keys (useGameControls' walk pad: they walk the selected character or the owner's, or
 * pan the free camera), so what moves, when it may and how it is held are the keyboard's, with no
 * second movement system. It fades when left alone.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import {
  JOYSTICK_BOTTOM_PX,
  JOYSTICK_FADE_DELAY_MS,
  JOYSTICK_FADE_MS,
  JOYSTICK_FADED_OPACITY,
  JOYSTICK_KNOB_PX,
  JOYSTICK_MARGIN_PX,
  JOYSTICK_OPACITY,
  JOYSTICK_SIZE_PX,
  JOYSTICK_Z_INDEX,
} from '../constants.js';
import { t } from '../i18n/index.js';
import type { CameraKey, Vec } from './camera.js';
import { useTitleScene } from './gfx/titleSceneState.js';
import { createIdleFade, joystickKeys, knobOffset } from './joystickMath.js';
import { getWalkPad } from './useGameControls.js';

const RADIUS = (JOYSTICK_SIZE_PX - JOYSTICK_KNOB_PX) / 2;

/** `enabled`: the office is what the phone shows (the pad walks a character, or pans the free
 *  camera, as the keys do). */
export function Joystick({ enabled }: { enabled: boolean }) {
  const lobby = useTitleScene().open;
  return enabled && !lobby ? <Pad /> : null;
}

function Pad() {
  const padRef = useRef<HTMLDivElement>(null);
  const [awake, setAwake] = useState(true);
  const [knob, setKnob] = useState<Vec>({ x: 0, y: 0 });
  const fade = useRef<ReturnType<typeof createIdleFade> | null>(null);
  const held = useRef<CameraKey[]>([]);
  const pointer = useRef<number | null>(null);

  useEffect(() => {
    const f = createIdleFade(JOYSTICK_FADE_DELAY_MS, setAwake);
    fade.current = f;
    f.wake();
    return f.dispose;
  }, []);

  /** Hold `next` instead of what is held: the keys' press and release. */
  const steer = useCallback((next: CameraKey[]) => {
    const pad = getWalkPad();
    for (const key of held.current) if (!next.includes(key)) pad?.release(key);
    for (const key of next) if (!held.current.includes(key)) pad?.press(key);
    held.current = next;
  }, []);
  useEffect(() => () => steer([]), [steer]);

  const drag = (e: React.PointerEvent) => {
    const r = padRef.current?.getBoundingClientRect();
    if (!r) return;
    const dx = e.clientX - (r.left + r.width / 2);
    const dy = e.clientY - (r.top + r.height / 2);
    setKnob(knobOffset(dx, dy, RADIUS));
    steer(joystickKeys(dx, dy, RADIUS));
  };
  const end = () => {
    pointer.current = null;
    steer([]);
    setKnob({ x: 0, y: 0 });
    fade.current?.wake();
  };

  return (
    <div
      ref={padRef}
      data-testid="joystick"
      data-awake={awake}
      role="group"
      aria-label={t('joystick.label')}
      className="absolute pixel-panel touch-none select-none"
      style={{
        left: `calc(var(--agty-safe-left) + ${JOYSTICK_MARGIN_PX}px)`,
        bottom: JOYSTICK_BOTTOM_PX,
        zIndex: JOYSTICK_Z_INDEX,
        width: JOYSTICK_SIZE_PX,
        height: JOYSTICK_SIZE_PX,
        opacity: awake ? JOYSTICK_OPACITY : JOYSTICK_FADED_OPACITY,
        transition: `opacity ${JOYSTICK_FADE_MS}ms`,
      }}
      onPointerDown={(e) => {
        if (pointer.current !== null) return; // one finger
        pointer.current = e.pointerId;
        e.currentTarget.setPointerCapture(e.pointerId);
        fade.current?.hold();
        drag(e);
      }}
      onPointerMove={(e) => pointer.current === e.pointerId && drag(e)}
      onPointerUp={(e) => pointer.current === e.pointerId && end()}
      onPointerCancel={(e) => pointer.current === e.pointerId && end()}
    >
      <div
        data-testid="joystick-knob"
        className="absolute bg-accent border-2 border-border shadow-pixel"
        style={{
          width: JOYSTICK_KNOB_PX,
          height: JOYSTICK_KNOB_PX,
          left: (JOYSTICK_SIZE_PX - JOYSTICK_KNOB_PX) / 2 + knob.x - 2,
          top: (JOYSTICK_SIZE_PX - JOYSTICK_KNOB_PX) / 2 + knob.y - 2,
        }}
      />
    </div>
  );
}
