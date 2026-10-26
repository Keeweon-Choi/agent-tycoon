/**
 * Safe update and rollback (H §6, roadmap P3). Reuses the manager's verify/unpack/service/record code.
 *
 *   update:   source (download | release folder | bundle) -> signature + SHA-256 + OS/CPU (verify.mjs)
 *             -> new version folder -> self-test with the new runtime -> compatibility (manifest)
 *             -> stop the old daemon (agent sessions are separate processes and keep running)
 *             -> rollback snapshot of ~/.config/cld-gui when dataSchema differs -> switch `current`
 *             -> start -> health with the new version + engine takeover -> keep two old versions.
 *             Any failure after the stop: pointer back, snapshot restored if the data may have
 *             changed, old version started, the version marked failed (never retried without --force).
 *   rollback: the same switch to `previous`; when the data format differs it restores the snapshot
 *             taken before `current` was installed (and snapshots the data it replaces first).
 *
 * install.json `update` holds the step BEFORE it runs ({ kind, from, to, step, snapshot, touched });
 * the next `agty update` (with or without --from) finishes or reverts an interrupted one.
 * This module only uses the manager's bindings inside functions (manager.mjs imports it back).
 */
import { createHash, randomUUID } from 'node:crypto';
import fssync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

import { BUNDLE_RE, verifyBundle, verifySums } from '../release/bundle/verify.mjs';
import { configPath, mergeConfig } from './install.mjs';
import {
  acquireLock, daemonIdentity, inside, installRoot, ownedCopy, pinnedKey, pruneEmptyDirs, readConfig, readCurrent, readRecord, realDeps, releaseKey,
  renderService, rootPlatform, selfTest, serviceNodeDirs, serviceOp, switchCurrent, unpack, versionDir, versionFiles, waitHealthy, writeOwned, writeRecord,
} from './manager.mjs';

/** Old versions kept after a successful update (H §6.1 step 10). */
export const KEEP_OLD = 2;
const sha256 = (text) => createHash('sha256').update(text).digest('hex');
const target = (deps) => ({ os: { win32: 'win', wsl: 'linux' }[deps.platform] ?? deps.platform, arch: deps.arch ?? process.arch });
const bundleName = (version, t) => `agent-tycoon-daemon-${version}-${t.os}-${t.arch}.tar.gz`;
const isUrl = (from) => /^https?:\/\//i.test(from);
const readManifest = async (root, version) => JSON.parse(await fs.readFile(path.join(versionDir(root, version), 'manifest.json'), 'utf8'));
const dataDir = (home) => path.dirname(configPath(home));
const live = (record) => !['dry-run', 'none'].includes(record.service?.kind);
const platformError = (message, version, t) => Object.assign(new Error(`${message}; this machine (${t.os}-${t.arch}) needs ${bundleName(version ?? '<version>', t)} (or .tar.zst) from the same release`), { code: 'PLATFORM' });

// ── Compatibility (H §6.2) ───────────────────────────────────────────────────

/** Semver order (1.2.0-rc.1 < 1.2.0 < 1.10.0); build metadata ignored. <0, 0, >0. */
export function compareVersions(a, b) {
  const parse = (v) => { const [main, ...pre] = String(v).split('+')[0].split('-'); return { main: main.split('.').map(Number), pre: pre.length ? pre.join('-').split('.') : [] }; };
  const x = parse(a); const y = parse(b);
  for (let i = 0; i < Math.max(x.main.length, y.main.length); i += 1) if ((x.main[i] ?? 0) !== (y.main[i] ?? 0)) return (x.main[i] ?? 0) - (y.main[i] ?? 0);
  if (!x.pre.length || !y.pre.length) return y.pre.length - x.pre.length; // a release is above its pre-releases
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i += 1) {
    const p = x.pre[i]; const q = y.pre[i];
    if (p === undefined || q === undefined) return p === undefined ? -1 : 1;
    if (p === q) continue;
    const np = /^\d+$/.test(p); const nq = /^\d+$/.test(q);
    if (np && nq) return Number(p) - Number(q);
    return np ? -1 : nq ? 1 : p < q ? -1 : 1;
  }
  return 0;
}

/**
 * errors: `to` cannot replace `from` (no protocol, or it reads an older data format than `from` wrote).
 * dataChanges: any dataSchema entry differs, so the new daemon migrates and a snapshot is needed.
 * ponytail: minApp/maxApp are shown, not checked; the manager learns the desktop app's version in P5.
 */
