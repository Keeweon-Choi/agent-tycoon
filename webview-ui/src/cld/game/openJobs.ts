import { showOffice } from '../hud/hudStore.js';
import { setRunsProject } from '../panels/runsFilter.js';

/** The 현황판's 실행 tab on every project (the job chip, the control center's 실행 중, the 실행 중 card). */
export function openJobs(): void {
  setRunsProject(null);
  showOffice('runs');
}
