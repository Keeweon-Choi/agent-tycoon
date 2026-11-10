import { type ReactNode, useEffect, useRef, useState } from 'react';

import { ATTACH_VIDEO_TICKET_RETRIES } from '../../constants.js';
import type { TicketFor } from './attachmentGallery.js';

/**
 * A video attachment played in place: the browser's own controls, `playsinline` (iOS Safari
 * would otherwise take the screen over), metadata only until play. A file's ticket is asked for
 * when it shows; one that ran out before play is asked for again. `fallback` shows when
 * the file cannot be served or this device cannot play it (the file card, with its download).
 */
export function AttachmentVideo({
  path,
  ticketFor,
  className,
  fallback,
  testId,
}: {
  path: string;
  ticketFor: TicketFor;
  className: string;
  fallback: ReactNode;
  testId: string;
}) {
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const retries = useRef(0);
  const mint = useRef<() => void>(() => undefined);
  mint.current = () => {
    ticketFor(path, 'preview').then(setSrc, () => setFailed(true));
  };
  useEffect(() => {
    retries.current = 0;
    setSrc(null);
    setFailed(false);
    mint.current();
  }, [path, ticketFor]);
  if (failed) return <>{fallback}</>;
  return src ? (
    <video
      // `#t=0.001` makes iOS Safari paint the first frame as the poster.
      src={`${src}#t=0.001`}
      className={className}
      data-testid={testId}
      controls
      playsInline
      preload="metadata"
      onError={() => {
        if (retries.current++ < ATTACH_VIDEO_TICKET_RETRIES) mint.current();
        else setFailed(true);
      }}
    />
  ) : null;
}