export function compatibility(from, to) {
  const errors = []; const warnings = [];
  if (!Number.isInteger(to.protocol)) errors.push(`${to.version} manifest.json has no protocol`);
  else if (Number.isInteger(from.protocol) && from.protocol !== to.protocol) warnings.push(`health protocol ${from.protocol} -> ${to.protocol}: the desktop app must support it (app ${to.minApp ?? '?'} – ${to.maxApp ?? 'any'})`);
  const a = from.dataSchema ?? {}; const b = to.dataSchema ?? {};
  const older = Object.keys(a).filter((file) => !(Number(b[file]) >= Number(a[file])));
  if (older.length) errors.push(`${to.version} reads older data formats (${older.map((file) => `${file} ${a[file]} -> ${b[file] ?? 'none'}`).join(', ')})`);
  const dataChanges = [...new Set([...Object.keys(a), ...Object.keys(b)])].some((file) => a[file] !== b[file]);
  return { errors, warnings, dataChanges };
}

// ── Where the release comes from ─────────────────────────────────────────────

/** Bundles for this machine named in a SHA256SUMS text (selection only; verify.mjs checks the one picked). */
function pickBundle(sumsText, t, where) {
  const all = sumsText.split('\n').map((line) => BUNDLE_RE.exec(/^[0-9a-f]{64} {2}(\S+)$/.exec(line)?.[1] ?? '')).filter(Boolean);
  const mine = all.filter((m) => m[2] === t.os && m[3] === t.arch);
  if (mine.length === 1) return { name: mine[0][0], version: mine[0][1] };
  if (mine.length > 1) throw new Error(`${where} lists ${mine.length} bundles for ${t.os}-${t.arch}; pass the bundle file itself`);
  throw platformError(`${where} has no bundle for this machine (${all.map((m) => m[0]).join(', ') || 'none listed'})`, all[0]?.[1], t);
}

async function download(deps, url, file) {
  const r = await (deps.fetch ?? fetch)(url, { signal: AbortSignal.timeout(10 * 60_000) });
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  await fs.writeFile(`${file}.part`, Buffer.from(await r.arrayBuffer()));
  await fs.rename(`${file}.part`, file);
}

function trustedKey(o, root) {
  const key = releaseKey(o, root, '');
  if (key.keyBeside) throw new Error(`no release key is pinned in ${pinnedKey(root)}: pass --pub <release key file> (it is pinned after a successful update); a key from the release itself proves nothing`);
  return key;
}

/** { bundle, sums, sig, pubkey, version, downloaded } from a URL (into <root>/downloads), a release folder, or a bundle file. */
async function source(o, root, deps) {
  const t = target(deps);
  if (isUrl(o.from)) {
    // A key fetched from the same server proves nothing: only --pub or the key pinned at install (never downloaded).
    const key = trustedKey(o, root);
    const file = path.posix.basename(new URL(o.from).pathname);
    const named = BUNDLE_RE.exec(file);
    const base = named ? o.from.slice(0, o.from.lastIndexOf('/')) : o.from.replace(/\/+$/, '');
    const dir = path.join(root, 'downloads', randomUUID());
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    try {
      for (const f of ['SHA256SUMS', 'SHA256SUMS.sig']) await download(deps, `${base}/${f}`, path.join(dir, f));
      const pick = named ? { name: file, version: named[1] } : pickBundle(await fs.readFile(path.join(dir, 'SHA256SUMS'), 'utf8'), t, base);
      if (!o.check) await download(deps, `${base}/${pick.name}`, path.join(dir, pick.name));
      return { bundle: path.join(dir, pick.name), sums: path.join(dir, 'SHA256SUMS'), sig: path.join(dir, 'SHA256SUMS.sig'), pubkey: key.pubkey, version: pick.version, downloaded: dir, base };
    } catch (error) {
      await fs.rm(dir, { recursive: true, force: true });
      if (error.code === 'PLATFORM') throw error;
      throw Object.assign(new Error(`download failed (${error.message}): the partial download was deleted and nothing installed was changed; try again later`), { code: 'NETWORK' });
    }
  }
  const from = path.resolve(o.from);
  const dir = fssync.statSync(from).isDirectory() ? from : path.dirname(from);
  const sums = path.resolve(o.sums ?? path.join(dir, 'SHA256SUMS'));
  const pick = dir === from ? pickBundle(await fs.readFile(sums, 'utf8'), t, from) : { name: path.basename(from), version: BUNDLE_RE.exec(path.basename(from))?.[1] };
  // A key shipped beside a release proves only that whoever made the folder signed it.
  const key = trustedKey(o, root);
  return { bundle: path.join(dir, pick.name), sums, sig: path.resolve(o.sig ?? path.join(dir, 'SHA256SUMS.sig')), pubkey: key.pubkey, version: pick.version, downloaded: null };
}

