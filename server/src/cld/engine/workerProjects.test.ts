import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import { workerProjectAt } from './workerProjects.js';

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true });
});

describe('worker project registry reader', () => {
  it('finds the same project in legacy, v1 and v2 registries', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cld-worker-projects-'));
    homes.push(home);
    const file = path.join(home, '.config', 'agent-tycoon', 'projects.json');
    const record = { name: 'alpha', folder: path.join(home, 'work', 'alpha') };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify([record]));
    const cwd = path.join(record.folder, 'child');

    expect(workerProjectAt(home, cwd)).toBe('alpha');
    fs.writeFileSync(file, JSON.stringify({ v: 1, projects: [record] }));
    expect(workerProjectAt(home, cwd)).toBe('alpha');
    const v2 = { ...record, projectId: 'p_aaaaaaaaaa', leadAssignmentId: 'a_aaaaaaaaaa' };
    fs.writeFileSync(file, JSON.stringify({ v: 2, projects: [v2] }));
    expect(workerProjectAt(home, cwd)).toBe('alpha');
  });
});
