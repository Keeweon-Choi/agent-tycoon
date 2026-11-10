/**
 * MHO §3.4 (H1, ADR-0020): the street summary, one shape both daemons read through the same
 * normalizer. The host that answers builds it from memory and passes it through here; the host
 * that asks parses what came back here. Names and states and a count only: no conversation, tool,
 * path, token or anything else ever has a field in it (unknown fields are dropped).
 */
import {
  STREET_AGENTS_MAX,
  STREET_NAME_MAX,
  STREET_SUMMARY_PATH,
  STREET_SUMMARY_VERSION,
  STREET_VERSION_MAX,
} from '../constants.js';
import type { ServerTextCode } from './serverText.js';

export const STREET_AGENT_STATES = ['working', 'waiting', 'idle', 'off'] as const;
/** `waiting`: waits on the owner (a permission or a question). */
export type StreetAgentState = (typeof STREET_AGENT_STATES)[number];

export interface StreetAgent {
  name: string;
  state: StreetAgentState;
}

export interface StreetSummary {
  v: typeof STREET_SUMMARY_VERSION;
  hostId: string;
  name: string;
  version: string;
  agents: StreetAgent[];
  /** How many agents wait on the owner. */
  waiting: number;
}

const HOST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
/** A host id as host.json makes it (a UUID). */
export const isHostId = (value: unknown): value is string => typeof value === 'string' && HOST_ID.test(value);

/** Controls and what hides or reorders text (the device-nickname rule's set, auth.ts). */
const HIDDEN = /[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]/g;

/** A name as a summary carries it: one line, no hidden characters, at most `max` characters. */
export function streetName(raw: unknown, fallback = '', max = STREET_NAME_MAX): string {
  if (typeof raw !== 'string') return fallback;
  const name = [...raw.replace(HIDDEN, ' ').replace(/\s+/g, ' ').trim()].slice(0, max).join('').trim();
  return name || fallback;
}

/** The summary with every cap applied and only its known fields, or null when it is not one. */
export function normalizeStreetSummary(raw: unknown): StreetSummary | null {
  const r = raw as Partial<Record<keyof StreetSummary, unknown>> | null;
  if (!r || typeof r !== 'object' || r.v !== STREET_SUMMARY_VERSION || !isHostId(r.hostId) || !Array.isArray(r.agents))
    return null;
  const agents = (r.agents as unknown[])
    .flatMap((a): StreetAgent[] => {
      const { name, state } = (a ?? {}) as { name?: unknown; state?: unknown };
      const ok = (STREET_AGENT_STATES as readonly unknown[]).includes(state);
      return ok ? [{ name: streetName(name, '?'), state: state as StreetAgentState }] : [];
    })
    // Waiting ones first, so the cap never hides one.
    .sort((a, b) => Number(b.state === 'waiting') - Number(a.state === 'waiting'))
    .slice(0, STREET_AGENTS_MAX);
  return {
    v: STREET_SUMMARY_VERSION,
    hostId: r.hostId.toLowerCase(),
    name: streetName(r.name),
    version: streetName(r.version, '', STREET_VERSION_MAX),
    agents,
    waiting: agents.filter((a) => a.state === 'waiting').length,
  };
}

/**
 * The address of another PC's daemon as the owner typed it (its invitation address, which may carry
 * the direct connector's secret path), without a trailing slash; or why not. https only: plain http
 * between PCs is refused (owner 11-06 18:36, Q4), and no user, password, query or fragment.
 */
export function neighbourUrl(raw: unknown): { url: string } | { error: ServerTextCode } {
  let url: URL;
  try {
    url = new URL(typeof raw === 'string' ? raw.trim() : '');
  } catch {
    return { error: 'street_url_bad' };
  }
  if (url.protocol === 'http:') return { error: 'street_https_only' };
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash)
    return { error: 'street_url_bad' };
  return { url: `${url.origin}${url.pathname.replace(/\/+$/, '')}` };
}

/**
 * ADR-0020: what a street token opens, the whole of it. The gate (authRoutes.ts) asks this, so a
 * test can widen it and see the route walk catch the leak (an object, so it can be spied on).
 */
export const STREET_GATE = {
  opens: (method: string, pathname: string): boolean => method === 'GET' && pathname === STREET_SUMMARY_PATH,
};
