/** The memos on the office's whiteboards (T-0065), by furniture uid, in ~/.config/agent-tycoon/memos.json. */
import * as fs from 'fs';

import type { WhiteboardMemos } from '../../../core/src/messages.js';
import { readJson, writeJsonAtomic } from './jsonFile.js';

export const MEMO_MAX = 600;

export interface Memo {
  text: string;
  updatedAt: number;
  by: string;
}
interface MemosFile {
  v: 1;
  memos: Record<string, Memo>;
}

/** Uid-keyed records without a prototype: a uid such as `constructor` is only a key. */
const dict = (): Record<string, Memo> => Object.create(null) as Record<string, Memo>;

export class MemoStore {
  private memos = dict();
  constructor(readonly file: string) {
    let raw: unknown;
    try {
      raw = readJson(file);
    } catch {
      const aside = `${file}.corrupt-${Date.now()}`;
      try {
        fs.renameSync(file, aside);
      } catch {
        /* file disappeared */
      }
      console.warn(`[cld] memos: invalid JSON moved to ${aside}`);
      return;
    }
    const entries = (raw as Partial<MemosFile> | null)?.memos;
    if (!entries || typeof entries !== 'object') return;
    for (const [uid, m] of Object.entries(entries)) {
      if (m && typeof m.text === 'string' && m.text && Number.isFinite(m.updatedAt))
        this.memos[uid] = { text: m.text, updatedAt: m.updatedAt, by: String(m.by ?? '') };
    }
  }

  /** `text` trimmed (empty erases the memo); null when stored, else why not. */
  set(uid: string, text: string, by: string, now = Date.now()): string | null {
    const trimmed = text.replace(/\r\n?/g, '\n').trim();
    if (trimmed.length > MEMO_MAX) return `메모는 ${MEMO_MAX}자까지예요`;
    const next = { ...this.memos };
    if (trimmed) next[uid] = { text: trimmed, updatedAt: now, by };
    else delete next[uid];
    try {
      writeJsonAtomic(this.file, { v: 1, memos: next } satisfies MemosFile);
    } catch (err) {
      return String(err);
    }
    this.memos = Object.assign(dict(), next);
    return null;
  }

  message(): WhiteboardMemos {
    return {
      type: 'whiteboardMemos',
      memos: Object.entries(this.memos).map(([uid, m]) => ({
        uid,
        text: m.text,
        updatedAt: m.updatedAt,
      })),
    };
  }
}