const NOTES = 'release-notes.txt';
const NOTES_MAX = 4_000;
/** The signed SHA256SUMS may list release-notes.txt: its text is shown only when it matches that hash (unsigned text never is). */
async function releaseNotes(deps, src, lines) {
  const hash = lines.find((line) => /^[0-9a-f]{64} {2}release-notes\.txt$/.test(line))?.slice(0, 64);
  if (!hash) return null;
  try {
    const file = path.join(src.downloaded ?? path.dirname(src.sums), NOTES);
    if (src.base) await download(deps, `${src.base}/${NOTES}`, file);
    const text = await fs.readFile(file);
    return sha256(text) === hash ? text.toString('utf8').slice(0, NOTES_MAX) : null;
  } catch { return null; }
}

/** verify.mjs, with the H §6.4 handling: a bad download is deleted, a wrong platform names the right bundle. */
async function verify(src, t) {
  try { return verifyBundle({ ...src, os: t.os, arch: t.arch }); } catch (error) {
    if (src.downloaded) await fs.rm(src.downloaded, { recursive: true, force: true });
    if (/^built for /.test(error.message)) throw platformError(`${path.basename(src.bundle)} is ${error.message}`, src.version, t);
    throw new Error(`refused ${path.basename(src.bundle)}: ${error.message}.\n⚠ The release may have been tampered with (supply-chain risk). ${src.downloaded ? 'The download was deleted; ' : ''}nothing was installed or changed. Do not install it by hand; get it again from the official release page and report this if it repeats.`);
  }
}

// ── Snapshots of ~/.config/cld-gui (same host, secrets included, permissions kept; not the B1 export) ──

/** Regular files under `dir`, relative, sorted (what a snapshot must still hold to be restored). */
async function filesUnder(dir) {
  const out = [];
  for (const e of await fs.readdir(dir, { recursive: true, withFileTypes: true })) if (e.isFile()) out.push(path.relative(dir, path.join(e.parentPath, e.name)));
  return out.sort();
}

/** Copies the data folder; returns the files it holds (recorded, checked before a restore). */
async function takeSnapshot(home, dir) {
  await fs.mkdir(path.dirname(dir), { recursive: true, mode: 0o700 });
  await fs.rm(dir, { recursive: true, force: true }); // a half copy from an interrupted run
  const src = dataDir(home);
  if (!fssync.existsSync(src)) { await fs.mkdir(dir, { mode: 0o700 }); return []; }
  // Sockets and FIFOs (engine.sock) are not data; files keep their mode (copyfile), folders too (cp).
  await fs.cp(src, dir, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true, filter: async (from) => { const st = await fs.lstat(from); return st.isFile() || st.isDirectory() || st.isSymbolicLink(); } });
  return filesUnder(dir);
}

/** Before anything is moved: the snapshot is still a folder we made, readable, with every file it was taken with. */
async function checkSnapshot(root, snapshot, files) {
  const missing = [];
  if (!(await ownedCopy(path.join(root, 'snapshots'), snapshot, root))) missing.push('the folder');
  else for (const rel of files ?? []) await fs.access(path.join(snapshot, rel), fssync.constants.R_OK).catch(() => missing.push(rel));
  if (missing.length) throw new Error(`the snapshot ${snapshot} is missing or incomplete (${missing.slice(0, 5).join(', ')}${missing.length > 5 ? ', …' : ''}): nothing was moved, the data folder is left as it is`);
}

/**
 * The live data folder is moved aside (kept, never deleted), then the snapshot is copied in. The aside
 * path is in install.json (record.replaced, and u.asides) BEFORE the move, so an interrupted restore
 * still names the folder holding the real data; uninstall --reset removes these copies.
 */
