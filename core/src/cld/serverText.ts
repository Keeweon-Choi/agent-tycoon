/**
 * I1: the words the daemon shows the owner (refusals, notices, warnings), one
 * table. The daemon sends the Korean text in `error` (so an older client still
 * reads something) together with `errorCode` (+ `errorParams` for the {name}
 * holes); the web UI looks the code up here and shows its own language. A code
 * the UI does not know falls back to the daemon's text. `code` itself is the
 * CLI/MCP error class (several texts share `usage`), so it is not the key.
 *
 * One entry per message: add it here and both languages exist (the webview
 * builds its `srv.<code>` dictionary entries from this table).
 */
export type TextVars = Record<string, string | number>;

/** What a daemon reply carries beside its Korean `error` text. */
export type Coded = {
  errorCode?: string;
  errorParams?: TextVars;
};

export const SERVER_TEXT = {
  // -- folders (projectPath.ts, shared by the form and the daemon) --
  path_slow_mnt: {
    ko: 'Windows 드라이브(/mnt) 폴더는 느립니다. 리눅스 홈 아래를 권장합니다',
    en: 'Folders on a Windows drive (/mnt) are slow. A folder under your Linux home works better.',
  },
  path_unc: {
    ko: '네트워크 폴더(UNC)는 느릴 수 있어요',
    en: 'Network folders (UNC) can be slow.',
  },
  path_long: {
    ko: '경로가 260자를 넘어요. 일부 프로그램이 다루지 못할 수 있어요',
    en: 'This path is over 260 characters. Some programs may not be able to open it.',
  },
  folder_dots: {
    ko: '폴더에 . 이나 .. 는 쓸 수 없어요',
    en: 'A folder path cannot contain "." or ".." parts.',
  },
  name_empty: { ko: '폴더 이름을 입력해 주세요', en: 'Enter a folder name.' },
  name_long: {
    ko: '폴더 이름은 255자까지예요',
    en: 'A folder name can be at most 255 characters.',
  },
  name_slash: {
    ko: '폴더 이름에 / 나 \\ 는 쓸 수 없어요',
    en: 'A folder name cannot contain / or \\.',
  },
  name_control: {
    ko: '폴더 이름에 제어 문자를 쓸 수 없어요',
    en: 'A folder name cannot contain control characters.',
  },
  name_win_chars: {
    ko: '폴더 이름에 < > : " | ? * 는 쓸 수 없어요',
    en: 'A folder name cannot contain < > : " | ? *',
  },
  name_win_end: {
    ko: 'Windows 폴더 이름은 점이나 공백으로 끝날 수 없어요',
    en: 'On Windows, a folder name cannot end with a dot or a space.',
  },
  name_win_reserved: {
    ko: '{name}: Windows가 장치 이름으로 쓰는 이름이라 쓸 수 없어요',
    en: '"{name}" is a device name on Windows, so it cannot be used.',
  },
  folder_empty: { ko: '폴더를 입력해 주세요', en: 'Enter a folder.' },
  folder_control: {
    ko: '폴더에 제어 문자를 쓸 수 없어요',
    en: 'A folder path cannot contain control characters.',
  },
  folder_too_long: { ko: '폴더 경로가 너무 길어요', en: 'This folder path is too long.' },
  folder_other_distro: {
    ko: '다른 WSL 배포판({distro})의 폴더예요',
    en: 'This folder belongs to another WSL distribution ({distro}).',
  },
  folder_start_wsl: {
    ko: '폴더는 / 나 ~/ 또는 C:\\ 로 시작해 주세요',
    en: 'Start the folder with /, ~/ or C:\\.',
  },
  folder_start_posix: {
    ko: '폴더는 / 나 ~/ 로 시작해 주세요',
    en: 'Start the folder with / or ~/.',
  },
  folder_start_win: {
    ko: '폴더는 C:\\ 같은 드라이브나 \\\\서버\\공유 로 시작해 주세요',
    en: 'Start the folder with a drive such as C:\\ or \\\\server\\share.',
  },
  // -- folder picker (folders.ts) --
  folder_outside: {
    ko: '홈 폴더와 드라이브 밖은 볼 수 없어요',
    en: 'Folders outside your home folder and drives cannot be shown.',
  },
  folder_forbidden: { ko: '이 폴더는 열 수 없어요', en: 'This folder cannot be opened.' },
  folder_not_found: { ko: '없는 폴더예요', en: 'This folder does not exist.' },
  folder_unreadable: { ko: '폴더를 열 수 없어요', en: 'Could not open the folder.' },
  root_home: { ko: '홈', en: 'Home' },
  // -- every surface: who may do what --
  no_permission: {
    ko: '이 접속에는 조작 권한이 없어요',
    en: 'This connection is not allowed to make changes.',
  },
  read_only_mode: {
    ko: '읽기 전용 모드라 조작할 수 없어요',
    en: 'This office is read-only, so nothing can be changed.',
  },
  engine_off: { ko: '엔진이 꺼져 있어요', en: 'The engine is turned off.' },
  chat_off: { ko: '대화 기능이 꺼져 있어요', en: 'Chat is turned off.' },
  bad_request: { ko: '요청이 올바르지 않아요', en: 'That request is not valid.' },
  conversation_not_found: { ko: '이 대화를 찾지 못했어요', en: 'That conversation was not found.' },
  // -- jobs (office.ts, jobs.ts) --
  job_unknown: { ko: '모르는 작업이에요', en: 'That job is not known.' },
  // -- Codex usage check --
  usage_denied: {
    ko: '이 접속에는 사용량을 확인할 권한이 없어요',
    en: 'This connection cannot check usage.',
  },
  usage_cooldown: {
    ko: '10분에 한 번만 확인할 수 있어요',
    en: 'Usage can be checked once every 10 minutes.',
  },
  usage_no_codex: { ko: 'Codex를 찾을 수 없어요', en: 'Codex was not found.' },
  usage_timeout: {
    ko: 'Codex 응답이 너무 오래 걸려서 멈췄어요',
    en: 'Codex took too long to answer, so it was stopped.',
  },
  usage_codex_exit: {
    ko: 'Codex가 끝났어요 (code {code})',
    en: 'Codex stopped (code {code}).',
  },
  // -- offices, floors, boards --
  whiteboard_missing: { ko: '이 화이트보드를 찾지 못했어요', en: 'That whiteboard was not found.' },
  not_engine_project: { ko: '엔진 프로젝트가 아니에요', en: 'This is not an engine project.' },
  work_record_missing: {
    ko: '이 일의 기록을 찾지 못했어요',
    en: 'The record of this work was not found.',
  },
  group_change_failed: { ko: '단톡방을 바꾸지 못했어요', en: 'Could not change the group room.' },
  floor_choose_toggle: { ko: '켜기나 끄기를 골라 주세요', en: 'Choose on or off.' },
  office_unknown: { ko: '없는 사무실이에요', en: 'That office does not exist.' },
  character_unknown: { ko: '없는 캐릭터예요', en: 'That character does not exist.' },
  office_or_character: {
    ko: '사무실이나 캐릭터 하나를 골라 주세요',
    en: 'Choose one office or one character.',
  },
  // -- messenger (engine/messenger.ts, chatSend.ts) --
  send_self: {
    ko: '자기 자신에게는 보낼 수 없어요',
    en: 'A project cannot send a message to itself.',
  },
  message_empty: { ko: '메시지가 없습니다', en: 'The message is empty.' },
  message_too_long: {
    ko: '메시지가 너무 깁니다({kb}KB까지)',
    en: 'The message is too long (up to {kb} KB).',
  },
  send_project_unknown: {
    ko: "'{name}' 프로젝트가 없습니다: {names}",
    en: "There is no project named '{name}'. Known projects: {names}",
  },
  command_needs_live: {
    ko: '/ 명령은 대화가 켜져 있을 때만 보낼 수 있어요',
    en: 'A / command can only be sent while the conversation is on.',
  },
  inbox_write_failed: { ko: 'inbox 파일을 쓰지 못했습니다', en: 'Could not write the inbox file.' },
  queue_write_failed: {
    ko: '대기 파일을 쓰지 못했습니다',
    en: 'Could not write the waiting file.',
  },
  not_waiting: { ko: '기다리는 메시지가 아니에요', en: 'That message is not waiting.' },
  command_after_turn: {
    ko: '/ 명령은 대화가 끝난 뒤 보낼 수 있어요',
    en: 'A / command can be sent once the conversation has ended.',
  },
  message_gone: {
    ko: '이미 들어갔거나 없는 메시지예요',
    en: 'That message has already gone in, or does not exist.',
  },
  already_typing: { ko: '이미 입력하고 있어요', en: 'It is already being typed.' },
  send_text_length: {
    ko: '보낼 글은 1자 이상 {max}자 이하여야 해요',
    en: 'The message must be between 1 and {max} characters.',
  },
  send_text_chars: {
    ko: '보낼 글에 쓸 수 없는 문자가 있어요',
    en: 'The message has characters that cannot be sent.',
  },
  slash_multiline: {
    ko: '여러 줄은 명령으로 보낼 수 없어요',
    en: 'A command cannot span several lines.',
  },
  slash_too_long: {
    ko: '/ 명령은 {max}자까지만 보낼 수 있어요',
    en: 'A / command can be at most {max} characters.',
  },
  slash_spacing: {
    ko: '명령 이름과 인수 사이에는 공백 하나만 쓸 수 있어요',
    en: 'Put exactly one space between the command name and its argument.',
  },
  slash_unknown: { ko: '모르는 명령이에요', en: 'That command is not known.' },
  slash_needs_arg: {
    ko: '/{name}에는 {arg}을(를) 함께 적어야 해요',
    en: '/{name} needs {arg} after it.',
  },
  job_not_ours: {
    ko: 'pid {pid} 은 cld-gui 작업이 아닙니다',
    en: 'pid {pid} is not a job started from this office.',
  },
  job_gone: {
    ko: '{what} 작업이 없습니다(이미 끝났을 수 있다)',
    en: 'There is no job {what} (it may have already finished).',
  },
  job_unstoppable: {
    ko: 'pid {pid} 은 멈출 수 없는 프로세스입니다',
    en: 'pid {pid} is a process that cannot be stopped.',
  },
  // -- floors (building.ts) --
  floor_missing: { ko: '없는 층이에요', en: 'That floor does not exist.' },
  floor_name_bad: {
    ko: '층 이름은 1~{max}자로 써 주세요',
    en: 'A floor name must be 1 to {max} characters.',
  },
  floor_limit: { ko: '층은 {max}개까지예요', en: 'There can be at most {max} floors.' },
  floor_first: { ko: '1층은 지울 수 없어요', en: 'Floor 1 cannot be removed.' },
  save_failed: { ko: '저장하지 못했어요 ({why})', en: 'Could not save ({why}).' },
  work_view_limit: {
    ko: '열어 둘 수 있는 작업 보기는 {max}개까지예요',
    en: 'You can keep at most {max} work views open.',
  },
  work_view_busy: { ko: '지금은 더 열 수 없어요', en: 'No more can be opened right now.' },
  // -- group rooms (engine/groups.ts, groupMessages.ts) --
  room_name_bad: { ko: '방 이름이 올바르지 않아요', en: 'That room name is not valid.' },
  room_name_taken: { ko: '이미 있는 방 이름이에요', en: 'A room with that name already exists.' },
  room_project_unregistered: {
    ko: '등록되지 않은 프로젝트가 있어요',
    en: 'Some of those projects are not registered.',
  },
  room_all_rename: { ko: '전체 방은 이름을 바꿀 수 없어요', en: 'The All room cannot be renamed.' },
  room_missing: { ko: '방을 찾지 못했어요', en: 'That room was not found.' },
  room_all_members: {
    ko: '전체 방의 구성원은 프로젝트 목록을 따라요',
    en: "The All room's members follow the project list.",
  },
  room_all_delete: { ko: '전체 방은 지울 수 없어요', en: 'The All room cannot be deleted.' },
  rooms_unreadable: {
    ko: '단톡방 목록을 읽지 못해 바꾸지 않았어요',
    en: 'The room list could not be read, so nothing was changed.',
  },
  rooms_corrupt: {
    ko: '단톡방 목록이 손상되어 바꾸지 않았어요',
    en: 'The room list is damaged, so nothing was changed.',
  },
  rooms_save_failed: {
    ko: '단톡방 목록을 저장하지 못했어요',
    en: 'Could not save the room list.',
  },
  room_log_failed: {
    ko: '단톡방 기록을 저장하지 못했어요',
    en: 'Could not save the room history.',
  },
  room_name_reserved: {
    ko: "'{name}' 이름으로는 보낼 수 없어요",
    en: "Messages cannot be sent under the name '{name}'.",
  },
  room_no_member: {
    ko: "방에 '{name}' 구성원이 없어요",
    en: "Nobody named '{name}' is in this room.",
  },
  git_missing: {
    ko: 'git을 찾지 못했어요',
    en: 'Git was not found.',
  },
  git_too_old: {
    ko: 'git 2.31 이상이 필요해요 (지금 {version})',
    en: 'Git 2.31 or newer is needed (this one is {version}).',
  },
  git_merge_base_failed: {
    ko: 'git merge-base 실패: {why}',
    en: 'git merge-base failed: {why}',
  },
  git_status_unreadable: {
    ko: 'git 상태를 읽지 못했어요',
    en: 'Could not read the git status.',
  },
  git_worktrees_unreadable: {
    ko: 'git worktree 목록을 읽지 못했어요',
    en: 'Could not read the list of git worktrees.',
  },
  merge_same: {
    ko: '같은 브랜치끼리는 병합하지 않아요',
    en: 'A branch cannot be merged into itself.',
  },
  branch_missing: {
    ko: '브랜치 {branch} 가 없어요',
    en: 'Branch {branch} does not exist.',
  },
  merge_behind: {
    ko: '{target} 가 {upstream} 보다 뒤처져 있어요. 먼저 받아(pull) 주세요',
    en: '{target} is behind {upstream}. Pull first.',
  },
  merge_in_progress: {
    ko: '{target} 를 다른 폴더에서 rebase/bisect 하는 중이에요. 끝낸 뒤 병합해 주세요',
    en: '{target} is being rebased or bisected in another folder. Finish that, then merge.',
  },
  merge_dirty: {
    ko: '{target} 를 쓰는 폴더에 커밋하지 않은 변경 {count}건이 있어요. 정리한 뒤 병합해 주세요',
    en: 'The folder that has {target} checked out has {count} uncommitted changes. Clean them up, then merge.',
  },
  git_config_unreadable: {
    ko: 'git 설정을 읽지 못했어요',
    en: 'Could not read the git configuration.',
  },
  merge_filters: {
    ko: '{target} 를 쓰는 폴더의 저장소가 자체 필터(git-crypt, LFS 등)를 써서 자동으로 옮기지 않아요. 그 폴더에서 직접 병합해 주세요',
    en: 'The folder that has {target} checked out uses its own filters (git-crypt, LFS, ...), so it is not moved automatically. Merge in that folder yourself.',
  },
  merge_moved: {
    ko: '{target} 가 그새 바뀌었어요. 다시 시도해 주세요',
    en: '{target} changed in the meantime. Try again.',
  },
  merge_move_failed: {
    ko: '{target} 를 옮기지 못했어요: {why}',
    en: 'Could not move {target}: {why}',
  },
  worktrees_not_dir: {
    ko: '{dir}가 폴더가 아니에요',
    en: '{dir} is not a folder.',
  },
  merge_prepare_failed: {
    ko: '병합 준비를 하지 못했어요: {why}',
    en: 'Could not prepare the merge: {why}',
  },
  merge_commit_unreadable: {
    ko: '병합 커밋을 읽지 못했어요',
    en: 'Could not read the merge commit.',
  },
  merge_failed: {
    ko: '병합하지 못했어요: {why}',
    en: 'The merge failed: {why}',
  },
  project_unregistered: {
    ko: '등록된 프로젝트가 아니에요',
    en: 'That project is not registered.',
  },
  git_run_failed: {
    ko: 'git을 실행하지 못했어요',
    en: 'Could not run git.',
  },
  diff_failed: {
    ko: 'diff를 읽지 못했어요',
    en: 'Could not read the diff.',
  },
  worktree_missing: {
    ko: '그런 작업 공간이 없어요',
    en: 'There is no such workspace.',
  },
  changes_unreadable: {
    ko: '변경을 읽지 못했어요',
    en: 'Could not read the changes.',
  },
  worktree_cannot_make: {
    ko: 'worktree 를 만들 수 없어요',
    en: 'A worktree cannot be created here.',
  },
  project_busy: {
    ko: '{name}: 이미 다른 조작이 진행 중이에요',
    en: '{name}: another action is already running.',
  },
  merge_no_base: {
    ko: '기준이 브랜치가 아니라 병합할 곳이 없어요',
    en: 'The base is not a branch, so there is nowhere to merge into.',
  },
  merge_protected: {
    ko: '{target} 는 보호 브랜치라 자동으로 병합하지 않아요. 작업실에서 직접 병합해 주세요',
    en: '{target} is a protected branch, so it is not merged automatically. Merge it yourself in the workshop.',
  },
  task_name_needed: {
    ko: '작업 이름을 알려 주세요',
    en: 'Tell me the task name.',
  },
  action_unknown: {
    ko: '모르는 조작이에요',
    en: 'That action is not known.',
  },
  git_not_repo: {
    ko: '이 폴더는 git 저장소가 아니에요',
    en: 'This folder is not a git repository.',
  },
  git_other_owner: {
    ko: '다른 사용자의 폴더라서 git이 열지 못했어요',
    en: 'git could not open this folder because it belongs to another user.',
  },
  git_not_worktree: {
    ko: 'git 작업 폴더가 아니에요',
    en: 'This is not a git working folder.',
  },
  git_open_failed: {
    ko: 'git이 이 폴더를 열지 못했어요: {why}',
    en: 'git could not open this folder: {why}',
  },
  folder_path_invalid: {
    ko: '폴더 경로가 올바르지 않아요',
    en: 'That folder path is not valid.',
  },
  folder_missing: {
    ko: '폴더가 없어요',
    en: 'That folder does not exist.',
  },
  git_not_top: {
    ko: 'git 저장소의 맨 위 폴더가 아니에요',
    en: 'This is not the top folder of a git repository.',
  },
  git_status_failed: {
    ko: 'git status 실패: {why}',
    en: 'git status failed: {why}',
  },
  file_not_changed: {
    ko: '변경 목록에 없는 파일이에요',
    en: 'That file is not in the list of changes.',
  },
  file_no_staged: {
    ko: '이 파일에는 스테이지된 변경이 없어요',
    en: 'This file has no staged changes.',
  },
  file_no_unstaged: {
    ko: '이 파일에는 스테이지 안 된 변경이 없어요',
    en: 'This file has no unstaged changes.',
  },
  diff_timeout: {
    ko: 'diff가 제한 시간 안에 끝나지 않았어요',
    en: 'The diff did not finish in time.',
  },
  git_diff_failed: {
    ko: 'git diff 실패: {why}',
    en: 'git diff failed: {why}',
  },
  new_folder_stage: {
    ko: '새 폴더예요. 스테이지하면 안의 파일을 하나씩 볼 수 있어요.',
    en: 'This is a new folder. Stage it to see its files one by one.',
  },
  new_folder_commit: {
    ko: '새 폴더예요. 커밋하면 안의 파일을 하나씩 볼 수 있어요.',
    en: 'This is a new folder. Commit it to see its files one by one.',
  },
  compare_no_branch: {
    ko: '기준 브랜치나 이 브랜치를 찾지 못해서 변경을 비교할 수 없어요',
    en: 'The base branch or this branch was not found, so the changes cannot be compared.',
  },
  merge_conflict: {
    ko: '충돌이라 멈췄어요(아무것도 바꾸지 않았어요): {files}',
    en: 'Stopped because of a conflict (nothing was changed): {files}',
  },
  merge_already: {
    ko: '{branch} 는 이미 {target} 에 있어요',
    en: '{branch} is already in {target}.',
  },
  merge_done_commit: {
    ko: '{target} ← {branch} (병합 커밋 {short})',
    en: '{target} ← {branch} (merge commit {short})',
  },
  stage_too_many: {
    ko: '한 번에 {max}개까지만 고를 수 있어요. 모두 선택을 써 주세요',
    en: 'You can pick at most {max} at a time. Use select all instead.',
  },
  git_busy: {
    ko: '다른 git 작업이 진행 중이에요',
    en: 'Another git operation is running.',
  },
  commit_timeout: {
    ko: '커밋이 제한 시간 안에 끝나지 않았어요 (훅이나 서명을 확인해 주세요)',
    en: 'The commit did not finish in time (check hooks or signing).',
  },
  commit_nothing: {
    ko: '커밋할 변경이 없어요',
    en: 'There is nothing to commit.',
  },
  git_no_identity: {
    ko: 'git 사용자 이름과 이메일이 없어요 (터미널에서 git config user.name, user.email)',
    en: 'git has no user name and email (set them in a terminal with git config user.name and user.email).',
  },
  commit_conflicts: {
    ko: '해결 안 된 충돌이 있어요',
    en: 'There are unresolved conflicts.',
  },
  commit_sign_failed: {
    ko: '서명에 실패했어요: {why}',
    en: 'Signing failed: {why}',
  },
  commit_failed: {
    ko: '커밋에 실패했어요: {why}',
    en: 'The commit failed: {why}',
  },
  commit_message_needed: {
    ko: '커밋 메시지를 적어 주세요',
    en: 'Write a commit message.',
  },
  commit_message_invalid: {
    ko: '커밋 메시지가 올바르지 않아요',
    en: 'That commit message is not valid.',
  },
  nothing_staged: {
    ko: '스테이지된 변경이 없어요',
    en: 'There are no staged changes.',
  },
  push_timeout: {
    ko: 'push가 제한 시간 안에 끝나지 않았어요',
    en: 'The push did not finish in time.',
  },
  push_rejected: {
    ko: '원격에 새 커밋이 있어서 거부됐어요. 먼저 가져와서 합쳐 주세요 (터미널에서 git pull)',
    en: 'The remote has new commits, so the push was rejected. Pull and merge first (git pull in a terminal).',
  },
  push_auth: {
    ko: '인증이 필요해요. 터미널에서 한 번 push해서 인증을 저장해 주세요',
    en: 'Sign-in is needed. Push once from a terminal to save your credentials.',
  },
  push_no_remote: {
    ko: '원격에 연결하지 못했어요',
    en: 'Could not connect to the remote.',
  },
  push_failed: {
    ko: 'push에 실패했어요: {why}',
    en: 'The push failed: {why}',
  },
  push_detached: {
    ko: '브랜치가 아닌 상태(detached HEAD)라 push할 수 없어요',
    en: 'This is not on a branch (detached HEAD), so it cannot be pushed.',
  },
  push_no_upstream: {
    ko: 'upstream이 없어서 push할 곳을 몰라요. 터미널에서 한 번 git push -u 로 정해 주세요',
    en: 'There is no upstream, so I do not know where to push. Set it once with git push -u in a terminal.',
  },
  push_nothing: {
    ko: '올릴 커밋이 없어요',
    en: 'There are no commits to push.',
  },
  push_remote_unknown: {
    ko: 'push할 원격을 알 수 없어요',
    en: 'The remote to push to is not known.',
  },
  push_branch_unknown: {
    ko: 'push할 브랜치를 알 수 없어요',
    en: 'The branch to push is not known.',
  },
  push_done: {
    ko: '{upstream} · 커밋 {count}개',
    en: '{upstream} · {count} commits',
  },
  stage_done: {
    ko: '{count}건',
    en: '{count} files',
  },
  nothing_to_stage: { ko: '스테이지할 변경이 없어요', en: 'There are no changes to stage.' },
  file_not_staged: {
    ko: '스테이지된 변경 목록에 없는 파일이에요: {file}',
    en: 'That file is not in the list of staged changes: {file}',
  },
  file_not_stageable: {
    ko: '스테이지할 변경 목록에 없는 파일이에요: {file}',
    en: 'That file is not in the list of changes to stage: {file}',
  },
  unstage_failed: { ko: '스테이지 해제에 실패했어요: {why}', en: 'Unstaging failed: {why}' },
  stage_failed: { ko: '스테이지에 실패했어요: {why}', en: 'Staging failed: {why}' },
  timed_out: { ko: '제한 시간을 넘었어요', en: 'it timed out' },
  worktree_name_rule: {
    ko: '작업 이름은 소문자·숫자·-만, 41자까지 쓸 수 있어요',
    en: 'A task name can use lowercase letters, digits and - only, up to 41 characters.',
  },
  worktree_no_commit: {
    ko: '커밋이 하나도 없어서 작업 공간을 만들 수 없어요',
    en: 'There are no commits yet, so a workspace cannot be created.',
  },
  task_id_invalid: {
    ko: 'Task id 가 올바르지 않아요',
    en: 'That task id is not valid.',
  },
  slug_rule: {
    ko: '이름은 소문자·숫자·-만, 40자까지 쓸 수 있어요',
    en: 'A name can use lowercase letters, digits and - only, up to 40 characters.',
  },
  base_name_invalid: {
    ko: '기준 브랜치 이름이 올바르지 않아요: {name}',
    en: 'That base branch name is not valid: {name}',
  },
  worktree_name_failed: {
    ko: '작업 공간 이름을 만들지 못했어요',
    en: 'Could not make a workspace name.',
  },
  task_has_worktree: {
    ko: 'Task {task} 에는 이미 worktree 가 있어요: {dir}/{name}',
    en: 'Task {task} already has a worktree: {dir}/{name}',
  },
  base_not_found: {
    ko: '기준 브랜치를 찾지 못했어요(커밋이 없거나 브랜치가 아니에요)',
    en: 'Could not find the base branch (there are no commits, or it is not a branch).',
  },
  base_missing: {
    ko: '기준 브랜치 {branch}가 없어요',
    en: 'The base branch {branch} does not exist.',
  },
  worktree_protected: {
    ko: '보호 브랜치({branch})에는 worktree 를 만들지 않아요',
    en: 'No worktree is created on the protected branch ({branch}).',
  },
  repo_busy: {
    ko: '저장소가 {operation} 중이에요. 끝낸 뒤에 만들어 주세요',
    en: 'The repository is in the middle of a {operation}. Create it after that finishes.',
  },
  worktree_exists: {
    ko: '작업 공간 {task}은(는) 이미 있어요',
    en: 'The workspace {task} already exists.',
  },
  worktree_folder_exists: {
    ko: '폴더가 이미 있어요: {dir}/{name}',
    en: 'The folder already exists: {dir}/{name}',
  },
  branch_exists: {
    ko: '브랜치 {branch}가 이미 있어요',
    en: 'The branch {branch} already exists.',
  },
  worktree_record_failed: {
    ko: 'worktree 기록을 쓰지 못해서 만든 것을 되돌렸어요',
    en: 'Could not write the worktree record, so what was created has been undone.',
  },
  git_config_dir: {
    ko: 'git 설정 위치를 찾지 못했어요',
    en: 'Could not find where git keeps its settings.',
  },
  task_name_invalid: {
    ko: '작업 이름이 올바르지 않아요',
    en: 'That task name is not valid.',
  },
  worktree_unregistered: {
    ko: 'git 작업 공간으로 등록돼 있지 않은 폴더라 지우지 않아요',
    en: 'That folder is not registered as a git workspace, so it is not removed.',
  },
  loss_commits: {
    ko: '병합되지 않은 커밋 {count}개',
    en: '{count} commits not merged',
  },
  loss_unknown_merge: {
    ko: '병합됐는지 알 수 없어요 (기준 브랜치가 없어요)',
    en: 'Cannot tell whether it was merged (the base branch is missing)',
  },
  loss_dirty: {
    ko: '커밋하지 않은 변경 {count}건',
    en: '{count} uncommitted changes',
  },
  remove_may_lose: {
    ko: '지우면 사라질 수 있어요: {losses}',
    en: 'Removing it may lose: {losses}',
  },
  worktree_remove_failed: {
    ko: '작업 공간을 지우지 못했어요: {why}',
    en: 'Could not remove the workspace: {why}',
  },
  branch_deleted: {
    ko: '브랜치도 지웠어요',
    en: 'The branch was removed too.',
  },
  branch_kept_why: {
    ko: '브랜치 {branch}는 남겼어요 ({why})',
    en: 'The branch {branch} was kept ({why}).',
  },
  branch_kept_unmerged: {
    ko: '브랜치 {branch}는 병합되지 않아 남겼어요',
    en: 'The branch {branch} was kept because it is not merged.',
  },
  worktree_make_failed: {
    ko: '작업 공간을 만들지 못했어요: {why}',
    en: 'Could not create the workspace: {why}',
  },
  guard_own_hooks: {
    ko: '이 저장소는 자체 hooksPath 를 써서 보호 브랜치 가드 훅을 깔지 않았어요',
    en: 'This repository uses its own hooksPath, so the protected-branch guard hooks were not installed.',
  },
  guard_on: {
    ko: '보호 브랜치 가드 훅({hooks})이 켜져 있어요. 실수 방지용이며 보안 경계는 아니에요',
    en: 'The protected-branch guard hooks ({hooks}) are on. They prevent mistakes; they are not a security boundary.',
  },
  guard_none: {
    ko: '보호 브랜치 가드 훅이 없어요',
    en: 'There are no protected-branch guard hooks.',
  },
  guard_user: {
    ko: '{base}. 이미 있는 {hooks} 훅은 건드리지 않았어요',
    en: '{base}. Your existing {hooks} hooks were left alone.',
  },
  guard_failed: {
    ko: '보호 브랜치 가드 훅을 깔지 못했어요',
    en: 'Could not install the protected-branch guard hooks.',
  },
  stop_failed: { ko: '멈추지 못했어요', en: 'It could not be stopped.' },
  swap_unfinished: {
    ko: 'Lead 교체가 끝나지 않았어요(lead-swap.json); cld-gui 를 다시 시작하면 이어서 끝내요',
    en: 'The Lead swap is not finished (lead-swap.json). Restart cld-gui and it will finish.',
  },
  worker_room: {
    ko: 'Worker 는 프로젝트의 방에 있어요(방은 프로젝트에서 바꿔 주세요)',
    en: "A Worker is in its project's room. Change the room on the project.",
  },
  worker_folder: {
    ko: 'Worker 폴더는 프로젝트 폴더 안이나 저장소의 .worktrees/ 안(worktree)이어야 해요',
    en: "A Worker's folder must be inside the project folder or inside the repository's .worktrees/ (a worktree).",
  },
  agent_unknown_start: {
    ko: 'cld-gui가 모르는 에이전트({id})라 켤 수 없어요',
    en: 'cld-gui does not know the agent ({id}), so it cannot be started.',
  },
  no_direct_chat: {
    ko: 'Codex Worker 와는 직접 대화하지 않아요 · Lead 에게 맡기거나 단톡방에서 불러 주세요',
    en: 'You do not talk to a Codex Worker directly. Ask its Lead, or call it in a group room.',
  },
  agent_unknown_send: {
    ko: 'cld-gui가 모르는 에이전트({id})라 받을 수 없어요',
    en: 'cld-gui does not know the agent ({id}), so it cannot receive messages.',
  },
  project_unknown: {
    ko: "'{name}' 프로젝트가 없습니다",
    en: "There is no project named '{name}'.",
  },
  registry_unreadable: {
    ko: '프로젝트 목록 파일을 읽지 못해 바꿀 수 없어요',
    en: 'The project list file could not be read, so nothing can be changed.',
  },
  renew_pending: {
    ko: "'{name}': 이미 새 대화로 넘기는 중이에요",
    en: "'{name}': already moving to a new conversation.",
  },
  project_busy_quoted: {
    ko: "'{name}': 이미 다른 조작이 진행 중이에요",
    en: "'{name}': another action is already running.",
  },
  registry_broken: {
    ko: '프로젝트 목록 파일({file})을 읽지 못해 바꿀 수 없어요: {why}',
    en: 'Could not read the project list file ({file}), so nothing can be changed: {why}',
  },
  down_idle: {
    ko: 'Claude 가 오래 쉬어 내림 · 메시지가 오면 다시 켬',
    en: 'Claude was stopped after resting a long time · it starts again when a message comes',
  },
  down_gave_up: {
    ko: '자꾸 꺼져서 다시 띄우지 않아요 ({why})',
    en: 'It keeps stopping, so it is not restarted ({why})',
  },
  registry_unreadable_short: {
    ko: '프로젝트 목록 파일을 읽지 못했어요',
    en: 'The project list file could not be read.',
  },
  import_not_found: {
    ko: '검색 결과에 없는 폴더예요',
    en: 'That folder is not in the search results.',
  },
  import_registered: {
    ko: '이미 등록되어 있어요',
    en: 'It is already registered.',
  },
  name_taken: {
    ko: '이미 있는 이름이에요',
    en: 'That name is already in use.',
  },
  import_start_failed: {
    ko: '등록했지만 켜지 못했어요: {why}',
    en: 'Registered, but it could not be started: {why}',
  },
  registry_save_failed: {
    ko: '프로젝트 목록을 저장하지 못했어요',
    en: 'Could not save the project list.',
  },
  engine_error: {
    ko: '엔진 오류로 끝내지 못했어요',
    en: 'The engine hit an error and could not finish.',
  },
  project_unknown_short: {
    ko: '모르는 프로젝트예요',
    en: 'That project is not known.',
  },
  project_renewing: {
    ko: '{name}: 새 대화로 넘기는 중이에요',
    en: '{name}: moving to a new conversation.',
  },
  already_lead: {
    ko: "'{name}' 은(는) 이미 Lead 예요: Lead 로 바꿀 수 있는 것은 Worker 예요",
    en: "'{name}' is already a Lead. Only a Worker can become a Lead.",
  },
  codex_not_lead: {
    ko: 'Codex Worker 는 아직 Lead 가 될 수 없어요',
    en: 'A Codex Worker cannot become a Lead yet.',
  },
  lead_claude_only: {
    ko: 'Lead 는 Claude 에이전트만 될 수 있어요',
    en: 'Only a Claude agent can be a Lead.',
  },
  worker_lead_missing: {
    ko: '이 Worker 의 프로젝트 Lead 를 찾지 못했어요',
    en: "Could not find this Worker's project Lead.",
  },
  project_readopting: {
    ko: '{name}: 세션을 다시 찾는 중이에요. 잠시 뒤 다시 해 주세요',
    en: '{name}: looking for its session again. Try again in a moment.',
  },
  rules_path_absolute: {
    ko: '규칙 파일은 절대 경로로 적어 주세요',
    en: 'Write the rules file as an absolute path.',
  },
  worker_role: {
    ko: 'Worker 의 역할(worker, reviewer)을 골라 주세요',
    en: 'Choose a role for the Worker (worker or reviewer).',
  },
  agent_unknown: {
    ko: '이 cld-gui 가 모르는 에이전트예요: {provider}',
    en: 'This cld-gui does not know that agent: {provider}',
  },
  codex_no_setting: {
    ko: 'Codex Worker 는 이 설정을 받지 않아요: {names}',
    en: 'A Codex Worker does not take these settings: {names}',
  },
  codex_effort: {
    ko: 'Codex 의 추론 강도는 {values} 중 하나예요',
    en: "Codex's reasoning effort must be one of: {values}",
  },
  agent_kind_fixed: {
    ko: '에이전트 종류는 바꿀 수 없어요(새로 만들어 주세요)',
    en: 'The agent kind cannot be changed (create a new one).',
  },
  role_project_fixed: {
    ko: '역할과 프로젝트는 바꿀 수 없어요',
    en: 'The role and the project cannot be changed.',
  },
  folder_change_running: {
    ko: '켜져 있는 동안에는 폴더를 바꿀 수 없어요',
    en: 'The folder cannot be changed while it is running.',
  },
  launch_options_next: {
    ko: '바꾼 실행 옵션은 새 대화부터 적용돼요',
    en: 'The changed launch options apply from the next conversation.',
  },
  session_name_clash: {
    ko: "'{other}'와 같은 폴더에서 세션 이름({a}, {b})이 겹쳐요: 다른 이름이나 제목을 써 주세요",
    en: "In the same folder as '{other}', the session names ({a}, {b}) collide. Use a different name or title.",
  },
  removed_terminal_kept: {
    ko: '터미널에서 열린 대화는 그대로 두었어요. 대화 기록은 남아요',
    en: 'The conversation open in a terminal was left as it is. The conversation history stays.',
  },
  removed_history_kept: {
    ko: '대화 기록은 남아요',
    en: 'The conversation history stays.',
  },
  swap_stop_failed: {
    ko: '{name}: {why} — 아무것도 바꾸지 않았어요',
    en: '{name}: {why} — nothing was changed.',
  },
  swap_journal_failed: {
    ko: '교체 기록을 쓰지 못했어요({why}) — 아무것도 바꾸지 않았어요',
    en: 'Could not write the swap record ({why}) — nothing was changed.',
  },
  swap_not_finished: {
    ko: '교체를 끝내지 못했어요. cld-gui 를 다시 시작하면 이어서 끝내요',
    en: 'The swap could not be finished. Restart cld-gui and it will finish.',
  },
  swap_lead_start_failed: {
    ko: '새 Lead 를 켜지 못했어요({why}) — 첫 메시지는 inbox 에서 기다려요',
    en: 'Could not start the new Lead ({why}) — its first message waits in the inbox.',
  },
  swap_worker_start_failed: {
    ko: '이전 Lead 를 Worker 로 켜지 못했어요({why})',
    en: 'Could not start the previous Lead as a Worker ({why}).',
  },
  swap_in_terminal: {
    ko: "'{name}' 의 대화가 터미널에서 열려 있어요. 닫은 뒤 다시 해 주세요",
    en: "The conversation of '{name}' is open in a terminal. Close it, then try again.",
  },
  swap_busy: {
    ko: "'{name}' 이(가) 일하는 중이에요. 작업이 끝난 뒤 다시 해 주세요",
    en: "'{name}' is working. Try again when the work is done.",
  },
  already_on: {
    ko: '이미 켜져 있어요',
    en: 'It is already on.',
  },
  already_in_terminal: {
    ko: '이 대화는 이미 터미널에서 열려 있어요',
    en: 'This conversation is already open in a terminal.',
  },
  session_elsewhere: {
    ko: '같은 이름의 백그라운드 세션이 다른 폴더에서 켜져 있어요',
    en: 'A background session with the same name is running in another folder.',
  },
  started_fresh: {
    ko: '이전 대화 기록이 없어 새 대화로 켰어요',
    en: 'There was no earlier conversation record, so a new conversation was started.',
  },
  session_not_found: {
    ko: '켠 세션을 찾지 못했어요',
    en: 'Could not find the session that was started.',
  },
  started_as_copy: {
    ko: '같은 대화의 사본으로 켰어요',
    en: 'Started as a copy of the same conversation.',
  },
  terminal_cannot_stop: {
    ko: '터미널에서 열린 대화는 여기서 끌 수 없어요',
    en: 'A conversation open in a terminal cannot be stopped here.',
  },
  already_off: {
    ko: '이미 꺼져 있어요',
    en: 'It is already off.',
  },
  terminal_cannot_restart: {
    ko: '터미널에서 열린 대화는 여기서 다시 켤 수 없어요',
    en: 'A conversation open in a terminal cannot be restarted here.',
  },
  session_not_stopped: {
    ko: '세션이 멈추지 않았어요',
    en: 'The session did not stop.',
  },
  name_rule: {
    ko: '이름은 영문, 숫자, 한글로 시작하고 . _ - 를 더해 41자까지예요',
    en: 'A name starts with a letter, digit or Hangul and may add . _ - , up to 41 characters.',
  },
  rules_unreadable: {
    ko: '규칙 파일을 읽을 수 없어요',
    en: 'The rules file cannot be read.',
  },
  model_invalid: {
    ko: '모델 이름이 올바르지 않아요',
    en: 'That model name is not valid.',
  },
  permission_mode_invalid: {
    ko: '권한 모드가 올바르지 않아요',
    en: 'That permission mode is not valid.',
  },
  effort_invalid: {
    ko: 'effort 값이 올바르지 않아요',
    en: 'That effort value is not valid.',
  },
  title_invalid: {
    ko: '대화 이름이 올바르지 않아요',
    en: 'That conversation name is not valid.',
  },
  folder_not_dir: {
    ko: '폴더가 아니에요',
    en: 'That is not a folder.',
  },
  folder_make_failed: {
    ko: '폴더를 만들지 못했어요',
    en: 'Could not create the folder.',
  },
  not_a_worker: {
    ko: "'{name}' 은(는) Worker 가 아니에요",
    en: "'{name}' is not a Worker.",
  },
  swap_list_unreadable: {
    ko: '바꾼 목록을 읽을 수 없어요({why})',
    en: 'Cannot read the changed list ({why}).',
  },
  home_folders_only: {
    ko: '홈 폴더 안의 폴더만 열 수 있어요',
    en: 'Only folders inside your home folder can be opened.',
  },
  stopped_n_times: {
    ko: '{count}번 꺼졌어요',
    en: 'It stopped {count} times.',
  },
  stopped_n_per_day: {
    ko: '하루에 {count}번 꺼졌어요',
    en: 'It stopped {count} times in a day.',
  },
  trust_needed: {
    ko: '폴더 신뢰 확인 필요: 터미널에서 이 폴더로 가서 claude를 한 번 실행하고 신뢰를 허락한 뒤 다시 켜 주세요',
    en: 'This folder needs your trust first: run claude once in it from a terminal, allow it, then start again.',
  },
  trust_answered: {
    ko: '폴더 신뢰 질문에 대신 답하고 켰어요',
    en: 'Answered the folder trust question for you and started it.',
  },
  trust_claude_only: {
    ko: '폴더 신뢰는 Claude 에이전트에만 있어요',
    en: 'Folder trust applies to Claude agents only.',
  },
  claude_missing: {
    ko: 'claude 실행 파일을 찾지 못했어요',
    en: 'The claude program was not found.',
  },
  session_start_failed: {
    ko: '세션을 켜지 못했어요',
    en: 'Could not start the session.',
  },
  session_id_unknown: {
    ko: '세션 id를 알 수 없어요',
    en: 'The session id is not known.',
  },
  session_stop_failed: {
    ko: '세션을 멈추지 못했어요',
    en: 'Could not stop the session.',
  },
  daemon_env: {
    ko: 'Claude 데몬(pid {pid})이 다른 세션의 환경을 물려받았어요: {vars}. 이 데몬이 띄우는 백그라운드 세션도 그 환경으로 돌아요',
    en: "The Claude daemon (pid {pid}) inherited another session's environment: {vars}. Background sessions it starts run with that environment too.",
  },
  codex_missing: {
    ko: 'codex 실행 파일을 찾지 못했어요(PATH)',
    en: 'The codex program was not found (PATH).',
  },
  run_stop_failed: {
    ko: '실행을 멈추지 못했어요',
    en: 'Could not stop the run.',
  },
  delegation_off: {
    ko: '위임 기능이 꺼져 있어요',
    en: 'Delegation is turned off.',
  },
  attachment_label: {
    ko: '첨부 파일',
    en: 'Attachment',
  },
  conversation_loading: {
    ko: '이 대화를 불러오는 중이에요',
    en: 'This conversation is still loading.',
  },
  history_too_big: {
    ko: '이 부분은 너무 커서 불러오지 못했어요',
    en: 'This part is too large to load.',
  },
  search_query_length: {
    ko: '검색어는 2~100자로 입력해 주세요',
    en: 'Enter a search of 2 to 100 characters.',
  },
  task_notice: {
    ko: '작업 알림',
    en: 'Task notice',
  },
  // -- room system lines (groupMessages.ts) --
  sys_assigned: { ko: 'Task {task} 배정: {line}', en: 'Task {task} assigned: {line}' },
  sys_reported: { ko: 'Task {task} 보고: {line}', en: 'Task {task} reported: {line}' },
  sys_conflict: { ko: 'Task {task} 병합 충돌: {line}', en: 'Task {task} merge conflict: {line}' },
  sys_merged: { ko: 'Task {task} 병합됨: {line}', en: 'Task {task} merged: {line}' },
  // -- work words: job titles and news lines (core/work.ts, engine/eventSummary.ts) --
  work_default: { ko: '작업', en: 'Job' },
  work_default_codex: { ko: 'Codex 작업', en: 'Codex task' },
  work_task_n: { ko: 'T-{id} 작업', en: 'Task T-{id}' },
  work_started_eul: { ko: '{subject}을 시작했어요', en: 'Started {subject}' },
  work_started_reul: { ko: '{subject}를 시작했어요', en: 'Started {subject}' },
  work_restarted_eul: { ko: '{subject}을 다시 시작했어요', en: 'Restarted {subject}' },
  work_restarted_reul: { ko: '{subject}를 다시 시작했어요', en: 'Restarted {subject}' },
  work_stopping_eul: { ko: '{subject}을 멈추는 중이에요', en: 'Stopping {subject}' },
  work_stopping_reul: { ko: '{subject}를 멈추는 중이에요', en: 'Stopping {subject}' },
  work_done_i: { ko: '{subject}이 끝났어요', en: '{subject} finished' },
  work_done_ga: { ko: '{subject}가 끝났어요', en: '{subject} finished' },
  work_failed_i: { ko: '{subject}이 실패했어요', en: '{subject} failed' },
  work_failed_ga: { ko: '{subject}가 실패했어요', en: '{subject} failed' },
  work_timeout_i: { ko: '{subject}이 시간 초과됐어요', en: '{subject} timed out' },
  work_timeout_ga: { ko: '{subject}가 시간 초과됐어요', en: '{subject} timed out' },
  work_stopped_i: { ko: '{subject}이 멈췄어요', en: '{subject} stopped' },
  work_stopped_ga: { ko: '{subject}가 멈췄어요', en: '{subject} stopped' },
  work_limit_i: {
    ko: '{subject}이 한도를 기다려요',
    en: '{subject} is waiting for the usage limit',
  },
  work_limit_ga: {
    ko: '{subject}가 한도를 기다려요',
    en: '{subject} is waiting for the usage limit',
  },
  ev_send: { ko: '{from} → {to} 메시지', en: '{from} → {to} message' },
  ev_send_inbox: { ko: '{from} → {to} 메시지 (inbox)', en: '{from} → {to} message (inbox)' },
  ev_send_queued: { ko: '{from} → {to} 메시지 (대기)', en: '{from} → {to} message (queued)' },
  ev_owner: { ko: '사장', en: 'Owner' },
  ev_me: { ko: '나({device})', en: 'me ({device})' },
  ev_send_edit: { ko: '{to} 대기 메시지 수정', en: 'Edited a queued message to {to}' },
  ev_send_hold: { ko: '{to} 대기 메시지 보류', en: 'Held a queued message to {to}' },
  ev_send_unhold: { ko: '{to} 대기 메시지 보류 해제', en: 'Released a held message to {to}' },
  ev_send_stuck: {
    ko: '{to}에게 입력이 안 들어가서 천천히 다시 시도해요',
    en: 'Typing into {to} keeps failing; retrying less often',
  },
  ev_token_guard: { ko: '{to} 쪽 입력 하나를 막았어요', en: 'Blocked an input for {to}' },
  ev_send_cancel: { ko: '{to} 대기 메시지 취소', en: 'Cancelled a queued message to {to}' },
  ev_delegate: { ko: '{from} → {to} 위임 {task}', en: '{from} → {to} delegated {task}' },
  ev_delegate_queued: {
    ko: '{from} → {to} 위임 {task} (대기)',
    en: '{from} → {to} delegated {task} (queued)',
  },
  ev_delegate_new: {
    ko: '{from} → {to} 위임 {task} (새 Worker)',
    en: '{from} → {to} delegated {task} (new Worker)',
  },
  ev_delegate_queued_new: {
    ko: '{from} → {to} 위임 {task} (대기) (새 Worker)',
    en: '{from} → {to} delegated {task} (queued) (new Worker)',
  },
  ev_task_report: {
    ko: '{from} → Task {task} 보고 ({status})',
    en: '{from} → Task {task} report ({status})',
  },
  ev_delegation_approval: {
    ko: '{from} 의 위임 승인 요청',
    en: '{from} asked for delegation approval',
  },
  ev_delegation_proposal: {
    ko: '{from} → {who} 위임 제안 {task}',
    en: '{from} → {who} delegation proposal {task}',
  },
  ev_delegation_start_failed: {
    ko: '{to} 이(가) 켜지지 않아 Task {task} 가 기다려요',
    en: '{to} did not start, so Task {task} is waiting',
  },
  ev_delegation_approved: { ko: '{to} 의 위임 승인', en: 'Delegation to {to} approved' },
  ev_delegation_denied: { ko: '{to} 의 위임 거절', en: 'Delegation to {to} declined' },
  ev_inbox_deliver: { ko: '{to} inbox 전달', en: 'Inbox delivered to {to}' },
  ev_orch_start: { ko: '{who} 시작', en: '{who} started' },
  ev_orch_resumed: { ko: '{who} 이어서 시작', en: '{who} resumed' },
  ev_orch_exit: { ko: '{who} 종료', en: '{who} stopped' },
  ev_orch_exit_code: { ko: '{who} 종료 (code {code})', en: '{who} stopped (code {code})' },
  ev_lead_swap_stop: {
    ko: '{project} Lead 교체: {to} → Lead, 이전 Lead 멈춤',
    en: '{project} Lead swap: {to} → Lead, the previous Lead stopped',
  },
  ev_lead_swap_worker: {
    ko: "{project} Lead 교체: {to} → Lead, 이전 Lead → Worker '{to}'",
    en: "{project} Lead swap: {to} → Lead, the previous Lead → Worker '{to}'",
  },
  ev_orch_giveup: {
    ko: '{who}: 자꾸 꺼져서 다시 띄우지 않아요',
    en: '{who}: it keeps stopping, so it is not restarted',
  },
  ev_orch_giveup_why: {
    ko: '{who}: 자꾸 꺼져서 다시 띄우지 않아요 ({why})',
    en: '{who}: it keeps stopping, so it is not restarted ({why})',
  },
  ev_turn_end: { ko: '{who} 턴 끝', en: '{who} finished a turn' },
  ev_compacted: { ko: '{who} 휴식', en: '{who} took a rest' },
  ev_compacted_n: { ko: '{who} 휴식 {count}회', en: '{who} took a rest ({count} so far)' },
  ev_renew_request: { ko: '{who} 교대 요청', en: 'Handoff requested for {who}' },
  ev_renew_done: { ko: '{who} 교대 완료', en: 'Handoff done for {who}' },
  ev_orch_renew: { ko: '{who} 새 대화로 교대', en: '{who} handed off to a new conversation' },
  ev_orch_renew_failed: {
    ko: '{who} 새 대화로 교대 실패 ({code})',
    en: '{who} could not hand off to a new conversation ({code})',
  },
  ev_revive: { ko: '자동 복구 ({count}곳 시작)', en: 'Auto-recovery ({count} started)' },
  ev_usage_reset_week: {
    ko: '{provider} 주간 사용량이 예정보다 일찍 초기화됐어요',
    en: '{provider} weekly usage reset earlier than scheduled',
  },
  ev_usage_reset_5h: {
    ko: '{provider} 5시간 사용량이 예정보다 일찍 초기화됐어요',
    en: '{provider} 5-hour usage reset earlier than scheduled',
  },
  ev_project: { ko: '프로젝트 {action}: {who}', en: 'Project {action}: {who}' },
  ev_project_changed: { ko: '변경', en: 'changed' },
  ev_gpu_queue: { ko: 'GPU 줄 섬: {name}', en: 'GPU queued: {name}' },
  ev_gpu_lease: { ko: 'GPU 차례 옴: {name}', en: 'GPU turn came: {name}' },
  ev_gpu_release: { ko: 'GPU 반납: {name}', en: 'GPU released: {name}' },
  ev_gpu_release_dead: {
    ko: 'GPU 반납: {name} (비정상 종료)',
    en: 'GPU released: {name} (abnormal exit)',
  },
  ev_gpu_cancel: { ko: 'GPU 대기 끝: {name} ({why})', en: 'GPU wait ended: {name} ({why})' },
  ev_gpu_move: { ko: 'GPU 순서 바뀜: {name}', en: 'GPU order changed: {name}' },
  ev_gpu_move_to: {
    ko: 'GPU 순서 바뀜: {name} → {position}번째',
    en: 'GPU order changed: {name} → #{position}',
  },
  gpu_why_cancel: { ko: '취소', en: 'cancelled' },
  gpu_why_wait: { ko: '시간 초과', en: 'timed out' },
  gpu_why_stop: { ko: '멈춤', en: 'stopped' },
  gpu_why_dead: { ko: '비정상 종료', en: 'abnormal exit' },
  // -- notices and pushes (core/notices.ts) --
  cause_turn_end: { ko: '일을 마쳤어요', en: 'Finished its work' },
  cause_question: { ko: '답을 기다려요', en: 'Waiting for your answer' },
  cause_permission: { ko: '허락을 기다려요', en: 'Waiting for your permission' },
  cause_permission_sub: {
    ko: '{sub}의 허락을 기다려요',
    en: '{sub} is waiting for your permission',
  },
  dev_new: { ko: '새 기기가 들어왔어요', en: 'A new device signed in' },
  dev_replaced: { ko: '기기 열쇠가 바뀌었어요', en: "A device's key was replaced" },
  dev_passkey: { ko: '패스키가 추가됐어요', en: 'A passkey was added' },
  dev_kind_phone: { ko: '휴대폰', en: 'Phone' },
  dev_kind_tablet: { ko: '태블릿', en: 'Tablet' },
  dev_kind_desktop: { ko: '컴퓨터', en: 'Computer' },
  dev_kind_unknown: { ko: '기기', en: 'Device' },
  dev_via_local: { ko: '이 PC에서', en: 'On this PC' },
  dev_via_lan: { ko: '같은 공유기(LAN)에서', en: 'On the same network (LAN)' },
  dev_via_remote: { ko: '바깥에서', en: 'From outside' },
  file_unreadable: {
    ko: '파일을 열 수 없어요',
    en: 'Could not open the file.',
  },
  login_needed: {
    ko: '로그인이 필요해요',
    en: 'Sign in first.',
  },
  try_again_soon: {
    ko: '잠시 후 다시 시도해 주세요',
    en: 'Try again in a moment.',
  },
  origin_mismatch: {
    ko: '요청 출처가 달라요',
    en: 'The request came from a different origin.',
  },
  file_request_invalid: {
    ko: '파일 요청이 올바르지 않아요',
    en: 'That file request is not valid.',
  },
  attach_request_invalid: {
    ko: '첨부 요청이 올바르지 않아요',
    en: 'That attachment request is not valid.',
  },
  attach_max_files: {
    ko: '한 메시지에는 파일 5개까지 첨부할 수 있어요',
    en: 'A message can carry at most 5 files.',
  },
  file_name_invalid: {
    ko: '파일 이름이 올바르지 않아요',
    en: 'That file name is not valid.',
  },
  setting_invalid: {
    ko: '설정이 올바르지 않아요',
    en: 'That setting is not valid.',
  },
  preview_unsupported: {
    ko: '이 형식은 직접 미리볼 수 없어요',
    en: 'This type cannot be previewed directly.',
  },
  link_expired: {
    ko: '링크가 만료되었어요',
    en: 'This link has expired.',
  },
  page_number_invalid: {
    ko: '페이지 번호가 올바르지 않아요',
    en: 'That page number is not valid.',
  },
  page_size_invalid: {
    ko: '페이지 크기가 올바르지 않아요',
    en: 'That page size is not valid.',
  },
  attach_type_unsupported: {
    ko: '첨부할 수 없는 파일 형식이에요',
    en: 'That file type cannot be attached.',
  },
  attach_folder_unusable: {
    ko: '첨부 폴더를 사용할 수 없어요',
    en: 'The attachment folder cannot be used.',
  },
  attach_too_large: {
    ko: '파일은 20 MB 이하만 첨부할 수 있어요',
    en: 'Files up to 20 MB can be attached.',
  },
  attach_type_mismatch: {
    ko: '파일 내용이 확장자와 맞지 않아요',
    en: 'The file content does not match its extension.',
  },
  attach_name_failed: {
    ko: '첨부 파일 이름을 만들 수 없어요',
    en: 'Could not make a name for the attachment.',
  },
  sensitive_blocked: {
    ko: '민감한 파일은 설정에서 허용해야 해요',
    en: 'Sensitive files must be allowed in settings first.',
  },
  not_a_file: {
    ko: '파일이 아니에요',
    en: 'That is not a file.',
  },
  file_over_50: {
    ko: '50 MB를 넘는 파일이에요',
    en: 'The file is over 50 MB.',
  },
  path_outside_project: {
    ko: '프로젝트 밖 경로예요',
    en: 'That path is outside the project.',
  },
  preview_not_supported: {
    ko: '미리보기를 지원하지 않아요',
    en: 'Preview is not supported for this file.',
  },
  project_folder_unreadable: {
    ko: '프로젝트 폴더를 열 수 없어요',
    en: 'The project folder cannot be opened.',
  },
  relative_only: {
    ko: '상대 경로만 열 수 있어요',
    en: 'Only relative paths can be opened.',
  },
  path_forbidden: {
    ko: '이 경로는 열 수 없어요',
    en: 'This path cannot be opened.',
  },
  pick_a_folder: {
    ko: '폴더를 골라 주세요',
    en: 'Choose a folder.',
  },
  folder_not_allowed: {
    ko: '허용된 폴더 밖이에요',
    en: 'That folder is outside the allowed folders.',
  },
  terminal_start_failed: {
    ko: '터미널을 시작하지 못했어요',
    en: 'Could not start the terminal.',
  },
  devices_full: {
    ko: '등록된 기기가 {max}대로 가득 찼어요. 보안 → 로그인한 기기에서 안 쓰는 기기를 지운 뒤 다시 들어오세요',
    en: 'The limit of {max} registered devices is reached. Remove a device you no longer use under Security on a signed-in device, then sign in again.',
  },
  device_id_taken: {
    ko: '다른 기기의 id예요',
    en: 'That id belongs to another device.',
  },
  device_key_invalid: {
    ko: '기기 키가 올바르지 않아요',
    en: 'That device key is not valid.',
  },
  devices_unreadable: {
    ko: 'devices.json을 읽을 수 없어 저장하지 않았어요',
    en: 'devices.json could not be read, so nothing was saved.',
  },
  device_browser: {
    ko: '브라우저',
    en: 'Browser',
  },
  device_keys_off: {
    ko: '기기 키를 쓸 수 없어요',
    en: 'Device keys cannot be used.',
  },
  audit_key_replaced: {
    ko: '기기 열쇠가 바뀌었어요: {label}',
    en: "A device's key was replaced: {label}",
  },
  device_name_rule: {
    ko: '이름은 1~40자로, 줄바꿈 없이 적어 주세요',
    en: 'Write a name of 1 to 40 characters, on one line.',
  },
  not_from_here: {
    ko: '이 화면에서는 받을 수 없어요',
    en: 'This cannot be received from this screen.',
  },
  device_login_failed: {
    ko: '기기 키로 로그인하지 못했어요',
    en: 'Could not sign in with the device key.',
  },
  device_key_unverified: {
    ko: '이 기기의 키를 확인하지 못했어요',
    en: "Could not verify this device's key.",
  },
  verify_with_passkey: {
    ko: '패스키로 확인해 주세요',
    en: 'Verify with a passkey.',
  },
  move_no_target: {
    ko: '옮길 주소가 없거나 이 기기에 기기 키가 없어요',
    en: 'There is no address to move to, or this device has no device key.',
  },
  move_target_changed: {
    ko: '바깥 주소가 바뀌었어요. 다시 열어 주세요',
    en: 'The outside address changed. Open the page again.',
  },
  setting_change_failed: {
    ko: '설정을 바꾸지 못했어요',
    en: 'Could not change the setting.',
  },
  passkey_required_on_here: {
    ko: '이 기기의 패스키로 이 주소에서 확인한 뒤 켤 수 있어요',
    en: "Verify with this device's passkey at this address first, then you can turn it on.",
  },
  passkey_required_off: {
    ko: '패스키로 확인한 뒤 끌 수 있어요',
    en: 'Verify with a passkey first, then you can turn it off.',
  },
  passkey_not_here: {
    ko: '이 주소에서는 패스키를 쓸 수 없어요',
    en: 'Passkeys cannot be used at this address.',
  },
  passkey_login_failed: {
    ko: '패스키로 로그인하지 못했어요',
    en: 'Could not sign in with the passkey.',
  },
  passkey_verify_failed: {
    ko: '패스키로 확인하지 못했어요',
    en: 'Could not verify with the passkey.',
  },
  audit_passkey_added: {
    ko: '패스키가 추가됐어요: {name}',
    en: 'A passkey was added: {name}',
  },
  passkey_already_bound: {
    ko: '이미 기기에 묶인 패스키예요',
    en: 'That passkey is already tied to a device.',
  },
  passkeys_unreadable: {
    ko: 'passkeys.json을 읽을 수 없어 저장하지 않았어요',
    en: 'passkeys.json could not be read, so nothing was saved.',
  },
  passkey_time_up: {
    ko: '등록 시간이 지났어요. 다시 해 주세요',
    en: 'The registration time ran out. Try again.',
  },
  passkey_unverified: {
    ko: '패스키를 확인하지 못했어요',
    en: 'Could not verify the passkey.',
  },
  passkey_registered: {
    ko: '이미 등록된 패스키예요',
    en: 'That passkey is already registered.',
  },
  passkey_cap: {
    ko: '이 기기는 이 주소에 패스키를 {max}개까지 둘 수 있어요. 안 쓰는 패스키를 지운 뒤 다시 등록해 주세요',
    en: 'This device can keep up to {max} passkeys for this address. Remove one you do not use, then register again.',
  },
  passkey_revoked: {
    ko: '철회된 기기의 패스키라 다시 등록할 수 없어요',
    en: 'That passkey belongs to a revoked device, so it cannot be registered again.',
  },
  audit_wrong_codes: {
    ko: '{by} (코드 3번 틀림)',
    en: '{by} (wrong code 3 times)',
  },
  photo_label: {
    ko: '{name} 사진',
    en: '{name} photo',
  },
  custom_label: {
    ko: '{name} 커스텀',
    en: '{name} custom',
  },
  push_not_allowed: {
    ko: '이 접속에서는 알림을 받을 수 없어요',
    en: 'This connection cannot receive notifications.',
  },
  push_registration_invalid: {
    ko: '알림 등록 정보가 올바르지 않아요',
    en: 'The notification registration is not valid.',
  },
  // -- the login page (loginPage.ts) --
  app_name: { ko: '에이전트 타이쿤', en: 'Agent Tycoon' },
  login_bad_code: { ko: '코드가 맞지 않거나 만료됐어요', en: 'The code is wrong or has expired.' },
  login_too_many: { ko: '잠시 후 다시 시도하세요', en: 'Try again in a moment.' },
  login_passkey_unbound: {
    ko: '이 패스키는 아직 기기에 묶이지 않았어요. 이 기기가 등록돼 있어야 해요. 아니면 등록된 기기의 기기 추가(QR·8자리 코드)로 먼저 들어오세요',
    en: 'This passkey is not tied to a device yet. This device has to be registered, or sign in first with Add device (QR or 8-digit code) on a registered device.',
  },
  login_title: { ko: '{app} 로그인', en: '{app} sign-in' },
  login_code_label: { ko: '로그인 코드', en: 'Sign-in code' },
  login_submit: { ko: '로그인', en: 'Sign in' },
  login_hint: {
    ko: '로그인한 기기의 {add}나 호스트의 {cmd}이 주는 8자리 코드예요. 5분 동안 한 번만 쓸 수 있어요.',
    en: 'The 8-digit code comes from {add} on a signed-in device, or from {cmd} on the host. It works once, for 5 minutes.',
  },
  login_add_device: { ko: '기기 추가', en: 'Add device' },
  login_passkey: { ko: '패스키로 로그인', en: 'Sign in with a passkey' },
  login_approval: { ko: '다른 기기에서 승인 요청', en: 'Ask another device to approve' },
  unknown_device: { ko: '알 수 없음', en: 'unknown' },
  no_answer: { ko: '응답 없음', en: 'no answer' },
  lan_ip_missing_check: {
    ko: '이 PC의 LAN 주소를 찾지 못했어요 (유선·와이파이 연결을 확인하세요)',
    en: "Could not find this PC's LAN address (check the wired or Wi-Fi connection).",
  },
  lan_ip_is: {
    ko: '이 PC의 LAN 주소 {ip}',
    en: "This PC's LAN address: {ip}",
  },
  fix_upnp_or_forward: {
    ko: '공유기 관리 화면에서 UPnP를 켜거나, 포트포워드에 "외부 TCP {port} → {lan}:{local}"를 직접 넣은 뒤 --manual-forward 로 다시 하세요',
    en: 'Turn on UPnP in the router\'s admin page, or add a port forward "external TCP {port} → {lan}:{local}" yourself, then run again with --manual-forward.',
  },
  seen_address: {
    ko: '인터넷에서 보이는 주소 {ip} (STUN)',
    en: 'The address the internet sees: {ip} (STUN)',
  },
  wsl_nat_note: {
    ko: 'WSL NAT: Windows가 {external}번을 받아 WSL 안 127.0.0.1:{port}로 넘겨요 (portproxy). WSL 안에서는 공유기 UPnP를 쓰지 않아요',
    en: "WSL NAT: Windows takes port {external} and passes it to 127.0.0.1:{port} inside WSL (portproxy). The router's UPnP is not used from inside WSL.",
  },
  seen_not_public: {
    ko: '인터넷에서 보이는 주소 {ip}가 공인 주소가 아니에요 (통신사 NAT): 바깥에서 들어올 수 없어요',
    en: 'The address the internet sees, {ip}, is not a public address (carrier NAT): nothing can come in from outside.',
  },
  public_ip_unknown_stun: {
    ko: '바깥에서 보이는 공인 IPv4 주소를 알아내지 못했어요 (STUN)',
    en: 'Could not find the public IPv4 address seen from outside (STUN).',
  },
  fix_use_tailscale: {
    ko: '안 되면 Tailscale을 쓰세요',
    en: 'If this does not work, use Tailscale.',
  },
  modem_direct: {
    ko: '모뎀 직결: Windows가 공인 주소 {ip}를 직접 받아요. 공유기가 없으니 UPnP 단계는 필요 없어요',
    en: 'Direct modem: Windows holds the public address {ip} itself. There is no router, so no UPnP step is needed.',
  },
  behind_router_wsl: {
    ko: '공유기 뒤예요 (Windows {lan}). WSL 안에서는 UPnP가 공유기에 닿지 않아요',
    en: 'Behind a router (Windows {lan}). UPnP cannot reach the router from inside WSL.',
  },
  fix_forward_once: {
    ko: '공유기 관리 화면의 포트포워드에 "외부 TCP {port} → {lan}:{port}"를 한 번 넣으세요',
    en: 'Add a port forward "external TCP {port} → {lan}:{port}" once in the router\'s admin page.',
  },
  windows_address_unreadable: {
    ko: 'Windows 주소를 읽지 못했어요. 공유기가 있으면 외부 TCP 443 → Windows로 포트포워드가 필요해요',
    en: 'Could not read the Windows address. With a router, you need a port forward from external TCP 443 to Windows.',
  },
  windows_relay_ok: {
    ko: 'Windows 중계 확인: {host}:{external} → WSL 127.0.0.1:{port}',
    en: 'Windows relay confirmed: {host}:{external} → WSL 127.0.0.1:{port}',
  },
  windows_relay_missing: {
    ko: 'Windows가 {external}번을 WSL 안으로 넘겨 주지 않아요 (portproxy·방화벽 규칙이 아직 없어요)',
    en: 'Windows does not pass port {external} into WSL (the portproxy and firewall rules are not there yet).',
  },
  fix_run_powershell: {
    ko: '관리자 PowerShell에서 아래 두 줄을 한 번 실행한 뒤 "다시 확인"을 누르세요',
    en: 'Run the two lines below once in an administrator PowerShell, then press "Check again".',
  },
  public_ip_unknown: {
    ko: '바깥에서 보이는 공인 IPv4 주소를 알아내지 못했어요',
    en: 'Could not find the public IPv4 address seen from outside.',
  },
  router_opened: {
    ko: '공유기에 길을 열었어요: 외부 {external} → {lan}:{port}',
    en: 'Opened a path on the router: external {external} → {lan}:{port}',
  },
  router_refused: {
    ko: '공유기가 {external}번 연결을 거절했어요: {why}',
    en: 'The router refused the port {external} mapping: {why}',
  },
  fix_check_443_rule: {
    ko: '공유기 관리 화면의 포트포워드에서 443을 쓰는 규칙을 확인하세요',
    en: "Check which port-forward rule already uses 443 in the router's admin page.",
  },
  manual_forward_trusted: {
    ko: '수동 포트포워드를 믿고 진행해요 (외부 {external} → {lan}:{port})',
    en: 'Going ahead on your manual port forward (external {external} → {lan}:{port}).',
  },
  router_closed: {
    ko: '공유기의 외부 {external} 연결을 다시 닫았어요',
    en: "Closed the router's external port {external} again.",
  },
  https_listening: {
    ko: 'HTTPS 대기 {host}:{port}',
    en: 'Listening for HTTPS on {host}:{port}',
  },
  listen_failed: {
    ko: '{port}번 포트에서 대기하지 못했어요: {why}',
    en: 'Could not listen on port {port}: {why}',
  },
  cert_kept: {
    ko: '인증서는 그대로 써요: {name} (2/3 지나면 자동 갱신)',
    en: 'Keeping the certificate: {name} (renewed automatically after 2/3 of its life)',
  },
  outside_check_failed_keep: {
    ko: '바깥 확인이 실패해서 지금 연결을 그대로 둬요',
    en: 'The outside check failed, so the current connection is left as it is.',
  },
  reconnect_failed: {
    ko: '다시 연결 실패: {why}',
    en: 'Reconnecting failed: {why}',
  },
  router_upnp_silent: {
    ko: '공유기가 UPnP에 답하지 않아요 (재부팅 중이거나 꺼졌어요)',
    en: 'The router does not answer UPnP (it may be rebooting or off).',
  },
  cert_cooldown: {
    ko: '인증서 발급이 한 시간 안에 실패해서 잠시 쉬어요',
    en: 'Issuing the certificate failed within the last hour, so this waits a while.',
  },
  cert_issued: {
    ko: '인증서 발급: {name} (만료 {until}, 2/3 지나면 자동 갱신)',
    en: 'Certificate issued: {name} (expires {until}, renewed automatically after 2/3 of its life)',
  },
  letsencrypt_failed: {
    ko: "Let's Encrypt가 바깥에서 {external}번으로 이 PC를 확인하지 못했어요: {why}",
    en: "Let's Encrypt could not reach this PC from outside on port {external}: {why}",
  },
  fix_443_blocked: {
    ko: '통신사가 443을 막거나 공유기 위에 NAT가 더 있을 수 있어요. 안 되면 Tailscale을 쓰세요',
    en: 'Your carrier may block 443, or there may be another NAT above the router. If it does not work, use Tailscale.',
  },
  gate_off: {
    ko: '비밀 주소 없이도 응답이 와요 ({status}): 문지기가 꺼져 있어요',
    en: 'It answers even without the secret address ({status}): the gatekeeper is off.',
  },
  secret_status: {
    ko: '비밀 주소가 {status}로 답해요',
    en: 'The secret address answers with {status}.',
  },
  outside_ok: {
    ko: '바깥 주소 확인: 비밀 주소로만 로그인 화면이 열리고, 나머지는 빈 404예요',
    en: 'Outside check: only the secret address opens the sign-in page; everything else is an empty 404.',
  },
  cert_untrusted: {
    ko: '인증서를 믿을 수 없어요: {why}',
    en: 'The certificate cannot be trusted: {why}',
  },
  nat_no_upnp: {
    ko: '공유기가 UPnP에 답하지 않아요 (꺼져 있거나 지원하지 않음)',
    en: 'The router does not answer UPnP (it is off or does not support it).',
  },
  nat_no_wan: {
    ko: '공유기가 바깥 주소를 알려 주지 않아요',
    en: 'The router does not tell its outside address.',
  },
  nat_cgnat: {
    ko: '공유기 바깥 주소 {ip}가 통신사 공유 대역이에요 (CGNAT): 바깥에서 들어올 수 없어요',
    en: "The router's outside address {ip} is in the carrier-shared range (CGNAT): nothing can come in from outside.",
  },
  nat_double: {
    ko: '공유기 바깥 주소 {ip}가 사설 주소예요: 위에 공유기(모뎀)가 하나 더 있어요 (이중 NAT)',
    en: "The router's outside address {ip} is a private address: there is another router (modem) above it (double NAT).",
  },
  nat_mismatch: {
    ko: '공유기 바깥 주소({wan})와 인터넷에서 보이는 주소({seen})가 달라요: 통신사 NAT 뒤예요',
    en: "The router's outside address ({wan}) differs from the address the internet sees ({seen}): you are behind carrier NAT.",
  },
  nat_open: {
    ko: '공인 주소 {ip}를 공유기가 직접 받고 있어요',
    en: 'The router holds the public address {ip} itself.',
  },
  port_taken: {
    ko: '외부 {port}번을 다른 기기({client})가 쓰고 있어요',
    en: 'Another device ({client}) is using external port {port}.',
  },
  tunnel_timeout: {
    ko: '임시 주소를 20초 안에 받지 못했어요',
    en: 'Did not get a temporary address within 20 seconds.',
  },
  tunnel_exited: {
    ko: 'cloudflared가 끝났어요',
    en: 'cloudflared exited.',
  },
  duckdns_refused: {
    ko: 'DuckDNS가 거절했어요: {why}',
    en: 'DuckDNS refused: {why}',
  },
  acme_no_challenge: {
    ko: '인증 기관이 {type} 확인을 주지 않았어요',
    en: 'The certificate authority did not give a {type} challenge.',
  },
  duckdns_no_token: {
    ko: 'DuckDNS 토큰이 없어요',
    en: 'There is no DuckDNS token.',
  },
  setup_found_address: {
    ko: '바깥 주소를 찾았어요',
    en: 'Found the outside address.',
  },
  setup_health_ok: {
    ko: '건강 확인 200',
    en: 'Health check 200',
  },
  setup_health_failed: {
    ko: '건강 확인 실패 ({status})',
    en: 'Health check failed ({status})',
  },
  setup_login_ok: {
    ko: '로그인 화면을 확인했어요',
    en: 'Confirmed the sign-in page.',
  },
  setup_login_failed: {
    ko: '로그인 화면 확인 실패 ({status})',
    en: 'Sign-in page check failed ({status})',
  },
  setup_ws_refused: {
    ko: '쿠키 없는 /ws 접속을 거절했어요',
    en: 'Refused a /ws connection without a cookie.',
  },
  setup_ws_open: {
    ko: '쿠키 없는 /ws 접속이 거절되지 않았어요',
    en: 'A /ws connection without a cookie was not refused.',
  },
  setup_outside_failed: {
    ko: '바깥 주소 확인 실패: {why}',
    en: 'Outside address check failed: {why}',
  },
  tailscale_autologin_retired: {
    ko: 'Tailscale 헤더 자동 로그인은 없앴어요 — 기기 키·패스키·초대 코드로 로그인하세요',
    en: 'Automatic sign-in from the Tailscale header has been removed: sign in with a device key, a passkey or an invite code.',
  },
  fallback_ssh: {
    ko: '노트북 앱만: 이 PC에 SSH가 열려 있으면 Pixel Office 앱의 "SSH 터널"로 중계 없이 붙어요 (아이폰은 못 써요).',
    en: 'Laptop app only: if SSH is open on this PC, the Pixel Office app\'s "SSH tunnel" connects without a relay (not usable from an iPhone).',
  },
  fallback_tailscale: {
    ko: 'Tailscale(무료 계정): CGNAT·이중 NAT·막힌 공유기에서도 되는 마지막 길이에요. node cld/install/install.mjs --remote --connector tailscale',
    en: 'Tailscale (free account): the last resort that also works behind CGNAT, double NAT and locked-down routers. node cld/install/install.mjs --remote --connector tailscale',
  },
  ts_foreign: {
    ko: 'Tailscale의 https 443이 다른 곳을 열고 있어요. 그 설정은 건드리지 않아요',
    en: "Tailscale's https 443 is serving something else. That setting is left alone.",
  },
  ts_unreadable: {
    ko: 'Tailscale serve 상태를 읽지 못해 아무것도 바꾸지 않았어요',
    en: 'Could not read the Tailscale serve state, so nothing was changed.',
  },
  ts_funnel_failed: {
    ko: 'Tailscale Funnel을 켜지 못했어요. 이 tailnet에서 Funnel이 허용됐는지, PC에서 Tailscale 권한을 확인하세요',
    en: 'Could not turn on Tailscale Funnel. Check that Funnel is allowed on this tailnet and that Tailscale has permission on this PC.',
  },
  ts_open_console: {
    ko: 'Tailscale 관리 콘솔 열기',
    en: 'Open the Tailscale admin console',
  },
  ts_serve_failed: {
    ko: 'Tailscale Serve를 켜지 못했어요. PC에서 Tailscale 권한을 확인하세요',
    en: "Could not turn on Tailscale Serve. Check Tailscale's permission on this PC.",
  },
  ts_funnel_off_failed: {
    ko: 'Tailscale Funnel을 끄지 못했어요',
    en: 'Could not turn off Tailscale Funnel.',
  },
  ts_serve_again_failed: {
    ko: 'Tailscale Serve를 다시 켜지 못했어요',
    en: 'Could not turn Tailscale Serve back on.',
  },
  ts_funnel_unverified: {
    ko: 'Tailscale Funnel 상태에서 이 PC의 공개 연결을 확인하지 못했어요',
    en: "Could not confirm this PC's public connection in the Funnel state.",
  },
  ts_serve_unverified: {
    ko: 'Tailscale Serve 상태에서 이 PC의 비공개 연결을 확인하지 못했어요',
    en: "Could not confirm this PC's private connection in the Serve state.",
  },
  portproxy_cannot_remove: {
    ko: 'Windows 포트 전달은 이 PC가 지울 수 없어요',
    en: 'This PC cannot remove the Windows port forwarding.',
  },
  run_admin_powershell: {
    ko: 'Windows 관리자 PowerShell 에서 실행하세요.',
    en: 'Run this in an administrator PowerShell on Windows.',
  },
  copy_undo_command: {
    ko: '되돌리는 명령 복사',
    en: 'Copy the undo command',
  },
  remote_read_only: {
    ko: '읽기 전용이에요 (설치할 때 --allow-actions)',
    en: 'This is read-only (install with --allow-actions).',
  },
  still_starting: {
    ko: '아직 시작 중이에요',
    en: 'Still starting.',
  },
  ts_setup_on_host: {
    ko: 'Tailscale 연결은 호스트에서 설치기로 한 번 해요',
    en: 'Tailscale is connected once on the host with the installer.',
  },
  ts_not_serving_host: {
    ko: 'tailscale serve가 {host}로 이 PC를 열고 있지 않아요',
    en: 'tailscale serve is not exposing this PC at {host}.',
  },
  wsl_nat_lan: {
    ko: 'WSL NAT 모드라 같은 와이파이의 기기가 이 PC 안을 보지 못해요',
    en: 'WSL runs in NAT mode, so devices on the same Wi-Fi cannot see inside this PC.',
  },
  lan_ip_missing: {
    ko: '이 PC의 LAN 주소를 찾지 못했어요',
    en: "Could not find this PC's LAN address.",
  },
  connector_is: {
    ko: '연결 방식: {name}',
    en: 'Connection method: {name}',
  },
  ts_serving_short: {
    ko: 'tailscale serve: https://{host}/ → 이 PC',
    en: 'tailscale serve: https://{host}/ → this PC',
  },
  ts_not_serving: {
    ko: 'tailscale serve가 이 PC를 열고 있지 않아요',
    en: 'tailscale serve is not exposing this PC.',
  },
  connector_check_installer: {
    ko: '{name}: 바깥 경로 확인은 설치기(--remote)가 해요',
    en: '{name}: the installer (--remote) checks the outside path.',
  },
  pick_connector: {
    ko: '접속 방식을 골라 주세요',
    en: 'Choose a connection method.',
  },
  already_checking: {
    ko: '이미 확인 중이에요',
    en: 'A check is already running.',
  },
  duckdns_check: {
    ko: 'DuckDNS 이름과 토큰을 확인해 주세요',
    en: 'Check the DuckDNS name and token.',
  },
  wsl_nat_needs_forward: {
    ko: 'WSL NAT에서는 Windows 포트 전달이 필요해요',
    en: 'In WSL NAT mode, Windows port forwarding is needed.',
  },
  ts_name_missing: {
    ko: 'Tailscale 기기 이름을 찾지 못했어요',
    en: 'Could not find the Tailscale device name.',
  },
  ts_name_differs: {
    ko: 'Tailscale 이름이 달라요: {host}',
    en: 'The Tailscale name differs: {host}',
  },
  tunnel_public: {
    ko: '임시 주소가 인터넷에 공개됐어요. 로그인은 필요하고 주소는 다음 실행 때 바뀌어요',
    en: 'The temporary address is now public on the internet. Sign-in is still required, and the address changes next time.',
  },
  connector_start_failed: {
    ko: '이 연결 방식을 시작하지 못했어요',
    en: 'Could not start this connection method.',
  },
  check_save_failed: {
    ko: '확인 결과를 저장하지 못했어요: {why}',
    en: 'Could not save the check result: {why}',
  },
  remote_check_failed: {
    ko: '원격 설정 확인 실패: {why}',
    en: 'The remote setup check failed: {why}',
  },
  direct_off: {
    ko: '바깥 직접 연결이 꺼져 있어요',
    en: 'The outside direct connection is turned off.',
  },
  fake_outside_check: {
    ko: '바깥 확인 (가짜)',
    en: 'Outside check (fake)',
  },
  ts_serving_funnel: {
    ko: 'tailscale serve가 이 PC를 열고 있어요: https://{host}/ (Funnel 켜짐)',
    en: 'tailscale serve is exposing this PC: https://{host}/ (Funnel on)',
  },
  ts_serving: {
    ko: 'tailscale serve가 이 PC를 열고 있어요: https://{host}/',
    en: 'tailscale serve is exposing this PC: https://{host}/',
  },
  wsl_mirrored: {
    ko: 'WSL mirrored 모드예요. 바깥에서 들어오려면 Windows 방화벽(Hyper-V)에 한 번 허용해야 해요.',
    en: 'WSL is in mirrored mode. To let connections in from outside, allow it once in the Windows (Hyper-V) firewall.',
  },
  admin_ps_once: {
    ko: '관리자 PowerShell에서 한 번: {command}',
    en: 'In an administrator PowerShell, once: {command}',
  },
  wsl_nat_guide_head: {
    ko: 'WSL NAT 모드라 공유기와 같은 와이파이의 기기는 이 PC 안의 WSL을 보지 못해요.',
    en: "WSL is in NAT mode, so devices on the router's Wi-Fi cannot see the WSL inside this PC.",
  },
  wsl_nat_step1: {
    ko: '1) 원격 직접(바깥): 관리자 PowerShell에서 한 번: {command}',
    en: '1) Direct from outside: in an administrator PowerShell, once: {command}',
  },
  wsl_nat_undo: {
    ko: '   되돌리기: {command}',
    en: '   Undo: {command}',
  },
  wsl_nat_step2: {
    ko: '2) 같은 와이파이: 관리자 PowerShell에서 netsh interface portproxy add v4tov4 listenport={port} listenaddress=0.0.0.0 connectport={port} connectaddress=<WSL 주소> 과 방화벽 규칙을 넣어요. WSL 주소는 재부팅마다 바뀌어요.',
    en: '2) Same Wi-Fi: in an administrator PowerShell, add netsh interface portproxy add v4tov4 listenport={port} listenaddress=0.0.0.0 connectport={port} connectaddress=<WSL address> and a firewall rule. The WSL address changes at every reboot.',
  },
  wsl_nat_step3: {
    ko: '3) mirrored 모드가 되는 PC라면: %UserProfile%\\.wslconfig 에 [wsl2] 아래 networkingMode=mirrored 를 넣고 PowerShell에서 `wsl --shutdown` 뒤 WSL을 다시 열고,',
    en: '3) If this PC can use mirrored mode: put networkingMode=mirrored under [wsl2] in %UserProfile%\\.wslconfig, run `wsl --shutdown` in PowerShell, reopen WSL, and then',
  },
  admin_ps_once_indented: {
    ko: '   관리자 PowerShell에서 한 번: {command}',
    en: '   in an administrator PowerShell, once: {command}',
  },
  hairpin_blocked: {
    ko: "이 PC에서는 공인 주소로 되돌아오는 연결(헤어핀)을 공유기가 막아 직접 확인하지 못했어요 ({why}). Let's Encrypt 확인이 바깥 도달을 이미 증명했어요. 휴대폰 데이터로 한 번 열어 보세요",
    en: "From this PC the router blocks connections that loop back to the public address (hairpin), so this could not be checked directly ({why}). Let's Encrypt's check already proved the outside can reach it. Open it once on your phone's mobile data.",
  },
  fallback_remote_control: {
    ko: '그래도 안 되면 "Claude 앱으로 대화만": 엔진 프로젝트 설정에서 remote-control을 켜면 claude.ai/code와 Claude 앱에서 그 세션과 대화할 수 있어요. Anthropic이 대화를 중계·저장하고, 요청마다 토큰이 들고, 픽셀 오피스는 없어요.',
    en: 'If that still fails, "chat only through the Claude app": turn on remote-control in the engine project\'s settings and you can talk to that session from claude.ai/code and the Claude app. Anthropic relays and stores the conversation, every request costs tokens, and there is no pixel office.',
  },
  // -- the remote setup plan (core/src/remoteSetupPlan.mjs, plain JS shared with the installer) --
  plan_local: { ko: '이 PC에서만 열어요', en: 'Open on this PC only' },
  plan_lan: { ko: '같은 와이파이에 열어요', en: 'Open on the same Wi-Fi' },
  plan_ssh: { ko: '노트북에서 SSH 터널을 열어요', en: 'Open an SSH tunnel from your laptop' },
  plan_ssh_guide: {
    ko: '노트북 터미널에서 연결하세요. SSH 서버가 없다면 이 PC에서 관리자 권한으로 서버를 켜세요.',
    en: "Connect from the laptop's terminal. If there is no SSH server, start one on this PC with administrator rights.",
  },
  label_ssh_cmd: { ko: 'SSH 명령 복사', en: 'Copy the SSH command' },
  label_ssh_server: { ko: 'SSH 서버 설치 명령 복사', en: 'Copy the SSH server install command' },
  plan_keep: {
    ko: '이미 작동하는 {choice} 연결을 유지해요',
    en: 'Keeping the {choice} connection that already works',
  },
  plan_cgnat: {
    ko: '통신사 CGNAT에서는 공유기 직결 주소로 들어올 수 없어요.',
    en: 'Behind carrier CGNAT, the router cannot be reached directly from outside.',
  },
  plan_duckdns_account: {
    ko: 'DuckDNS 이름과 토큰을 넣으세요',
    en: 'Enter your DuckDNS name and token',
  },
  plan_duckdns_guide: {
    ko: 'DuckDNS에 로그인해 서브도메인을 만들고 토큰을 아래에 넣으세요.',
    en: 'Sign in to DuckDNS, create a subdomain and enter its token below.',
  },
  label_open_duckdns: { ko: 'DuckDNS 열기', en: 'Open DuckDNS' },
  plan_wsl_relay: {
    ko: 'Windows가 이 PC로 연결을 넘겨야 해요',
    en: 'Windows has to pass the connection on to this PC',
  },
  plan_wsl_guide_1: {
    ko: 'Windows 관리자 PowerShell에서 아래 명령을 실행하세요.',
    en: 'Run the commands below in an administrator PowerShell on Windows.',
  },
  plan_recheck_auto: {
    ko: '설정 뒤 자동으로 다시 확인해요.',
    en: 'It checks again automatically afterwards.',
  },
  plan_wsl_command_placeholder: {
    ko: 'Windows 포트 전달을 설정하세요',
    en: 'Set up Windows port forwarding',
  },
  label_powershell_cmd: { ko: 'PowerShell 명령 복사', en: 'Copy the PowerShell command' },
  plan_direct_duckdns: {
    ko: '공유기를 열고 DuckDNS HTTPS 주소를 확인해요',
    en: 'Open the router and check the DuckDNS HTTPS address',
  },
  plan_direct: {
    ko: '공유기를 자동으로 열고 HTTPS 주소를 확인해요',
    en: 'Open the router automatically and check the HTTPS address',
  },
  plan_cloudflared: { ko: 'cloudflared를 설치하세요', en: 'Install cloudflared' },
  plan_cloudflared_guide: {
    ko: '공식 설치 페이지에서 cloudflared를 설치하세요.',
    en: 'Install cloudflared from the official install page.',
  },
  plan_installed_recheck: {
    ko: '설치되면 자동으로 다시 확인해요.',
    en: 'It checks again automatically once installed.',
  },
  label_open_install_page: { ko: '설치 페이지 열기', en: 'Open the install page' },
  plan_tunnel: {
    ko: '임시 공개 주소를 열어요. 주소는 실행할 때마다 바뀌고 오래 유지되지 않아요',
    en: 'Open a temporary public address. It changes every run and does not last long.',
  },
  plan_ts_install: { ko: 'Tailscale을 설치하세요', en: 'Install Tailscale' },
  plan_ts_install_guide: {
    ko: 'PC에 Tailscale을 설치하세요. 폰에도 앱과 같은 계정이 필요해요.',
    en: 'Install Tailscale on this PC. The phone needs the app and the same account too.',
  },
  label_ts_install_page: {
    ko: 'Tailscale 설치 페이지 열기',
    en: 'Open the Tailscale install page',
  },
  label_linux_install_cmd: { ko: 'Linux 설치 명령 복사', en: 'Copy the Linux install command' },
  plan_ts_login: { ko: 'Tailscale에 한 번 로그인하세요', en: 'Sign in to Tailscale once' },
  plan_ts_login_guide: {
    ko: 'PC에서 로그인하고 폰에도 Tailscale 앱을 설치해 같은 계정으로 로그인하세요.',
    en: 'Sign in on this PC, then install the Tailscale app on your phone and sign in to the same account.',
  },
  label_ts_login: { ko: 'Tailscale 로그인 열기', en: 'Open Tailscale sign-in' },
  label_login_cmd: { ko: '로그인 명령 복사', en: 'Copy the sign-in command' },
  plan_funnel_consent: {
    ko: '이 tailnet에서 Funnel을 한 번 허용하세요',
    en: 'Allow Funnel on this tailnet once',
  },
  plan_funnel_consent_guide: {
    ko: 'Tailscale 관리 콘솔에서 이 tailnet의 Funnel을 허용하세요.',
    en: 'Allow Funnel for this tailnet in the Tailscale admin console.',
  },
  plan_allowed_recheck: {
    ko: '허용되면 자동으로 다시 확인해요.',
    en: 'It checks again automatically once allowed.',
  },
  plan_funnel: {
    ko: 'Tailscale Funnel로 인터넷에 열어요. 로그인은 필요해요',
    en: 'Open to the internet with Tailscale Funnel. Sign-in is still required.',
  },
  plan_serve: {
    ko: 'Tailscale Serve로 내 기기에만 열어요',
    en: 'Open only to your own devices with Tailscale Serve',
  },
  // -- REMOTE-XPLAT: per-platform plan lines, the turn-off notes, the self-test, the read-only scan --
  plan_ssh_existing: {
    ko: '이미 있는 SSH로 붙어요: 새 포트를 열지 않는 가장 비공개인 길이에요',
    en: 'Use the SSH that is already there: it opens no new port and is the most private way in.',
  },
  plan_ssh_laptop: {
    ko: '노트북 터미널에서 아래 명령을 실행하세요.',
    en: "Run the command below in the laptop's terminal.",
  },
  plan_ssh_guide_windows: {
    ko: '노트북 터미널에서 연결하세요. SSH 서버가 없다면 Windows 관리자 PowerShell에서 아래 서버 명령을 실행하세요.',
    en: "Connect from the laptop's terminal. If there is no SSH server, run the server command below in an administrator PowerShell on Windows.",
  },
  plan_ssh_guide_mac: {
    ko: '노트북 터미널에서 연결하세요. SSH가 꺼져 있다면 시스템 설정 > 일반 > 공유 > 원격 로그인을 켜세요 (아래 명령은 터미널에 전체 디스크 접근 권한이 있어야 해요).',
    en: "Connect from the laptop's terminal. If SSH is off, turn on System Settings > General > Sharing > Remote Login (the command below needs Full Disk Access for the terminal).",
  },
  plan_fw_windows: {
    ko: 'Windows 방화벽이 바깥에서 오는 연결을 막아요',
    en: 'The Windows firewall blocks connections from outside.',
  },
  plan_fw_wsl_mirrored: {
    ko: 'WSL mirrored 모드라 Windows 방화벽(Hyper-V)이 바깥에서 오는 연결을 막아요',
    en: "WSL is in mirrored mode, so Windows' (Hyper-V) firewall blocks connections from outside.",
  },
  plan_fw_ufw: {
    ko: 'ufw 방화벽이 켜져 있어 바깥에서 오는 연결을 막아요',
    en: 'The ufw firewall is on and blocks connections from outside.',
  },
  plan_fw_firewalld: {
    ko: 'firewalld 방화벽이 켜져 있어 바깥에서 오는 연결을 막아요',
    en: 'The firewalld firewall is on and blocks connections from outside.',
  },
  plan_fw_macos: {
    ko: 'macOS 방화벽이 켜져 있어 Node가 연결을 받도록 허용해야 해요',
    en: 'The macOS firewall is on: Node must be allowed to accept connections.',
  },
  plan_fw_guide_unix: {
    ko: '이 PC의 터미널에서 아래 명령을 실행하세요 (sudo 비밀번호를 물어요).',
    en: "Run the commands below in this PC's terminal (sudo asks for your password).",
  },
  plan_fw_confirm: {
    ko: '실행했으면 "실행했어요"를 누르세요.',
    en: 'Once they ran, press "I ran it".',
  },
  label_terminal_cmd: { ko: '터미널 명령 복사', en: 'Copy the terminal commands' },
  firewall_left: {
    ko: '방화벽 규칙은 이 PC가 지우지 않아요. 더 쓰지 않으면 아래 명령으로 지우세요',
    en: 'This PC does not remove the firewall rules. If you no longer need them, remove them with the commands below.',
  },
  run_terminal: {
    ko: '이 PC의 터미널에서 실행하세요 (sudo 비밀번호를 물어요).',
    en: "Run this in this PC's terminal (sudo asks for your password).",
  },
  router_forward_left: {
    ko: '공유기에 손으로 넣은 포트 포워드(외부 443)는 이 PC가 지울 수 없어요. 더 쓰지 않으면 공유기 관리 화면에서 지우세요',
    en: "This PC cannot remove the port forward you added on the router (outside 443). If you no longer need it, remove it in the router's admin page.",
  },
  setup_unknown_here: {
    ko: '이 PC 안에서는 바깥 주소에 닿지 못해 확인하지 못했어요 ({why}). 설정 쪽 확인은 통과했어요. 휴대폰 데이터 같은 바깥 기기에서 한 번 열어 보세요',
    en: 'Could not check from inside this PC: the outside address is not reachable from here ({why}). The set-up side passed. Open it once from an outside device, such as a phone on mobile data.',
  },
  found_ssh: {
    ko: 'SSH 서버가 이미 {port}번에서 답해요 ({banner})',
    en: 'An SSH server already answers on port {port} ({banner}).',
  },
  found_ssh_sessions: {
    ko: '지금 {peers}에서 SSH로 접속해 있어요',
    en: 'Connected over SSH right now from {peers}.',
  },
  found_ssh_wsl_relay: {
    ko: 'Windows가 {listen}번을 이 WSL의 SSH({port}번)로 넘기고 있어요',
    en: "Windows passes port {listen} on to this WSL's SSH (port {port}).",
  },
  found_ssh_wsl_unreachable: {
    ko: 'WSL NAT 모드라 WSL 안의 SSH({port}번)는 바깥에서 닿지 않아요: Windows 포트 전달이 있어야 해요',
    en: 'WSL runs in NAT mode, so the SSH inside WSL (port {port}) cannot be reached from outside: Windows port forwarding is needed.',
  },
  found_ssh_windows: {
    ko: 'Windows의 OpenSSH 서버가 켜져 있어요 ({port}번)',
    en: "Windows' OpenSSH server is running (port {port}).",
  },
  use_ssh: {
    ko: '노트북에서 아래 명령 한 줄로 붙어요. 새 포트를 열지 않는 가장 비공개인 길이에요',
    en: 'The laptop connects with the one line below. It opens no new port and is the most private way in.',
  },
  found_tailscale: {
    ko: 'Tailscale이 이미 로그인돼 있어요 ({host})',
    en: 'Tailscale is already signed in ({host}).',
  },
  use_tailscale: {
    ko: 'Tailscale Serve 카드로 이 이름에 이 PC를 내 기기에만 열어요 (공유기 포트 없음)',
    en: 'The Tailscale Serve card opens this PC under that name to your own devices only (no router port).',
  },
  found_tailscale_serving: {
    ko: 'tailscale serve가 이미 이 PC를 열고 있어요: https://{host}/',
    en: 'tailscale serve already exposes this PC: https://{host}/',
  },
  use_tailscale_serving: {
    ko: 'Tailscale Serve 카드가 이 설정을 그대로 이어 써요',
    en: 'The Tailscale Serve card keeps using this set-up as it is.',
  },
  found_cloudflared: {
    ko: 'cloudflared가 이미 돌고 있어요 ({count}개)',
    en: 'cloudflared is already running ({count}).',
  },
  use_cloudflared: {
    ko: '그 터널 설정에 http://127.0.0.1:{port} 를 더하고 그 주소를 "내 주소" 카드에 넣으면 새 포트 없이 열려요. 터널 설정은 직접 바꿔요',
    en: 'Add http://127.0.0.1:{port} to that tunnel\'s configuration and put its address in the "own address" card: no new port. You change the tunnel yourself.',
  },
  found_proxy: {
    ko: '이 PC의 {ports}번에서 이미 무언가가 듣고 있어요 (리버스 프록시일 수 있어요)',
    en: 'Something already listens on port {ports} of this PC (perhaps a reverse proxy).',
  },
  use_proxy: {
    ko: '그 프록시가 http://127.0.0.1:{port} 로 넘기게 하고 그 주소를 "내 주소" 카드에 넣으세요',
    en: 'Have that proxy forward to http://127.0.0.1:{port} and put its address in the "own address" card.',
  },
  found_router: {
    ko: '공유기가 이미 외부 {external}번을 {client}:{internal}로 넘기고 있어요',
    en: 'The router already forwards outside port {external} to {client}:{internal}.',
  },
  use_router: {
    ko: '다른 기기의 포워드면 건드리지 않아요. 직접 열기는 같은 외부 포트를 쓸 수 없어요',
    en: "If it is another device's forward it is left alone, and direct cannot use that outside port.",
  },
  use_router_ours: {
    ko: '이 PC의 직접 연결이 연 포워드예요. 직접 열기 카드가 그대로 써요',
    en: "This PC's direct connection opened it. The direct card keeps using it.",
  },
  found_portproxy: {
    ko: 'Windows가 {listen}번을 {target}로 넘기고 있어요',
    en: 'Windows passes port {listen} on to {target}.',
  },
  use_portproxy: {
    ko: '이 PC가 만든 전달이 아니에요. 건드리지 않아요',
    en: 'This PC did not make this forward. It is left alone.',
  },
  use_portproxy_ours: {
    ko: '직접 열기의 Windows 전달이에요. 직접 열기 카드가 다시 묻지 않고 그대로 써요',
    en: "This is direct's Windows forward. The direct card uses it without asking again.",
  },
  found_firewall: {
    ko: 'Windows 방화벽 규칙이 이미 있어요: {names}',
    en: 'Windows firewall rules are already there: {names}',
  },
  use_firewall: {
    ko: '이 규칙이 있는 포트는 방화벽 단계를 다시 묻지 않아요',
    en: 'Ports with these rules do not ask for the firewall step again.',
  },
  found_duckdns: {
    ko: 'DuckDNS 이름 {name}이 저장돼 있어요',
    en: 'The DuckDNS name {name} is saved.',
  },
  use_duckdns: {
    ko: 'DuckDNS 카드가 이 이름과 토큰을 다시 써요',
    en: 'The DuckDNS card reuses this name and token.',
  },
  // -- job names and progress (jobRules.json, jobDigest.ts, jobHistory.ts) --
  jobname_deploy: { ko: '배포', en: 'Deploy' },
  jobname_merge_check: { ko: '병합 검사', en: 'Merge check' },
  jobname_browser_all: { ko: '브라우저 시험 전체', en: 'All browser tests' },
  jobname_browser: { ko: '브라우저 시험({name})', en: 'Browser test ({name})' },
  jobname_test: { ko: '시험', en: 'Tests' },
  jobname_build: { ko: '빌드', en: 'Build' },
  jobname_train: { ko: '학습', en: 'Training' },
  jobname_video: { ko: '영상 변환', en: 'Video conversion' },
  jobname_program: { ko: '{program} 작업', en: '{program} job' },
  jobname_unknown_program: { ko: '알 수 없는', en: 'unknown' },
  step_generate_protocol: { ko: '프로토콜 생성', en: 'Generate the protocol' },
  step_build_screen: { ko: '화면 빌드', en: 'Build the screen' },
  step_config: { ko: '설정', en: 'Settings' },
  step_restart_service: { ko: '서비스 다시 켜기', en: 'Restart the service' },
  step_end: { ko: '끝', en: 'Done' },
  step_test_files: { ko: '시험 파일', en: 'Test files' },
  progress_steps: { ko: '{done}/{total}단계', en: 'Step {done}/{total}' },
  progress_first_run: { ko: '첫 실행', en: 'First run' },
  progress_last: {
    ko: '지난번 {last} · 약 {left} 남음',
    en: 'Last time {last} · about {left} left',
  },
  minutes_n: { ko: '{n}분', en: '{n} min' },
  nvidia_stale: {
    ko: 'nvidia-smi 응답 없음: 이번에는 GPU를 건너뜀',
    en: 'nvidia-smi did not answer: the GPU was skipped this time.',
  },
  disk_low: {
    ko: '디스크 {name} 공간 부족',
    en: 'Disk {name} is low on space',
  },
  no_running_jobs: {
    ko: '돌고 있는 작업 없음',
    en: 'No jobs running',
  },
  slash_arg_instruction: {
    ko: '[지시]',
    en: '[instruction]',
  },
  slash_desc_compact: {
    ko: '대화를 요약해 컨텍스트를 줄여요',
    en: 'Summarize the conversation to shrink the context',
  },
  slash_desc_clear: {
    ko: '대화 기록을 지우고 새로 시작해요',
    en: 'Clear the conversation and start fresh',
  },
  slash_desc_context: {
    ko: '컨텍스트 사용량을 보여줘요',
    en: 'Show how much of the context is used',
  },
  slash_desc_cost: {
    ko: '이번 세션의 사용량과 비용을 보여줘요',
    en: "Show this session's usage and cost",
  },
  slash_desc_init: {
    ko: '프로젝트 안내 파일을 만들어요',
    en: 'Create the project guide file',
  },
  slash_desc_review: {
    ko: '변경 사항을 리뷰해요',
    en: 'Review the changes',
  },
  slash_desc_security: {
    ko: '변경 사항의 보안을 점검해요',
    en: 'Check the changes for security problems',
  },
  slash_desc_pr: {
    ko: '풀 리퀘스트 댓글을 가져와요',
    en: 'Fetch the pull request comments',
  },
  slash_arg_model: {
    ko: '<모델>',
    en: '<model>',
  },
  slash_desc_model: {
    ko: '사용할 모델을 바꿔요',
    en: 'Change the model to use',
  },
  slash_arg_path: {
    ko: '<경로>',
    en: '<path>',
  },
  slash_desc_add_dir: {
    ko: '작업 폴더를 더 추가해요',
    en: 'Add another working folder',
  },
  slash_arg_file: {
    ko: '<파일>',
    en: '<file>',
  },
  slash_desc_export: {
    ko: '대화를 파일로 내보내요',
    en: 'Export the conversation to a file',
  },
  slash_arg_value: {
    ko: '값',
    en: 'a value',
  },
  // -- room and floor names the daemon creates (layout.ts, engine.ts, groups.ts, building.ts) --
  room_lounge: { ko: '라운지', en: 'Lounge' },
  room_lobby: { ko: '로비', en: 'Lobby' },
  room_ops: { ko: '관리실', en: 'Operations' },
  room_all: { ko: '전체', en: 'All' },
  room_lounge_floor: { ko: '{floor} 라운지', en: '{floor} Lounge' },
  floor_n: { ko: '{n}층', en: 'Floor {n}' },
  tasks_unreadable: {
    ko: '{file} 을(를) 읽지 못했습니다({why}). 파일은 그대로 두었고, 고칠 때까지 작업을 저장하지 않습니다',
    en: '{file} could not be read ({why}). The file was left as it is, and no tasks are saved until it is fixed.',
  },
  // -- R3: start policy in 설정 (server/src/cld/startPolicy.ts) --
  start_policy_not_managed: {
    ko: '설치본이 아니라 소스에서 실행 중이라 시작 정책이 없어요',
    en: 'This office runs from source, not from an install, so it has no start policy.',
  },
  start_policy_unsupported: {
    ko: '이 PC({platform})에서는 아직 시작 정책을 바꿀 수 없어요. 지금은 Linux와 WSL만 돼요',
    en: 'The start policy cannot be changed on this PC ({platform}) yet. Only Linux and WSL are supported for now.',
  },
  start_policy_session_only: {
    ko: '시작 정책은 로그인한 브라우저에서만 바꿀 수 있어요 (호스트 토큰은 에이전트 세션도 읽을 수 있어서요)',
    en: 'The start policy can only be changed from a logged-in browser (agent sessions can read the host token).',
  },
  start_policy_bad: {
    ko: '시작 정책은 on-demand, always, manual 중 하나예요',
    en: 'The start policy is one of on-demand, always or manual.',
  },
  start_policy_failed: {
    ko: '시작 정책을 바꾸지 못했어요: {why}',
    en: 'Could not change the start policy: {why}',
  },
  // @@MORE
} as const satisfies Record<string, { ko: string; en: string }>;

