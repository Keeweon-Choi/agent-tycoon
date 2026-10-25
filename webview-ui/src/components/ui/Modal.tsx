import type { ReactNode } from 'react';
import { useEffect } from 'react';
import { createPortal } from 'react-dom';

import { requestStaleRecheck } from '../../cld/staleBuild.js';
import { Button } from './Button.js';
import { TITLE_BAR } from './windowChrome.js';

interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  title: ReactNode;
  children: ReactNode;
  /** z-index for backdrop (modal gets +1). Default 49 */
  zIndex?: number;
  className?: string;
}

export function Modal({
  isOpen,
  onClose,
  title,
  children,
  zIndex = 50,
  className = '',
}: ModalProps) {
  useEffect(() => {
    if (!isOpen) return;
    return () => requestStaleRecheck();
  }, [isOpen]);
  if (!isOpen) return null;

  // On the body, not where the caller sits: inside a panel that makes a stacking
  // context (the office panel's aside, z 30) a modal's own z-index only ranks it in
  // there, and the labels and bubbles (41-43) drew over it (T-0063).
  return createPortal(
    <>
      <div className="fixed inset-0 bg-black/50" style={{ zIndex }} onClick={onClose} />
      {/* Sizing wrapper: a full-viewport flex box (inset-0, no viewport
          units — dvw/dvh support varies across iOS) whose padding is the
          modal's screen margin. The panel can never exceed it: max-w/h-full
          caps it, min-width yields via min() (min-width beats max-width in
          CSS, so an unconditional minimum would overflow narrow phones), and
          overflow scrolls. Clicks on the margin fall through to the
          backdrop. */}
      <div
        className="fixed inset-0 flex items-center justify-center pt-[calc(var(--cld-safe-top)+8px)] pr-[calc(var(--cld-safe-right)+8px)] pb-[calc(var(--cld-safe-bottom)+8px)] pl-[calc(var(--cld-safe-left)+8px)] pointer-events-none"
        style={{ zIndex: zIndex + 1 }}
      >
        <div
          role="dialog"
          aria-modal="true"
          className={`pointer-events-auto bg-bg border-2 border-border rounded-none shadow-pixel min-w-[min(320px,100%)] max-w-full max-h-full overflow-y-auto overflow-x-hidden ${className}`}
        >
          {/* Sticky so the close button stays reachable while long content
              (changelog, settings) scrolls under it. */}
          <div data-modal-title className={`${TITLE_BAR} sticky top-0 z-10 bg-bg mb-10`}>
            <span className="text-accent-text text-2xl">{title}</span>
            <Button variant="ghost" size="icon_md" onClick={onClose}>
              x
            </Button>
          </div>
          {children}
        </div>
      </div>
    </>,
    document.body,
  );
}
