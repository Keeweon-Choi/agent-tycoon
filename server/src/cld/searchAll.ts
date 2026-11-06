/**
 * The messenger-wide search: the words in every conversation's text (one-to-one transcripts and group
 * room posts), grouped by conversation, newest first. A PC that runs heavy work shares the daemon, so
 * the search is bounded four ways (constants.ts ALL_SEARCH_*): results in all and per conversation,
 * transcript bytes per conversation (the newest ones), and time. Conversations are read one after the
 * other, the most recently written first, so the time limit cuts the stalest; nothing is held in
 * memory but one chunk of one transcript.
 */
import * as fs from 'fs';

import { refused } from '../../../core/src/cld/serverText.js';
import type { ChatSearchAllResult } from '../../../core/src/messages.js';
import {
  ALL_SEARCH_BYTES_PER_CONVERSATION,
  ALL_SEARCH_HITS_PER_CONVERSATION,
  ALL_SEARCH_MAX_HITS,
  ALL_SEARCH_MAX_MS,
  ALL_SEARCH_ROOM_SEGMENTS,
} from '../constants.js';
import type { GroupMessages } from './engine/groupMessages.js';
import type { GroupRoom } from './engine/groups.js';
import { chatSearch, matchSnippet, searchNeedle } from './transcriptHistory.js';

type Group = ChatSearchAllResult['groups'][number];

export interface SearchAllSources {
  leads: Array<{ agentId: number; transcript: string | null }>;
  rooms: GroupRoom[];
  /** A room's own posts holding the words (GroupMessages.searchPosts). */
  roomPosts: (...args: Parameters<GroupMessages['searchPosts']>) => ReturnType<GroupMessages['searchPosts']>;
}

export interface SearchAllLimits {
  maxHits: number;
  hitsPerConversation: number;
  bytesPerConversation: number;
  maxMs: number;
  roomSegments: number;
}
export const DEFAULT_LIMITS: SearchAllLimits = {
  maxHits: ALL_SEARCH_MAX_HITS,
  hitsPerConversation: ALL_SEARCH_HITS_PER_CONVERSATION,
  bytesPerConversation: ALL_SEARCH_BYTES_PER_CONVERSATION,
  maxMs: ALL_SEARCH_MAX_MS,
  roomSegments: ALL_SEARCH_ROOM_SEGMENTS,
};

const mtime = (file: string | null): number => {
  try {
    return file ? fs.statSync(file).mtimeMs : 0;
  } catch {
    return 0;
  }
};

/** `cancelled`: a newer request replaced this one (nothing is returned). `now` and `limits` are injectable for tests. */
export async function searchAll(
  query: string,
  src: SearchAllSources,
  cancelled: () => boolean,
  limits: SearchAllLimits = DEFAULT_LIMITS,
  now: () => number = Date.now,
): Promise<Pick<ChatSearchAllResult, 'groups' | 'truncated' | 'error' | 'errorCode' | 'errorParams'>> {
  const needle = searchNeedle(query);
  if (!needle) return { groups: [], truncated: false, ...refused('search_query_length') };
  const folded = needle.toLocaleLowerCase();
  const until = now() + limits.maxMs;
  const timeUp = () => now() >= until;
  const groups: Group[] = [];
  let total = 0;
  let truncated = false;
  const room = (left: number) => Math.min(limits.hitsPerConversation, left);

  for (const r of src.rooms) {
    if (cancelled()) return { groups: [], truncated: false };
    if (timeUp() || total >= limits.maxHits) {
      truncated = true;
      break;
    }
    const found = src.roomPosts(r, folded, {
      segments: limits.roomSegments,
      maxHits: room(limits.maxHits - total),
      cancelled,
      snippet: (text) => matchSnippet(text, folded, true),
    });
    if (found.hits.length) {
      groups.push({
        roomId: r.id,
        hits: found.hits.map((h) => ({
          id: h.id,
          at: h.at,
          kind: h.sender === null ? 'user' : 'assistant',
          snippet: h.snippet,
          ...(h.sender !== null && { sender: h.sender }),
        })),
        more: found.truncated,
      });
      total += found.hits.length;
    }
    truncated ||= found.truncated;
  }

  const leads = src.leads
    .filter((l) => l.transcript)
    .map((l) => ({ ...l, at: mtime(l.transcript) }))
    .sort((a, b) => b.at - a.at);
  for (const lead of leads) {
    if (cancelled()) return { groups: [], truncated: false };
    if (timeUp() || total >= limits.maxHits) {
      truncated = true;
      break;
    }
    const page = await chatSearch(lead.transcript, needle, {
      bounded: true,
      byteBudget: limits.bytesPerConversation,
      maxHits: room(limits.maxHits - total),
      cancelled,
      stop: timeUp,
    });
    if (page.hits.length) {
      groups.push({ agentId: lead.agentId, hits: page.hits, more: page.truncated });
      total += page.hits.length;
    }
    truncated ||= page.truncated;
  }
  groups.sort((a, b) => b.hits[0].at - a.hits[0].at);
  return { groups, truncated };
}