async function restoreSnapshot(root, record, deps, snapshot, files) {
  await checkSnapshot(root, snapshot, files);
  const u = record.update;
  const dest = dataDir(deps.home);
  if (fssync.existsSync(dest)) {
    const aside = `${dest}.replaced-${Date.now()}`;
    record.replaced = [...(record.replaced ?? []), aside];
    u.asides = [...(u.asides ?? []), aside];
    await writeRecord(root, record);
    await fs.rename(dest, aside);
    await deps.afterStep?.('restore-moved');
  }
  await fs.cp(snapshot, dest, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true });
}
/** Where the data that was live before the first restore attempt is (later attempts only moved partial copies). */
const asideNote = (u) => (u.asides?.length ? ` (the data it replaced is kept in ${u.asides[0]}${u.asides.length > 1 ? `; ${u.asides.slice(1).join(', ')} hold partial copies of the snapshot` : ''}; agty uninstall --reset removes them)` : '');

// ── Switching ────────────────────────────────────────────────────────────────

/** `current` -> version and the service definition re-rendered for it (not started). */
async function pointTo(root, record, deps, version) {
  await switchCurrent(root, version, deps.platform, record);
  const manifest = await readManifest(root, version);
  const config = mergeConfig(await readConfig(deps.home));
  const pathNodeDirs = serviceNodeDirs(record, deps, root); // merged into the record, never rebuilt from this shell's PATH
  const s = renderService({ platform: rootPlatform(deps.platform), home: deps.home, root, version, manifest, config, pathNodeDir: pathNodeDirs });
  if (s.file && record.service.kind !== 'none' && sha256(s.content) !== record.service.sha256) await writeOwned(record, s.file, s.content);
  record.service = { ...record.service, sha256: sha256(s.content), argv: s.argv, cwd: s.cwd, create: s.create ?? null, pathNodeDirs };
  return { ...s, autostart: record.startPolicy !== 'manual' }; // an update never re-enables a manual install
}

/** Another daemon on our port or engine socket (a source install, another user's): H §6.4 "do not switch". */
async function otherDaemon(record, root, deps) {
  const h = Number.isInteger(record.port) ? await deps.health(record.port) : null;
  if (h && (h.service !== 'cld-gui' || h.version !== record.current)) return `port ${record.port} answers as ${h.service ?? '?'} ${h.version ?? '?'}, not the installed ${record.current}`;
  const status = await deps.control?.('status').catch(() => null);
  if (status?.ok && !(await daemonIdentity(record, root, status)).matches) return `the engine socket is held by another daemon (port ${status.daemon?.port ?? '?'}, ${status.daemon?.entry ?? '?'})`;
  return null;
}

/** After health: the engine that answers is the new version's, and the sessions that were on are on again (T-0126). */
async function takeover(record, root, deps, before, version) {
  if (!before?.ok || !deps.control) return { missing: [] }; // no engine before: nothing to take over
  const want = (before.projects ?? []).filter((p) => p.state === 'on').map((p) => p.name);
  let missing = want;
  for (let i = 0; i < (deps.takeoverTries ?? 30); i += 1) {
    const status = await deps.control('status').catch(() => null);
    if (status?.ok) {
      if (!(await daemonIdentity({ ...record, current: version }, root, status)).matches) return { other: `the engine socket answers from another daemon (port ${status.daemon?.port ?? '?'}, ${status.daemon?.entry ?? '?'})`, missing: [] };
      const on = new Set((status.projects ?? []).filter((p) => p.state === 'on').map((p) => p.name));
      missing = want.filter((name) => !on.has(name));
      if (!missing.length) return { missing };
    }
    await deps.sleep(2_000);
  }
  return { missing };
}

/** Stops the old daemon and makes sure it is down (a stop error only passes when nothing answers any more). */
export async function stopOld(record, deps) {
  let failure = null;
  try { await serviceOp(record.service.kind, 'stop', record.service, deps); } catch (error) { failure = error; }
  if (!live(record)) { if (failure) throw failure; return; }
  for (let i = 0; i < 10; i += 1) {
    const up = (Number.isInteger(record.port) && (await deps.health(record.port))) || (await deps.serviceActive?.(record.service)?.catch(() => false));
    if (!up) return;
    await deps.sleep(1_000);
  }
  throw new Error(`${record.current} is still running after the stop${failure ? ` (${failure.message})` : ''}: no snapshot is taken of data a daemon may still write`);
}

