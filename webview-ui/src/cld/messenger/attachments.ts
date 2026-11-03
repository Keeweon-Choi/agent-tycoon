import { ATTACH_VIDEO_MAX_BYTES } from '../../constants.js';
import { t } from '../../i18n/index.js';
import { serverText } from '../serverText.js';

export const MAX_ATTACHMENTS = 5;
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

export type ChipState = 'pending' | 'uploading' | 'failed' | 'ready';
export interface AttachmentChip {
  id: string;
  name: string;
  size: number;
  type: string;
  state: ChipState;
  progress: number;
  error?: string;
  file?: File;
  path?: string;
  relative?: string;
}

const imageType: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  jfif: 'image/jpeg',
  jpe: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
};
const videoType: Record<string, string> = {
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
};
const storedType: Record<string, string> = {
  zip: 'application/zip',
  '7z': 'application/x-7z-compressed',
  tar: 'application/x-tar',
  gz: 'application/gzip',
  tgz: 'application/gzip',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  odt: 'application/vnd.oasis.opendocument.text',
  ods: 'application/vnd.oasis.opendocument.spreadsheet',
  odp: 'application/vnd.oasis.opendocument.presentation',
  doc: 'application/msword',
  xls: 'application/vnd.ms-excel',
  ppt: 'application/vnd.ms-powerpoint',
  hwp: 'application/x-hwp',
  hwpx: 'application/hwp+zip',
  rtf: 'application/rtf',
};
const textExtensions = new Set([
  'txt',
  'md',
  'csv',
  'json',
  'log',
  'ts',
  'tsx',
  'js',
  'jsx',
  'mjs',
  'cjs',
  'py',
  'go',
  'rs',
  'java',
  'kt',
  'swift',
  'c',
  'h',
  'cpp',
  'hpp',
  'cs',
  'sh',
  'bash',
  'zsh',
  'css',
  'html',
  'xml',
  'yaml',
  'yml',
  'sql',
  'toml',
]);

/** The conservative type used for a file path named in a message. */
export function linkedFileType(name: string): string {
  const ext = name.split('.').at(-1)?.toLowerCase() ?? '';
  if (imageType[ext]) return imageType[ext];
  if (ext === 'pdf') return 'application/pdf';
  if (videoType[ext]) return videoType[ext];
  return textExtensions.has(ext) ? 'text/plain' : 'application/octet-stream';
}

export function fileType(name: string, declared: string): string | null {
  const ext = name.split('.').at(-1)?.toLowerCase() ?? '';
  if (imageType[ext]) return !declared || declared === imageType[ext] ? imageType[ext] : null;
  if (ext === 'pdf') return !declared || declared === 'application/pdf' ? 'application/pdf' : null;
  if (storedType[ext]) return storedType[ext];
  // A phone names a clip's type by its container (video/quicktime for .mov, sometimes nothing): the extension decides.
  if (videoType[ext]) return videoType[ext];
  if (textExtensions.has(ext)) return declared || 'text/plain';
  return null;
}

export const isVideoType = (type: string): boolean => type.startsWith('video/');

export function fileChip(file: File, id: string): AttachmentChip {
  const type = fileType(file.name, file.type);
  const video = type !== null && isVideoType(type);
  const error =
    file.size > (video ? ATTACH_VIDEO_MAX_BYTES : MAX_ATTACHMENT_BYTES)
      ? t(video ? 'attachment.error.videoSize' : 'attachment.error.size')
      : !type
        ? t('attachment.error.type')
        : undefined;
  return {
    id,
    name: file.name,
    size: file.size,
    type: type ?? file.type,
    state: error ? 'failed' : 'pending',
    progress: 0,
    ...(error && { error }),
    file,
  };
}

export function updateChip(chips: AttachmentChip[], id: string, patch: Partial<AttachmentChip>) {
  return chips.map((chip) => (chip.id === id ? { ...chip, ...patch } : chip));
}

/** The message text with one `[첨부]` line per file; null when a path or type
 *  (a file-browser name may hold a newline) would start a line of its own. */
export function composeAttachmentText(text: string, chips: AttachmentChip[]): string | null {
  const lines = chips.map(
    (chip) => `[\ucca8\ubd80] ${chip.path} (${chip.type}, ${Math.ceil(chip.size / 1024)} KB)`,
  );
  if (lines.some((line) => /\p{Cc}/u.test(line))) return null;
  return [text.trim(), ...lines].filter(Boolean).join('\n');
}

