/**
 * Throwaway git repositories for the tests of this folder: a bare remote and a
 * clone of it, in a temp dir, with git's config pinned (no global or system
 * config, a fixed identity) so nothing on the developer's machine leaks in.
 * Never used at runtime, never pointed at a real repository.
 */
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import type { GitRunner } from './gitRun.js';
import { createGitRunner, findGit, gitEnv } from './gitRun.js';

export interface TempRepo {
  /** The temp dir holding everything below. */
  root: string;
  /** The bare remote (`origin` of the clone). */
  remote: string;
  /** The working clone: the project folder. */
  folder: string;
  /** The code under test's runner, over the same pinned environment. */
  run: GitRunner;
  /** Run git for test setup (cwd = the clone unless given); returns stdout. */
  git(args: string[], cwd?: string): string;
  /** Write a file in the clone (parents created). */
  write(rel: string, content: string): string;
  /** Another clone of the remote, to move the remote ahead of `folder`. */
  cloneRemote(name: string): string;
  cleanup(): void;
}

export const GIT_AVAILABLE = findGit() !== null;

export function makeTempRepo(opts: { commit?: boolean; push?: boolean } = {}): TempRepo {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cld-git-')));
  const home = path.join(root, 'home');
  fs.mkdirSync(home);
  const env = gitEnv(
    {
      ...process.env,
      HOME: home,
      GIT_CONFIG_GLOBAL: os.devNull,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@localhost',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@localhost',
    },
    {},
  );
  const git = (args: string[], cwd?: string): string =>
    execFileSync(findGit()!, args, {
      cwd: cwd ?? folder,
      env,
      encoding: 'utf-8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  const remote = path.join(root, 'remote.git');
  const folder = path.join(root, 'clone');
  git(['init', '-q', '--bare', '-b', 'main', remote], root);
  git(['clone', '-q', remote, folder], root);
  const write = (rel: string, content: string): string => {
    const file = path.join(folder, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    return file;
  };
  if (opts.commit !== false) {
    write('a.txt', 'one\n');
    write('sub/b.txt', 'b\n');
    git(['add', '-A']);
    git(['commit', '-q', '-m', 'init']);
    if (opts.push !== false) git(['push', '-q', '-u', 'origin', 'main']);
  }
  return {
    root,
    remote,
    folder,
    run: createGitRunner({ env }),
    git,
    write,
    cloneRemote: (name) => {
      const dir = path.join(root, name);
      git(['clone', '-q', remote, dir], root);
      return dir;
    },
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

/**
 * A runner that records every argv it is given, then runs it. `inFlight`: how many runs have
 * started and not finished (a test that asserts "no git runs from now on" first lets those end).
 */
export function recording(inner: GitRunner): {
  run: GitRunner;
  calls: string[][];
  inFlight: () => number;
} {
  const calls: string[][] = [];
  let pending = 0;
  return {
    calls,
    inFlight: () => pending,
    run: (cwd, args, opts) => {
      calls.push(args);
      pending++;
      return inner(cwd, args, opts).finally(() => pending--);
    },
  };
}
