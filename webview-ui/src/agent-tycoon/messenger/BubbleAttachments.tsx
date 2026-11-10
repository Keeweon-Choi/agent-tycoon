/** Messenger attachment chips and inline attachment bubbles. */
/* eslint-disable react-refresh/only-export-components */
import { useEffect, useMemo, useState } from 'react';

import type { ChatItem } from '../../../../core/src/messages.js';
import { Button } from '../../components/ui/Button.js';
import { t } from '../../i18n/index.js';
import { rootFileTicket } from '../files/filesStore.js';
import { Icon } from '../icons/Icon.js';
import { HighlightedText } from '../markdown.js';
import { agtyOwnToast } from '../officeStore.js';
import { attachmentActionToast } from './attachmentActions.js';
import type { ViewerFile } from './attachmentGallery.js';
import { draftPath, useAttachmentTarget, useOpenAttachment, useTicketFor } from './attachmentGallery.js';
import { type AttachmentChip,isVideoType, splitAttachmentText } from './attachments.js';
import { AttachmentVideo } from './AttachmentVideo.js';
import { sizeLabel } from './attachmentView.js';
import { AttachmentGallery } from './AttachmentViewer.js';

/** FEAT-MESSENGER-GPT-LOOK: the kind of a file, as the glyph of its card's tile (Material Symbols). */
function fileGlyph(type: string, name: string): string {
  if (type.startsWith('image/')) return 'image';
  if (isVideoType(type)) return 'movie';
  if (/\.(zip|tar|gz|tgz|7z|rar)$/i.test(name)) return 'folder_zip';
  return 'description';
}

/** A file's 내려받기, as the viewer does it; a failure says why in the viewer's own toast. */
async function saveFile(file: ViewerFile, ticketFor: ReturnType<typeof useTicketFor>): Promise<void> {
  const report = (outcome: Parameters<typeof attachmentActionToast>[1]) => {
    const next = attachmentActionToast('download', outcome, { canCopy: false });
    agtyOwnToast(t('attachment.viewer.title'), t(next.key, next.values), next.tone, next.duration);
  };
  try {
    const link = document.createElement('a');
    link.href = await ticketFor(file.path, 'download');
    link.download = file.name;
    document.body.append(link);
    link.click();
    link.remove();
  } catch (error) {
    report({ kind: 'failed', reason: error instanceof Error && error.message ? error.message : String(error) });
  }
}

export function DraftChip({ chip, remove }: { chip: AttachmentChip; remove: () => void }) {
  const [thumbnail, setThumbnail] = useState<string | null>(null);
  const openViewer = useOpenAttachment();
  useEffect(() => {
    if (!chip.file || !chip.type.startsWith('image/')) return;
    const url = URL.createObjectURL(chip.file);
    setThumbnail(url);
    return () => URL.revokeObjectURL(url);
  }, [chip.file, chip.type]);
  return (
    <div
      className="msg-chip max-w-full text-xs"
      data-state={chip.state}
    >
      <div className="flex gap-6 items-center min-w-0">
        {/* MSG-UI2: the thumbnail and the name open the same viewer as a sent file does. */}
        <button
          type="button"
          className="min-w-0 flex gap-4 items-center text-left"
          data-testid="draft-open"
          aria-label={t('messenger.attachmentOpen', { name: chip.name })}
          // The tap must not take the focus from the composer's text box: the gallery hands it
          // back when the viewer closes (COMPOSE-PREVIEW).
          onPointerDown={(event) => event.preventDefault()}
          onClick={() => openViewer?.(draftPath(chip))}
        >
          {thumbnail ? (
            <img src={thumbnail} alt="" className="w-20 h-20 object-cover pointer-events-none" />
          ) : (
            <span className="material-symbols-sharp text-[16px] text-devroom-mine-text" aria-hidden="true">
              {fileGlyph(chip.type, chip.name)}
            </span>
          )}
          <span className="truncate max-w-128" title={chip.name}>
            {chip.name}
          </span>
        </button>
        <span className="text-text-muted shrink-0">{Math.ceil(chip.size / 1024)} KB</span>
        <button
          type="button"
          className="shrink-0 grid place-items-center size-20 text-text-muted hover:text-text hover:bg-btn-hover pointer-coarse:size-36"
          aria-label={t('messenger.attachmentRemove', { name: chip.name })}
          onClick={remove}
          disabled={chip.state === 'uploading'}
        >
          <Icon name="x" size={14} pixel={<span className="material-symbols-sharp text-[14px]" aria-hidden="true">
            close
          </span>} />
        </button>
      </div>
      {chip.state === 'uploading' && (
        <progress
          aria-label={t('messenger.attachmentUpload', { name: chip.name })}
          value={chip.progress}
          max={100}
          className="w-full h-4"
        />
      )}
      {chip.error && (
        <p role="alert" className="text-danger">
          {chip.error}
        </p>
      )}
    </div>
  );
}

/** The files a lead sent that the server kept (the viewer's list); `unavailable` ones are left out. */
export function sentFiles(item: ChatItem): ViewerFile[] {
  return (item.attachments ?? []).flatMap((file) =>
    file.path
      ? [{ path: file.path, name: file.name, type: file.type ?? '', sizeKb: file.sizeKb ?? 0 }]
      : [],
  );
}

