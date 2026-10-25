import './attachmentViewer.css';

import {
  type CSSProperties,
  type ReactNode,
  type Ref,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';

import {
  ATTACH_VIEWER_Z_INDEX,
  ATTACH_WHEEL_SENSITIVITY,
  ATTACH_ZOOM_STEP,
} from '../../constants.js';
import { t } from '../../i18n/index.js';
import { writeClipboardImage } from '../../terminal/clipboard.js';
import { Markdown } from '../markdown.js';
import { cldToast } from '../officeStore.js';
import { closeOverlay } from '../overlayHistory.js';
import {
  ATTACHMENT_ACTION_ERROR_DURATION,
  ATTACHMENT_ACTION_SUCCESS_DURATION,
  type AttachmentActionOutcome,
  attachmentActionToast,
  type AttachmentKind,
  type FileAction,
  type FileActionCapabilities,
  fileActions,
  type ImageAction,
  type ImageActionCapabilities,
  prepareClipboardPng,
} from './attachmentActions.js';
import { Gallery, type TicketFor, type ViewerFile } from './attachmentGallery.js';
import { linkedFileType } from './attachments.js';
import {
  canInlineText,
  canOfferFileActions,
  clampPan,
  fitScale,
  fitView,
  isViewerTap,
  isZoomed,
  linkedFileProblem,
  opensInline,
  pinchView,
  type Point,
  readTextPreview,
  type Size,
  sizeLabel,
  stepIndex,
  swipeStep,
  tapZoomView,
  type View,
  wheelFactor,
  zoomAround,
  zoomLabel,
} from './attachmentView.js';

/**
 * One viewer for a whole conversation: its bubbles open it on their file, and
 * prev/next walks `files` (the conversation's loaded attachments, oldest first).
 */
export function AttachmentGallery({
  files,
  ticketFor,
  children,
}: {
  files: ViewerFile[];
  ticketFor: TicketFor;
  children: ReactNode;
}) {
  const [at, setAt] = useState<{ path: string; line?: number } | null>(null);
  const open = useCallback((path: string, line?: number) => setAt({ path, line }), []);
  const index = at === null ? -1 : files.findIndex((file) => file.path === at.path);
  const linked =
    at && index < 0
      ? {
          path: at.path,
          name: at.path.split('/').filter(Boolean).at(-1) ?? at.path,
          type: linkedFileType(at.path),
          sizeKb: 0,
          linked: true,
          line: at.line,
        }
      : null;
  const viewerFiles = index >= 0 ? files : linked ? [linked] : [];
  const viewerIndex = index >= 0 ? index : 0;
  const close = useCallback(() => setAt(null), []);
  return (
    <Gallery.Provider value={open}>
      {children}
      {at !== null && viewerFiles.length > 0 && (
        <AttachmentViewer
          files={viewerFiles}
          index={viewerIndex}
          onIndex={(i) => open(viewerFiles[i].path)}
          onClose={close}
          ticketFor={ticketFor}
        />
      )}
    </Gallery.Provider>
  );
}

const centred = (e: { clientX: number; clientY: number }, el: HTMLElement | null): Point => {
  const r = el?.getBoundingClientRect();
  return r
    ? { x: e.clientX - (r.left + r.width / 2), y: e.clientY - (r.top + r.height / 2) }
    : { x: 0, y: 0 };
};

/** The full-screen viewer. Only ✕, Esc and browser back close it; the app is never navigated. */
export function AttachmentViewer({
  files,
  index,
  onIndex,
  onClose,
  ticketFor,
}: {
  files: ViewerFile[];
  index: number;
  onIndex: (index: number) => void;
  onClose: () => void;
  ticketFor: TicketFor;
}) {
  const file = files[index];
  const isImage = file.type.startsWith('image/');
  const stage = useRef<HTMLDivElement>(null);
  const controls = useRef<HTMLDivElement>(null);
  const img = useRef<HTMLImageElement>(null);
  const [vp, setVp] = useState<Size>(() => ({ w: window.innerWidth, h: window.innerHeight }));
  const [controlsHeight, setControlsHeight] = useState(0);
  // Each result is tagged with its file, so a step to the next never shows the last one's.
  const [natOf, setNat] = useState<{ path: string; size: Size } | null>(null);
  const [urlOf, setUrl] = useState<{ path: string; url: string } | null>(null);
  const [problemOf, setProblem] = useState<{
    path: string;
    text: string;
    missing?: boolean;
  } | null>(null);
  const [checkedPath, setCheckedPath] = useState<string | null>(null);
  const [textOf, setText] = useState<{ path: string; content: string } | null>(null);
  const nat = natOf?.path === file.path ? natOf.size : null;
  const url = urlOf?.path === file.path ? urlOf.url : null;
  const problem = problemOf?.path === file.path ? problemOf : null;
  const text = textOf?.path === file.path ? textOf.content : null;
  const checking = file.linked === true && checkedPath !== file.path && !problem;
  // An image that failed to load shows its file card, so it gets the card's actions (no copy).
  const kind: AttachmentKind = isImage && !problem ? 'image' : text !== null ? 'text' : 'other';
  const canOfferActions = canOfferFileActions(
    file.linked === true,
    checking,
    // A 404 carries no reason text: it still refuses every action.
    problem?.missing ? 'missing' : (problem?.text ?? ''),
  );
  const [view, setView] = useState<View>({ scale: 1, x: 0, y: 0 });
  // A link to a line opens the source, where the line jump lands.
  const [markdownRendered, setMarkdownRendered] = useState(file.line === undefined);
  const textPreview = useRef<HTMLDivElement>(null);
  const fit = nat ? fitScale(nat, vp) : 1;
  const zoomed = isZoomed(view.scale, fit);
  const actions = useAttachmentActions(file, ticketFor);
  const actionButtons = fileActions(kind, fileActionCapabilities(file, canOfferActions));
  const contentBottom = controlsHeight
    ? Math.max(isImage ? 120 : 72, controlsHeight + 24)
    : 0;
  // What the native wheel listener and the gestures read without re-binding.
  const geom = useRef({ nat, vp, fit, view, zoomed });
  geom.current = { nat, vp, fit, view, zoomed };

  // Back closes it: an entry of our own while open, popped by ✕ or Esc.
  useEffect(() => {
    history.pushState({ cldAttach: true }, '');
    const onPop = () => onClose();
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [onClose]);

  const step = useCallback(
    (delta: number) => {
      const next = stepIndex(index, delta, files.length);
      if (next >= 0 && next !== index) onIndex(next);
    },
    [index, files.length, onIndex],
  );
  const zoomBy = useCallback((factor: number, at: Point = { x: 0, y: 0 }) => {
    const g = geom.current;
    if (!g.nat) return;
    setView((v) => zoomAround(v, v.scale * factor, at, g.nat!, g.vp, g.fit));
  }, [setView]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const keys: Record<string, () => void> = {
        Escape: () => closeOverlay('cldAttach', onClose),
        ArrowLeft: () => step(-1),
        ArrowRight: () => step(1),
        '+': () => zoomBy(ATTACH_ZOOM_STEP),
        '=': () => zoomBy(ATTACH_ZOOM_STEP),
        '-': () => zoomBy(1 / ATTACH_ZOOM_STEP),
        '0': () => setView(fitView(geom.current.fit)),
      };
      const act = keys[e.key];
      if (!act || e.ctrlKey || e.metaKey || e.altKey) return;
      // Typing in a box behind (the messenger's) keeps its arrows; Esc is ours either way.
      if (e.key !== 'Escape' && (e.target as HTMLElement)?.closest?.('input, textarea')) return;
      e.preventDefault();
      e.stopPropagation();
      act();
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
    };
  }, [step, zoomBy, onClose]);

  // The controls live outside the gesture stage. Measuring both makes the image fit the
  // remaining space, including a wrapped action row on a narrow phone.
  useEffect(() => {
    const updateViewport = () => {
      const box = stage.current?.getBoundingClientRect();
      setVp(
        box ? { w: box.width, h: box.height } : { w: window.innerWidth, h: window.innerHeight },
      );
    };
    const el = stage.current;
    updateViewport();
    if (!el || !window.ResizeObserver) {
      window.addEventListener('resize', updateViewport);
      return () => window.removeEventListener('resize', updateViewport);
    }
    const observer = new ResizeObserver(updateViewport);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const el = controls.current;
    if (!el) {
      setControlsHeight(0);
      return;
    }
    const updateHeight = () => setControlsHeight(Math.ceil(el.getBoundingClientRect().height));
    updateHeight();
    if (!window.ResizeObserver) return;
    const observer = new ResizeObserver(updateHeight);
    observer.observe(el);
    return () => observer.disconnect();
  }, [actionButtons.length, isImage]);

  // The wheel needs a non-passive listener to stop the page behind from scrolling.
  useEffect(() => {
    const el = stage.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      // A trackpad pinch arrives as ctrl+wheel with tiny deltas.
      const boost = e.ctrlKey ? 8 : 1;
      zoomBy(wheelFactor(e.deltaY * boost, e.deltaMode, ATTACH_WHEEL_SENSITIVITY), centred(e, el));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [zoomBy]);

  // A new linked path is checked immediately. Its ticket route verifies that it exists before
  // the card exposes an action; text uses that same short-lived ticket for its preview.
  useEffect(() => {
    let live = true;
    setView({ scale: 1, x: 0, y: 0 });
    const knownBytes = file.sizeKb * 1024;
    if (canInlineText(file.name, knownBytes))
      ticketFor(file.path, 'download')
        .then(async (url) => {
          const response = await fetch(url, { credentials: 'same-origin' });
          if (!response.ok) throw new Error(String(response.status));
          return readTextPreview(response, file.name);
        })
        .then((content) => {
          if (!live) return;
          if (content !== null) setText({ path: file.path, content });
          if (file.linked) setCheckedPath(file.path);
        })
        .catch((error: unknown) => {
          if (!live) return;
          const next = linkedFileProblem(error);
          setProblem({ path: file.path, text: next.reason, missing: next.missing });
        });
    else if (isImage || file.linked)
      ticketFor(file.path, isImage ? 'preview' : 'download')
        .then((value) => {
          if (!live) return;
          if (isImage) setUrl({ path: file.path, url: value });
          if (file.linked) setCheckedPath(file.path);
        })
        .catch((error: unknown) => {
          if (!live) return;
          const next = linkedFileProblem(error);
          setProblem({ path: file.path, text: next.reason, missing: next.missing });
        });
    return () => {
      live = false;
    };
  }, [file.linked, file.name, file.path, file.sizeKb, isImage, ticketFor]);
  useEffect(() => setMarkdownRendered(file.line === undefined), [file.path, file.line]);
  // The image's size arrives after the fit is known: start fitted.
  useEffect(() => {
    if (nat) setView(fitView(fitScale(nat, geom.current.vp)));
  }, [nat]);
  // A resize that changes the fit must not strand the view below it.
  useEffect(() => {
    if (nat) setView((v) => clampPan({ ...v, scale: Math.max(v.scale, fit) }, nat, vp));
  }, [nat, fit, vp]);

  // ── Pointers: one finger pans (zoomed) or swipes, two pinch, a still tap is a tap ──
  const pointers = useRef(new Map<number, Point>());
  const gesture = useRef<
    | { kind: 'pan'; from: Point; start: View }
    | { kind: 'pinch'; mid: Point; dist: number; start: View }
    | null
  >(null);
  const press = useRef<{
    x: number;
    y: number;
    moved: boolean;
  } | null>(null);
  const beginPinch = () => {
    const [a, b] = [...pointers.current.values()];
    gesture.current = {
      kind: 'pinch',
      mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
      dist: Math.hypot(a.x - b.x, a.y - b.y),
      start: geom.current.view,
    };
  };
  const onDown = (e: React.PointerEvent) => {
    stage.current?.setPointerCapture(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size === 2) {
      beginPinch();
      if (press.current) press.current.moved = true;
      return;
    }
    if (pointers.current.size > 2) return;
    press.current = {
      x: e.clientX,
      y: e.clientY,
      moved: false,
    };
    gesture.current = {
      kind: 'pan',
      from: { x: e.clientX, y: e.clientY },
      start: geom.current.view,
    };
  };
  const onMove = (e: React.PointerEvent) => {
    if (!pointers.current.has(e.pointerId)) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const g = gesture.current;
    const { nat: size, vp: port, fit: f } = geom.current;
    if (!g || !size) return;
    if (g.kind === 'pinch') {
      const pts = [...pointers.current.values()];
      if (pts.length < 2) return;
      const r = stage.current!.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      const mid = { x: (pts[0].x + pts[1].x) / 2 - cx, y: (pts[0].y + pts[1].y) / 2 - cy };
      const startMid = { x: g.mid.x - cx, y: g.mid.y - cy };
      setView(
        pinchView(
          g.start,
          startMid,
          g.dist,
          mid,
          Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y),
          size,
          port,
          f,
        ),
      );
      return;
    }
    const dx = e.clientX - g.from.x;
    const dy = e.clientY - g.from.y;
    if (press.current && !isViewerTap(e.clientX - press.current.x, e.clientY - press.current.y))
      press.current.moved = true;
    if (geom.current.zoomed && press.current?.moved)
      setView(clampPan({ ...g.start, x: g.start.x + dx, y: g.start.y + dy }, size, port));
  };
  const onUp = (e: React.PointerEvent) => {
    if (!pointers.current.delete(e.pointerId)) return;
    if (pointers.current.size > 0) {
      // A pinch lost a finger: the other one carries on as a pan from here.
      const [rest] = [...pointers.current.values()];
      gesture.current = { kind: 'pan', from: rest, start: geom.current.view };
      if (press.current) press.current.moved = true;
      return;
    }
    const p = press.current;
    press.current = null;
    gesture.current = null;
    if (!p) return;
    const { zoomed: isIn, nat: size, fit: f, view: v } = geom.current;
    if (p.moved) {
      if (!isIn) {
        const s = swipeStep(e.clientX - p.x, e.clientY - p.y);
        if (s) step(s);
      }
      return;
    }
    if (size) setView(tapZoomView(v, centred(e, stage.current), size, f));
  };

  return createPortal(
    <div
      className="attach-viewer"
      style={
        {
          zIndex: ATTACH_VIEWER_Z_INDEX,
          '--attach-content-bottom': `${contentBottom}px`,
        } as CSSProperties
      }
      role="dialog"
      aria-modal="true"
      aria-label={t('attachment.viewer.title')}
      data-testid="attach-viewer"
    >
      <div
        ref={stage}
        className="attach-stage"
        data-testid="attach-stage"
        data-zoomed={zoomed}
        style={
          contentBottom ? { bottom: `calc(var(--cld-safe-bottom) + ${contentBottom}px)` } : undefined
        }
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
      >
        {isImage && url && !problem && (
          <img
            ref={img}
            src={url}
            alt={file.name}
            draggable={false}
            className="attach-img"
            data-testid="attach-img"
            data-scale={view.scale}
            style={
              nat
                ? {
                    width: nat.w,
                    height: nat.h,
                    marginLeft: -nat.w / 2,
                    marginTop: -nat.h / 2,
                    transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`,
                  }
                : { visibility: 'hidden' }
            }
            onLoad={(e) =>
              setNat({
                path: file.path,
                size: { w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight },
              })
            }
            onError={() =>
              setProblem({ path: file.path, text: t('attachment.viewer.unavailable') })
            }
          />
        )}
      </div>
      {isImage && !url && !problem && (
        <p className="attach-loading" role="status">
          {t('attachment.viewer.loading')}
        </p>
      )}
      {text !== null ? (
        isMarkdown(file.name) && markdownRendered ? (
          <MarkdownFile content={text} previewRef={textPreview} />
        ) : (
          <TextFile content={text} line={file.line} previewRef={textPreview} />
        )
      ) : (
        (!isImage || problem) && (
          <FileCard
            file={file}
            problem={problem?.text ?? ''}
            missing={problem?.missing === true}
            checking={checking}
          />
        )
      )}
      <div className="attach-bar attach-top">
        <span className="attach-title" title={file.path}>
          <span className="attach-title-name">{file.name}</span>
          <span className="attach-title-meta">
            {files.length > 1 && `${index + 1} / ${files.length} · `}
            {file.sizeKb ? sizeLabel(file.sizeKb) : t('usage.unknown')}
          </span>
        </span>
        <button
          type="button"
          className="attach-btn attach-close"
          aria-label={t('attachment.viewer.close')}
          data-testid="attach-close"
          onClick={() => closeOverlay('cldAttach', onClose)}
        >
          ✕
        </button>
      </div>
      {files.length > 1 && (
        <>
          <button
            type="button"
            className="attach-btn attach-side attach-prev"
            aria-label={t('attachment.viewer.previous')}
            data-testid="attach-prev"
            onClick={() => step(-1)}
          >
            ‹
          </button>
          <button
            type="button"
            className="attach-btn attach-side attach-next"
            aria-label={t('attachment.viewer.next')}
            data-testid="attach-next"
            onClick={() => step(1)}
          >
            ›
          </button>
        </>
      )}
      {(actionButtons.length > 0 || isImage) && (
        <div ref={controls} className="attach-actions-controls" data-testid="attach-actions-controls">
          {actionButtons.length > 0 && (
            <FileActions
              actions={actions}
              buttons={actionButtons}
              kind={kind}
              text={text}
              preview={textPreview}
              markdown={isMarkdown(file.name) && text !== null}
              markdownRendered={markdownRendered}
              onMarkdownView={setMarkdownRendered}
            />
          )}
          {isImage && !problem && (
            <div className="attach-bar attach-bottom">
              <button
                type="button"
                className="attach-btn"
                aria-label={t('attachment.viewer.zoomOut')}
                data-testid="attach-zoom-out"
                disabled={!nat}
                onClick={() => zoomBy(1 / ATTACH_ZOOM_STEP)}
              >
                −
              </button>
              <span className="attach-text" data-testid="attach-zoom" aria-live="polite">
                {zoomLabel(view.scale)}
              </span>
              <button
                type="button"
                className="attach-btn"
                aria-label={t('attachment.viewer.zoomIn')}
                data-testid="attach-zoom-in"
                disabled={!nat}
                onClick={() => zoomBy(ATTACH_ZOOM_STEP)}
              >
                +
              </button>
            </div>
          )}
        </div>
      )}
    </div>,
    document.body,
  );
}

export function TextFile({
  content,
  line,
  previewRef,
}: {
  content: string;
  line?: number;
  previewRef?: Ref<HTMLDivElement>;
}) {
  const preview = useRef<HTMLPreElement>(null);
  useEffect(() => {
    preview.current
      ?.querySelector<HTMLElement>('[data-current-line="true"]')
      ?.scrollIntoView({ block: 'center' });
  }, [content, line]);
  const lines = content.split('\n');
  return (
    <div ref={previewRef} className="attach-file">
      <pre ref={preview} className="attach-text-preview" data-testid="attach-text-preview">
        {lines.map((item, index) => (
          <span
            key={index}
            className="attach-text-line"
            data-current-line={index + 1 === line || undefined}
          >
            {item}
            {index < lines.length - 1 && '\n'}
          </span>
        ))}
      </pre>
    </div>
  );
}

function MarkdownFile({ content, previewRef }: { content: string; previewRef: Ref<HTMLDivElement> }) {
  return (
    <div className="attach-file">
      <div ref={previewRef} className="attach-markdown-preview" data-testid="attach-markdown-preview">
        <Markdown text={content} />
      </div>
    </div>
  );
}

const isMarkdown = (name: string) => name.toLowerCase().endsWith('.md');

interface AttachmentActions {
  download: () => Promise<void>;
  openTab: () => Promise<void>;
  share: () => Promise<void>;
  copyImage: () => Promise<void>;
  copyText: (content: string, preview: HTMLElement | null) => Promise<void>;
}

/** Ticketed actions are shared by file cards and the image toolbar. */
function useAttachmentActions(file: ViewerFile, ticketFor: TicketFor): AttachmentActions {
  const report = useCallback(
    (
      action: ImageAction,
      outcome: AttachmentActionOutcome,
      capabilities: ImageActionCapabilities = fileActionCapabilities(file, true),
    ) => {
      const next = attachmentActionToast(action, outcome, capabilities);
      cldToast(t('attachment.viewer.title'), t(next.key, next.values), next.tone, next.duration);
    },
    [file],
  );
  const fail = useCallback(
    (action: ImageAction, error: unknown) =>
      report(action, {
        kind: 'failed',
        reason: error instanceof Error && error.message ? error.message : String(error),
      }),
    [report],
  );
  const download = useCallback(async () => {
    try {
      const link = document.createElement('a');
      link.href = await ticketFor(file.path, 'download');
      link.download = file.name;
      document.body.append(link);
      link.click();
      link.remove();
      report('download', { kind: 'downloaded' });
    } catch (error) {
      fail('download', error);
    }
  }, [fail, file.name, file.path, report, ticketFor]);
  const openTab = useCallback(async () => {
    // Open within the tap, then point it at the ticket: a home-screen app can refuse it
    // without navigating this viewer away.
    const tab = window.open('about:blank', '_blank');
    if (!tab) {
      report('open', { kind: 'failed', reason: t('attachment.viewer.popupBlocked') });
      return;
    }
    tab.opener = null;
    try {
      tab.location.assign(await ticketFor(file.path, 'preview'));
      report('open', { kind: 'opened' });
    } catch (error) {
      tab.close();
      fail('open', error);
    }
  }, [fail, file.path, report, ticketFor]);
  const fileBlob = useCallback(async () => {
    const response = await fetch(await ticketFor(file.path, 'download'), {
      credentials: 'same-origin',
    });
    if (!response.ok) throw new Error(String(response.status));
    return response.blob();
  }, [file.path, ticketFor]);
  const share = useCallback(async () => {
    try {
      const blob = await fileBlob();
      await navigator.share({ files: [new File([blob], file.name, { type: file.type })] });
      report('share', { kind: 'saved' });
    } catch (error) {
      // Closing the operating-system sheet is expected, not a failed attachment action.
      if (error instanceof DOMException && error.name === 'AbortError') return;
      fail('share', error);
    }
  }, [fail, file.name, file.type, fileBlob, report]);
  const copyImage = useCallback(async () => {
    const capabilities = fileActionCapabilities(file, true);
    if (!capabilities.canCopy) {
      report('copy', { kind: 'failed', reason: '' }, capabilities);
      return;
    }
    // Do not await before this call: writeClipboardImage creates ClipboardItem right now,
    // while Safari still considers this button tap a user gesture.
    const blobPromise = fileBlob().then((blob) => pngClipboardBlob(blob, file.type));
    const write = writeClipboardImage(blobPromise);
    try {
      await write;
      report('copy', { kind: 'copied' });
    } catch (error) {
      fail('copy', error);
    }
  }, [fail, file, fileBlob, report]);
  const copyText = useCallback(
    async (content: string, preview: HTMLElement | null) => {
      if (window.isSecureContext !== true || !navigator.clipboard?.writeText) {
        const selection = window.getSelection();
        if (selection && preview) {
          const range = document.createRange();
          range.selectNodeContents(preview);
          selection.removeAllRanges();
          selection.addRange(range);
        }
        cldToast(
          t('attachment.viewer.title'),
          t('attachment.viewer.copyManual'),
          'error',
          ATTACHMENT_ACTION_ERROR_DURATION,
        );
        return;
      }
      try {
        await navigator.clipboard.writeText(content);
        cldToast(
          t('attachment.viewer.title'),
          t('attachment.viewer.copiedText'),
          'ok',
          ATTACHMENT_ACTION_SUCCESS_DURATION,
        );
      } catch (error) {
        fail('copy', error);
      }
    },
    [fail],
  );
  return { download, openTab, share, copyImage, copyText };
}

function fileActionCapabilities(
  file: Pick<ViewerFile, 'name' | 'type'>,
  canOfferActions: boolean,
): FileActionCapabilities {
  let canShare = false;
  try {
    canShare =
      navigator.canShare?.({ files: [new File([], file.name, { type: file.type })] }) === true;
  } catch {
    // An unknown image MIME type may make a browser refuse the capability probe.
  }
  return {
    canOfferActions,
    canShare,
    canCopy: window.isSecureContext === true && !!window.ClipboardItem && !!navigator.clipboard?.write,
    opensInline: opensInline(file.type),
  };
}

function FileActions({
  actions,
  buttons,
  kind,
  text,
  preview,
  markdown,
  markdownRendered,
  onMarkdownView,
}: {
  actions: AttachmentActions;
  buttons: FileAction[];
  kind: AttachmentKind;
  text: string | null;
  preview: React.RefObject<HTMLDivElement | null>;
  markdown: boolean;
  markdownRendered: boolean;
  onMarkdownView: (rendered: boolean) => void;
}) {
  const action = (actionKind: FileAction) => {
    if (actionKind === 'download') return actions.download;
    if (actionKind === 'share') return actions.share;
    if (actionKind === 'copy')
      return kind === 'text' && text !== null
        ? () => actions.copyText(text, preview.current)
        : actions.copyImage;
    return actions.openTab;
  };
  const label = (actionKind: FileAction) =>
    t(
      actionKind === 'download'
        ? 'attachment.viewer.download'
        : actionKind === 'share'
          ? 'attachment.viewer.saveShare'
          : actionKind === 'copy'
            ? kind === 'text'
              ? 'attachment.viewer.copyText'
              : 'attachment.viewer.copy'
            : 'attachment.viewer.openNew',
    );
  return (
    <div className="attach-actions" data-testid="attach-actions">
      {buttons.map((actionKind) => (
        <button
          key={actionKind}
          type="button"
          className="attach-btn"
          data-testid={`attach-${actionKind}`}
          onClick={() => void action(actionKind)()}
        >
          {label(actionKind)}
        </button>
      ))}
      {markdown && (
        <div className="attach-markdown-toggle" role="group" aria-label={t('attachment.viewer.viewMode')}>
          <button
            type="button"
            className="attach-btn"
            aria-pressed={markdownRendered}
            onClick={() => onMarkdownView(true)}
          >
            {t('attachment.viewer.rendered')}
          </button>
          <button
            type="button"
            className="attach-btn"
            aria-pressed={!markdownRendered}
            onClick={() => onMarkdownView(false)}
          >
            {t('attachment.viewer.raw')}
          </button>
        </div>
      )}
    </div>
  );
}

async function pngClipboardBlob(blob: Blob, type: string): Promise<Blob> {
  return prepareClipboardPng(blob, type, canvasPngBlob);
}

async function canvasPngBlob(blob: Blob): Promise<Blob> {
  const url = URL.createObjectURL(blob);
  try {
    const image = new Image();
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error('Image decode failed'));
      image.src = url;
    });
    // This canvas is never attached to the document, so conversion stays offscreen.
    const canvas = document.createElement('canvas');
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Canvas unavailable');
    context.drawImage(image, 0, 0);
    return await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(
        (png) => (png ? resolve(png) : reject(new Error('PNG conversion failed'))),
        'image/png',
      ),
    );
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** A file the viewer cannot draw: what it is, and the two ways to get at it that never replace the app. */
function FileCard({
  file,
  problem,
  missing,
  checking,
}: {
  file: ViewerFile;
  problem: string;
  missing: boolean;
  checking: boolean;
}) {
  const note2 = missing
    ? t('attachment.viewer.fileMissing')
    : problem
      ? file.linked
        ? t('attachment.viewer.fileProblem', { reason: problem })
        : problem
      : '';
  return (
    <div className="attach-file" data-testid="attach-file">
      <div className="attach-file-card">
        <span className="attach-file-name">▤ {file.name}</span>
        <span className="attach-file-meta">
          {file.type} · {file.sizeKb ? sizeLabel(file.sizeKb) : t('usage.unknown')}
        </span>
      </div>
      {checking && (
        <p className="attach-note" role="status" data-testid="attach-note">
          {t('attachment.viewer.loading')}
        </p>
      )}
      {note2 && (
        <p className="attach-note" role="status" data-testid="attach-note">
          {note2}
        </p>
      )}
    </div>
  );
}