const step = async (root, record, deps, name) => { record.update.step = name; await writeRecord(root, record); await deps.afterStep?.(name); };

/** A version this run unpacked and never ran is removed again (not a failure of the version). */
async function dropStaged(root, record, u) {
  if (!u.fresh || [record.current, record.previous].includes(u.to) || !record.versions[u.to]) return;
  if (inside(path.join(root, 'versions'), record.versions[u.to].dir)) await fs.rm(record.versions[u.to].dir, { recursive: true, force: true });
  delete record.versions[u.to];
}

/** Back to `from`: stop, restore the snapshot when the data may have changed, point back, start. Returns the message. */
async function revert(root, record, deps, why, { failed = true } = {}) {
  const u = record.update;
  const restoring = u.touched && u.snapshot && !u.restored;
  // A missing snapshot: nothing is moved or stopped; the new version and its data stay (and record.update, for status).
  if (restoring) await checkSnapshot(root, u.snapshot, u.snapshotFiles).catch((error) => { throw new Error(`${u.kind} to ${u.to} failed (${why}) and cannot be undone: ${error.message}; ${u.to} stays current (agty status)`); });
  await step(root, record, deps, 'reverting');
  await serviceOp(record.service.kind, 'stop', record.service, deps).catch((error) => deps.print(`! stopping ${u.to}: ${error.message}`));
  if (restoring) { await restoreSnapshot(root, record, deps, u.snapshot, u.snapshotFiles); u.restored = true; await writeRecord(root, record); }
  await serviceOp(record.service.kind, 'activate', await pointTo(root, record, deps, u.from), deps);
  const back = !live(record) || (await waitHealthy(record.port, u.from, { check: deps.health, sleep: deps.sleep }));
  if (failed && !record.failedVersions.includes(u.to)) record.failedVersions.push(u.to);
  // Restored (the live data is that copy now) or never needed: either way the snapshot goes.
  if (u.snapshot) { await fs.rm(u.snapshot, { recursive: true, force: true }); record.snapshots = record.snapshots.filter((s) => s !== u.snapshot); }
  if (u.kind === 'update' && !u.touched) await dropStaged(root, record, u);
  record.update = null;
  await writeRecord(root, record);
  return `${u.kind} to ${u.to} failed (${why}); back on ${u.from}${back ? ' (healthy)' : ' (NOT answering: agty status)'}${u.restored ? `; data restored from the snapshot taken before${asideNote(u)}` : ''}${failed ? `; ${u.to} is marked failed and is not tried again without --force` : ''}`;
}

async function finish(root, record, deps) {
  const u = record.update;
  if (u.kind === 'update') { record.versions[u.to].from = u.from; record.versions[u.to].snapshot = u.snapshot ?? null; record.versions[u.to].snapshotFiles = u.snapshotFiles ?? null; record.previous = u.from; }
  else { const before = record.versions[u.to]?.from; record.previous = before && before !== u.to && record.versions[before] ? before : null; }
  record.current = u.to;
  record.failedVersions = record.failedVersions.filter((v) => v !== u.to);
  record.update = null;
  await writeRecord(root, record);
  await prune(root, record, deps);
}

