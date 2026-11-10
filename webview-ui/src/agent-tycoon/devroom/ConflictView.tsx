/**
 * P4 개발실 W2 (mockups-1101/devroom-W2): the 직접 풀기 panel. Left the conflicting files, right the
 * picked file with its blocks: each block is two columns (내 것 = the Worker's, 저쪽 것 = the base's)
 * and three buttons; a chosen block folds into a green line. Nothing is written until
 * 「해결됨으로 표시」: then each file gets one `resolve` with one choice per block, and the merge
 * is committed with `mergeContinue`. The owner picks every side, never the program.
 */
import { useState } from 'react';

import type { RepoActionResult, RepoConflictBlock, RepoConflictChoice, RepoConflictFile } from '../../../../core/src/messages.js';
import { MERGE_FILES_W_PX } from '../../constants.js';
import { t } from '../../i18n/index.js';
import { BODY, SMALL } from './devroomData.js';
import {
  canMark,
  choicesFor,
  doneBlocks,
  type Picks,
  picksOf,
  type Segment,
  segments,
  setPick,
} from './mergeState.js';
import { act } from './mergeStore.js';

const button = `border-2 border-border bg-btn-bg hover:bg-btn-hover shadow-pixel px-10 py-3 disabled:opacity-(--btn-disabled-opacity) ${BODY}`;
const PICKS: readonly Exclude<RepoConflictChoice, 'keep'>[] = ['ours', 'theirs', 'both'];
const PICK_LABEL = { ours: 'merge.resolve.mine', theirs: 'merge.resolve.theirs', both: 'merge.resolve.both' } as const;

function Block({
  block,
  index,
  pick,
  worker,
  base,
  canAct,
  onPick,
}: {
  block: RepoConflictBlock;
  index: number;
  pick: RepoConflictChoice | undefined;
  worker: string;
  base: string;
  canAct: boolean;
  onPick: (choice: RepoConflictChoice | undefined) => void;
}) {
  if (pick && pick !== 'keep') {
    return (
      <button
        type="button"
        className={`flex items-center gap-8 px-9 py-5 border-2 border-devroom-resolved-line bg-devroom-resolved-bg text-devroom-ok text-left ${BODY}`}
        data-testid="merge-block-done"
        title={t('merge.resolve.reopen')}
        onClick={() => onPick(undefined)}
      >
        {t('merge.resolve.done', { n: index + 1, pick: t(PICK_LABEL[pick]) })}
        <span className="ml-auto text-text-muted">
          {t('merge.resolve.lines', { from: block.startLine, to: block.endLine })}
        </span>
      </button>
    );
  }
  return (
    <div className="border-2 border-devroom-conf-line bg-devroom-block" data-testid="merge-block" data-block={index}>
      <div className="grid grid-cols-2">
        <div className={`px-9 py-6 whitespace-pre-wrap bg-devroom-mine-bg text-devroom-mine-text border-r-2 border-devroom-conf-line ${BODY}`}>
          <span className={`block mb-3 ${SMALL}`}>{t('merge.resolve.mineBy', { worker })}</span>
          {block.ours}
        </div>
        <div className={`px-9 py-6 whitespace-pre-wrap bg-devroom-theirs-bg text-devroom-theirs-text ${BODY}`}>
          <span className={`block mb-3 ${SMALL}`}>{t('merge.resolve.theirsBy', { base })}</span>
          {block.theirs}
        </div>
      </div>
      <div className="flex items-center gap-6 px-9 py-6 border-t-2 border-devroom-conf-line bg-devroom-block-bar">
        {PICKS.map((choice) => (
          <button
            key={choice}
            type="button"
            className={button}
            data-testid={`merge-pick-${choice}`}
            disabled={!canAct}
            onClick={() => onPick(choice)}
          >
            {t(PICK_LABEL[choice])}
          </button>
        ))}
        <span className={`ml-6 text-text-muted ${SMALL}`}>{t('merge.resolve.pickHint')}</span>
      </div>
    </div>
  );
}

function FileBody({
  file,
  picks,
  worker,
  base,
  canAct,
  onPick,
}: {
  file: RepoConflictFile;
  picks: Picks;
  worker: string;
  base: string;
  canAct: boolean;
  onPick: (index: number, choice: RepoConflictChoice | undefined) => void;
}) {
  if (!file.blocks.length || file.text === undefined) {
    return <p className={`text-devroom-conf ${BODY}`}>{t('merge.resolve.noBlocks')}</p>;
  }
  const chosen = picksOf(picks, file);
  const part = (seg: Segment, i: number) =>
    seg.kind === 'ctx' ? (
      <div key={`c${i}`} className={`text-devroom-ctx pl-4 ${BODY}`}>
        {seg.gap && <div className="text-text-muted">…</div>}
        {seg.lines.map((l) => (
          <div key={l.no} className="whitespace-pre-wrap break-words">
            {l.text || ' '}
          </div>
        ))}
      </div>
    ) : (
      <Block
        key={`b${seg.index}`}
        block={seg.block}
        index={seg.index}
        pick={chosen[seg.index]}
        worker={worker}
        base={base}
        canAct={canAct}
        onPick={(choice) => onPick(seg.index, choice)}
      />
    );
  return <>{segments(file.text, file.blocks).map(part)}</>;
}

