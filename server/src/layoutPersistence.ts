import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  LAYOUT_FILE_NAME,
  LAYOUT_FILE_POLL_INTERVAL_MS,
  LAYOUT_REVISION_KEY,
} from './constants.js';
import { officeFile, officeFileToRead } from './officeFolder.js';

export interface LayoutWatcher {
  markOwnWrite(): void;
  dispose(): void;
}

function getLayoutFilePath(): string {
  return officeFile(LAYOUT_FILE_NAME);
}

export function readLayoutFromFile(home = os.homedir()): Record<string, unknown> | null {
  const filePath = officeFileToRead(LAYOUT_FILE_NAME, home);
  try {
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(raw) as Record<string, unknown>;
  } catch (err) {
    console.error('[Agent Tycoon] Failed to read layout file:', err);
    return null;
  }
}

export function writeLayoutToFile(layout: Record<string, unknown>): void {
  const filePath = getLayoutFilePath();
  const dir = path.dirname(filePath);
  try {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const json = JSON.stringify(layout, null, 2);
    const tmpPath = filePath + '.tmp';
    fs.writeFileSync(tmpPath, json, 'utf-8');
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    console.error('[Agent Tycoon] Failed to write layout file:', err);
  }
}

interface LayoutLoadResult {
  layout: Record<string, unknown>;
  /** True when the user's saved layout was replaced by a newer bundled default */
  wasReset: boolean;
}

/**
 * Load layout from file. Falls back to bundled default if the file is empty.
 * Resets to the bundled default when a newer revision is bundled.
 *
 * The file is the only source of truth (the VS Code extension that migrated
 * its workspaceState into it is gone).
 *
 * 1. If file exists → return it (reset if bundled default has a newer revision)
 * 2. Else if defaultLayout provided → write to file, return it
 * 3. Else → return null
 */
export function loadLayout(
  defaultLayout?: Record<string, unknown> | null,
): LayoutLoadResult | null {
  const fromFile = readLayoutFromFile();
  if (fromFile) {
    const fileRevision = (fromFile[LAYOUT_REVISION_KEY] as number) ?? 0;
    const defaultRevision = (defaultLayout?.[LAYOUT_REVISION_KEY] as number) ?? 0;
    if (defaultRevision > fileRevision) {
      console.log(
        `[Agent Tycoon] Layout revision outdated (${fileRevision} < ${defaultRevision}), resetting to bundled default`,
      );
      writeLayoutToFile(defaultLayout!);
      return { layout: defaultLayout!, wasReset: true };
    }
    console.log('[Agent Tycoon] Layout loaded from file');
    return { layout: fromFile, wasReset: false };
  }

  if (defaultLayout) {
    console.log('[Agent Tycoon] Writing bundled default layout to file');
    writeLayoutToFile(defaultLayout);
    return { layout: defaultLayout, wasReset: false };
  }

  return null;
}

/**
 * Watch the office layout.json for external changes (a hand edit, another daemon).
 * Uses hybrid fs.watch + polling (same pattern as JSONL watching).
 */
export function watchLayoutFile(
  onExternalChange: (layout: Record<string, unknown>) => void,
): LayoutWatcher {
  const filePath = getLayoutFilePath();
  let skipNextChange = false;
  let lastMtime = 0;
  let fsWatcher: fs.FSWatcher | null = null;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let disposed = false;

  // Initialize lastMtime
  try {
    if (fs.existsSync(filePath)) {
      lastMtime = fs.statSync(filePath).mtimeMs;
    }
  } catch {
    /* ignore */
  }

  function checkForChange(): void {
    if (disposed) return;
    try {
      if (!fs.existsSync(filePath)) return;
      const stat = fs.statSync(filePath);
      if (stat.mtimeMs <= lastMtime) return;
      lastMtime = stat.mtimeMs;

      if (skipNextChange) {
        skipNextChange = false;
        return;
      }

      const raw = fs.readFileSync(filePath, 'utf-8');
      const layout = JSON.parse(raw) as Record<string, unknown>;
      console.log('[Agent Tycoon] External layout change detected');
      onExternalChange(layout);
    } catch (err) {
      console.error('[Agent Tycoon] Error checking layout file:', err);
    }
  }

  function startFsWatch(): void {
    if (disposed || fsWatcher) return;
    try {
      if (!fs.existsSync(filePath)) return;
      fsWatcher = fs.watch(filePath, () => {
        checkForChange();
      });
      fsWatcher.on('error', (err) => {
        // fs.watch can be unreliable on macOS (kqueue) and may hit inotify limits on Linux
        console.log(`[Agent Tycoon] Layout: fs.watch error: ${err.message}`);
        fsWatcher?.close();
        fsWatcher = null;
      });
    } catch {
      // File may not exist yet — polling will retry
    }
  }

  // Start fs.watch if file exists
  startFsWatch();

  // Polling backup (also starts fs.watch if file appears)
  pollTimer = setInterval(() => {
    if (disposed) return;
    if (!fsWatcher) {
      startFsWatch();
    }
    checkForChange();
  }, LAYOUT_FILE_POLL_INTERVAL_MS);

  return {
    markOwnWrite(): void {
      skipNextChange = true;
      // Update lastMtime preemptively so a near-instant poll doesn't miss the flag
      try {
        if (fs.existsSync(filePath)) {
          lastMtime = fs.statSync(filePath).mtimeMs;
        }
      } catch {
        /* ignore */
      }
    },
    dispose(): void {
      disposed = true;
      fsWatcher?.close();
      fsWatcher = null;
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
    },
  };
}