/** H §6.1 steps 7-9 for both update and rollback (`restore`: the snapshot a rollback puts back). */
async function switchVersion(root, record, deps, { restore = null } = {}) {
  const u = record.update;
  const before = await deps.control?.('status').catch(() => null);
  const guarded = async (fn) => { try { return await fn(); } catch (error) { throw new Error(await revert(root, record, deps, error.message, { failed: !!u.touched })); } };
  // H §6.1 step 6 (wait for a merge or remote setup to finish): the daemon exposes no such signal
  // yet (status lists projects, jobs and tasks, which all survive a daemon restart); add the wait with it.
  await step(root, record, deps, 'stopping');
  await guarded(() => stopOld(record, deps)); // never stop-agents: sessions keep running
  if (u.dataChanges) {
    u.snapshot = path.join(root, 'snapshots', `${u.from}-before-${u.to}-${Date.now()}`);
    record.snapshots = [...(record.snapshots ?? []), u.snapshot];
    await step(root, record, deps, 'snapshot');
    u.snapshotFiles = await guarded(() => takeSnapshot(deps.home, u.snapshot));
    await writeRecord(root, record);
    deps.print(`✔ rollback snapshot of ${dataDir(deps.home)} -> ${u.snapshot}`);
  }
  if (restore) {
    u.touched = true;
    await step(root, record, deps, 'restoring');
    await guarded(() => restoreSnapshot(root, record, deps, restore.dir, restore.files));
    deps.print(`✔ data restored from ${restore.dir}${asideNote(u)}`);
  }
  await step(root, record, deps, 'switching');
  u.touched = true; // from here the new daemon may run and migrate (recovery tells by the pointer)
  await guarded(async () => serviceOp(record.service.kind, 'activate', await pointTo(root, record, deps, u.to), deps));
  if (!live(record)) deps.print(`  health: not checked (service ${record.service.kind})`);
  else {
    if (!(await waitHealthy(record.port, u.to, { check: deps.health, sleep: deps.sleep }))) throw new Error(await revert(root, record, deps, `failed health: ${u.to} did not answer on port ${record.port}`));
    const taken = await takeover(record, root, deps, before, u.to);
    if (taken.other) throw new Error(await revert(root, record, deps, taken.other));
    if (taken.missing.length) deps.print(`! the engine has not taken over ${taken.missing.join(', ')} yet (they keep running; agty status)`);
  }
  const { kind, from, to } = u;
  const note = asideNote(u);
  await finish(root, record, deps);
  deps.print(`✔ ${kind === 'update' ? 'updated' : 'rolled back'} ${from} -> ${to}${note}`);
  return { ok: true, record };
}

/** Keeps `current`, `previous` and the newest others up to KEEP_OLD; failed versions go. Removal follows P2b: recorded, inside the root, hash-checked files only. */
async function prune(root, record, deps) {
  const old = Object.entries(record.versions).filter(([v]) => v !== record.current);
  const keep = new Set(old.filter(([v]) => !record.failedVersions.includes(v))
    .sort(([a, x], [b, y]) => (b === record.previous) - (a === record.previous) || String(y.installedAt).localeCompare(String(x.installedAt)))
    .slice(0, KEEP_OLD).map(([v]) => v));
  for (const [v, entry] of old) {
    if (keep.has(v)) continue;
    const state = inside(path.join(root, 'versions'), entry.dir) ? await versionFiles(root, entry) : { files: [], kept: [entry.dir] };
    for (const file of state.files) await fs.rm(file, { force: true });
    await pruneEmptyDirs(entry.dir).catch(() => {});
    if (state.kept.length) deps.print(`남김(직접 고친 파일): ${state.kept.join(', ')}`);
    else { delete record.versions[v]; deps.print(`✔ old version ${v} removed${fssync.existsSync(entry.dir) ? ` (unlisted files left in ${entry.dir})` : ''}`); }
  }
  const used = new Set(Object.values(record.versions).map((e) => e.snapshot).filter(Boolean));
  for (const snap of record.snapshots ?? []) {
    if (used.has(snap)) continue;
    if (await ownedCopy(path.join(root, 'snapshots'), snap, root)) await fs.rm(snap, { recursive: true, force: true });
  }
  record.snapshots = (record.snapshots ?? []).filter((s) => used.has(s));
  await writeRecord(root, record);
}

// ── Recovery after an interrupted run (H §6.4 "PC turned off") ───────────────

/**
 * Finishes or reverts. Once `current` points at the new version it may have been serving for days:
 * reverting then (and restoring its snapshot) is asked, never done silently; --yes refuses and says what it would do.
 */
