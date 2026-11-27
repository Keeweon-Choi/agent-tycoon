/**
 * T-185: the 현황판's 타임라인 tab draws the runs on one time axis. The boss asks alpha, alpha hands one
 * piece of work to a sub-agent and ends on a question (the engine fake plays it). Jobs are started from
 * alpha's folder with the fixture's `agty()`, as the agent's own shell would: one that ends well, a check
 * on issue T-7 that fails, then (T-7 sent to 검토 and back to 진행 중) its retry, still running. The tab
 * shows each in its row with the recorded connectors, a bar opens its card, the question waits in
 * 사장님이 할 일, and 1시간 / 오늘 switch the window.
 */
import { openOfficeWindow } from '../../../server/src/agent-tycoon/testHome';
import { expect, test } from '../../fixtures/standalone';
import { openConversation, sendMessage } from '../../helpers/messenger';
import { claudeScenario } from '../../helpers/mock-claude';
import { ringOf } from '../../helpers/office';
import {
  buildAssistantTextRecord,
  buildAssistantToolUseRecord,
  buildTurnDurationRecord,
  buildUserToolResultRecord,
} from '../../helpers/team';

const SUB = '단위 테스트 돌리기';
const OK = '빌드 확인';
const BAD = '배포 전 검사';
const RETRY = '배포 재검사';
const ISSUE = 'T-7';
const QUESTION = '검사는 끝났어요. 배포할까요?';

/** A sub-agent's line in the Lead's own transcript (the shape of run-devroom.ts sub()). */
const sub = (parent: string, message: Record<string, unknown>) => ({
  type: 'progress',
  parentToolUseID: parent,
  data: { type: 'agent_progress', message },
});

const shot = (name: string) => test.info().outputPath(name);

test.use({
  viewport: { width: 1600, height: 1000 },
  standaloneOptions: {
    agents: [{ name: 'alpha' }],
    scenarios: [
      claudeScenario('hand work to a sub-agent')
        .forAgent('alpha')
        .onPrompt('검사')
        .at(300)
        .appendJsonl(buildAssistantToolUseRecord('tu-sub', 'Task', { description: SUB, prompt: 'npm test' }))
        .at(800)
        .appendJsonl(sub('tu-sub', buildAssistantToolUseRecord('tu-sub-1', 'Bash', { command: 'npm test' })))
        .at(2_000)
        .appendJsonl(sub('tu-sub', buildUserToolResultRecord('tu-sub-1', '12 passed')))
        .at(2_500)
        .appendJsonl(buildUserToolResultRecord('tu-sub', 'tests pass'))
        .at(2_600)
        .appendJsonl(buildAssistantTextRecord(QUESTION))
        .at(2_700)
        .appendJsonl(buildTurnDurationRecord())
        .build(),
    ],
  },
});

