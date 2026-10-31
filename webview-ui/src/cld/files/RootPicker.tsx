import { useEffect, useState } from 'react';

import { t } from '../../i18n/index.js';
import { useDevroomGroups } from '../devroom/devroomData.js';
import { isMerged } from '../devroom/devroomState.js';
import { useRepoStore } from '../repo/repoStore.js';
import type { FileRoot } from './filesStore.js';

/** `● 작업 중` -> `작업 중`: the dev room's chip words without its leading glyph. */
const plain = (chip: string) => chip.replace(/^[●!✔]\s*/, '');

/** `ᚠ main ▾  작업 폴더 고르기`: the project's main folder or one of its open task worktrees (W4). */
export function RootPicker({
  root,
  project,
  onPick,
}: {
  root: FileRoot;
  project: string;
  onPick: (root: FileRoot) => void;
}) {
  const [open, setOpen] = useState(false);
  const repo = useRepoStore().states[project];
  const rows = useDevroomGroups().groups.find((g) => g.project === project)?.rows ?? [];
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && setOpen(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);
  const current = root.kind === 'worktree' ? root.task : null;
  const choices = (repo?.ok ? (repo.worktrees ?? []) : [])
    .map((wt) => ({ wt, chip: rows.find((r) => r.wt.task === wt.task)?.chip }))
    // The dev room's own rule (a fresh worktree with no commit also counts as merged by git alone).
    .filter(({ wt, chip }) => wt.exists && (chip ? chip !== 'merged' : !isMerged(wt)))
    .map(({ wt, chip }) => {
      const status = chip
        ? plain(t(`devroom.chip.${chip}`, { count: wt.conflicts?.length ?? 0 }))
        : '';
      return {
        task: wt.task,
        sub: [wt.assignee, status].filter(Boolean).join(' · '),
      };
    });
  const row = (key: string, name: string, sub: string, target: FileRoot, on: boolean) => (
    <button
      key={key}
      type="button"
      role="menuitemradio"
      aria-checked={on}
      className={`block w-full text-left px-11 py-7 border-b-2 border-devroom-menu-line last:border-b-0 text-xs hover:bg-active-bg ${on ? 'bg-active-bg' : ''}`}
      onClick={() => {
        setOpen(false);
        onPick(target);
      }}
    >
      {name}
      <small className="block text-2xs text-text-muted">
        {on ? [sub, t('files.edit.here')].filter(Boolean).join(' · ') : sub}
      </small>
    </button>
  );
  return (
    <div className="relative">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t('files.edit.pickLabel')}
        data-testid="root-picker"
        className="flex w-full items-center gap-8 border-2 border-devroom-main-line bg-devroom-main px-8 py-4 text-left text-xs"
        onClick={() => setOpen((value) => !value)}
      >
        <span aria-hidden className="text-accent-text">
          ᚠ
        </span>
        <span className="truncate">{current ?? t('files.edit.main')}</span>
        <span aria-hidden>▾</span>
        <span className="ml-auto truncate text-2xs text-text-muted">{t('files.edit.pick')}</span>
      </button>
      {open && (
        <>
          <button
            type="button"
            tabIndex={-1}
            aria-hidden
            className="fixed inset-0 z-[90] cursor-default"
            onClick={() => setOpen(false)}
          />
          <div
            role="menu"
            data-testid="root-picker-menu"
            className="absolute left-0 right-0 top-full z-[91] mt-4 border-2 border-devroom-main-line bg-devroom-menu shadow-pixel"
          >
            {row(
              'main',
              t('files.edit.main'),
              t('files.edit.mainSub'),
              { kind: 'project', project },
              current === null,
            )}
            {choices.map((c) =>
              row(
                c.task,
                c.task,
                c.sub,
                { kind: 'worktree', project, task: c.task },
                current === c.task,
              ),
            )}
          </div>
        </>
      )}
    </div>
  );
}
