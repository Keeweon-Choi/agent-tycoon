/**
 * MHO v1b (ADR-0020): the street's HTTP routes, both sides of a pairing.
 *
 * The host that is read (B):
 * - `POST /api/street/pair-code`: a pair code, for a logged-in session with a FRESH step-up (this
 *   PC's browser too: it hands out a credential) or this PC's host token (the CLI);
 * - `POST /api/street/pair` (public in the gate: the code is the credential): per client and per
 *   code 10 failures a minute (NFR-SEC-015), all failures together 20 in 10 minutes while a code is
 *   out (NFR-SEC-016); never on the LAN's plain-http listener;
 * - `GET /api/street/summary`: a request signed with a street key (the gate's one exception) or
 *   this host's own token;
 * - `DELETE /api/street/readers/:hostId`: the "옆 건물" row of the device list, revoking at once.
 *
 * The host that reads (A): `POST /api/street/neighbours {url, code}` (a remote session needs a
 * fresh step-up) and `DELETE /api/street/neighbours/:hostId`. `GET /api/street` lists both.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { refused } from '../../../core/src/agent-tycoon/serverText.js';
import { STREET_PAIR_PATH, STREET_SUMMARY_PATH } from '../../../core/src/constants.js';
import { codeKey, ipKey, isLanRequest, isLocalRequest, type StandaloneAuth } from './auth.js';
import { contextOf, hostBearerValid, requestClient, sessionFor } from './authRoutes.js';
import { STEPUP_REQUIRED } from './shell/gate.js';
import type { Street, StreetRefusal } from './street.js';

const LOCK_KEY = ['street'];
/** A pairing request is a code, a host id and a name. */
const PAIR_BODY_LIMIT = 2048;

export function registerStreetRoutes(
  app: FastifyInstance,
  opts: { street: Street; token: string; auth: StandaloneAuth },
): void {
  const { street, token, auth } = opts;

  /** Who acts: this PC's host token, or a logged-in same-origin session (else the reply is sent). */
  const caller = (request: FastifyRequest, reply: FastifyReply) => {
    if (hostBearerValid(request, token)) return { by: 'host', fresh: true, remote: false };
    const session = sessionFor(request, reply, auth);
    if (!session) return null;
    return { by: auth.actorLabel(session), fresh: auth.stepUpFresh(session), remote: !isLocalRequest(request) };
  };
  /** Another PC talks to this one over https only: never on the LAN's plain-http listener. */
  const plainHttp = (request: FastifyRequest, reply: FastifyReply) =>
    isLanRequest(request.socket) ? (reply.code(403).send(refused('street_https_only')), true) : false;
  const refuse = (reply: FastifyReply, r: StreetRefusal) => {
    const { status, ...body } = r;
    return reply.code(status).send(body);
  };

  app.post('/api/street/pair-code', async (request, reply) => {
    const who = caller(request, reply);
    if (!who) return reply;
    if (!who.fresh) return reply.code(403).send({ error: STEPUP_REQUIRED });
    auth.audit.write({ kind: 'street', detail: 'pairCode', by: who.by, ...contextOf(request) });
    reply.header('cache-control', 'no-store');
    return street.createPairCode();
  });

  app.post<{ Body: { code?: unknown; hostId?: unknown; name?: unknown } | undefined }>(
    STREET_PAIR_PATH,
    { bodyLimit: PAIR_BODY_LIMIT },
    async (request, reply) => {
      if (plainHttp(request, reply)) return reply;
      const code = typeof request.body?.code === 'string' ? request.body.code : '';
      const keys = [ipKey(requestClient(request)), codeKey(code)];
      // The global lock counts and holds only while the owner's code is out: guesses with no code
      // live cannot keep pairing locked (the review's L1).
      const live = street.codeLive();
      if (auth.limiter.blocked(keys) || (live && street.pairLock.blocked(LOCK_KEY)))
        return reply.code(429).send(refused('street_pair_rate'));
      const result = street.pair(code, request.body);
      if ('status' in result) {
        if (result.errorCode === 'street_pair_refused') {
          auth.limiter.fail(keys);
          if (live && street.pairLock.fail(LOCK_KEY)) {
            auth.audit.write({ kind: 'lockout', detail: 'street', ...contextOf(request) });
            console.warn('[Agent Tycoon] street pairing locked for 10 minutes: 20 failed codes in 10 minutes');
          }
        }
        return refuse(reply, result);
      }
      const peer = street.lists().readers.find((r) => r.hostId === String(request.body?.hostId).toLowerCase());
      auth.audit.write({
        kind: 'street',
        detail: 'paired',
        ...(peer ? { device: { id: peer.hostId, label: peer.name } } : {}),
        ...contextOf(request),
      });
      reply.header('cache-control', 'no-store');
      return result;
    },
  );

  app.get(STREET_SUMMARY_PATH, async (request, reply) => {
    if (plainHttp(request, reply)) return reply;
    const reader = street.readerOf(request.headers.authorization, request.method, STREET_SUMMARY_PATH);
    if (!reader && !hostBearerValid(request, token)) return reply.code(401).type('text/plain').send('unauthorized');
    if (reader && street.tooSoon(reader.hostId)) return reply.code(429).send();
    const summary = street.summary(reader?.hostId);
    if (!summary) return reply.code(503).send(refused('street_no_identity'));
    reply.header('cache-control', 'no-store');
    return summary;
  });

  app.get('/api/street', async (request, reply) => {
    if (!caller(request, reply)) return reply;
    reply.header('cache-control', 'no-store');
    return street.lists();
  });

  app.delete<{ Params: { hostId: string } }>('/api/street/readers/:hostId', async (request, reply) => {
    const who = caller(request, reply);
    if (!who) return reply;
    const gone = street.unpair(request.params.hostId);
    if (!gone) return reply.code(404).send(refused('street_unknown'));
    auth.audit.write({ kind: 'street', detail: 'unpaired', device: { id: gone.hostId, label: gone.name }, by: who.by, ...contextOf(request) });
    return { ok: true };
  });

  app.post<{ Body: { url?: unknown; code?: unknown } | undefined }>('/api/street/neighbours', async (request, reply) => {
    const who = caller(request, reply);
    if (!who) return reply;
    if (who.remote && !who.fresh) return reply.code(403).send({ error: STEPUP_REQUIRED });
    const result = await street.addNeighbour(request.body?.url, request.body?.code);
    if ('status' in result) return refuse(reply, result);
    const n = result.neighbour;
    auth.audit.write({ kind: 'street', detail: 'added', device: { id: n.hostId, label: n.name }, by: who.by, ...contextOf(request) });
    return result;
  });

  app.delete<{ Params: { hostId: string } }>('/api/street/neighbours/:hostId', async (request, reply) => {
    const who = caller(request, reply);
    if (!who) return reply;
    const gone = street.removeNeighbour(request.params.hostId);
    if (!gone) return reply.code(404).send(refused('street_unknown'));
    auth.audit.write({ kind: 'street', detail: 'removed', device: { id: gone.hostId, label: gone.name }, by: who.by, ...contextOf(request) });
    return { ok: true };
  });
}
