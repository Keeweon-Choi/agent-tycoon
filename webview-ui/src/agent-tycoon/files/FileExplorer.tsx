import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import type {
  ProjectFileEntry,
  ProjectFileList,
  ProjectFilePreview,
} from '../../../../core/src/agent-tycoon/projectFiles.js';
import { Button } from '../../components/ui/Button.js';
import { RECENT_FOLD_STORAGE_KEY, RECENT_OUTPUTS_SHOWN } from '../../constants.js';
import { useIsMobile } from '../../hooks/useIsMobile.js';
import { getLanguage, t } from '../../i18n/index.js';
import { useEngineStore } from '../engineStore.js';
import { FolderPicker } from '../FolderPicker.js';
import { fileType, MAX_ATTACHMENTS } from '../messenger/attachments.js';
import {
  messengerGetSnapshot,
  openMessenger,
  setAttachments,
  useMessenger,
} from '../messenger/messengerStore.js';
import { useAgtyStore } from '../officeStore.js';
import { useRepoView } from '../repo/useRepoView.js';
import { ZoomBar } from '../Zoom.js';
import { useTextZoom, useZoomHost } from '../zoomStore.js';
import { useEditSession } from './editSession.js';
import { chooseFileRoot, clearPendingFile, listingCache, useFileRoot, usePendingFile } from './explorerState.js';
import {
  type FileRoot,
  fileRootKey,
  fileSettings,
  ignoredRootFiles,
  isIgnoredPath,
  listRootFiles,
  previewRootFile,
  recentProjectFiles,
  rootFileTicket,
} from './filesStore.js';
import { lineList } from './lineDiff.js';
import { Preview } from './Preview.js';
import { RootPicker } from './RootPicker.js';

/** CodeMirror is its own chunk: fetched when the first file is opened for editing (A6). */
const Editor = lazy(() => import('./Editor.js'));
/** What the editor opens (the daemon also refuses non-text and over 1 MB). */
const EDITABLE: readonly string[] = ['text', 'markdown', 'json', 'csv', 'html'];
const EDIT_MAX_BYTES = 1024 * 1024;

