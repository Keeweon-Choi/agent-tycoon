/** P4 개발실's 변경 tab: the picked worktree's review (TaskReview, mockups-1101/review-loop-R1..R4). */
import { setDevroomTab } from './devroomStore.js';
import { TaskReview } from './TaskReview.js';

export function ChangesTab({ project, task, on }: { project: string; task: string; on: boolean }) {
  return <TaskReview project={project} task={task} live={on} onMerge={() => setDevroomTab('merge')} />;
}
