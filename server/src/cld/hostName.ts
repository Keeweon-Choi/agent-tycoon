/**
 * MHO 3.6: this host's display name, kept next to its id in host.json (engine/host.ts). Set in
 * 설정 > 일반, else the machine's name. It is shown in the tab title and on the login page, where a
 * person decides where to type a code, so it passes the device-nickname rule (no bidi, zero-width or
 * line-separator characters, at most 40) both when it is set and when a hand-edited file is read.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import * as os from 'os';

import { refused } from '../../../core/src/cld/serverText.js';
import { validNickname } from './auth.js';
import { sameOriginRequest } from './authRoutes.js';
import { type HostFile, hostPath, readHost } from './engine/host.js';
import { writeJsonAtomic } from './jsonFile.js';
import { STEPUP_REQUIRED } from './shell/gate.js';

/** Its id and display name, for hostInfo. Only reads: the daemon made host.json at start. */
export function hostLabel(home: string): { hostId?: string; hostName: string } {
  const host = readHost(home);
  const hostName = validNickname(host?.name) ?? os.hostname();
  return host ? { hostId: host.hostId, hostName } : { hostName };
}

/** Set (or with '' clear) the display name, keeping the id. False: no valid host.json, or not written. */
export function setHostName(home: string, name: string): boolean {
  const host = readHost(home);
  if (!host) return false;
  const next: HostFile = { v: 1, hostId: host.hostId, createdAt: host.createdAt, ...(name ? { name } : {}) };
  try {
    writeJsonAtomic(hostPath(home), next);
    return true;
  } catch {
    return false;
  }
}

/**
 * POST /api/cld/host-name { name } ('' goes back to the machine's name). Like the other settings
 * routes: same origin, and a remote device needs a fresh step-up. A label, not an action on agents:
 * --read-only (the default without --allow-actions) allows it. `changed`: tell every client.
 */
export function registerHostNameRoute(
  app: FastifyInstance,
  home: string,
  changed: () => void,
  auth: (request: FastifyRequest, reply: FastifyReply) => Promise<void>,
  stepUpFresh?: (request: FastifyRequest) => boolean,
  kindOf?: (request: FastifyRequest) => { host: boolean; remote: boolean },
  actorOf?: (request: FastifyRequest) => string | undefined,
): void {
  app.post<{ Body: { name?: unknown } | undefined }>(
    '/api/cld/host-name',
    { preHandler: auth },
    async (request, reply) => {
      const k = kindOf?.(request) ?? { host: false, remote: true }; // unknown: the careful one
      if (!k.host && !sameOriginRequest(request)) return reply.code(403).send(refused('origin_mismatch'));
      const raw = request.body?.name;
      const name = raw === '' ? '' : validNickname(raw);
      if (name === null) return reply.code(400).send(refused('host_name_bad'));
      if (k.remote && !stepUpFresh?.(request)) return reply.code(403).send({ error: STEPUP_REQUIRED });
      if (!setHostName(home, name)) return reply.code(500).send(refused('save_failed', { why: 'host.json' }));
      console.log(`[Agent Tycoon] host name set by ${actorOf?.(request) ?? 'device'}`);
      changed();
      return { ok: true, hostName: hostLabel(home).hostName };
    },
  );
}