export type ServerTextCode = keyof typeof SERVER_TEXT;
export const isServerTextCode = (code: unknown): code is ServerTextCode =>
  typeof code === 'string' && Object.hasOwn(SERVER_TEXT, code);

const HOLE = /\{(\w+)\}/g;
const HOLE_SPLIT = /\{(\w+)\}/;
export const fillText = (template: string, vars?: TextVars): string =>
  template.replace(HOLE, (hole, name: string) =>
    vars?.[name] === undefined ? hole : String(vars[name]),
  );

/** Any coded reply text: the Korean `error`, optionally its code (what relays and old callers hold). */
export type WithError = Coded & { error: string };

/** A refusal as the daemon sends it: Korean text for old clients, code for the UI. */
export type Refused = Coded & {
  error: string;
  errorCode: ServerTextCode;
};
export function refused(code: ServerTextCode, vars?: TextVars): Refused {
  return {
    error: fillText(SERVER_TEXT[code].ko, vars),
    errorCode: code,
    ...(vars && { errorParams: vars }),
  };
}
/** Just the Korean text, for fields that are plain strings (warnings, notes). */
export const koText = (code: ServerTextCode, vars?: TextVars): string =>
  fillText(SERVER_TEXT[code].ko, vars);

/** `srv.<code>` dictionary entries of one language, for the webview's ko.ts / en.ts. */
export type ServerTextKeys = { [K in ServerTextCode as `srv.${K}`]: string };
export function serverTextKeys(lang: 'ko' | 'en'): ServerTextKeys {
  return Object.fromEntries(
    Object.entries(SERVER_TEXT).map(([code, text]) => [`srv.${code}`, text[lang]]),
  ) as ServerTextKeys;
}

