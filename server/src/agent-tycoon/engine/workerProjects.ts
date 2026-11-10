import * as fs from 'fs';
import * as path from 'path';

import { configDirectory } from '../configPath.js';

interface ProjectLocation {
  name: string;
  folder: string;
}

/** The read-only registry subset used by the worker outside the daemon: name and folder,
 *  which every version keeps in projects.json (legacy array, v1, v2). */
export function readWorkerProjects(file: string): ProjectLocation[] {
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    const all = Array.isArray(raw)
      ? raw
      : typeof raw === 'object' &&
          raw !== null &&
          Array.isArray((raw as { projects?: unknown }).projects)
        ? (raw as { projects: unknown[] }).projects
        : [];
    return all.filter(
      (project): project is ProjectLocation =>
        typeof project === 'object' &&
        project !== null &&
        typeof (project as ProjectLocation).name === 'string' &&
        typeof (project as ProjectLocation).folder === 'string',
    );
  } catch {
    return [];
  }
}

/** The deepest registered project containing this worker's working directory. */
export function workerProjectAt(home: string, cwd: string): string | null {
  const projects = readWorkerProjects(path.join(configDirectory(home), 'projects.json'));
  let best: { name: string; len: number } | null = null;
  for (const project of projects) {
    const folder = project.folder.endsWith(path.sep)
      ? project.folder
      : `${project.folder}${path.sep}`;
    if ((cwd === project.folder || cwd.startsWith(folder)) && (!best || folder.length > best.len))
      best = { name: project.name, len: folder.length };
  }
  return best?.name ?? null;
}
