/**
 * T-73: pressing the 검토 대기 notice opens what it names (see reviewTarget): the 개발실's 변경 tab
 * on the Task's worktree (the phone's sub-page there), else the 현황판's issue board with the Task open.
 */
import type { BoardTask } from '../../../../core/src/messages.js';
import { MOBILE_MEDIA_QUERY, REVIEW_TOAST_WAIT_MS } from '../../constants.js';
import { openDevRoom, openDevroomPage, setDevroomTab } from '../devroom/devroomStore.js';
import { openIssue } from '../workbench/workbenchStore.js';
import { repoGetSnapshot, repoSubscribe } from './repoStore.js';
import { type ReviewTarget, reviewTarget } from './reviewStore.js';

export function openReviewTarget(target: ReviewTarget): void {
  if (target.kind === 'review') {
    openDevRoom(target.project, target.worktree);
    if (window.matchMedia(MOBILE_MEDIA_QUERY).matches) openDevroomPage(target.project, target.worktree, 'changes');
    else setDevroomTab('changes');
    return;
  }
  openIssue(target.project, target.id);
}

// Loaded when pressed: the transport needs a browser, and the store's Node tests import this file.
const viewOn = (on: boolean): void => void import('../../transport/index.js').then(({ transport }) => transport.send({ type: 'devroomView', on }));

/**
 * The press on a Task's notice. The daemon sends `repoState` only while a view is on, so with none
 * loaded the press asks for one, opens on the answer and gives up after REVIEW_TOAST_WAIT_MS.
 * ponytail: our `off` can race a dev room the user opens in those seconds; a per-view count if it shows.
 */
export function openTaskReview(task: BoardTask): void {
  const loaded = () => repoGetSnapshot().states[task.project];
  if (loaded()) return openReviewTarget(reviewTarget(task, loaded()?.worktrees));
  viewOn(true);
  let done = false;
  const unsubscribe = repoSubscribe(() => loaded() && finish());
  const timer = setTimeout(finish, REVIEW_TOAST_WAIT_MS);
  function finish(): void {
    if (done) return;
    done = true;
    unsubscribe();
    clearTimeout(timer);
    const target = reviewTarget(task, loaded()?.worktrees);
    if (target.kind === 'issue') viewOn(false);
    openReviewTarget(target);
  }

}
