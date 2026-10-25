import type { ComponentPropsWithoutRef, ReactNode } from 'react';
import { useRef, useState } from 'react';

import { t } from '../i18n/index.js';
import { withinTapSlop } from '../touch/touchPrimitives.js';
import { swipeDismiss } from './toastSwipe.js';

interface StartPoint {
  id: number;
  x: number;
  y: number;
  at: number;
}

interface FloatingToastProps extends Omit<ComponentPropsWithoutRef<'div'>, 'children' | 'className' | 'onClick'> {
  children: ReactNode;
  className: string;
  frameClassName?: string;
  onDismiss: () => void;
  onTap?: () => void;
  testId?: string;
}

/** The one frame for short-lived floating notices: closeable on every device and swipeable on touch. */
export function FloatingToast({
  children,
  className,
  frameClassName = '',
  onDismiss,
  onTap,
  testId,
  ...rest
}: FloatingToastProps) {
  const start = useRef<StartPoint | null>(null);
  const skipTap = useRef(false);
  const [dragY, setDragY] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [leaving, setLeaving] = useState(false);

  const resetDrag = () => {
    start.current = null;
    setDragging(false);
    setDragY(0);
  };

  return (
    <div
      {...rest}
      role="status"
      data-testid={testId}
      className={className}
      onClick={() => {
        if (skipTap.current) {
          skipTap.current = false;
          return;
        }
        onTap?.();
      }}
      onPointerDown={(event) => {
        if (event.pointerType !== 'touch' || leaving) return;
        start.current = {
          id: event.pointerId,
          x: event.clientX,
          y: event.clientY,
          at: event.timeStamp,
        };
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        const point = start.current;
        if (!point || point.id !== event.pointerId) return;
        const dx = event.clientX - point.x;
        const dy = event.clientY - point.y;
        if (withinTapSlop(dx, dy)) return;
        setDragging(true);
        setDragY(Math.min(0, dy));
      }}
      onPointerCancel={resetDrag}
      onPointerUp={(event) => {
        const point = start.current;
        if (!point || point.id !== event.pointerId) return;
        const dy = event.clientY - point.y;
        const ms = event.timeStamp - point.at;
        if (!swipeDismiss(dy, ms)) {
          resetDrag();
          return;
        }
        start.current = null;
        skipTap.current = true;
        setDragging(false);
        setDragY(-96);
        setLeaving(true);
      }}
    >
      <div
        className={`floating-toast-frame pixel-panel relative overflow-hidden ${dragging ? '' : 'transition-transform duration-150 ease-out'} ${frameClassName}`}
        style={{ transform: leaving ? 'translateY(-120%)' : `translateY(${dragY}px)` }}
        onTransitionEnd={(event) => {
          if (leaving && event.propertyName === 'transform') onDismiss();
        }}
      >
        <button
          type="button"
          className="absolute right-2 top-2 z-10 grid size-16 place-items-center border-2 border-border bg-bg text-sm leading-none shadow-pixel hover:bg-bg-dark"
          aria-label={t('common.close')}
          onClick={(event) => {
            event.stopPropagation();
            onDismiss();
          }}
        >
          ×
        </button>
        <div className="relative z-[1] pr-20 pointer-coarse:pr-48">{children}</div>
      </div>
    </div>
  );
}