export function splitAttachmentText(text: string): {
  body: string;
  attachments: Array<{ path: string; name: string; type: string; sizeKb: number }>;
} {
  const attachments: Array<{ path: string; name: string; type: string; sizeKb: number }> = [];
  const lines = text.split('\n');
  while (lines.length) {
    const line = lines.at(-1)!;
    // An absolute path: POSIX, a Windows drive (C:\...) or UNC (\\wsl.localhost\...).
    const match = /^\[\ucca8\ubd80\] ((?:\/|[A-Za-z]:[\\/]|\\\\)[^\n]+) \(([^(),]+), (\d+) KB\)$/.exec(line);
    if (!match) break;
    const savedName = match[1].split(/[\\/]/).at(-1)!;
    attachments.unshift({
      path: match[1],
      name: savedName.replace(/^\d{8}-\d{6}-(?:-\d+-)?/, ''),
      type: match[2],
      sizeKb: Number(match[3]),
    });
    lines.pop();
  }
  return { body: lines.join('\n').trimEnd(), attachments };
}

export interface UploadedAttachment {
  path: string;
  name: string;
  size: number;
  type: string;
}

let inFlightUploads = 0;

/** Active attachment requests across every messenger composer. */
export function uploadsInFlight(): number {
  return inFlightUploads;
}

export function uploadAttachment(
  project: string,
  chip: AttachmentChip,
  batch: string,
  progress: (value: number) => void,
): Promise<UploadedAttachment> {
  inFlightUploads++;
  return new Promise<UploadedAttachment>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/cld/attach/${encodeURIComponent(project)}`);
    xhr.withCredentials = true;
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.setRequestHeader('X-File-Name', encodeURIComponent(chip.name));
    xhr.setRequestHeader('X-File-Type', chip.type);
    xhr.setRequestHeader('X-Attachment-Batch', batch);
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) progress(Math.round((event.loaded / event.total) * 100));
    };
    xhr.onload = () => {
      let data: { error?: string } & Partial<UploadedAttachment> = {};
      try {
        data = JSON.parse(xhr.responseText) as typeof data;
      } catch {
        /* An HTTP error may have no JSON. */
      }
      if (xhr.status === 200 && data.path && data.name && data.size !== undefined && data.type)
        resolve(data as UploadedAttachment);
      else reject(new Error(serverText(data, t('attachment.error.upload', { status: xhr.status }))));
    };
    xhr.onerror = () => reject(new Error(t('attachment.error.disconnected')));
    try {
      xhr.send(chip.file);
    } catch (error) {
      reject(error);
    }
  }).finally(() => {
    inFlightUploads--;
  });
}

/** The one upload loop of a direct-message send and a room post: uploads every chip that is not
 *  ready, one after the other, reporting each change through `onChange`. The first failure marks
 *  that chip failed and stops (ok false). `upload` picks the batch (a DM shares one per message,
 *  a room takes one per chip); `relative` (DM only) maps the saved path to the chip's relative path. */
export async function uploadChips(
  chips: AttachmentChip[],
  opts: {
    upload: (
      chip: AttachmentChip,
      progress: (value: number) => void,
    ) => Promise<UploadedAttachment>;
    onChange: (chips: AttachmentChip[]) => void;
    relative?: (savedPath: string) => string;
  },
): Promise<{ chips: AttachmentChip[]; ok: boolean }> {
  let uploaded = chips;
  for (const chip of chips) {
    if (chip.state === 'ready') continue;
    uploaded = updateChip(uploaded, chip.id, { state: 'uploading', progress: 0 });
    opts.onChange(uploaded);
    try {
      const saved = await opts.upload(chip, (progress) => {
        uploaded = updateChip(uploaded, chip.id, { progress });
        opts.onChange(uploaded);
      });
      uploaded = updateChip(uploaded, chip.id, {
        state: 'ready',
        progress: 100,
        path: saved.path,
        ...(opts.relative && { relative: opts.relative(saved.path) }),
        name: saved.name,
        type: saved.type,
        size: saved.size,
      });
      opts.onChange(uploaded);
    } catch (error) {
      uploaded = updateChip(uploaded, chip.id, {
        state: 'failed',
        error: (error as Error).message,
      });
      opts.onChange(uploaded);
      return { chips: uploaded, ok: false };
    }
  }
  return { chips: uploaded, ok: true };
}
