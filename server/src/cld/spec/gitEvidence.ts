/**
 * SPT §2.6, D1's evidence: where git says a document went. Read only, through the guarded runner
 * (no hooks, fsmonitor, filters or transport), capped, and only when a scan has a document to
 * place. git is evidence, never the condition: no repository, a `lastHead` git no longer has or
 * that is not an ancestor of HEAD (a rebase, a forced push), or output over the cap leaves the
 * committed renames out, and the ladder matches by content (D2, D3). Nothing here writes the
 * repository, `.git` or any git config.
 */
import { SPEC_GIT_MAX_BYTES } from '../../constants.js';
import { type GitRunner, READ_ENV } from '../engine/git/gitRun.js';
import type { GitView } from './discover.js';

const DOC_PATHSPEC = ':(glob,icase)**/*.md';

/**
 * New path → the path at `lastHead`: the committed renames since then, chained commit by commit on
 * the first-parent line (`-M50%`, a deletion ends a chain), then the renames staged now. null:
 * no git evidence at all (not a repository).
 */
export async function readRenames(run: GitRunner, folder: string, lastHead: string | null, view: GitView): Promise<{ renames: Map<string, string> | null; rebased: boolean }> {
  if (!view.repo) return { renames: null, rebased: false };
  const chain = new Map<string, string>(); // path now → path at lastHead
  let rebased = false;
  if (lastHead && view.head && lastHead !== view.head) {
    const opts = { env: READ_ENV, maxBytes: SPEC_GIT_MAX_BYTES };
    try {
      const anc = await run(folder, ['merge-base', '--is-ancestor', lastHead, 'HEAD'], opts);
      if (anc.code !== 0) rebased = true;
      else {
        const r = await run(
          folder,
          ['-c', 'core.quotepath=off', 'log', '--first-parent', '--reverse', '-M50%', '--name-status', '-z', '--format=', '--relative', `${lastHead}..HEAD`, '--', DOC_PATHSPEC],
          opts,
        );
        if (r.code === 0 && !r.capped) {
          const t = r.stdout.toString('utf-8').split('\0');
          for (let i = 0; i < t.length; i++) {
            const st = t[i].replace(/^\n+/, '');
            if (st.startsWith('R') || st.startsWith('C')) {
              const [a, b] = [t[++i], t[++i]];
              if (st.startsWith('R')) {
                const o = chain.get(a) ?? a;
                chain.delete(a);
                chain.set(b, o);
              }
            } else if (st === 'D') chain.delete(t[++i]);
            else if (st) i++; // A, M, T: one path
          }
        }
      }
    } catch {
      /* git gone meanwhile: content only */
    }
  }
  for (const [now, mid] of view.renames) {
    const o = chain.get(mid) ?? mid;
    chain.delete(mid);
    chain.set(now, o);
  }
  for (const [now, old] of chain) if (now === old) chain.delete(now);
  return { renames: chain, rebased };
}

/**
 * SPT §2.8: a remote URL as the Registry keeps it, no credentials: `user:token@` and any query or
 * fragment gone, the host lower-cased, scp-like `git@host:owner/repo` as `host/owner/repo`, the
 * trailing `.git` and slashes gone (a local path stays a path). null: what is left still has an
 * `@` (credentials this could not parse away, `https://u:pa/ss@host/x`, `u:tok@host:a/b`): left out,
 * so no Registry or backup ever holds one.
 */
export function normalRemote(url: string): string | null {
  let u = url.trim();
  const scp = /^(?:[^@/:\s]+@)?([^/:\s]{2,}):(?!\/\/)(.+)$/.exec(u);
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(u)) {
    try {
      const x = new URL(u);
      u = `${x.hostname.toLowerCase()}${x.port ? `:${x.port}` : ''}${decodeURIComponent(x.pathname)}`;
    } catch {
      u = u.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/@]*@/i, '').replace(/[?#].*$/, '');
    }
  } else if (scp) u = `${scp[1].toLowerCase()}/${scp[2]}`;
  u = u.replace(/\/+$/, '').replace(/\.git$/i, '').replace(/\/+$/, '');
  return u.includes('@') ? null : u;
}

export interface RepoEvidence {
  /** The root commit of HEAD's first-parent line. */
  firstParentRoot?: string;
  /** Every root commit HEAD reaches (this repository has two: ours and upstream's). */
  roots: string[];
  /** Normalised remote URLs, sorted, no credentials. */
  remotes: string[];
}

/** HEAD's roots and the remotes, read only (rev-list, config --get-regexp); null: no repository or no commit. */
export async function readRepoEvidence(run: GitRunner, folder: string): Promise<RepoEvidence | null> {
  const opts = { env: READ_ENV, maxBytes: SPEC_GIT_MAX_BYTES };
  try {
    const [first, all, remotes] = await Promise.all([
      run(folder, ['rev-list', '--max-parents=0', '--first-parent', 'HEAD'], opts),
      run(folder, ['rev-list', '--max-parents=0', 'HEAD'], opts),
      run(folder, ['config', '--get-regexp', '^remote\\..*\\.url$'], opts),
    ]);
    if (first.code !== 0 || all.code !== 0) return null;
    const lines = (b: Buffer) => b.toString('utf-8').split('\n').map((l) => l.trim()).filter(Boolean);
    const urls = remotes.code === 0 ? lines(remotes.stdout).flatMap((l) => normalRemote(l.replace(/^\S+\s+/, '')) ?? []) : [];
    return { firstParentRoot: lines(first.stdout)[0], roots: lines(all.stdout).sort(), remotes: [...new Set(urls)].sort() };
  } catch {
    return null;
  }
}

/** `sha` is an ancestor of the folder's HEAD (false when git does not have it). */
export async function isAncestor(run: GitRunner, folder: string, sha: string): Promise<boolean> {
  if (!/^[0-9a-f]{7,64}$/.test(sha)) return false; // lastHead as git status gives it (abbreviated)
  try {
    return (await run(folder, ['merge-base', '--is-ancestor', sha, 'HEAD'], { env: READ_ENV, maxBytes: SPEC_GIT_MAX_BYTES })).code === 0;
  } catch {
    return false;
  }
}
