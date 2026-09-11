import type { ReleaseHttpAdapter } from '../release-adapter';
import { httpAdapter as baseHttpAdapter } from './base';

/**
 * B16 範例 release 的 HTTP 組裝：完全沿用 base——模組頁面由 storefront controller 從模組宣告生成，
 * 上傳入口是 base 已掛上的通用端點（ADR 0050）——只換 release id。
 */
export const httpAdapter: ReleaseHttpAdapter = { ...baseHttpAdapter, releaseId: 'file-requests' };