export function ResolvePanel({
  project,
  task,
  files,
  worker,
  base,
  canAct,
  merging,
  say,
  onAbort,
  onAfter,
}: {
  project: string;
  task: string;
  files: readonly RepoConflictFile[];
  worker: string;
  base: string;
  canAct: boolean;
  merging: boolean;
  say: (r: RepoActionResult) => void;
  onAbort: () => void;
  onAfter: () => void;
}) {
  const [picks, setPicks] = useState<Picks>({});
  const [path, setPath] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const file = files.find((f) => f.path === path) ?? files[0];
  const marked = canMark(picks, files);

  const mark = async () => {
    setWorking(true);
    let failed = false;
    for (const f of files) {
      const choices = choicesFor(picks, f);
      if (!choices) continue;
      const r = await act({ action: 'resolve', project, task, path: f.path, choices });
      if (!r.ok) {
        say(r);
        failed = true;
        break;
      }
    }
    if (!failed) say(await act({ action: 'mergeContinue', project, task }));
    setPicks({});
    setWorking(false);
    onAfter();
  };

  return (
    <section className="flex-1 min-h-0 mx-12 mb-12 flex flex-col border-2 border-border bg-devroom-panel" data-testid="merge-resolve">
      <header className={`h-34 shrink-0 flex items-center gap-10 px-10 bg-devroom-head border-b-2 border-border ${BODY}`}>
        <b className="font-normal">{t('merge.resolve.title')}</b>
        <span className="text-text-muted truncate">{file?.path}</span>
        <span className="flex-1" />
        {file && file.blocks.length > 0 && (
          <span className="text-accent-text shrink-0" data-testid="merge-progress">
            {t('merge.resolve.progress', { done: doneBlocks(picks, file), total: file.blocks.length })}
          </span>
        )}
        {canAct && merging && (
          <button type="button" className={`${button} shrink-0`} title={t('merge.resolve.abortHint')} data-testid="merge-abort" disabled={working} onClick={onAbort}>
            {t('merge.resolve.abort')}
          </button>
        )}
      </header>
      <div className="flex-1 min-h-0 flex">
        <div className={`shrink-0 overflow-y-auto p-8 border-r-2 border-border bg-devroom-files ${SMALL}`} style={{ width: MERGE_FILES_W_PX }}>
          <p className="mb-6 text-accent-text">{t('merge.resolve.files', { count: files.length })}</p>
          {files.map((f) => {
            const on = f === file;
            const left = f.blocks.length - doneBlocks(picks, f);
            const touched = doneBlocks(picks, f) > 0;
            return (
              <button
                key={f.path}
                type="button"
                data-testid="merge-file"
                aria-pressed={on}
                className={`block w-full text-left px-5 py-6 border-b-2 border-devroom-menu-line break-all ${on ? 'bg-active-bg outline-2 outline-devroom-review-line' : ''}`}
                onClick={() => setPath(f.path)}
              >
                {f.path}
                <span className={`block ${on ? 'text-devroom-conf' : 'text-text-muted'}`}>
                  {touched && left === 0
                    ? t('merge.resolve.fileDone')
                    : touched
                      ? t('merge.resolve.left', { count: left })
                      : t('merge.resolve.count', { count: f.blocks.length })}
                </span>
              </button>
            );
          })}
          <p className="mt-10 text-text-muted leading-normal">
            {t('merge.resolve.legendMine', { worker })}
            <br />
            {t('merge.resolve.legendTheirs', { base })}
          </p>
        </div>
        <div className="flex-1 min-w-0 flex flex-col gap-6 px-12 py-8 overflow-y-auto">
          {file ? (
            <FileBody
              key={file.path}
              file={file}
              picks={picks}
              worker={worker}
              base={base}
              canAct={canAct && !working}
              onPick={(i, choice) => setPicks(setPick(picks, file.path, i, file.blocks.length, choice))}
            />
          ) : (
            <p className={`text-text-muted ${BODY}`}>{t('merge.resolve.none')}</p>
          )}
          <span className="flex-1" />
          <div className="flex items-center justify-end gap-10">
            <span className={`text-text-muted ${SMALL}`}>{working ? t('merge.resolve.working') : t('merge.resolve.markHint')}</span>
            <button
              type="button"
              className={`${button} ${marked ? 'bg-accent! border-devroom-accent-line text-white' : ''}`}
              data-testid="merge-mark"
              disabled={!canAct || !marked || working}
              onClick={() => void mark()}
            >
              {t('merge.resolve.mark')}
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}
