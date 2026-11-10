'use strict';
/**
 * Who is calling over the engine's control socket (SEC-CONTROL, agent-tycoon/docs/design/security.md §8).
 *
 * Three callers: an agent (its AGTY_AGENT_TOKEN, agentTokens.ts), the owner (the token in
 * `<config>/owner-token`, 0600, made by the daemon), and everyone else (unidentified: the least
 * privilege). The daemon checks both tokens; this module is also what the owner's CLI (`agty`,
 * agent-tycoon/bin/agty) and the manager (agent-tycoon/install/manager.mjs) use to decide what to send.
 *
 * The CLI sends the owner token only when nothing this daemon started is in the caller's line:
 * no AGTY_AGENT_TOKEN the daemon issued (agent-tokens.json) and no AGTY_JOB_ID of one of its jobs,
 * in the caller's environment or, on Linux, in the starting environment of any ancestor
 * (/proc/<pid>/environ). So an agent that drops or fakes AGTY_AGENT_TOKEN, or runs `agty` through
 * `agty job`, is still not the owner (the ancestor's token even keeps it the same agent).
 *
 * ponytail: a guardrail, not a boundary. Every process of this OS user can read owner-token and
 * write its own control-socket client; a process that leaves the agent's process tree on purpose
 * (setsid + double fork) is no longer seen as inside it; macOS and Windows have no /proc here, so
 * there only the caller's own environment counts. What it stops is an agent becoming the owner by
 * accident or by dropping an environment variable.
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { configDirectory, stateDirectory } = require('./configPath.cjs');

const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const JOB_ID_RE = /^\d{4}-\d{6}-[A-Za-z0-9가-힣._-]{1,48}$/;
const MAX_HOPS = 64;

const sha256 = (s) => crypto.createHash('sha256').update(s).digest();
const ownerTokenPath = (home) => path.join(configDirectory(home), 'owner-token');

/** server/src/agent-tycoon/engine/jobs.ts jobsDir (controlIdentity.test.ts keeps them equal). */
function jobsFolder(home, platform = process.platform, env = process.env) {
  return path.join(stateDirectory(home, platform, env), 'jobs');
}

/** The owner token, or null (none yet, unreadable, not one). */
function readOwnerToken(home) {
  try {
    const t = fs.readFileSync(ownerTokenPath(home), 'utf8').trim();
    return TOKEN_RE.test(t) ? t : null;
  } catch {
    return null;
  }
}

/**
 * The daemon's side: the owner token, made when there is none (32 random bytes, 0600, written
 * under a private name and then linked into place, so a reader never sees half a file and two
 * daemons starting together end up with the one token). A file that is not a token is replaced.
 */
function ensureOwnerToken(home) {
  const have = readOwnerToken(home);
  if (have) return have;
  const file = ownerTokenPath(home);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, `${crypto.randomBytes(32).toString('base64url')}\n`, { mode: 0o600, flag: 'wx' });
  try {
    try {
      fs.linkSync(tmp, file);
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      if (!readOwnerToken(home)) fs.renameSync(tmp, file); // there, but not a token
    }
  } finally {
    fs.rmSync(tmp, { force: true });
  }
  const t = readOwnerToken(home);
  if (!t) throw new Error(`${file}: no owner token`);
  return t;
}

/** The daemon's side: `given` is the owner token (constant time). */
function ownerTokenMatches(home, given) {
  if (typeof given !== 'string' || !TOKEN_RE.test(given)) return false;
  let mine;
  try {
    mine = ensureOwnerToken(home);
  } catch {
    return false;
  }
  return crypto.timingSafeEqual(sha256(mine), sha256(given));
}

/** sha256 hex of every agent token the daemon of `home` issued (agentTokens.ts' file). */
function agentTokenHashes(home) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(configDirectory(home), 'agent-tokens.json'), 'utf8'));
    return new Set(Object.values(j?.tokens ?? {}).filter((h) => typeof h === 'string'));
  } catch {
    return new Set();
  }
}

/** AGTY_AGENT_TOKEN and AGTY_JOB_ID of a /proc environ block (NUL separated). */
function markersOf(block) {
  const out = {};
  const TOKEN = 'AGTY_AGENT_TOKEN=';
  const JOB = 'AGTY_JOB_ID=';
  for (const kv of block.split('\0')) {
    if (kv.startsWith(TOKEN)) out.token = kv.slice(TOKEN.length);
    else if (kv.startsWith(JOB)) out.job = kv.slice(JOB.length);
  }
  return out;
}

/** The starting environments of this process and its ancestors, nearest first (Linux only). */
function lineEnvironments(o) {
  if ((o.platform ?? process.platform) !== 'linux') return [];
  const proc = o.proc ?? '/proc';
  const out = [];
  let pid = o.pid ?? process.pid;
  for (let hop = 0; hop < MAX_HOPS && pid > 1; hop++) {
    try {
      out.push(markersOf(fs.readFileSync(path.join(proc, String(pid), 'environ'), 'latin1')));
    } catch {
      /* another user's (init, sshd): its environment is not ours to read */
    }
    let stat;
    try {
      stat = fs.readFileSync(path.join(proc, String(pid), 'stat'), 'utf8');
    } catch {
      break;
    }
    // "pid (comm) state ppid ...": comm may hold spaces and parentheses.
    const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
    if (!Number.isInteger(ppid) || ppid === pid) break;
    pid = ppid;
  }
  return out;
}

/**
 * What a caller of the daemon of `home` sends: `token` (an agent's) and `owner` (the owner
 * token, only when no agent or job of this daemon is in its line). `o` is for tests
 * (`proc`, `pid`, `platform`).
 */
function callerIdentity(home, env = process.env, o = {}) {
  const platform = o.platform ?? process.platform;
  const own = { token: env.AGTY_AGENT_TOKEN || undefined, job: env.AGTY_JOB_ID || undefined };
  const known = agentTokenHashes(home);
  const jobs = jobsFolder(home, platform, env);
  const isAgent = (m) => !!m.token && known.has(sha256(m.token).toString('hex'));
  const isJob = (m) => !!m.job && JOB_ID_RE.test(m.job) && fs.existsSync(path.join(jobs, `${m.job}.json`));
  for (const m of [own, ...lineEnvironments({ ...o, platform })]) {
    if (isAgent(m)) return { token: m.token };
    if (isJob(m)) return own.token ? { token: own.token } : {};
  }
  // Nothing of this daemon's: the owner (a token in env here is another daemon's, a test's).
  const owner = readOwnerToken(home);
  return { ...(own.token && { token: own.token }), ...(owner && { owner }) };
}

module.exports = {
  callerIdentity,
  ensureOwnerToken,
  jobsFolder,
  ownerTokenMatches,
  ownerTokenPath,
  readOwnerToken,
};
