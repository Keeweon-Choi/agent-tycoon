/** Messenger attachment chips and inline attachment bubbles. */
/* eslint-disable react-refresh/only-export-components */
import { useEffect, useMemo, useState } from 'react';

import type { ChatItem } from '../../../../core/src/messages.js';
import { t } from '../../i18n/index.js';
import { rootFileTicket } from '../files/filesStore.js';
import { HighlightedText } from '../markdown.js';
import type { ViewerFile } from './attachmentGallery.js';
import { draftPath, useAttachmentTarget, useOpenAttachment, useTicketFor } from './attachmentGallery.js';
import { type AttachmentChip,isVideoType, splitAttachmentText } from './attachments.js';
import { AttachmentVideo } from './AttachmentVideo.js';
import { AttachmentGallery } from './AttachmentViewer.js';

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
      className="min-w-0 max-w-full border border-border bg-bg-dark px-4 py-2 text-xs"
      data-state={chip.state}
    >
      <div className="flex gap-4 items-center">
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
          {thumbnail && <img src={thumbnail} alt="" className="w-32 h-32 object-cover pointer-events-none" />}
          <span className="truncate max-w-128" title={chip.name}>
            {chip.name}
          </span>
        </button>
        <span className="text-text-muted shrink-0">{Math.ceil(chip.size / 1024)} KB</span>
        <button
          type="button"
          aria-label={t('messenger.attachmentRemove', { name: chip.name })}
          onClick={remove}
          disabled={chip.state === 'uploading'}
        >
          ×
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
        <div className="flex flex-wrap gap-4 mt-4">
          {attachments.map((file) => {
            const chip = (
              <button
                key={file.path}
                type="button"
                title={file.path}
                className="border border-border px-4 py-2 text-xs max-w-160 truncate"
                onClick={() => openViewer?.(file.path)}
              >
                {file.type.startsWith('image/') && urls[file.path] ? (
                  <img src={urls[file.path]} alt={file.name} className="w-64 h-64 object-contain" />
                ) : (
                  <>▤ {file.name}</>
                )}
              </button>
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
