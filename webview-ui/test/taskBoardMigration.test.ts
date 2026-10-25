/**
 * D6 P0: the board model shows the same rows for the v1 task file and for its
 * migrated v2 form (the server test pins that migration to this snapshot).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import type { BoardTask, CodexTask, OfficeJob } from '../../core/src/messages.js';
import { boardItems, groupItems } from '../src/cld/taskboard/taskBoardState.js';

const at = (min: number) => new Date(Date.UTC(2026, 9, 23, 14, min)).toISOString();
const fixture = (name: string): BoardTask[] =>
  JSON.parse(
    readFileSync(
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../server/src/cld/fixtures', name),
      'utf-8',
    ),
  ).tasks;

describe('task board: tasks.json v1 and v2 (D6)', () => {
  it('P0: the v1 board and its migrated v2 form show the same rows', () => {
    const runs: CodexTask[] = [{ id: '1022-110000-demo', project: 'demo', state: 'done', started: at(1), ended: at(2), exit: 0 }];
    const job: OfficeJob[] = [{ id: '1022-130500-demo', pid: 9, project: 'demo', cmd: 'python t.py', started: at(3) }];
    const row = (i: ReturnType<typeof boardItems>[number]) => ({
      key: i.key,
      status: i.status,
      source: i.source,
      owner: i.owner,
      title: i.title,
      project: i.project,
      updatedAt: i.updatedAt,
      since: i.since,
      runs: i.runs.map((r) => `${r.kind}:${r.id}`),
      missing: i.missing,
    });
    const v1 = boardItems(fixture('tasks-v1.json'), runs, job).map(row);
    const v2 = boardItems(fixture('tasks-v2-migrated.json'), runs, job).map(row);
    expect(v2).toEqual(v1);
    expect(groupItems(boardItems(fixture('tasks-v2-migrated.json'))).map((g) => g.items.map((i) => i.id))).toEqual(
      groupItems(boardItems(fixture('tasks-v1.json'))).map((g) => g.items.map((i) => i.id)),
    );
  });
});
