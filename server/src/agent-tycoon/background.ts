/** The isometric office's background setting (BACKGROUND), kept in ~/.config/agent-tycoon/background.json. */
import * as fs from 'fs';

import {
  type BackgroundSettings,
  DEFAULT_BACKGROUND,
  parseBackground,
} from '../../../core/src/agent-tycoon/background.js';
import type { OfficeBackground } from '../../../core/src/messages.js';
import { readJson, writeJsonAtomic } from './jsonFile.js';

export class BackgroundStore {
  private settings: BackgroundSettings = { ...DEFAULT_BACKGROUND };
  /** Whether the owner ever saved one (an untouched office sends nothing: the screens' default holds). */
  private saved = false;
  constructor(readonly file: string) {
    try {
      const stored = parseBackground(readJson(file));
      if (stored) {
        this.settings = stored;
        this.saved = true;
      }
    } catch {
      try {
        fs.renameSync(file, `${file}.corrupt-${Date.now()}`);
      } catch {
        /* file disappeared */
      }
    }
  }

  /** null when stored, else why not. */
  set(raw: unknown): string | null {
    const next = parseBackground(raw);
    if (!next) return '배경 설정이 올바르지 않아요';
    try {
      writeJsonAtomic(this.file, next);
    } catch (err) {
      return String(err);
    }
    this.settings = next;
    this.saved = true;
    return null;
  }

  /** The setting as a message, or null while none was ever saved. */
  message(): OfficeBackground | null {
    return this.saved ? { type: 'officeBackground', ...this.settings } : null;
  }

  /** The stored (or default) setting as a message, for the answer to a refused change. */
  current(): OfficeBackground {
    return { type: 'officeBackground', ...this.settings };
  }
}
