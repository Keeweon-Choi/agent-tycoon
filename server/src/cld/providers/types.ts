/**
 * Normalized world model (SAD 6.6, ADR-0011): what the providers give the
 * office. The Claude provider needs only Claude Code; the built-in engine
 * adds its projects on top. Wire names stay `officeState` etc. for now (T-0033c).
 */
import type { OfficeOrchestrator, OfficeRoom } from '../../../../core/src/messages.js';

/** Data kinds the office can supply; a missing one hides that feature (no message is sent). */
export type Capability = 'agents' | 'hw' | 'usage';

/** One character-bearing session (an engine project or any Claude session). */
export interface AgentEntry extends Omit<OfficeOrchestrator, 'agentId'> {
  /** Stable character key: the same key keeps the same character across refreshes. */
  key: string;
  /** Transcript JSONL that drives the character, or null (idle synthetic). */
  transcript: string | null;
}

export interface World {
  /** Rooms in display order (project groups). */
  rooms: OfficeRoom[];
  agents: AgentEntry[];
}

/** Values of the fields only some entries fill in. */
export const ENTRY_DEFAULTS = {
  title: null,
  bg: null,
  compactions: 0,
  alive: false,
} as const;