export async function recoverUpdate(root, record, deps, o = {}) {
  const u = record.update;
  if (!u) return null;
  deps.print(`! ${u.kind} ${u.from} -> ${u.to} stopped at '${u.step}'`);
  if (u.step === 'unpacked') { await dropStaged(root, record, u); record.update = null; await writeRecord(root, record); deps.print(`  nothing had changed yet: still on ${u.from}`); return 'reverted'; }
  const switched = (await readCurrent(root, deps.platform)) === u.to;
  if (u.step === 'switching' && switched && (!live(record) || (await waitHealthy(record.port, u.to, { check: deps.health, sleep: deps.sleep, tries: 10 })))) {
    await finish(root, record, deps); deps.print(`✔ finished: ${u.to} is running`); return 'finished';
  }
  // Ask only when the new version may have been serving (stopped at 'switching'). A run stopped at
  // 'reverting' had already decided to revert, and may have moved the data folder aside: carry on.
  if (switched && u.step === 'switching') {
    const plan = `reverting would stop ${u.to} (current since ${u.startedAt}) and start ${u.from}${u.snapshot && !u.restored ? `, putting ${dataDir(deps.home)} back to the snapshot ${u.snapshot} (the data there now is moved aside and kept)` : ''}`;
    const cancel = (why) => { throw Object.assign(new Error(`${why}: ${plan}. Nothing was changed; once ${u.to} answers again, agty update finishes the update instead`), { code: 'CANCELLED' }); };
    if (o.yes) cancel(`${u.kind} ${u.from} -> ${u.to} stopped at '${u.step}' and ${u.to} is current but not answering; not reverting under --yes`);
    if (!(await deps.confirm(`${u.to} 가 지금 응답하지 않아요. ${plan}. 되돌릴까요? (y/N)`))) cancel('not reverted');
  }
  u.touched = u.touched || switched; // the new version ran (or a rollback replaced the data): restore the snapshot
  deps.print(await revert(root, record, deps, `interrupted at '${u.step}'`, { failed: switched || u.step === 'reverting' }));
  return 'reverted';
}

// ── Commands ─────────────────────────────────────────────────────────────────

async function locked(o, deps, op, fn) {
  const root = o.root ?? installRoot(rootPlatform(deps.platform), deps.home, deps.env);
  const release = await acquireLock(root, op, { wait: o.wait ?? 0 });
  try {
    const record = await readRecord(root);
    if (!record?.current) throw new Error(`no Agent Tycoon install in ${root} (agty install --from <bundle>)`);
    record.snapshots ??= []; record.update ??= null;
    if (o.check && record.update) deps.print(`! an interrupted ${record.update.kind} ${record.update.from} -> ${record.update.to} is pending ('${record.update.step}'): agty update finishes or reverts it`);
    const recovered = o.check ? null : await recoverUpdate(root, record, deps, o); // --check only reads
    return await fn(root, record, recovered);
  } finally { await release(); }
}

/** update [--check] --from <bundle | release folder | URL>; without --from it only finishes an interrupted one. */
export async function update(o, deps = realDeps()) {
  if (o.rollback) return rollback(o, deps);
  return locked(o, deps, 'update', async (root, record, recovered) => {
    if (!o.from) { if (recovered) return { ok: true, record, recovered }; throw new Error('--from <bundle, release folder or URL> is required'); }
    const t = target(deps);
    const src = await source(o, root, deps);
    if (o.check) {
      let notes = null;
      try {
        const sums = verifySums(src).toString('utf8').split('\n');
        if (!sums.some((line) => line.endsWith(`  ${path.basename(src.bundle)}`))) throw new Error(`${path.basename(src.bundle)} is not listed in the signed SHA256SUMS`);
        notes = await releaseNotes(deps, src, sums);
      } catch (error) { throw new Error(`refused ${path.basename(src.sums)}: ${error.message}.\n⚠ The release may have been tampered with (supply-chain risk); nothing was changed.`); } finally { if (src.downloaded) await fs.rm(src.downloaded, { recursive: true, force: true }); }
      const v = src.version;
      const newer = compareVersions(v, record.current) > 0;
      deps.print(!newer ? `up to date (installed ${record.current}${v !== record.current ? `; the release has ${v}` : ''})` : record.failedVersions.includes(v) ? `${v} is available but failed here before (update --force to try it again); installed ${record.current}` : `${v} is available (installed ${record.current}): agty update --from ${o.from}`);
      return { ok: true, record, current: record.current, available: newer ? v : null, failed: record.failedVersions.includes(v), bundle: path.basename(src.bundle), notes };
    }
    const verified = await verify(src, t);
    deps.print(`✔ ${path.basename(src.bundle)}: signature, SHA-256 and ${verified.os}-${verified.arch} match`);
    const drop = () => (src.downloaded ? fs.rm(src.downloaded, { recursive: true, force: true }) : null);
    if (verified.version === record.current) { await drop(); deps.print(`already on ${verified.version}`); return { ok: true, record, unchanged: true }; }
    if (compareVersions(verified.version, record.current) < 0 && !o.force) { await drop(); throw new Error(`${verified.version} is older than the installed ${record.current}: to go back use agty rollback (it restores the data snapshot when needed); --force installs an older version anyway`); }
    if (record.failedVersions.includes(verified.version) && !o.force) { await drop(); throw new Error(`${verified.version} failed before; pass --force to try it again`); }
    const other = await otherDaemon(record, root, deps);
    if (other) { await drop(); throw new Error(`${other}: not switching (two daemons would share the port, socket and data). agty status / doctor shows which; stop the other one first`); }

    const fresh = !record.versions[verified.version];
    let manifest;
    try { manifest = await unpack(root, src.bundle, verified, record, deps.print); } finally { await drop(); }
    record.update = { kind: 'update', from: record.current, to: verified.version, step: 'unpacked', fresh, startedAt: new Date().toISOString() };
    await writeRecord(root, record);
    await deps.afterStep?.('unpacked');
    const u = record.update;
    const test = await selfTest(versionDir(root, u.to), manifest, deps);
    if (!test.ok) {
      await dropStaged(root, record, u);
      if (!record.failedVersions.includes(u.to)) record.failedVersions.push(u.to);
      record.update = null; await writeRecord(root, record);
      throw new Error(`self-test of ${u.to} failed; still on ${u.from} (${u.to} is marked failed):\n${test.output}`);
    }
    deps.print(`✔ self-test ${u.to}`);
    const compat = compatibility(await readManifest(root, u.from), manifest);
    for (const w of compat.warnings) deps.print(`! ${w}`);
    if (compat.errors.length) {
      await dropStaged(root, record, u); record.update = null; await writeRecord(root, record);
      throw new Error(`${u.to} cannot replace ${u.from}: ${compat.errors.join('; ')}; still on ${u.from}${compat.errors.some((e) => e.includes('data formats')) ? ' (to go back to an older version use agty rollback)' : ''}`);
    }
    u.dataChanges = compat.dataChanges;
    const result = await switchVersion(root, record, deps);
    if (o.pub && path.resolve(o.pub) !== pinnedKey(root)) { await writeOwned(record, pinnedKey(root), await fs.readFile(path.resolve(o.pub), 'utf8'), 0o600); await writeRecord(root, record); deps.print(`✔ release key pinned: ${pinnedKey(root)}`); }
    return result;
  });
}

