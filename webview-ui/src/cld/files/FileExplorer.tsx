import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import type {
  ProjectFileEntry,
  ProjectFileList,
  ProjectFilePreview,
} from '../../../../core/src/cld/projectFiles.js';
import { Button } from '../../components/ui/Button.js';
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
import { useCldStore } from '../officeStore.js';
import { chooseFileRoot, listingCache, useFileRoot } from './explorerState.js';
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
import { Preview } from './Preview.js';

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
          {list?.entries.length === 0 && <p className="text-text-muted px-8">{t('files.emptyFolder')}</p>}
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
  const selection = useRef(0);
  const isMobile = useIsMobile();
  const events = useCldStore().events;
  const { officeSnapshot: officeState, officeReadOnly } = useCldStore();
  const engine = useEngineStore().state;
  const messenger = useMessenger();
  const sendableContacts = messenger.contacts.filter((contact) => contact.canSend);
  const [sendLead, setSendLead] = useState('');
  const folder =
    root.kind === 'project'
      ? (engine?.projects.find((project) => project.name === root.project)?.folder ??
        officeState?.orchestrators.find((project) => project.name === root.project)?.dir)
      : undefined;
  const chosenLead =
    sendLead ||
    (root.kind === 'project' && sendableContacts.some((contact) => contact.name === root.project)
      ? root.project
      : (sendableContacts[0]?.name ?? ''));
  const latestTurn =
    root.kind === 'project'
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
  const open = async (entry: ProjectFileEntry) => {
    const current = ++selection.current;
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
    selection.current++;
    setSelected(null);
    openMessenger(lead.agentId);
  };
  const pane = selected && (
    <div
      aria-label={t('files.preview')}
      className={
        isMobile
          ? 'fixed inset-0 z-[100] overflow-auto bg-bg text-xs p-[calc(12px+var(--cld-safe-top))_calc(12px+var(--cld-safe-right))_calc(12px+var(--cld-safe-bottom))_calc(12px+var(--cld-safe-left))]'
          : 'min-w-0 flex-1 border border-border p-8 bg-bg text-xs overflow-auto'
      }
    >
      <div className="flex flex-wrap gap-8 items-center mb-8">
        <strong className="truncate flex-1">{selected.name}</strong>
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
            selection.current++;
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
      {preview && <Preview file={preview} url={previewUrl} />}
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
          <input
            type="search"
            aria-label={t('files.nameFilter')}
            placeholder={t('files.filterPlaceholder')}
            className="bg-bg border border-border p-4 min-w-0 flex-1"
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
          <div className="p-8 border-b border-border" aria-label={t('files.recentFiles')}>
            <p className="text-text-muted mb-4">
              {t('files.recent24h')}{recent.partial ? t('files.partialSuffix') : ''}
            </p>
            {recent.entries.map((entry) => (
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
  const { officeSnapshot: officeState, hostInfo } = useCldStore();
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
  return (
    // Desktop: the drawer's height, tree and preview scrolling on their own (VS Code style).
    <section className="min-w-0 flex flex-col gap-8 md:h-full" aria-label={t('files.explorer')}>
      <div className="flex flex-wrap gap-4 items-center">
        <strong className="text-xs mr-4">{t('files.projects')}</strong>
        {names.map((name) => (
          <Button
            size="sm"
            variant={root?.kind === 'project' && root.project === name ? 'active' : 'default'}
            key={name}
            aria-pressed={root?.kind === 'project' && root.project === name}
            onClick={() => chooseFileRoot({ kind: 'project', project: name })}
          >
            {name}
          </Button>
        ))}
        <Button size="sm" onClick={() => setPickerOpen(true)}>
          {t('files.openOther')}
        </Button>
      </div>
      {root && (
        <p className="text-text-muted text-xs break-all">
          {root.kind === 'project' ? root.project : root.folder}
        </p>
      )}
      {root && (
        <Explorer
          key={fileRootKey(root)}
          root={root}
          label={root.kind === 'project' ? root.project : root.folder}
        />
      )}
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