/** A message's attachments as thumbnails and file chips; a tap opens the app's own viewer. */
export function BubbleAttachments(props: {
  text: string;
  /** The files themselves (a lead's sent files, T-0105); absent: read from `[첨부]` lines in `text`. */
  attachments?: ViewerFile[];
  project?: string;
  projectRoot?: string;
  highlightQuery?: string;
  currentMatch?: boolean;
}) {
  const inGallery = useOpenAttachment();
  const ticketFor = useTicketFor(props.project, props.projectRoot);
  const files = useMemo(
    () => props.attachments ?? splitAttachmentText(props.text).attachments,
    [props.attachments, props.text],
  );
  const body = <BubbleAttachmentsBody {...props} />;
  // Outside a conversation (the work sheet) the bubble brings a viewer of its own files.
  return inGallery ? (
    body
  ) : (
    <AttachmentGallery files={files} ticketFor={ticketFor}>
      {body}
    </AttachmentGallery>
  );
}

function BubbleAttachmentsBody({
  text,
  attachments: given,
  project,
  projectRoot,
  highlightQuery,
  currentMatch,
}: {
  text: string;
  attachments?: ViewerFile[];
  project?: string;
  projectRoot?: string;
  highlightQuery?: string;
  currentMatch?: boolean;
}) {
  const { body, attachments } = useMemo(
    () => (given ? { body: text, attachments: given } : splitAttachmentText(text)),
    [given, text],
  );
  const [urls, setUrls] = useState<Record<string, string>>({});
  const targetFor = useAttachmentTarget(project, projectRoot);
  const ticketFor = useTicketFor(project, projectRoot);
  const openViewer = useOpenAttachment();
  useEffect(() => {
    let live = true;
    for (const file of attachments) {
      if (urls[file.path]) continue;
      const target = targetFor(file.path);
      if (!target || !file.type.startsWith('image/')) continue;
      rootFileTicket({ kind: 'project', project: target.project }, target.relative, 'preview')
        .then((url) => {
          if (live) setUrls((held) => ({ ...held, [file.path]: url }));
        })
        .catch(() => undefined);
    }
    return () => {
      live = false;
    };
  }, [attachments, targetFor, urls]);
  return (
    <>
      {body && (
        <p className="whitespace-pre-wrap [overflow-wrap:anywhere]">
          <HighlightedText text={body} query={highlightQuery} current={currentMatch} />
        </p>
      )}
      {attachments.length > 0 && (
        <div className="flex flex-wrap gap-6 mt-6">
          {attachments.map((file) => {
            // FEAT-MESSENGER-GPT-LOOK: a picture shows itself in a sunk frame; any other file is a card with
            // its kind, name and size and a 내려받기 button (when the daemon can hand it out).
            const chip =
              file.type.startsWith('image/') && urls[file.path] ? (
                <button
                  key={file.path}
                  type="button"
                  title={file.path}
                  className="msg-file p-4! w-auto!"
                  onClick={() => openViewer?.(file.path)}
                >
                  <img src={urls[file.path]} alt={file.name} className="w-96 h-64 object-contain" />
                </button>
              ) : (
                <div key={file.path} className="msg-file" data-testid="bubble-file">
                  <span className="msg-file-tile" aria-hidden="true">
                    <span className="material-symbols-sharp text-[18px]">{fileGlyph(file.type, file.name)}</span>
                  </span>
                  <button
                    type="button"
                    title={file.path}
                    className="msg-file-name"
                    aria-label={t('messenger.attachmentOpen', { name: file.name })}
                    onClick={() => openViewer?.(file.path)}
                  >
                    <span className="block truncate text-sm text-text">{file.name}</span>
                    {file.sizeKb > 0 && <span className="block text-2xs text-text-muted">{sizeLabel(file.sizeKb)}</span>}
                  </button>
                  {targetFor(file.path) && (
                    <Button
                      size="icon_md"
                      aria-label={t('msglib.fileSaveLabel', { name: file.name })}
                      title={t('attachment.viewer.download')}
                      onClick={() => void saveFile(file, ticketFor)}
                    >
                      <Icon name="download" size={16} pixel={<span className="material-symbols-sharp" aria-hidden="true">
                        download
                      </span>} />
                    </Button>
                  )}
                </div>
              );
            // A video plays in place; the button under it opens the large viewer.
            return isVideoType(file.type) && targetFor(file.path) ? (
              <div key={file.path} className="min-w-0 max-w-full flex-1 basis-full">
                <AttachmentVideo
                  path={file.path}
                  ticketFor={ticketFor}
                  className="attach-inline-video"
                  testId="bubble-video"
                  fallback={chip}
                />
                <button
                  type="button"
                  className="text-xs text-text-muted truncate max-w-full"
                  data-testid="bubble-video-open"
                  title={file.path}
                  aria-label={t('attachment.video.open', { name: file.name })}
                  onClick={() => openViewer?.(file.path)}
                >
                  ⤢ {file.name}
                </button>
              </div>
            ) : (
              chip
            );
          })}
        </div>
      )}
    </>
  );
}
