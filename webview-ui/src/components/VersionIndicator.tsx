import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';

import { toMajorMinor } from '../changelogData.ts';
import { FloatingToast } from '../cld/FloatingToast.js';
import {
  CHANGELOG_SEEN_STORAGE_KEY,
  WHATS_NEW_AUTO_CLOSE_MS,
  WHATS_NEW_FADE_MS,
} from '../constants.ts';
import { t, useLanguage } from '../i18n/index.js';
import { Button } from './ui/Button.js';

function readSeen(): string {
  try {
    return window.localStorage.getItem(CHANGELOG_SEEN_STORAGE_KEY) ?? '';
  } catch {
    return '';
  }
}

function writeSeen(version: string): void {
  try {
    window.localStorage.setItem(CHANGELOG_SEEN_STORAGE_KEY, version);
  } catch {
    // The notice may come back on the next visit; nothing else depends on it.
  }
}

interface VersionIndicatorProps {
  /** The tycoon office: only the update notice, as the app's floating toast (the HUD owns the
   *  corners, so no version label), remembered per browser. */
  floating?: boolean;
  currentVersion: string;
  lastSeenVersion: string;
  /** Never show the "Updated to vX" notice -- a read-only office can't record
   *  that it was seen, so it would come back on every load. */
  hideUpdateNotice: boolean;
  onDismiss: () => void;
  onOpenChangelog: () => void;
}

export function VersionIndicator({
  currentVersion,
  lastSeenVersion,
  hideUpdateNotice,
  onDismiss,
  onOpenChangelog,
  floating = false,
}: VersionIndicatorProps) {
  useLanguage();
  const [dismissed, setDismissed] = useState(false);
  const [fading, setFading] = useState(false);
  const [labelHovered, setLabelHovered] = useState(false);

  const currentMajorMinor = toMajorMinor(currentVersion);
  const isUnseen =
    currentMajorMinor !== lastSeenVersion && !(floating && readSeen() === currentMajorMinor);
  const showUpdateNotice = isUnseen && !dismissed && !hideUpdateNotice;

  // Start fade-out after auto-close delay, then fully dismiss after the transition
  useEffect(() => {
    if (!showUpdateNotice || fading) return;
    const fadeTimer = setTimeout(() => setFading(true), WHATS_NEW_AUTO_CLOSE_MS);
    return () => clearTimeout(fadeTimer);
  }, [showUpdateNotice, fading]);

  useEffect(() => {
    if (!fading) return;
    const removeTimer = setTimeout(() => {
      if (floating) writeSeen(currentMajorMinor);
      setDismissed(true);
      onDismiss();
    }, WHATS_NEW_FADE_MS);
    return () => clearTimeout(removeTimer);
  }, [fading, onDismiss, floating, currentMajorMinor]);

  const handleDismiss = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      if (floating) writeSeen(currentMajorMinor);
      setDismissed(true);
      onDismiss();
    },
    [onDismiss, floating, currentMajorMinor],
  );

  const handleOpenChangelog = useCallback(() => {
    if (floating) writeSeen(currentMajorMinor);
    setDismissed(true);
    onOpenChangelog();
  }, [onOpenChangelog, floating, currentMajorMinor]);

  if (!currentVersion) return null;

  if (floating) {
    if (!showUpdateNotice) return null;
    return createPortal(
      <FloatingToast
        className="fixed left-1/2 -translate-x-1/2 bottom-[calc(var(--cld-toast-bottom)+8px)] z-[85] w-max max-w-[min(420px,calc(100vw-32px))] cursor-pointer"
        frameClassName="px-12 py-8 text-sm break-words"
        style={{
          opacity: fading ? 0 : 1,
          transition: `opacity ${WHATS_NEW_FADE_MS / 1000}s ease-out`,
        }}
        onDismiss={() => {
          writeSeen(currentMajorMinor);
          setDismissed(true);
          onDismiss();
        }}
        onTap={handleOpenChangelog}
        testId="update-notice"
      >
        <strong className="mr-8 text-accent-text">
          {t('changelog.updated', { version: currentMajorMinor })}
        </strong>
        {t('changelog.see')}
      </FloatingToast>,
      document.body,
    );
  }

  return (
    <>
      {/* Update notice — shown once per version until dismissed or auto-closed */}
      {showUpdateNotice && (
        <div
          onClick={handleOpenChangelog}
          className="absolute bottom-42 right-28 z-20 pixel-panel px-10 pt-8 pb-9 cursor-pointer flex flex-col gap-8 max-w-2xs"
          style={{
            opacity: fading ? 0 : 1,
            transition: `opacity ${WHATS_NEW_FADE_MS / 1000}s ease-out`,
          }}
        >
          <div className="flex justify-between items-center gap-10">
            <span className="text-lg text-accent-text leading-none">
              {t('changelog.updated', { version: currentMajorMinor })}
            </span>
            <Button variant="ghost" size="icon" onClick={handleDismiss} className="leading-none">
              x
            </Button>
          </div>
          <span className="text-sm whitespace-nowrap">{t('changelog.see')}</span>
        </div>
      )}
      {/* Hover tooltip — "See what's new" appears on label hover after notice is gone */}
      {!showUpdateNotice && labelHovered && (
        <div
          onClick={handleOpenChangelog}
          className="absolute bottom-42 right-28 z-20 pixel-panel py-6 px-12 cursor-pointer text-sm whitespace-nowrap"
        >
          {t('changelog.seeBang')}
        </div>
      )}
      {/* Version label — always visible */}
      <div
        onMouseEnter={() => setLabelHovered(true)}
        onMouseLeave={() => setLabelHovered(false)}
        onClick={handleOpenChangelog}
        className="absolute bottom-8 right-28 z-20 text-lg cursor-pointer select-none pr-2 transition-opacity duration-200"
        style={{ opacity: labelHovered ? 0.8 : 0.4 }}
      >
        v{currentMajorMinor}
      </div>
    </>
  );
}