/** The 최근 산출물 fold is the owner's, kept in this browser (storage may be blocked: then it opens unfolded). */
function readRecentFolded(): boolean {
  try {
    return localStorage.getItem(RECENT_FOLD_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}
function saveRecentFolded(folded: boolean): void {
  try {
    localStorage.setItem(RECENT_FOLD_STORAGE_KEY, folded ? '1' : '0');
  } catch {
    /* not remembered */
  }
}

function FolderNode({
  root,
  relative,
  label,
  depth,
  hidden,
  filter,
  ignored,
  refresh,
  onFile,
  initialExpanded = false,
}: {
  root: FileRoot;
  relative: string;
  label: string;
  depth: number;
  hidden: boolean;
  filter: string;
  ignored: string[];
  refresh: number;
  onFile: (entry: ProjectFileEntry) => void;
  initialExpanded?: boolean;
}) {
  const [expanded, setExpanded] = useState(initialExpanded);
  const [offset, setOffset] = useState(0);
  const key = listingCache.key(root, relative, offset, hidden);
  const [loaded, setLoaded] = useState<{ key: string; list: ProjectFileList | null }>(() => ({
    key,
    list: listingCache.peek(key),
  }));
  const list = loaded.key === key ? loaded.list : listingCache.peek(key);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!expanded) return;
    let live = true;
    listingCache
      .showThenRefresh(
        key,
        () => listRootFiles(root, relative, offset, hidden),
        (value) => {
          if (live) {
            setLoaded({ key, list: value });
            setError('');
          }
        },
      )
      .catch((err: Error) => {
        if (live) setError(err.message);
      });
    return () => {
      live = false;
    };
  }, [expanded, key, root, relative, offset, hidden, refresh]);
  const visible = list?.entries.filter(
    (entry) =>
      !filter || entry.name.toLocaleLowerCase().includes(filter) || entry.kind === 'directory',
  );
  return (
    <div>
      <button
        type="button"
        className={`w-full text-left py-4 hover:bg-border truncate ${isIgnoredPath(relative, ignored) ? 'opacity-50' : ''}`}
        style={{ paddingLeft: depth * 14 + 4 }}
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
      >
        <span aria-hidden>{expanded ? '▾' : '▸'}</span> {label}
      </button>
      {expanded && (
        <div>
          {error && (
            <p role="alert" className="text-red-400 px-8">
              {error}
            </p>
          )}
          {!list && !error && <p className="text-text-muted px-8">{t('files.loading')}</p>}
          {visible?.map((entry) =>
            entry.kind === 'directory' ? (
              <FolderNode
                key={entry.path}
                root={root}
                relative={entry.path}
                label={entry.name}
                depth={depth + 1}
                hidden={hidden}
                filter={filter}
                ignored={ignored}
                refresh={refresh}
                onFile={onFile}
              />
            ) : (
              <button
                key={entry.path}
                type="button"
                className={`w-full text-left py-4 pr-4 hover:bg-border truncate ${isIgnoredPath(entry.path, ignored) ? 'opacity-50' : ''}`}
                style={{ paddingLeft: (depth + 1) * 14 + 4 }}
                title={entry.path}
                onClick={() => onFile(entry)}
              >
                <span aria-hidden>▤</span> {entry.name}
              </button>
            ),
          )}
          {list?.entries.length === 0 && (
            <p className="text-text-muted px-8">{t('files.emptyFolder')}</p>
          )}
          {list?.nextOffset != null && (
            <Button
              size="sm"
              style={{ marginLeft: (depth + 1) * 14 }}
              onClick={() => {
                setOffset(list.nextOffset!);
                setError('');
              }}
            >
              {t('files.nextPage')}
            </Button>
          )}
          {offset > 0 && (
            <Button
              size="sm"
              onClick={() => {
                setOffset(0);
                setError('');
              }}
            >
              {t('files.firstPage')}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

function Explorer({ root, label }: { root: FileRoot; label: string }) {
  const [hidden, setHidden] = useState(false);
  const [filter, setFilter] = useState('');
  const [ignored, setIgnored] = useState<string[]>([]);
  const [refresh, setRefresh] = useState(0);
  const [selected, setSelected] = useState<ProjectFileEntry | null>(null);
  const [preview, setPreview] = useState<ProjectFilePreview | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [allowSensitive, setAllowSensitive] = useState(false);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState(false);
  /** SPT-P3-ACCEPT: the line [원본 열기] asked for (the source view, scrolled there and marked). */
  const [line, setLine] = useState<number | undefined>();
  const selection = useRef(0);
  const isMobile = useIsMobile();
  const events = useAgtyStore().events;
  const { officeSnapshot: officeState, officeReadOnly } = useAgtyStore();
  const engine = useEngineStore().state;
  const messenger = useMessenger();
  const sendableContacts = messenger.contacts.filter((contact) => contact.canSend);
  const [sendLead, setSendLead] = useState('');
  const session = useEditSession(root, editing && selected ? selected.path : null);
  const zoomSurface = editing ? 'editor' : 'preview';
  const { zoom } = useTextZoom(zoomSurface);
  const zoomHost = useZoomHost(zoomSurface);
  const [recentFolded, setRecentFolded] = useState(readRecentFolded);
  const [recentShown, setRecentShown] = useState(RECENT_OUTPUTS_SHOWN);
  const folder =
    root.kind === 'project'
      ? (engine?.projects.find((project) => project.name === root.project)?.folder ??
        officeState?.orchestrators.find((project) => project.name === root.project)?.dir)
      : undefined;
  const editable =
    !officeReadOnly &&
    !!preview &&
    EDITABLE.includes(preview.kind) &&
    preview.size <= EDIT_MAX_BYTES &&
    !preview.truncated;
  /** Leaving an edited file asks first: its unsaved text would be lost. */
  const leaveEdit = () => !(editing && session.dirty) || window.confirm(t('files.edit.discard'));
  const chosenLead =
    sendLead ||
    (root.kind === 'project' && sendableContacts.some((contact) => contact.name === root.project)
      ? root.project
      : (sendableContacts[0]?.name ?? ''));
  const latestTurn =
    root.kind !== 'folder'
      ? events.find((event) => event.name === root.project && event.kind === 'turn_end')?.ts
      : undefined;
  const seenTurn = useRef(latestTurn);
  useEffect(() => {
    const onFocus = () => setRefresh((value) => value + 1);
    const onVisible = () => {
      if (document.visibilityState === 'visible') onFocus();
    };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);
  useEffect(() => {
    if (!latestTurn || latestTurn === seenTurn.current) return;
    seenTurn.current = latestTurn;
    setRefresh((value) => value + 1);
  }, [latestTurn]);
  // T-0044's 최근 산출물, per project, on the same refresh signals as the tree.
  const [recent, setRecent] = useState<{ entries: ProjectFileEntry[]; partial: boolean } | null>(
    null,
  );
  useEffect(() => {
    if (root.kind !== 'project') return;
    let live = true;
    recentProjectFiles(root.project, hidden)
      .then((value) => {
        if (live) setRecent(value);
      })
      .catch(() => {
        if (live) setRecent(null);
      });
    return () => {
      live = false;
    };
  }, [root, hidden, refresh]);
  useEffect(() => {
    let live = true;
    ignoredRootFiles(root)
      .then((value) => {
        if (live) setIgnored(value);
      })
      .catch(() => {
        if (live) setIgnored([]);
      });
    fileSettings()
      .then((value) => {
        if (live) setAllowSensitive(value.allowSensitive);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [root]);
  const open = async (entry: ProjectFileEntry, at?: number) => {
    if (!leaveEdit()) return;
    const current = ++selection.current;
    setLine(at);
    setEditing(false);
    setSelected(entry);
    setPreview(null);
    setPreviewUrl(null);
    setError('');
    try {
      const value = await previewRootFile(root, entry.path);
      if (current !== selection.current) return;
      setPreview(value);
      if (value.kind === 'image' || value.kind === 'pdf' || value.kind === 'html') {
        const url = await rootFileTicket(root, entry.path, 'preview');
        if (current === selection.current) setPreviewUrl(url);
      }
    } catch (err) {
      if (current === selection.current) setError((err as Error).message);
    }
  };
  // SPT-P1A: a file the 문서 tab asked for, shown once this project's explorer is up.
  const pending = usePendingFile();
  useEffect(() => {
    if (!pending || root.kind !== 'project' || pending.project !== root.project) return;
    clearPendingFile();
    void open(pending.entry, pending.line);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `open` is this render's; the request is taken once
  }, [pending, root]);
  /** Back to the read-only view shows the file as it is now (it may have been saved meanwhile). */
  const toggleEdit = () => {
    if (!editing) return setEditing(true);
    if (!leaveEdit() || !selected) return;
    setEditing(false);
    previewRootFile(root, selected.path)
      .then(setPreview)
      .catch((err: Error) => setError(err.message));
  };
  const download = async (entry: ProjectFileEntry) => {
    try {
      const url = await rootFileTicket(root, entry.path, 'download');
      const link = document.createElement('a');
      link.href = url;
      link.download = entry.name;
      document.body.append(link);
      link.click();
      link.remove();
    } catch (err) {
      setError((err as Error).message);
    }
  };
  const toMessenger = (entry: ProjectFileEntry) => {
    const lead = sendableContacts.find((contact) => contact.name === chosenLead);
    if (!lead || !folder) return;
    const held = messengerGetSnapshot().attachments[lead.agentId] ?? [];
    if (held.length >= MAX_ATTACHMENTS) {
      setError(t('messenger.limitFiles'));
      return;
    }
    const absolute = `${folder.replace(/\/$/, '')}/${entry.path}`;
    const type = fileType(entry.name, '') ?? 'application/octet-stream';
    setAttachments(lead.agentId, [
      ...held,
      {
        id: crypto.randomUUID(),
        name: entry.name,
        size: entry.size,
        type,
        state: 'ready',
        progress: 100,
        path: absolute,
        relative: entry.path,
      },
    ]);
    // Desktop keeps the file open beside the messenger; the phone's full-screen pane would cover it.
    if (isMobile) {
      selection.current++;
      setSelected(null);
    }
    openMessenger(lead.agentId);
  };
  const pane = selected && (
    <div
      aria-label={t('files.preview')}
      ref={zoomHost}
      tabIndex={-1}
      className={
        isMobile
          ? 'fixed inset-0 z-[100] overflow-auto bg-bg text-xs outline-none touch-pan-x touch-pan-y p-[calc(12px+var(--agty-safe-top))_calc(12px+var(--agty-safe-right))_calc(12px+var(--agty-safe-bottom))_calc(12px+var(--agty-safe-left))]'
          : 'min-w-0 flex-1 border border-border p-8 bg-bg text-xs overflow-auto outline-none'
      }
    >
      <div className="flex flex-wrap gap-8 items-center mb-8">
        <strong className="truncate flex-1">{selected.name}</strong>
        <ZoomBar surface={zoomSurface} />
        {editable &&
          (isMobile ? (
            <Button
              size="sm"
              variant={editing ? 'active' : 'default'}
              aria-pressed={editing}
              onClick={toggleEdit}
            >
              {t('files.edit.toggle')}
            </Button>
          ) : (
            <button
              type="button"
              role="switch"
              aria-checked={editing}
              data-testid="edit-switch"
              className="flex items-center gap-8 text-xs"
              onClick={toggleEdit}
            >
              {t('files.edit.toggle')}
              <span
                aria-hidden
                className={`flex h-24 w-44 items-center border-2 p-2 ${editing ? 'justify-end border-devroom-on-line bg-devroom-on-bg' : 'justify-start border-border bg-btn-bg'}`}
              >
                <span className={`size-16 ${editing ? 'bg-devroom-on-text' : 'bg-text-muted'}`} />
              </span>
            </button>
          ))}
        {editing && (
          <Button
            size="sm"
            variant="accent"
            data-testid="edit-save"
            disabled={!session.dirty || session.saving || session.loading}
            onClick={() => void session.save()}
          >
            {session.saving ? t('files.edit.saving') : t('files.edit.save')}
          </Button>
        )}
        {root.kind === 'project' && !officeReadOnly && folder && sendableContacts.length > 0 && (
          <>
            <select
              aria-label={t('files.recipient')}
              className="border border-border bg-bg px-4 py-2 text-xs max-w-full"
              value={chosenLead}
              onChange={(event) => setSendLead(event.target.value)}
            >
              {sendableContacts.map((contact) => (
                <option key={contact.agentId} value={contact.name}>
                  {contact.name}
                </option>
              ))}
            </select>
            <Button size="sm" onClick={() => toMessenger(selected)}>
              {t('files.sendMessenger')}
            </Button>
          </>
        )}
        <Button size="sm" onClick={() => void download(selected)}>
          {t('files.download')}
        </Button>
        <Button
          size="sm"
          onClick={() => {
            if (!leaveEdit()) return;
            selection.current++;
            setEditing(false);
            setSelected(null);
            setPreview(null);
          }}
        >
          {t('common.close')}
        </Button>
      </div>
      <p className="text-text-muted mb-8 break-all">
        {selected.path} · {selected.size.toLocaleString()} B ·{' '}
        {new Date(selected.mtime).toLocaleString(getLanguage() === 'ko' ? 'ko-KR' : 'en-US')}
      </p>
      {preview?.truncated && <p className="text-yellow-300 mb-8">{t('files.previewTruncated')}</p>}
      {editing && preview && (
        <div className="-mx-8 -mb-8 flex min-h-[50vh] flex-1 flex-col">
          {session.changed && (
            <div
              role="alert"
              data-testid="edit-changed"
              className="flex flex-wrap items-center gap-8 border-b-2 border-devroom-conf-line bg-devroom-banner-bg px-8 py-6 text-devroom-conf"
            >
              <span className="flex-1">{t('files.edit.banner')}</span>
              <Button size="sm" onClick={session.reload}>
                {t('files.edit.reload')}
              </Button>
              <Button size="sm" disabled={session.saving} onClick={() => void session.saveAnyway()}>
                {t('files.edit.saveAnyway')}
              </Button>
            </div>
          )}
          <div className="min-h-[40vh] flex-1">
            {session.loading ? (
              <p className="p-8">{t('files.edit.loading')}</p>
            ) : (
              !session.error && (
                <Suspense fallback={<p className="p-8">{t('files.edit.loading')}</p>}>
                  <Editor
                    path={selected.path}
                    doc={session.doc}
                    docKey={session.docKey}
                    marks={session.marks}
                    zoom={zoom}
                    label={t('files.edit.label', { name: selected.name })}
                    onChange={session.edit}
                  />
                </Suspense>
              )
            )}
          </div>
          {session.marks.length > 0 && (
            <p data-testid="edit-lines" className="px-8 py-4 text-2xs text-text-muted">
              {t('files.edit.lines', { lines: lineList(session.marks) })}
            </p>
          )}
          <p
            data-testid="edit-status"
            className={`border-t-2 border-border bg-devroom-bar px-8 py-6 ${session.error ? 'text-red-400' : 'text-text-muted'}`}
          >
            {session.error ||
              (session.changed && !session.saved
                ? t('files.edit.refused')
                : session.saved
                  ? t('files.edit.saved')
                  : t('files.edit.status'))}
          </p>
        </div>
      )}
      {!editing && preview && <Preview file={preview} url={previewUrl} zoom={zoom} line={line} />}
      {!editing && isMobile && editable && (
        <p className="mt-8 border-2 border-border bg-devroom-box p-8 text-2xs text-text-muted">
          {t('files.edit.readOnly')}
        </p>
      )}
      {!preview && !error && <p>{t('files.previewLoading')}</p>}
      {error && (
        <p role="alert" className="text-red-400">
          {error}
        </p>
      )}
    </div>
  );
  return (
    <div
      className="flex flex-col md:flex-row gap-8 min-h-[40vh] min-w-0 md:flex-1 md:min-h-0"
      aria-label={t('files.explorerLabel', { name: label })}
    >
      <div className="w-full md:w-[min(320px,45%)] md:shrink-0 border border-border overflow-auto min-w-0 text-xs">
        <div className="sticky top-0 bg-bg z-10 p-8 border-b border-border flex flex-wrap gap-4">
          {root.kind !== 'folder' && (
            <div className="w-full">
              <RootPicker root={root} project={root.project} onPick={chooseFileRoot} />
            </div>
          )}
          <input
            type="search"
            aria-label={t('files.nameFilter')}
            placeholder={t('files.filterPlaceholder')}
            className="ui-input p-4 min-w-96 flex-1"
            value={filter}
            onChange={(event) => setFilter(event.target.value.toLocaleLowerCase())}
          />
          <Button size="sm" onClick={() => setRefresh((value) => value + 1)}>
            {t('files.refresh')}
          </Button>
          <label className="flex items-center gap-4">
            <input
              type="checkbox"
              checked={hidden}
              onChange={(event) => setHidden(event.target.checked)}
            />
            {t('files.hiddenFiles')}
          </label>
          <label className="flex items-center gap-4">
            <input
              type="checkbox"
              checked={allowSensitive}
              onChange={async (event) => {
                try {
                  setAllowSensitive((await fileSettings(event.target.checked)).allowSensitive);
                } catch (err) {
                  setError((err as Error).message);
                }
              }}
            />
            {t('files.openSensitive')}
          </label>
        </div>
        {recent && recent.entries.length > 0 && (
          <div
            className="p-8 border-b border-border"
            aria-label={t('files.recentFiles')}
            data-testid="recent-outputs"
            data-folded={recentFolded || undefined}
          >
            <button
              type="button"
              className="w-full text-left text-text-muted hover:text-accent-text"
              aria-expanded={!recentFolded}
              data-testid="recent-toggle"
              onClick={() => {
                setRecentFolded(!recentFolded);
                saveRecentFolded(!recentFolded);
              }}
            >
              <span aria-hidden>{recentFolded ? '▸' : '▾'}</span> {t('files.recent24h')}
              {recent.partial ? t('files.partialSuffix') : ''} ·{' '}
              {t('files.recentCount', { count: recent.entries.length })}
            </button>
            {!recentFolded &&
              recent.entries.slice(0, recentShown).map((entry) => (
                <button
                  key={entry.path}
                  type="button"
                  title={entry.path}
                  className="w-full text-left py-4 hover:bg-border truncate"
                  onClick={() => void open(entry)}
                >
                  <span aria-hidden>▤</span> {entry.path}
                </button>
              ))}
            {!recentFolded && recent.entries.length > recentShown && (
              <Button
                size="sm"
                data-testid="recent-more"
                onClick={() => setRecentShown((n) => n + RECENT_OUTPUTS_SHOWN)}
              >
                {t('files.recentMore', { count: recent.entries.length - recentShown })}
              </Button>
            )}
          </div>
        )}
        <FolderNode
          root={root}
          relative=""
          label={label}
          depth={0}
          hidden={hidden}
          filter={filter}
          ignored={ignored}
          refresh={refresh}
          onFile={(entry) => void open(entry)}
          initialExpanded
        />
      </div>
      {selected && (isMobile ? createPortal(pane, document.body) : pane)}
    </div>
  );
}

export function FileExplorer() {
  const { officeSnapshot: officeState, hostInfo } = useAgtyStore();
  const engine = useEngineStore().state;
  const stored = useFileRoot();
  const [pickerOpen, setPickerOpen] = useState(false);
  const names = [
    ...new Set([
      ...(officeState?.orchestrators.map((project) => project.name) ?? []),
      ...(engine?.projects.map((project) => project.name) ?? []),
    ]),
  ];
  const firstProject = names[0];
  const home = hostInfo?.home;
  const root = useMemo<FileRoot | null>(
    () =>
      stored ??
      (firstProject
        ? { kind: 'project', project: firstProject }
        : home
          ? { kind: 'folder', folder: home }
          : null),
    [stored, firstProject, home],
  );
  // The picker's worktrees come from the project's repository state, sent while someone looks at it.
  useRepoView(root && root.kind !== 'folder' ? root.project : null);
  const rootName = (r: FileRoot) =>
    r.kind === 'folder' ? r.folder : r.kind === 'worktree' ? `${r.project} / ${r.task}` : r.project;
  return (
    // Desktop: the drawer's height, tree and preview scrolling on their own (VS Code style).
    <section className="min-w-0 flex flex-col gap-8 md:h-full" aria-label={t('files.explorer')}>
      <div className="flex flex-wrap gap-4 items-center">
        <strong className="text-xs mr-4">{t('files.projects')}</strong>
        {names.map((name) => (
          <Button
            size="sm"
            variant={root?.kind !== 'folder' && root?.project === name ? 'active' : 'default'}
            key={name}
            aria-pressed={root?.kind !== 'folder' && root?.project === name}
            onClick={() => chooseFileRoot({ kind: 'project', project: name })}
          >
            {name}
          </Button>
        ))}
        <Button size="sm" onClick={() => setPickerOpen(true)}>
          {t('files.openOther')}
        </Button>
      </div>
      {root && <p className="text-text-muted text-xs break-all">{rootName(root)}</p>}
      {root && <Explorer key={fileRootKey(root)} root={root} label={rootName(root)} />}
      {!root && <p className="text-text-muted text-xs">{t('files.waitingFolder')}</p>}
      {/* On the body: inside the phone shell's transformed track a fixed modal
          centres on the 200%-wide track and focusing it slides the pages. */}
      {pickerOpen &&
        createPortal(
          <FolderPicker
            start={root?.kind === 'folder' ? root.folder : (hostInfo?.home ?? '')}
            onPick={(folder) => {
              chooseFileRoot({ kind: 'folder', folder });
              setPickerOpen(false);
            }}
            onClose={() => setPickerOpen(false)}
          />,
          document.body,
        )}
    </section>
  );
}
