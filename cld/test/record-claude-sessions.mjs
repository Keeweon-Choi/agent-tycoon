#!/usr/bin/env node
/**
 * Records ~/.claude/sessions/<pid>.json (what Claude Code writes per process)
 * as anonymized fixtures for the contract test in
 * server/src/cld/providers/claudeProvider.test.ts. Read-only, and never opens
 * the .key files beside them. Keys and value shapes are kept; ids, paths,
 * names and times are replaced. Every live file plus one file per other shape
 * (kind, status, name source, keys). After a Claude Code upgrade:
 *
 *   node cld/test/record-claude-sessions.mjs && (cd server && npx vitest run src/cld/providers)
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const src = path.join(os.homedir(), '.claude/sessions');
const out =
  process.argv[2] ?? path.join(path.dirname(fileURLToPath(import.meta.url)), 'claude-sessions');

function alive(d) {
  try {
    const stat = fs.readFileSync(`/proc/${d.pid}/stat`, 'utf-8');
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] === d.procStart;
  } catch {
    return false;
  }
}

const files = fs
  .readdirSync(src)
  .filter((n) => /^\d+\.json$/.test(n))
  .map((n) => JSON.parse(fs.readFileSync(path.join(src, n), 'utf-8')))
  .sort((a, b) => Number(alive(b)) - Number(alive(a)) || a.startedAt - b.startedAt);
const shapes = new Set();
const picked = files.filter((d) => {
  const shape = [d.kind, d.status, d.nameSource, Object.keys(d).sort()].join('|');
  const keep = alive(d) || !shapes.has(shape);
  shapes.add(shape);
  return keep;
});

const fake = (prefix) => {
  const seen = new Map();
  return (v) => {
    if (!seen.has(v)) seen.set(v, `${prefix}${seen.size + 1}`);
    return seen.get(v);
  };
};
const project = fake('project-');
const label = fake('session-');
const hex8 = fake('');
const t0 = Math.min(...picked.map((d) => d.startedAt));
const time = (t) => 1792550000000 + (t - t0);

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
picked.forEach((d, i) => {
  const pid = 1101 + i;
  const n = String(i + 1).padStart(12, '0');
  const job = (v) => (0xa0000000 + Number(hex8(v))).toString(16);
  const o = {};
  for (const [k, v] of Object.entries(d)) {
    if (k === 'pid') o[k] = pid;
    else if (k === 'procStart') o[k] = String(300000 + i);
    else if (k === 'sessionId') o[k] = `c0000000-0000-4000-8000-${n}`;
    else if (k === 'cwd') o[k] = `/work/${project(v)}`;
    else if (k === 'name')
      o[k] =
        v === d.jobId
          ? job(v)
          : v === 'ops'
            ? v
            : v.endsWith('-orchestrator')
              ? `${label(v)}-orchestrator`
              : label(v);
    else if (k === 'jobId' || k === 'parkedJobId') o[k] = job(v);
    else if (k === 'messagingSocketPath') o[k] = `/run/user/1000/cc-socks/${pid}.sock`;
    else if (k === 'tmux') o[k] = `office:@1.%${i + 1}`;
    else if (k === 'pidDomain') o[k] = `linux:${'0'.repeat(32)}:pid:[4026531836]`;
    else if (k === 'bridgeSessionId') o[k] = v === null ? null : `session_${n.padStart(24, '0')}`;
    else if (['startedAt', 'updatedAt', 'statusUpdatedAt', 'nameSince'].includes(k)) o[k] = time(v);
    else if (
      [
        'version',
        'peerProtocol',
        'peerFeatures',
        'kind',
        'entrypoint',
        'status',
        'nameSource',
        'agent',
        'spare',
      ].includes(k)
    )
      o[k] = v;
    else o[k] = typeof v === 'string' ? 'redacted' : typeof v === 'number' ? 0 : v; // a key this script does not know yet
  }
  fs.writeFileSync(path.join(out, `${pid}.json`), `${JSON.stringify(o, null, 1)}\n`);
  console.log(
    `${pid}.json  ${alive(d) ? 'live' : 'dead'}  ${d.kind} ${d.status}${d.spare ? ' spare' : ''}${d.parkedJobId ? ' parked' : ''}`,
  );
});