/** rollback: `previous` again; restores the snapshot taken before `current` when the data format differs. */
export async function rollback(o, deps = realDeps()) {
  return locked(o, deps, 'rollback', async (root, record) => {
    const from = record.current; const to = record.previous;
    if (!to || !record.versions[to] || !fssync.existsSync(versionDir(root, to))) throw new Error(`no previous version to roll back to (installed: ${Object.keys(record.versions).join(', ')})`);
    if (record.failedVersions.includes(to) && !o.force) throw new Error(`${to} failed before; pass --force to roll back to it anyway`);
    const [fromM, toM] = [await readManifest(root, from), await readManifest(root, to)];
    const compat = compatibility(fromM, toM);
    for (const w of compat.warnings) deps.print(`! ${w}`);
    let restore = null;
    if (compat.dataChanges) {
      const snap = record.versions[from]?.from === to ? record.versions[from].snapshot : null;
      if (!snap) throw new Error(`${to} uses another data format than ${from} and there is no snapshot from before ${from}: ${to} could not read the data, so this stays on ${from}`);
      await checkSnapshot(root, snap, record.versions[from].snapshotFiles).catch((error) => { throw new Error(`${to} uses another data format than ${from} and ${error.message}; this stays on ${from}`); });
      deps.print(`${to} uses another data format: ${dataDir(deps.home)} goes back to the snapshot from before ${from} (${snap}); changes made since then stay in a copy beside it`);
      if (!o.yes && !(await deps.confirm('스냅샷으로 데이터를 되돌리고 이전 버전으로 돌아갈까요? (y/N)'))) { deps.print('되돌리기를 취소했습니다'); return { ok: false, record }; }
      restore = { dir: snap, files: record.versions[from].snapshotFiles };
    }
    const test = await selfTest(versionDir(root, to), toM, deps);
    if (!test.ok) throw new Error(`self-test of ${to} failed; still on ${from}:\n${test.output}`);
    const other = await otherDaemon(record, root, deps);
    if (other) throw new Error(`${other}: not switching; stop the other daemon first`);
    record.update = { kind: 'rollback', from, to, step: 'ready', dataChanges: compat.dataChanges, startedAt: new Date().toISOString() };
    return switchVersion(root, record, deps, { restore });
  });
}
