/**
 * The attachment viewer's maths, DOM-free. A view is where the image sits:
 * `scale` (1 = the image's own pixels) and a pan offset `x`,`y` of the image's
 * centre from the viewport's centre. Points are relative to the viewport centre.
 */
import {
  ATTACH_DOUBLE_TAP_MS,
  ATTACH_DOUBLE_TAP_PX,
  ATTACH_FIT_EPSILON,
  ATTACH_FIT_MARGIN_PX,
  ATTACH_SWIPE_PX,
  ATTACH_TAP_ZOOM_FACTOR,
  ATTACH_ZOOM_MAX,
} from '../../constants.js';
import { withinTapSlop } from '../../touch/touchPrimitives.js';

export interface Size {
  w: number;
  h: number;
}
export interface Point {
  x: number;
  y: number;
}
export interface View extends Point {
  scale: number;
}

/** The scale that shows the whole image inside the viewport; small images are not enlarged. */
export function fitScale(img: Size, vp: Size, margin = ATTACH_FIT_MARGIN_PX): number {
  if (img.w <= 0 || img.h <= 0) return 1;
  const room = { w: Math.max(1, vp.w - 2 * margin), h: Math.max(1, vp.h - 2 * margin) };
  return Math.min(1, room.w / img.w, room.h / img.h);
}

export const clampScale = (scale: number, fit: number, max = ATTACH_ZOOM_MAX): number =>
  Math.min(Math.max(scale, fit), Math.max(max, fit));

export const isZoomed = (scale: number, fit: number): boolean =>
  scale > fit * (1 + ATTACH_FIT_EPSILON);

/** Pan limits: an axis the scaled image does not fill stays centred; one it overfills may slide until its edge meets the viewport's. */
export function clampPan(view: View, img: Size, vp: Size): View {
  const limit = (image: number, port: number) => Math.max(0, (image * view.scale - port) / 2);
  const lx = limit(img.w, vp.w);
  const ly = limit(img.h, vp.h);
  return {
    scale: view.scale,
    x: Math.min(Math.max(view.x, -lx), lx) + 0, // + 0: never -0
    y: Math.min(Math.max(view.y, -ly), ly) + 0,
  };
}

export const fitView = (fit: number): View => ({ scale: fit, x: 0, y: 0 });

/** Zoom to `scale`, keeping the image point under `at` where it is. */
export function zoomAround(
  view: View,
  scale: number,
  at: Point,
  img: Size,
  vp: Size,
  fit: number,
): View {
  const next = clampScale(scale, fit);
  const k = next / view.scale;
  return clampPan(
    { scale: next, x: at.x - (at.x - view.x) * k, y: at.y - (at.y - view.y) * k },
    img,
    vp,
  );
}

/** The image point nearest to a stage point, including the empty fitted margins. */
export function nearestImagePoint(at: Point, view: View, img: Size): Point {
  const halfW = (img.w * view.scale) / 2;
  const halfH = (img.h * view.scale) / 2;
  return {
    x: Math.min(Math.max(at.x, view.x - halfW), view.x + halfW),
    y: Math.min(Math.max(at.y, view.y - halfH), view.y + halfH),
  };
}

/** A click or tap toggles between fit and twice fit, anchored on the nearest image point. */
export function tapZoomView(view: View, at: Point, img: Size, fit: number): View {
  if (isZoomed(view.scale, fit)) return fitView(fit);
  const scale = clampScale(fit * ATTACH_TAP_ZOOM_FACTOR, fit);
  const anchor = nearestImagePoint(at, view, img);
  const k = scale / view.scale;
  // Unlike a wheel or pinch, a deliberate click must keep this exact point in
  // place even when the enlarged image still does not fill one viewport axis.
  return {
    scale,
    x: anchor.x - (anchor.x - view.x) * k,
    y: anchor.y - (anchor.y - view.y) * k,
  };
}

/** A pointer release within the shared tap slop is a click, not a pan or swipe. */
export const isViewerTap = (dx: number, dy: number): boolean => withinTapSlop(dx, dy);

/** A pinch: the gesture began with `start` view, fingers `startDist` apart around `startMid`; now `dist` apart around `mid`. */
export function pinchView(
  start: View,
  startMid: Point,
  startDist: number,
  mid: Point,
  dist: number,
  img: Size,
  vp: Size,
  fit: number,
): View {
  if (startDist <= 0) return start;
  const next = clampScale(start.scale * (dist / startDist), fit);
  const k = next / start.scale;
  return clampPan(
    {
      scale: next,
      x: mid.x - (startMid.x - start.x) * k,
      y: mid.y - (startMid.y - start.y) * k,
    },
    img,
    vp,
  );
}

