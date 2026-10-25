import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeAll, beforeEach, expect, it, vi } from 'vitest';

import type { BoardTask } from '../../../../core/src/messages.js';
import { setLanguage } from '../../i18n/index.js';
import type { CldScope as CldScopeType } from '../officeStore.js';
import { scopeToProject } from './workbenchState.js';

// The board's modules read `window` when they load (the transport, the mock switch).
let CldScope: typeof CldScopeType;
let cldHandleMessage: typeof import('../officeStore.js').cldHandleMessage;
let cldResetForTests: typeof import('../officeStore.js').cldResetForTests;
let TaskBoardView: typeof import('../taskboard/TaskBoard.js').TaskBoardView;
beforeAll(async () => {
  vi.stubGlobal('window', {
    location: { search: '', host: 'localhost', protocol: 'http:' },
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  });
  ({ CldScope, cldHandleMessage, cldResetForTests } = await import('../officeStore.js'));
  ({ TaskBoardView } = await import('../taskboard/TaskBoard.js'));
});

beforeEach(() => {
  setLanguage('ko');
  cldResetForTests();
});

const task = (id: string, project: string): BoardTask => ({
  id,
  project,
  title: `title-${id}`,
  status: 'todo',
  source: 'reported',
  createdAt: '2026-10-24T00:00:00.000Z',
  updatedAt: '2026-10-24T00:00:00.000Z',
  history: [],
});

/** No scope at all is the standalone 업무 window: no provider is rendered. */
const render = (scope: ReturnType<typeof scopeToProject> | null) => {
  const board = createElement(TaskBoardView, { now: 0 });
  return renderToStaticMarkup(
    scope ? createElement(CldScope.Provider, { value: scope }, board) : board,
  );
};

it('the standalone task board (no scope) shows every project; only the workbench narrows it', () => {
  cldHandleMessage({
    type: 'taskBoard',
    tasks: [task('a1', 'alpha'), task('b1', 'beta'), task('a2', 'alpha-a')],
  });
  const all = render(null);
  for (const id of ['a1', 'b1', 'a2']) expect(all).toContain(`title-${id}`);
  const scoped = render(scopeToProject(['alpha', 'alpha-a']));
  expect(scoped).toContain('title-a1');
  expect(scoped).toContain('title-a2');
  expect(scoped).not.toContain('title-b1');
});