/**
 * Which table entry a Korean text came from, and its {holes}: for the fields that
 * carry a bare string (a warning, a note, a label) where a code has no room.
 * The daemon builds those texts from this same table (koText), so the match is
 * exact by construction; a text that matches nothing stays as sent.
 */
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const TEMPLATES = Object.entries(SERVER_TEXT).map(([code, text]) => {
  const names: string[] = [];
  const source = text.ko
    .split(HOLE_SPLIT)
    .map((part, i) => {
      if (i % 2 === 0) return escapeRe(part);
      names.push(part);
      return '([\\s\\S]+?)';
    })
    .join('');
  return {
    code: code as ServerTextCode,
    names,
    fixed: text.ko.replace(/\{\w+\}/g, '').length,
    re: new RegExp(`^${source}$`),
  };
});
// Holes-free first (an exact text beats a pattern), then the most literal text (a longer
// template beats a shorter one that could swallow its tail into a hole).
TEMPLATES.sort(
  (a, b) => Number(a.names.length > 0) - Number(b.names.length > 0) || b.fixed - a.fixed,
);
export function matchKorean(text: string): { code: ServerTextCode; params?: TextVars } | undefined {
  for (const t of TEMPLATES) {
    const m = t.re.exec(text);
    if (!m) continue;
    return t.names.length
      ? { code: t.code, params: Object.fromEntries(t.names.map((n, i) => [n, m[i + 1]])) }
      : { code: t.code };
  }
  return undefined;
}

