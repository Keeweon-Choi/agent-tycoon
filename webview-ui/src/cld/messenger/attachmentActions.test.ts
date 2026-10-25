import { describe, expect, it, vi } from 'vitest';

import {
  ATTACHMENT_ACTION_ERROR_DURATION,
  ATTACHMENT_ACTION_SUCCESS_DURATION,
  attachmentActionToast,
  fileActions,
  imageActions,
  prepareClipboardPng,
  shouldConvertImageToPng,
} from './attachmentActions.js';

describe('image attachment actions', () => {
  it('keeps download, copy, and a new tab available while gating sharing by browser support', () => {
    expect(imageActions({ canShare: false, canCopy: false })).toEqual(['download', 'copy', 'open']);
    expect(imageActions({ canShare: true, canCopy: false })).toEqual([
      'download',
      'share',
      'copy',
      'open',
    ]);
    expect(imageActions({ canShare: false, canCopy: true })).toEqual(['download', 'copy', 'open']);
    expect(imageActions({ canShare: true, canCopy: true })).toEqual([
      'download',
      'share',
      'copy',
      'open',
    ]);
  });

  it('leaves PNG alone and converts each other image MIME type for clipboard writing', () => {
    expect(shouldConvertImageToPng('image/png')).toBe(false);
    expect(shouldConvertImageToPng('IMAGE/PNG')).toBe(false);
    expect(shouldConvertImageToPng('image/jpeg')).toBe(true);
    expect(shouldConvertImageToPng('image/webp')).toBe(true);
  });

  it('retypes downloaded PNGs and sends JPEGs through the canvas conversion path', async () => {
    const downloaded = new Blob(['png'], { type: 'application/octet-stream' });
    const canvasPng = vi.fn(async (source: Blob) => new Blob([source], { type: 'image/png' }));

    await expect(prepareClipboardPng(downloaded, 'image/png', canvasPng)).resolves.toMatchObject({
      type: 'image/png',
    });
    expect(canvasPng).not.toHaveBeenCalled();

    await prepareClipboardPng(downloaded, 'image/jpeg', canvasPng);
    expect(canvasPng).toHaveBeenCalledWith(downloaded);
  });

  it('maps successful outcomes to two-second toast messages and failures to error toasts', () => {
    expect(attachmentActionToast('download', { kind: 'downloaded' }, { canCopy: true })).toEqual({
      key: 'attachment.viewer.downloaded',
      tone: 'ok',
      duration: ATTACHMENT_ACTION_SUCCESS_DURATION,
    });
    expect(attachmentActionToast('share', { kind: 'saved' }, { canCopy: true })).toEqual({
      key: 'attachment.viewer.saved',
      tone: 'ok',
      duration: ATTACHMENT_ACTION_SUCCESS_DURATION,
    });
    expect(attachmentActionToast('copy', { kind: 'copied' }, { canCopy: true })).toEqual({
      key: 'attachment.viewer.copied',
      tone: 'ok',
      duration: ATTACHMENT_ACTION_SUCCESS_DURATION,
    });
    expect(attachmentActionToast('open', { kind: 'opened' }, { canCopy: true })).toEqual({
      key: 'attachment.viewer.opened',
      tone: 'ok',
      duration: ATTACHMENT_ACTION_SUCCESS_DURATION,
    });
    expect(attachmentActionToast('download', { kind: 'failed', reason: '403' }, { canCopy: true })).toEqual({
      key: 'attachment.viewer.actionProblem',
      tone: 'error',
      duration: ATTACHMENT_ACTION_ERROR_DURATION,
      values: { reason: '403' },
    });
  });

  it('explains unavailable image copy as an error toast', () => {
    expect(attachmentActionToast('copy', { kind: 'failed', reason: '' }, { canCopy: false })).toEqual({
      key: 'attachment.viewer.copyUnavailable',
      tone: 'error',
      duration: ATTACHMENT_ACTION_ERROR_DURATION,
    });
  });
});

describe('file attachment actions', () => {
  const supported = { canOfferActions: true, canShare: true, canCopy: true, opensInline: true };

  it('keeps the image action order unchanged', () => {
    expect(fileActions('image', supported)).toEqual(['download', 'share', 'copy', 'open']);
  });

  it('offers text copy, download, and browser-supported sharing', () => {
    expect(fileActions('text', supported)).toEqual(['copy', 'download', 'share']);
    expect(fileActions('text', { ...supported, canShare: false })).toEqual(['copy', 'download']);
  });

  it('uses the text policy for a rendered Markdown preview', () => {
    expect(fileActions('text', supported)).toEqual(['copy', 'download', 'share']);
  });

  it('offers other files download, eligible new-tab opening, and browser-supported sharing', () => {
    expect(fileActions('other', supported)).toEqual(['download', 'open', 'share']);
    expect(fileActions('other', { ...supported, opensInline: false, canShare: false })).toEqual([
      'download',
    ]);
  });

  it('keeps refused linked files actionless', () => {
    expect(fileActions('text', { ...supported, canOfferActions: false })).toEqual([]);
  });
});
