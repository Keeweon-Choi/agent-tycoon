/**
 * The whiteboards' memos (T-0065): a DOM overlay over the writable face of
 * every WHITEBOARD on the floor shown that has a memo, placed through
 * overlayProjection like the lobby board so it follows the camera and zoom.
 * A tap on a whiteboard (the canvas over its footprint) opens the memo for
 * writing; read-only clients read it. The overlay lets the pointer through,
 * and during the layout editor taps stay the editor's.
 */
import './whiteboard.css';

import { useCallback, useEffect, useRef, useState } from 'react';

import { Button } from '../../components/ui/Button.js';
import { Modal } from '../../components/ui/Modal.js';
import {
  WHITEBOARD_INK,
  WHITEBOARD_MEMO_MAX,
  WHITEBOARD_TYPE,
  WHITEBOARD_Z_INDEX,
} from '../../constants.js';
import { t } from '../../i18n/index.js';
import { frameDue } from '../../office/engine/gameLoop.js';
import type { OfficeState } from '../../office/engine/officeState.js';
import { overlayProjection } from '../../office/projection.js';
import { TILE_SIZE } from '../../office/types.js';
import { transport } from '../../transport/index.js';
import { DRAG_THRESHOLD_PX } from '../camera.js';
import { isOfficeCanvasTarget } from '../canvasTarget.js';
import { currentRect, onFloor } from '../floors.js';
import { boardRect, inRect, memoRect, memoText, useWhiteboardMemos } from './whiteboard.js';

interface WhiteboardMemosProps {
  officeState: OfficeState;
  containerRef: React.RefObject<HTMLDivElement | null>;
  zoom: number;
  panRef: React.RefObject<{ x: number; y: number }>;
  /** False in the layout editor: a tap there selects the board, it opens no memo. */
  interactive: boolean;
  /** This client may read the memo but not write it. */
  readOnly: boolean;
}

/** The whiteboards on the floor shown, and the projection that places them. */
function shownBoards(
  officeState: OfficeState,
  el: HTMLDivElement | null,
  zoom: number,
  pan: { x: number; y: number },
) {
  if (!el) return null;
  const layout = officeState.getLayout();
  const boards = layout.furniture.filter(
    (f) => f.type === WHITEBOARD_TYPE && onFloor(currentRect(layout), (f.row + 1) * TILE_SIZE),
  );
  const p = overlayProjection(
    layout,
    el.getBoundingClientRect(),
    zoom,
    pan,
    window.devicePixelRatio || 1,
  );
  return { boards, p, view: el.getBoundingClientRect() };
}

export function WhiteboardMemos({
  officeState,
  containerRef,
  zoom,
  panRef,
  interactive,
  readOnly,
}: WhiteboardMemosProps) {
  const memos = useWhiteboardMemos();
  const [editing, setEditing] = useState<string | null>(null);
  const close = useCallback(() => setEditing(null), []);

  // Follow the camera on the canvas's frames, while there is a memo to draw.
  const [, setTick] = useState(0);
  const any = memos.size > 0;
  useEffect(() => {
    if (!any) return;
    let raf = 0;
    const tick = (ts: number) => {
      if (frameDue(ts)) setTick((n) => n + 1);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [any]);

  // A tap (not a drag) on a whiteboard of the canvas opens its memo; the canvas below still gets it.
  const latest = useRef({ zoom });
  latest.current = { zoom };
  useEffect(() => {
    const el = containerRef.current;
    if (!el || !interactive) return;
    let down: { x: number; y: number } | null = null;
    const local = (e: PointerEvent) => {
      const box = el.getBoundingClientRect();
      return { x: e.clientX - box.left, y: e.clientY - box.top };
    };
    // Pointer events: the canvas's touch gestures may cancel the click a tap would make.
    const onDown = (e: PointerEvent) => {
      down = e.isPrimary && e.button === 0 ? local(e) : null;
    };
    const onUp = (e: PointerEvent) => {
      const p = local(e);
      const tap = down && Math.hypot(p.x - down.x, p.y - down.y) <= DRAG_THRESHOLD_PX;
      down = null;
      // Only the canvas itself: a panel or button over the board keeps its click.
      if (!tap || !isOfficeCanvasTarget(e.target)) return;
      const shown = shownBoards(officeState, el, latest.current.zoom, panRef.current);
      const hit = shown?.boards.find((b) => inRect(boardRect(b, shown.p), p.x, p.y));
      if (hit) setEditing(hit.uid);
    };
    el.addEventListener('pointerdown', onDown, true);
    el.addEventListener('pointerup', onUp, true);
    return () => {
      el.removeEventListener('pointerdown', onDown, true);
      el.removeEventListener('pointerup', onUp, true);
    };
  }, [containerRef, officeState, panRef, interactive]);

  const shown = any ? shownBoards(officeState, containerRef.current, zoom, panRef.current) : null;
  return (
    <>
      {shown?.boards.map((b) => {
        const memo = memos.get(b.uid);
        if (!memo) return null;
        const rect = memoRect(b, shown.p);
        const { fontPx, lineHeightPx, lines } = memoText(rect);
        if (
          rect.left > shown.view.width ||
          rect.top > shown.view.height ||
          rect.left + rect.width < 0 ||
          rect.top + rect.height < 0
        )
          return null;
        return (
          <div
            key={b.uid}
            className="wb-memo"
            data-testid="whiteboard-memo"
            data-uid={b.uid}
            style={{
              ...rect,
              fontSize: fontPx,
              lineHeight: `${lineHeightPx}px`,
              color: WHITEBOARD_INK,
              zIndex: WHITEBOARD_Z_INDEX,
              WebkitLineClamp: lines,
            }}
          >
            {memo.text}
          </div>
        );
      })}
      {editing && (
        <MemoModal
          key={editing}
          uid={editing}
          initial={memos.get(editing)?.text ?? ''}
          readOnly={readOnly}
          onClose={close}
        />
      )}
    </>
  );
}

/** The memo in a small modal: a textarea, its counter, 저장 and 취소 (Esc closes). */
function MemoModal({
  uid,
  initial,
  readOnly,
  onClose,
}: {
  uid: string;
  initial: string;
  readOnly: boolean;
  onClose: () => void;
}) {
  const [text, setText] = useState(initial);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);
  const save = () => {
    transport.send({ type: 'setWhiteboardMemo', uid, text });
    onClose();
  };
  return (
    <Modal isOpen onClose={onClose} title={t('board.whiteboard')} className="w-[min(440px,100%)]">
      <textarea
        aria-label={t('board.memo')}
        data-testid="whiteboard-input"
        className="w-full bg-bg-dark border-2 border-border px-8 py-4 text-base resize-none"
        rows={6}
        maxLength={WHITEBOARD_MEMO_MAX}
        value={text}
        readOnly={readOnly}
        autoFocus={!readOnly}
        placeholder={readOnly ? '' : t('board.memoPlaceholder')}
        onChange={(e) => setText(e.target.value)}
      />
      <div className="flex items-center justify-between gap-8 mt-8">
        <span className="text-text-muted text-sm" data-testid="whiteboard-count">
          {text.length}/{WHITEBOARD_MEMO_MAX}
        </span>
        <span className="flex gap-8">
          {!readOnly && (
            <Button variant="accent" size="md" data-testid="whiteboard-save" onClick={save}>
              {t('engine.save')}
            </Button>
          )}
          <Button size="md" data-testid="whiteboard-cancel" onClick={onClose}>
            {readOnly ? t('common.close') : t('common.cancel')}
          </Button>
        </span>
      </div>
    </Modal>
  );
}
