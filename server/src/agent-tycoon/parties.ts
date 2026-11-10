/**
 * FEAT-PARTY-V2: the parties the owner composes in the party column, in ~/.config/agent-tycoon/parties.json,
 * so the desktop app and the phone see the same ones. The default party (everyone) is the screen's own and
 * never stored. Tiny data, written only on a change.
 */
import * as fs from 'fs';

import {
  PARTY_DEFAULT_ID,
  PARTY_ID_MAX,
  PARTY_MAX,
  PARTY_MEMBER_KEY_MAX,
  PARTY_MEMBER_MAX,
  PARTY_NAME_MAX,
} from '../../../core/src/constants.js';
import type { Parties, Party } from '../../../core/src/messages.js';
import { readJson, writeJsonAtomic } from './jsonFile.js';

const str = (v: unknown, max: number): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;

/** The parties as sent or stored, cleaned (names trimmed, members unique), or why not. */
export function cleanParties(raw: unknown): Party[] | string {
  if (!Array.isArray(raw) || raw.length > PARTY_MAX) return `파티는 ${PARTY_MAX}개까지예요`;
  const ids = new Set<string>();
  const out: Party[] = [];
  for (const p of raw as Array<Record<string, unknown> | null>) {
    const name = typeof p?.name === 'string' ? p.name.trim() : '';
    if (!p || !str(p.id, PARTY_ID_MAX) || p.id === PARTY_DEFAULT_ID || ids.has(p.id)) return '파티를 찾지 못했어요';
    if (!str(name, PARTY_NAME_MAX)) return `파티 이름은 1~${PARTY_NAME_MAX}자예요`;
    const members = Array.isArray(p.members) ? p.members : null;
    if (!members || members.length > PARTY_MEMBER_MAX || !members.every((m) => str(m, PARTY_MEMBER_KEY_MAX)))
      return `파티 인원은 ${PARTY_MEMBER_MAX}명까지예요`;
    ids.add(p.id);
    out.push({ id: p.id, name, members: [...new Set(members as string[])] });
  }
  return out;
}

export class PartyStore {
  private parties: Party[] = [];
  constructor(readonly file: string) {
    try {
      const got = cleanParties((readJson(file) as { parties?: unknown } | null)?.parties ?? []);
      if (typeof got !== 'string') this.parties = got;
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
    const next = cleanParties(raw);
    if (typeof next === 'string') return next;
    try {
      writeJsonAtomic(this.file, { v: 1, parties: next });
    } catch (err) {
      return String(err);
    }
    this.parties = next;
    return null;
  }

  message(): Parties {
    return { type: 'parties', parties: this.parties.map((p) => ({ ...p, members: [...p.members] })) };
  }
}
