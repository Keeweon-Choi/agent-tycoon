/** Image-viewer controls that can be selected without touching browser APIs. */
export type ImageAction = 'download' | 'share' | 'copy' | 'open';
export type AttachmentKind = 'image' | 'text' | 'other';
export type FileAction = ImageAction;

export interface ImageActionCapabilities {
  canShare: boolean;
  canCopy: boolean;
}

export interface FileActionCapabilities extends ImageActionCapabilities {
  canOfferActions: boolean;
  opensInline: boolean;
}

/** Download, copy, and a new tab are always useful; only sharing needs browser support. */
export function imageActions({ canShare }: ImageActionCapabilities): ImageAction[] {
  return [
    'download',
    ...(canShare ? (['share'] as const) : []),
    'copy',
    'open',
  ];
}

/** The viewer's one action row varies only by preview kind and browser/file capability. */
export function fileActions(
  kind: AttachmentKind,
  { canOfferActions, canShare, opensInline: canOpenInline }: FileActionCapabilities,
): FileAction[] {
  if (!canOfferActions) return [];
  if (kind === 'image') return imageActions({ canShare, canCopy: true });
  if (kind === 'text') return ['copy', 'download', ...(canShare ? (['share'] as const) : [])];
  return ['download', ...(canOpenInline ? (['open'] as const) : []), ...(canShare ? (['share'] as const) : [])];
}

/** Chrome's image clipboard accepts PNG, so every other image type needs drawing first. */
export const shouldConvertImageToPng = (type: string): boolean =>
  type.toLowerCase() !== 'image/png';

/** Give downloaded PNGs the MIME type Chromium requires for image clipboard items. */
export async function prepareClipboardPng(
  blob: Blob,
  type: string,
  canvasPng: (source: Blob) => Promise<Blob>,
): Promise<Blob> {
  if (!shouldConvertImageToPng(type)) return new Blob([blob], { type: 'image/png' });
  return canvasPng(blob);
}

export type AttachmentActionOutcome =
  | { kind: 'downloaded' }
  | { kind: 'saved' }
  | { kind: 'copied' }
  | { kind: 'opened' }
  | { kind: 'failed'; reason: string };

export const ATTACHMENT_ACTION_SUCCESS_DURATION = 2_000;
export const ATTACHMENT_ACTION_ERROR_DURATION = 8_000;

/** The UI translates this small outcome model, keeping action status easy to test. */
export function attachmentActionToast(
  action: ImageAction,
  outcome: AttachmentActionOutcome,
  { canCopy }: Pick<ImageActionCapabilities, 'canCopy'>,
): {
  key:
    | 'attachment.viewer.downloaded'
    | 'attachment.viewer.saved'
    | 'attachment.viewer.copied'
    | 'attachment.viewer.opened'
    | 'attachment.viewer.actionProblem'
    | 'attachment.viewer.copyUnavailable';
  tone: 'ok' | 'error';
  duration?: number;
  values?: { reason: string };
} {
  if (action === 'copy' && !canCopy) {
    return {
      key: 'attachment.viewer.copyUnavailable',
      tone: 'error',
      duration: ATTACHMENT_ACTION_ERROR_DURATION,
    };
  }
  switch (outcome.kind) {
    case 'downloaded':
      return {
        key: 'attachment.viewer.downloaded',
        tone: 'ok',
        duration: ATTACHMENT_ACTION_SUCCESS_DURATION,
      };
    case 'saved':
      return {
        key: 'attachment.viewer.saved',
        tone: 'ok',
        duration: ATTACHMENT_ACTION_SUCCESS_DURATION,
      };
    case 'copied':
      return {
        key: 'attachment.viewer.copied',
        tone: 'ok',
        duration: ATTACHMENT_ACTION_SUCCESS_DURATION,
      };
    case 'opened':
      return {
        key: 'attachment.viewer.opened',
        tone: 'ok',
        duration: ATTACHMENT_ACTION_SUCCESS_DURATION,
      };
    case 'failed':
      return {
        key: 'attachment.viewer.actionProblem',
        tone: 'error',
        duration: ATTACHMENT_ACTION_ERROR_DURATION,
        values: { reason: outcome.reason },
      };
  }
}
