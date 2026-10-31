/** P4 개발실's 변경 tab: the picked worktree's review (TaskReview, mockups-1101/review-loop-R1..R4). */
import { setDevroomTab } from './devroomStore.js';
import { TaskReview } from './TaskReview.js';

export function ChangesTab({ project, task }: { project: string; task: string }) {
  return <TaskReview project={project} task={task} onMerge={() => setDevroomTab('merge')} />;
}
