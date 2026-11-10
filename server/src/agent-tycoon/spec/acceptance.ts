/**
 * SPT-P3-ACCEPT §5.3: a project's acceptance records, `<settings directory>/spec/<projectId>/acceptance.json`
 * (0600 in 0700, tmp + rename, `v:1`; the daemon is the only writer; backed up by name). Append-only:
 * each record is the owner's judgement of one requirement version (its `textHash`) with the four
 * evidence marks of that moment. Nothing is ever deleted here: the file goes only with the project's
 * whole spec folder (purgeSpecData), as links.json does. A file this store cannot read is `corrupt`:
 * left as it is, never written over, every acceptance write refused.
 */
import * as path from 'path';

import type { Acceptance, TraceAcceptanceWeek, TraceEvidence } from '../../../../core/src/agent-tycoon/spec/trace.js';
import { SPEC_ACCEPT_WEEKS_PAST } from '../../constants.js';
import { readJson } from '../jsonFile.js';
import { type LinkBy, writeSpecJson } from './links.js';
import { specDirectory } from './store.js';

export const ACCEPTANCE_VERSION = 1;
export const ACCEPTANCE_STATES = ['none', 'validate', 'accepted', 'rejected'] as const;

export interface AcceptanceRecord {
  uid: string;
  /** The requirement's text when judged: a new text starts again from 검토 전. */
  textHash: string;
  state: Acceptance;
  /** Masked, at most SPEC_LINK_NOTE_MAX characters; required for 'rejected'. */
  note?: string;
  by: LinkBy;
  at: string;
  /** The four marks and 완료 보고 at that moment. */
  evidence: TraceEvidence;
}

export interface AcceptanceFile {
  v: typeof ACCEPTANCE_VERSION;
  /** Bumped on every save; `specChanged` carries it with the Registry's and the links'. */
  rev: number;
  /** In the order written. */
  records: AcceptanceRecord[];
}

export type LoadedAcceptance = { file: AcceptanceFile; corrupt: string | null };

export const acceptanceFile = (home: string, projectId: string): string => path.join(specDirectory(home, projectId), 'acceptance.json');
export const emptyAcceptance = (): AcceptanceFile => ({ v: ACCEPTANCE_VERSION, rev: 0, records: [] });

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const validRecord = (r: unknown): r is AcceptanceRecord =>
  isObject(r) &&
  typeof r.uid === 'string' &&
  typeof r.textHash === 'string' &&
  (ACCEPTANCE_STATES as readonly unknown[]).includes(r.state) &&
  (r.note === undefined || typeof r.note === 'string') &&
  isObject(r.by) &&
  typeof r.by.name === 'string' &&
  typeof r.at === 'string' &&
  isObject(r.evidence);

/** The project's records (none yet: empty); corrupt (why) when the file is not one, then an empty view that is never saved. */
export function readAcceptance(file: string): LoadedAcceptance {
  let raw: unknown;
  try {
    raw = readJson(file);
  } catch (err) {
    return { file: emptyAcceptance(), corrupt: err instanceof Error ? err.message : String(err) };
  }
  if (raw === null) return { file: emptyAcceptance(), corrupt: null };
  if (!isObject(raw) || raw.v !== ACCEPTANCE_VERSION || typeof raw.rev !== 'number' || !Array.isArray(raw.records))
    return { file: emptyAcceptance(), corrupt: `not a v${ACCEPTANCE_VERSION} acceptance file` };
  const bad = raw.records.findIndex((r) => !validRecord(r));
  if (bad >= 0) return { file: emptyAcceptance(), corrupt: `a bad acceptance record (#${bad})` };
  return { file: { v: ACCEPTANCE_VERSION, rev: raw.rev, records: raw.records as AcceptanceRecord[] }, corrupt: null };
}

export const writeAcceptance = (file: string, a: AcceptanceFile): void => writeSpecJson(file, a);

/**
 * One requirement's acceptance now (SPT §5.3-5.4), per version: only each textHash's latest record
 * counts. `current` is the current text's (else 'none'). 수용 재검토 (`review`) holds when the current
 * text has no record and the newest older version's latest record is a judgement (not 'none': a
 * withdrawn judgement stays withdrawn); `previous` is that record, only then. A text changed back
 * finds its own record again; recording 검토 전 on the current text clears the review.
 */
export function acceptanceNow(records: readonly AcceptanceRecord[], textHash: string): { current: Acceptance; previous?: { state: Acceptance; at: string }; review: boolean } {
  let onNow: AcceptanceRecord | undefined;
  let older: AcceptanceRecord | undefined;
  // The last record of a hash is that version's latest; the last record of any other hash is the newest older version's latest.
  for (let i = records.length - 1; i >= 0 && !(onNow && older); i--) {
    if (records[i].textHash === textHash) onNow ??= records[i];
    else older ??= records[i];
  }
  const review = !onNow && !!older && older.state !== 'none';
  return { current: onNow?.state ?? 'none', ...(review && { previous: { state: older!.state, at: older!.at } }), review };
}

const DAYS = 7;
const dayKey = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/**
 * GAME-UI-1: 이번 주 수락 (TraceAcceptanceWeek) in `now`'s local time, Monday first. Read from the
 * newest record back, stopping at the first one before the oldest week counted: each (day, uid)
 * counts once, by its last record that day (accepted or rejected; 검토 전·검증 필요 not at all).
 */
export function acceptanceWeek(records: readonly AcceptanceRecord[], now: Date, past = SPEC_ACCEPT_WEEKS_PAST): TraceAcceptanceWeek {
  const today = (now.getDay() + DAYS - 1) % DAYS;
  const total = (past + 1) * DAYS;
  // Local midnights from the oldest week's Monday (Date fixes month ends and DST).
  const day = (i: number) => new Date(now.getFullYear(), now.getMonth(), now.getDate() - today - past * DAYS + i);
  const index = new Map(Array.from({ length: total }, (_, i) => [dayKey(day(i)), i] as const));
  const from = day(0).getTime();
  const counts = Array.from({ length: total }, () => ({ accepted: 0, rejected: 0 }));
  const seen = new Set<string>();
  for (let i = records.length - 1; i >= 0; i--) {
    const r = records[i];
    const at = new Date(r.at);
    if (at.getTime() < from) break; // written in order: everything before is older
    const d = index.get(dayKey(at));
    if (d === undefined || seen.has(`${d}:${r.uid}`)) continue; // a later week (clock moved back) or not the day's last
    seen.add(`${d}:${r.uid}`);
    if (r.state === 'accepted' || r.state === 'rejected') counts[d][r.state]++;
  }
  const weeks = Array.from({ length: past }, (_, w) => counts.slice(w * DAYS, (w + 1) * DAYS).reduce((n, c) => n + c.accepted, 0));
  return { start: dayKey(day(past * DAYS)), today, days: counts.slice(past * DAYS), weeks };
}
