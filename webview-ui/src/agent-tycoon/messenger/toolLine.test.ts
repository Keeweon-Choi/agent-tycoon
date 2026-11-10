import { beforeEach, expect, it } from 'vitest';

import { setLanguage } from '../../i18n/index.js';
import { argFields, jobLineLabel, parseMcpTool, toolLineLabel, toolRowName } from './toolLine.js';

beforeEach(() => setLanguage('ko'));

it('uses an agent tool description for the collapsed label, otherwise the EZ phrase', () => {
  expect(
    toolLineLabel({
      toolName: 'Bash',
      text: 'Running: npm run build',
      desc: '\uac80\uc0ac \uacb0\uacfc \uc77d\uae30',
    }),
  ).toBe('🔨 \uac80\uc0ac \uacb0\uacfc \uc77d\uae30');
  expect(toolLineLabel({ toolName: 'Bash', text: 'Running: npm run build' })).toBe(
    '🔨 \ube4c\ub4dc\ud558\ub294 \uc911',
  );
});

it('a job reads as its own description; without one, its command explained; unknown, the generic words', () => {
  expect(jobLineLabel({ cmd: 'npm run build', label: '\ubc30\ud3ec: \ubc18\uc601' })).toBe(
    '🔨 \ubc30\ud3ec: \ubc18\uc601',
  );
  expect(jobLineLabel({ cmd: 'npm run build', label: null })).toBe(
    '🔨 \ube4c\ub4dc\ud558\ub294 \uc911',
  );
  expect(jobLineLabel({ cmd: 'git commit -m x', label: '  ' })).toBe(
    '📦 \uc800\uc7a5(\ucee4\ubc0b)\ud558\ub294 \uc911',
  );
  expect(jobLineLabel({ cmd: './weird-tool --go', label: null })).toBe(
    '💻 \uba85\ub839 \uc2e4\ud589 \uc911',
  );
});

const mcp = (tool: string, args?: string, server = 'agty') => ({
  toolName: `mcp__${server}__${tool}`,
  text: `Using mcp__${server}__${tool}`,
  ...(args ? { args } : {}),
});

it('names our engine tools in Korean, with the key input when the line has one', () => {
  expect(toolLineLabel(mcp('update_task', 'taskId: T-59, status: done'))).toBe(
    '⚙️ \uc774\uc288 T-59 \u2192 \ub05d\ub0a8',
  );
  expect(toolLineLabel(mcp('update_task'))).toBe('⚙️ \uc774\uc288 \uc0c1\ud0dc \ubc14\uafb8\uae30');
});

it('shows each engine tool with its key input (English words)', () => {
  setLanguage('en');
  const label = (tool: string, args?: string) => toolLineLabel(mcp(tool, args));
  expect(label('create_task', 'title: Fix the toast, detail: long')).toBe(
    '⚙️ Creating a task: Fix the toast',
  );
  expect(label('update_task', 'taskId: T-7, note: hi')).toBe('⚙️ Task T-7 note');
  expect(label('update_task', 'taskId: T-7, status: odd')).toBe('⚙️ Task T-7 note');
  expect(label('get_task_status', 'taskId: T-7')).toBe('⚙️ Reading status of task T-7');
  expect(label('send_message', 'to: lead, text: hello')).toBe('⚙️ Message: lead');
  expect(label('post_to_group', 'room: all, text: hi')).toBe('⚙️ Room post: all');
  expect(label('add_review_note', 'task: T-1, file: a.ts')).toBe('⚙️ Review note: T-1');
  expect(label('delegate_task', 'idempotencyKey: k1')).toBe('⚙️ Delegating a task');
  expect(label('list_agents')).toBe('⚙️ Listing agents');
});

it('truncates a long input and survives missing or odd inputs', () => {
  setLanguage('en');
  const long = 'x'.repeat(100);
  expect(toolLineLabel(mcp('create_task', `title: ${long}`))).toBe(
    `⚙️ Creating a task: ${'x'.repeat(40)}…`,
  );
  expect(toolLineLabel(mcp('create_task'))).toBe('⚙️ Creating a task');
  expect(toolLineLabel(mcp('send_message', 'text: hello'))).toBe('⚙️ Sending a message');
  expect(toolLineLabel(mcp('update_task', 'status: done'))).toBe('⚙️ Updating a task');
});

it('shows any other MCP tool as server · tool, an unknown engine tool too, and keeps a described one', () => {
  setLanguage('en');
  expect(toolLineLabel(mcp('search', undefined, 'notion'))).toBe('⚙️ notion · search');
  expect(toolLineLabel(mcp('brand_new_tool'))).toBe('⚙️ agty · brand_new_tool');
  expect(
    toolLineLabel({ ...mcp('search', undefined, 'notion'), desc: 'Look it up' }),
  ).not.toContain('notion');
});

it('reads the agty server as the engine tool, and the pre-rename cld-gui one as a foreign server', () => {
  setLanguage('en');
  expect(toolLineLabel(mcp('update_task', 'taskId: T-59, status: done', 'agty'))).toBe(
    '⚙️ Task T-59 → Done',
  );
  expect(toolLineLabel(mcp('update_task', 'taskId: T-59, status: done', 'cld-gui'))).not.toContain(
    'Task T-59',
  );
});

it('toolRowName is the words a run folds under, without the input', () => {
  setLanguage('en');
  expect(toolRowName(mcp('update_task', 'taskId: T-59, status: done'))).toBe('⚙️ Updating a task');
  expect(toolRowName({ toolName: 'Bash', text: 'Running: npm run build' })).toBe(
    toolLineLabel({ toolName: 'Bash', text: 'Running: npm run build' }),
  );
});

it('argFields reads the first of each key', () => {
  expect(argFields('taskId: T-1, status: done, taskId: T-2')).toEqual({
    taskId: 'T-1',
    status: 'done',
  });
  expect(argFields(undefined)).toEqual({});
  expect(parseMcpTool('Bash')).toBeNull();
  expect(parseMcpTool('mcp__a__b__c')).toEqual({ server: 'a', tool: 'b__c' });
});