/** An error that carries its coded refusal, for code that reports by throwing. */
export class CodedError extends Error {
  readonly why: Refused;
  constructor(why: Refused) {
    super(why.error);
    this.why = why;
  }
}
/** The refusal inside a thrown value: its own coded text, or the plain message. */
export const refusedOf = (
  err: unknown,
  plain: (err: unknown) => string,
): Pick<Refused, 'error'> & Coded => (err instanceof CodedError ? err.why : { error: plain(err) });

/** `error` + code + params out of any reply that may carry them (what a relay forwards). */
export const pickRefusal = (r: { error?: string } & Coded): { error: string } & Coded => ({
  error: r.error ?? '',
  ...(r.errorCode && { errorCode: r.errorCode }),
  ...(r.errorParams && { errorParams: r.errorParams }),
});

export type TextLang = 'ko' | 'en';
/**
 * A bare daemon text in `lang`: for a reader the browser cannot localize itself (a Web Push
 * body shown by the OS). Holes that are themselves table texts follow along; anything the
 * table does not know stays as sent.
 */
export function textIn(lang: TextLang, text: string): string {
  if (lang === 'ko') return text;
  const hit = matchKorean(text);
  if (!hit) return text;
  const params = hit.params
    ? Object.fromEntries(
        Object.entries(hit.params).map(([k, v]) => [
          k,
          typeof v === 'string' ? textIn(lang, v) : v,
        ]),
      )
    : undefined;
  return fillText(SERVER_TEXT[hit.code][lang], params);
}
