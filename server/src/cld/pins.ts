/** The conversations pinned to the top of the messenger (U-30), in ~/.config/cld-gui/pins.json. */
import * as fs from 'fs';

import type { PinnedConversations } from '../../../core/src/messages.js';
import { readJson, writeJsonAtomic } from './jsonFile.js';

export const PIN_MAX = 200;
const KEY_MAX = 200;

export class PinStore {
  private keys: string[] = [];
  constructor(readonly file: string) {
    try {
      const raw = (readJson(file) as { keys?: unknown } | null)?.keys;
      if (Array.isArray(raw)) this.keys = raw.filter((k): k is string => typeof k === 'string');
    } catch {
      try {
        fs.renameSync(file, `${file}.corrupt-${Date.now()}`);
      } catch {
        /* file disappeared */
      }
    }
  }

  /** null when stored, else why not. */
  set(key: string, pinned: boolean): string | null {
    if (!key || key.length > KEY_MAX) return '이 대화를 찾지 못했어요';
    const has = this.keys.includes(key);
    if (has === pinned) return null;
    if (pinned && this.keys.length >= PIN_MAX) return `즐겨찾기는 ${PIN_MAX}개까지예요`;
    const next = pinned ? [...this.keys, key] : this.keys.filter((k) => k !== key);
    try {
      writeJsonAtomic(this.file, { v: 1, keys: next });
    } catch (err) {
      return String(err);
    }
    this.keys = next;
    return null;
  }

  message(): PinnedConversations {
    return { type: 'pinnedConversations', keys: [...this.keys] };
  }
}