test('the timeline shows the runs by kind, the failed one as failed, a card per bar and two windows @area:jobs', async ({
  page,
  standalone,
}) => {
  expect(standalone.port).not.toBe(18240); // never the real daemon
  const ring = await ringOf(page, 'alpha');
  await expect(ring).toHaveAttribute('data-ring', 'idle', { timeout: 30_000 }); // its 자동 복구 turn is over

  // The sub-agent: alpha's turn spawns it and sees it end.
  await openConversation(page, 'alpha');
  await sendMessage(page, 'alpha', '검사 돌려 줘');
  await expect(ring).toHaveAttribute('data-ring', 'working', { timeout: 30_000 });
  await expect(ring).toHaveAttribute('data-ring', 'waiting', { timeout: 30_000 }); // its turn ends on a question

  // The jobs, from alpha's folder; the failing check is recorded on issue T-7.
  const cwd = standalone.agentFolder('alpha');
  const agty = async (args: string[]) => {
    const r = await standalone.agty(args, { cwd });
    expect(r.code, r.stderr).toBe(0);
  };
  await agty(['task', 'add', '배포 전 검사 고치기', '--id', ISSUE, '--project', 'alpha', '--status', 'doing']);
  await agty(['job', '-d', OK, 'echo ok']);
  await agty(['job', '-d', BAD, '--task', ISSUE, 'echo broken; exit 3']);

  await page.getByRole('button', { name: '메신저 닫기' }).click();
  await openOfficeWindow(page);
  const win = page.locator('[data-hud-window="office"]');
  await win.getByRole('button', { name: '최대화' }).click();
  await win.getByRole('button', { name: '타임라인', exact: true }).click();
  const timeline = win.getByTestId('timeline');
  await expect(timeline).toHaveAttribute('data-span', 'hour');
  await timeline.getByRole('combobox', { name: '실행을 볼 프로젝트' }).selectOption('alpha');

  const row = (name: string) => timeline.locator(`[data-testid="timeline-row"][data-row="${name}"]`);
  // A run's stored label is its hover title (a run too short for a label at this zoom shows only its bar).
  const bar = (name: string, label: string) => row(name).locator(`[data-testid="timeline-bar"][title="${label}"]`);

  // Each run in its row: the jobs under 작업, the sub-agent under 서브에이전트, in that fixed order.
  await expect(bar('job', OK)).toHaveAttribute('data-state', 'done', { timeout: 15_000 });
  await expect(bar('job', BAD)).toHaveAttribute('data-state', 'failed', { timeout: 15_000 });
  await expect(bar('job', BAD)).toContainText('실패');

  // T-7 goes to 검토, comes back to 진행 중, and its check runs again.
  await agty(['task', 'update', ISSUE, '--status', 'review']);
  await agty(['task', 'update', ISSUE, '--status', 'doing']);
  await agty(['job', '-d', RETRY, '--task', ISSUE, 'sleep 600']);
  await expect(bar('job', RETRY)).toHaveAttribute('data-state', 'running', { timeout: 15_000 });
  await expect(bar('job', RETRY)).toContainText('째'); // its elapsed time, open to the now line
  await expect(timeline.locator('[data-testid="timeline-link"][data-kind="back"]')).toHaveCount(1);
  await expect(bar('subagent', SUB)).toHaveAttribute('data-state', 'done', { timeout: 15_000 });
  // The boss's message is a mark on his row, his wait a dashed stretch; the Lead's spawn a mark linked to the sub-agent.
  await expect(row('owner').locator('[data-testid="timeline-bar"][data-state="mark"]')).toContainText(/메시지 \d+개/);
  await expect(row('owner').locator('[data-testid="timeline-bar"][data-state="wait"]')).toContainText('질문 1개가');
  await expect(row('lead').getByTestId('timeline-bar')).toContainText('서브에이전트 1명 맡김');
  await expect(timeline.locator('[data-testid="timeline-link"][data-kind="spawn"]')).toHaveCount(1);
  expect(await timeline.getByTestId('timeline-row').evaluateAll((els) => els.map((e) => e.getAttribute('data-row')))).toEqual([
    'owner',
    'lead',
    'subagent',
    'job',
  ]);
  // 사장님이 할 일: the Lead's question as it was written, answered in the messenger.
  await expect(timeline.getByTestId('timeline-todo-card')).toContainText(QUESTION);

  // A bar opens its card: the stored facts, the exit code, the way to its 실행 entry.
  await bar('job', BAD).click();
  const card = timeline.getByTestId('timeline-card');
  await expect(card.getByTestId('timeline-card-title')).toHaveText(BAD);
  await expect(card).toContainText('실패');
  await expect(card).toContainText('exit 3');
  await expect(card.getByTestId('timeline-card-when')).toHaveText(/\d\d:\d\d – \d\d:\d\d/);
  await expect(card).toContainText('검토 → 진행 중 뒤'); // what came next on T-7, as recorded
  await expect(card.getByTestId('timeline-card-issue')).toContainText(`${ISSUE} 배포 전 검사 고치기`); // the issue it is recorded on
  await expect(card.getByTestId('timeline-open-runs')).toBeVisible();
  await page.screenshot({ path: shot('timeline-desktop.png') });

  // 1시간 and 오늘 are two windows: the axis' ticks every 10 minutes, then the host day's.
  const ticks = timeline.getByTestId('timeline-tick');
  const hourTicks = await ticks.count();
  expect(hourTicks).toBeLessThanOrEqual(8);
  await timeline.getByRole('button', { name: '오늘', exact: true }).click();
  await expect(timeline).toHaveAttribute('data-span', 'today');
  await expect(timeline.getByRole('heading', { name: '오늘' })).toBeVisible();
  // Every 2 hours of the host day (00:00 sits on the left edge, under the row heads: its line only).
  await expect(ticks).toHaveCount(12);
  await expect(ticks.first()).toHaveText('02:00');
  await expect(bar('job', BAD)).toHaveAttribute('data-state', 'failed');
  await page.screenshot({ path: shot('timeline-today.png') });

  // The card stays on the run it shows; its door: the 실행 tab with that job's card in view.
  await expect(card.getByTestId('timeline-card-title')).toHaveText(BAD);
  await timeline.getByTestId('timeline-open-runs').click();
  await expect(win.getByTestId('runs-panel')).toBeVisible();
  await expect(win.getByTestId('job-card').filter({ hasText: BAD })).toHaveAttribute('data-focused', 'true');

  // A phone-wide window: the same chart, scrolled sideways inside its panel (a picture, not a check).
  await win.getByRole('button', { name: '타임라인', exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: shot('timeline-narrow.png') });
});