/** Double tap: fitted goes to 100% (or twice the fit when the image already shows at 100%), anything else back to fit. */
export function doubleTapScale(scale: number, fit: number): number {
  if (isZoomed(scale, fit)) return fit;
  return fit < 1 ? 1 : clampScale(fit * 2, fit);
}

/** The attachment `delta` steps from `index`, wrapping round; -1 when there is nothing to step through. */
export function stepIndex(index: number, delta: number, count: number): number {
  if (count <= 0) return -1;
  return (((index + delta) % count) + count) % count;
}

/** A finished drag, not zoomed in: -1 previous, 1 next, 0 neither (short, or more vertical than horizontal). */
export function swipeStep(dx: number, dy: number): -1 | 0 | 1 {
  if (Math.abs(dx) < ATTACH_SWIPE_PX || Math.abs(dx) < Math.abs(dy) * 1.5) return 0;
  return dx < 0 ? 1 : -1;
}

/** Is this tap the second of a double tap? */
export function isDoubleTap(
  prev: ({ at: number } & Point) | null,
  now: { at: number } & Point,
): boolean {
  return (
    !!prev &&
    now.at - prev.at <= ATTACH_DOUBLE_TAP_MS &&
    Math.hypot(now.x - prev.x, now.y - prev.y) <= ATTACH_DOUBLE_TAP_PX
  );
}

/** Wheel delta to a scale factor; line-mode wheels (deltaMode 1) count 16 px a line. */
export function wheelFactor(deltaY: number, deltaMode: number, sensitivity: number): number {
  return Math.exp(-(deltaMode === 1 ? deltaY * 16 : deltaY) * sensitivity);
}

export const zoomLabel = (scale: number): string => `${Math.round(scale * 100)}%`;

/** A human size from the `[첨부]` line's KB. */
export function sizeLabel(kb: number): string {
  return kb >= 1024 ? `${(kb / 1024).toFixed(1)} MB` : `${kb} KB`;
}

/** Can the server hand this out inline for a new tab? Its preview tickets cover images, PDF and HTML; text and the rest are download-only. */
export const opensInline = (type: string): boolean =>
  type === 'application/pdf' || type === 'text/html';

/** A linked file must first receive a ticket; no action can safely be offered after a refusal. */
export const canOfferFileActions = (linked: boolean, pending: boolean, problem: string): boolean =>
  !linked || (!pending && !problem);

export const MAX_TEXT_PREVIEW_BYTES = 200 * 1024;
const TEXT_PREVIEW_EXTENSIONS = new Set([
  'ts',
  'tsx',
  'js',
  'mjs',
  'json',
  'md',
  'txt',
  'log',
  'yaml',
  'yml',
  'css',
  'html',
  'sh',
  'py',
  'toml',
]);

/** Text files under the preview cap stay in the viewer; all other files use its file card. */
export function canInlineText(name: string, sizeBytes: number): boolean {
  const extension = name.split('.').at(-1)?.toLowerCase() ?? '';
  return sizeBytes <= MAX_TEXT_PREVIEW_BYTES && TEXT_PREVIEW_EXTENSIONS.has(extension);
}

/** Read only a bounded text response, including when its server omitted Content-Length. */
export async function readTextPreview(response: Response, name: string): Promise<string | null> {
  const length = response.headers.get('content-length');
  const declaredBytes = length === null ? Number.NaN : Number(length);
  if (Number.isFinite(declaredBytes) && !canInlineText(name, declaredBytes)) {
    await response.body?.cancel();
    return null;
  }

  const reader = response.body?.getReader();
  if (!reader) return response.text();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (!canInlineText(name, size)) {
      reader.releaseLock();
      await response.body?.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

/** Preserve the server's useful refusal reason, except for its explicit missing-file status. */
export function linkedFileProblem(error: unknown): { missing: boolean; reason: string } {
  const status =
    typeof error === 'object' && error !== null && 'status' in error
      ? (error as { status?: unknown }).status
      : undefined;
  if (status === 404) return { missing: true, reason: '' };
  return {
    missing: false,
    reason: error instanceof Error && error.message ? error.message : String(error),
  };
}
