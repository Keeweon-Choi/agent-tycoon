import { useEffect } from 'react';

import { Button } from '../components/ui/Button.js';
import { transport } from '../transport/index.js';
import { listenForAppDownloads } from './desktopApp.js';
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
  useEffect(listenForAppDownloads, []);
  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => cldDismissToast(toast.id), actionToastDuration(toast));
    return () => window.clearTimeout(timer);
  }, [toast]);
  return (
    <>
      {toast && (
            <FloatingToast
              key={toast.id}
              over={toast.own === true}
              className="w-max max-w-[min(420px,calc(100vw-32px))] cursor-pointer"
              frameClassName={`px-12 py-8 text-sm break-words ${toast.tone === 'error' ? 'text-red-400' : toast.tone === 'info' ? 'text-yellow-300' : 'text-text'}`}
              onDismiss={() => cldDismissToast(toast.id)}
              onTap={() => {
                toast.open?.run();
                cldDismissToast(toast.id);
              }}
            >
              <strong className="mr-8">{toast.name}</strong>
              {toast.text}
              {toast.open && (
                <Button
                  size="sm"
                  variant="accent"
                  className="ml-8 align-middle"
                  data-testid="toast-open"
                >
                  {toast.open.label}
                </Button>
              )}
            </FloatingToast>
      )}
      <EngineLayer />
    </>
  );
}
