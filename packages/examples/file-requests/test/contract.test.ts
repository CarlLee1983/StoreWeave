import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { runModuleContractChecks } from '@storeweave/bundle';
import type { ThemeContext } from '@storeweave/kernel';
import { renderBaseLayout } from '@storeweave/theme-base';
import { release } from '../../../platform/bundle/src/releases/file-requests';
import { analyzeText, createFileRequestRenderers, UnprocessableFileError, type FileRequestDto } from '../src';

describe('file-requests 模組契約', () => {
  it('在它的 release 裡通過 Module Contract Test', () => {
    expect(runModuleContractChecks(release, 'file-requests').filter(check => !check.ok)).toEqual([]);
  });
});

describe('預設處理步驟', () => {
  const signal = new AbortController().signal;

  it('計算位元組、SHA-256 與行數，最後一行沒有換行也算一行', async () => {
    await expect(analyzeText(Readable.from([Buffer.from('a,b\n'), Buffer.from('c,d')]), signal)).resolves.toEqual({
      byteSize: 7, lineCount: 2, sha256: createHash('sha256').update('a,b\nc,d').digest('hex'),
    });
    await expect(analyzeText(Readable.from([Buffer.from('one\ntwo\n')]), signal)).resolves.toMatchObject({ byteSize: 8, lineCount: 2 });
  });

  it('空檔案是不可處理的內容，不是暫時性故障', async () => {
    await expect(analyzeText(Readable.from([]), signal)).rejects.toBeInstanceOf(UnprocessableFileError);
  });
});

describe('file-requests renderer', () => {
  const ctx = { storeName: 'Store', storeId: 'store', locale: 'zh-TW', timeZone: 'Asia/Taipei', publicUrl: 'http://localhost:3000', options: {}, csrfToken: 'token"><x' } as ThemeContext;
  // 用真的 base 外框：標題的跳脫由外框負責，換成不跳脫的替身就驗不到實際輸出。
  const renderers = createFileRequestRenderers(renderBaseLayout);
  const hostile: FileRequestDto = {
    id: '6f1c2a7e-2b1d-4d5e-9f00-8a1b2c3d4e5f', title: '<script>alert(1)</script>', ownerActorId: 'user:1', ownerName: null,
    storageObjectId: '7f1c2a7e-2b1d-4d5e-9f00-8a1b2c3d4e5f', filename: '"><img src=x>', contentType: 'text/plain', byteSize: 3,
    status: 'ready_for_review', generation: 1, sha256: null, lineCount: 1, failureReason: null, reviewNote: '<b>note</b>', reviewedBy: null,
    submittedAt: new Date('2026-09-11T00:00:00Z'), analyzedAt: null, decidedAt: null, updatedAt: new Date('2026-09-11T00:00:00Z'),
  };

  it('跳脫使用者輸入與 CSRF token', () => {
    const summary = { queued: 0, ready_for_review: 1, approved: 0, rejected: 0, failed: 0, purging: 0 };
    const pages = [
      renderers['filerequests.request.index'](ctx, { requests: [hostile], canReview: true, uploadPath: '/upload', acceptedTypes: ['text/plain'] }),
      renderers['filerequests.request.view'](ctx, { request: hostile, canReview: false }),
      renderers['filerequests.review.index'](ctx, { summary, requests: [hostile], error: '<i>bad</i>' }),
    ].join('\n');
    expect(pages).not.toContain('<script>alert(1)</script>');
    expect(pages).not.toContain('"><img');
    expect(pages).not.toContain('<b>note</b>');
    expect(pages).not.toContain('<i>bad</i>');
    expect(pages).not.toContain('token"><x');
    expect(pages).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });
});
