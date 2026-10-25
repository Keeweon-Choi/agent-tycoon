import { useEffect } from 'react';
import { createPortal } from 'react-dom';

import { transport } from '../transport/index.js';
import { EngineLayer } from './EngineControls.js';
import { FloatingToast } from './FloatingToast.js';
import {
  actionToastDuration,
  cldConnectionLost,
  cldDismissToast,
  useCldStore,
} from './officeStore.js';

/** The result toast and the engine's dialogs. Mounted once, at the app's top
 *  level: position:fixed inside the mobile shell's transformed track would size
 *  to the track. */
export function ActionLayer() {
  const { toast } = useCldStore();
  useEffect(
    () =>
      transport.onStateChange((state) => {
        if (state !== 'connected') cldConnectionLost();
      }),
    [],
  );
  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => cldDismissToast(toast.id), actionToastDuration(toast));
    return () => window.clearTimeout(timer);
  }, [toast]);
  return (
    <>
      {toast &&
        createPortal(
          <>
            {/* z-85 clears the attachment viewer (80), while security step-up (90) and file explorer (100) modals remain above it. */}
            <FloatingToast
              key={toast.id}
              className="fixed left-1/2 -translate-x-1/2 bottom-[calc(var(--cld-toast-bottom)+8px)] z-[85] w-max max-w-[min(420px,calc(100vw-32px))] cursor-pointer"
              frameClassName={`px-12 py-8 text-sm break-words ${toast.tone === 'error' ? 'text-red-400' : toast.tone === 'info' ? 'text-yellow-300' : 'text-text'}`}
              onDismiss={() => cldDismissToast(toast.id)}
              onTap={() => cldDismissToast(toast.id)}
            >
              <strong className="mr-8">{toast.name}</strong>
              {toast.text}
            </FloatingToast>
          </>,
          document.body,
        )}
      <EngineLayer />
    </>
  );
}
