import packageJson from '../package.json';
import { defineModule, type ModuleResources } from '@storeweave/kernel';
import type { NotificationsPort } from '@storeweave/notifications';
import {
  claimExpiredFileRequestsCommand, createClaimExpiredFileRequestsHandler, createDecideFileRequestHandler, createPurgeFileRequestsHandler, createRecordAnalysisHandler, createRecordFailureHandler,
  createRetryFileRequestHandler, createSubmitFileRequestHandler, decideFileRequestCommand, purgeFileRequestsCommand,
  recordAnalysisCommand, recordFailureCommand, retryFileRequestCommand, submitFileRequestCommand, type FileRequestCommandDeps,
} from './commands';
import { fileRequestEvents } from './events';
import { analyzeText, CLEANUP_JOB, cleanupJobPayload, createCleanupJob, createProcessJob, PROCESS_JOB, processJobPayload, type FileAnalyzer } from './jobs';
import { fileRequestMigrations } from './migrations';
import { fileRequestPages } from './pages';
import {
  createFileRequestSummaryHandler, fileRequestSummaryQuery, getFileRequestHandler, getFileRequestQuery,
  listFileRequestsForReviewHandler,
  listFileRequestsForReviewQuery, listMyFileRequestsHandler, listMyFileRequestsQuery,
} from './queries';
import { ACCEPTED_CONTENT_TYPES, FILE_REQUEST_PERMISSIONS } from './types';

export const FILE_REQUESTS_MODULE = 'file-requests';

export interface FileRequestsModuleOptions {
  /** 審核頁的絕對網址，放進審核通知信。 */
  readonly reviewUrl: string;
  /** 審核通知信的收件人；沒有就只發站內通知。 */
  readonly reviewerEmail?: string;
  /** 走完流程的申請保留幾天後由排程清理。 */
  readonly retentionDays?: number;
  /** 每個人同時能有幾筆未結案的申請，預設 10。 */
  readonly maxOpenRequestsPerOwner?: number;
  /** 背景處理步驟；預設計算 SHA-256 與行數。 */
  readonly analyze?: FileAnalyzer;
}

/**
 * 檔案處理申請：B16 的非商務模組範例。它示範一個模組透過正式公開入口接入 base 的全部方式——
 * 自己的資料表與 migration、權限、Command／Query、事件、上傳入口、背景工作與排程、
 * Storage／Cache（`resources`）、通知（`bindPorts`），以及前台與審核頁面。
 */
export function createFileRequestsModule(options: FileRequestsModuleOptions) {
  let resources: ModuleResources | undefined;
  let notifications: NotificationsPort | undefined;
  const required = <T>(value: T | undefined, what: string): T => {
    if (value === undefined) throw new Error(`File requests module was composed without ${what}`);
    return value;
  };
  const storage = () => required(resources?.storage, 'the storage resource');
  const cache = () => required(resources?.cache, 'the cache resource');
  const deps: FileRequestCommandDeps = {
    storage, cache, notifications: () => required(notifications, 'the notification port'),
    reviewUrl: options.reviewUrl, reviewerEmail: options.reviewerEmail,
    maxOpenRequestsPerOwner: options.maxOpenRequestsPerOwner ?? 10,
  };

  return defineModule({
    name: FILE_REQUESTS_MODULE,
    version: packageJson.version,
    baseVersionRange: '^1.0.0',
    dependencies: { required: [
      { name: 'platform', versionRange: '^0.1.0' },
      { name: 'platform-storage', versionRange: '^0.1.0' },
      { name: 'platform-cache', versionRange: '^0.1.0' },
      { name: 'platform-notifications', versionRange: '^0.1.0' },
    ] },
    data: { owns: ['file_requests_records'] },
    migrations: fileRequestMigrations,
    events: fileRequestEvents,
    permissions: [
      { key: FILE_REQUEST_PERMISSIONS.submit, description: '送出與查看自己的檔案處理申請', owner: FILE_REQUESTS_MODULE },
      { key: FILE_REQUEST_PERMISSIONS.review, description: '查看全部申請並審核', owner: FILE_REQUESTS_MODULE },
      { key: FILE_REQUEST_PERMISSIONS.process, description: '重新處理失敗的申請與執行清理', owner: FILE_REQUESTS_MODULE },
    ],
    commands: [
      { descriptor: submitFileRequestCommand, handler: createSubmitFileRequestHandler(deps) },
      { descriptor: recordAnalysisCommand, handler: createRecordAnalysisHandler(deps) },
      { descriptor: recordFailureCommand, handler: createRecordFailureHandler(deps) },
      { descriptor: retryFileRequestCommand, handler: createRetryFileRequestHandler(deps) },
      { descriptor: decideFileRequestCommand, handler: createDecideFileRequestHandler(deps) },
      { descriptor: claimExpiredFileRequestsCommand, handler: createClaimExpiredFileRequestsHandler(deps) },
      { descriptor: purgeFileRequestsCommand, handler: createPurgeFileRequestsHandler(deps) },
    ],
    queries: [
      { descriptor: getFileRequestQuery, handler: getFileRequestHandler },
      { descriptor: listMyFileRequestsQuery, handler: listMyFileRequestsHandler },
      { descriptor: listFileRequestsForReviewQuery, handler: listFileRequestsForReviewHandler },
      { descriptor: fileRequestSummaryQuery, handler: createFileRequestSummaryHandler(cache) },
    ],
    jobs: [
      {
        type: PROCESS_JOB,
        handler: createProcessJob({ storage, analyze: options.analyze ?? analyzeText }),
        jobContractV1: {
          currentVersion: 1, versions: { 1: processJobPayload },
          execution: { timeoutMs: 60_000, concurrencyKey: 'file-requests-process', concurrencyLimit: 2 },
        },
      },
      {
        type: CLEANUP_JOB,
        handler: createCleanupJob({ storage, retentionDays: options.retentionDays ?? 30 }),
        jobContractV1: { currentVersion: 1, versions: { 1: cleanupJobPayload } },
        // 台北時間每天 03:30；上一次還沒跑完就跳過這一次。
        schedule: { cron: '30 3 * * *', timezone: 'Asia/Taipei', overlap: 'skip' },
      },
    ],
    uploads: [{
      name: 'request-file',
      contentTypes: [...ACCEPTED_CONTENT_TYPES], command: submitFileRequestCommand.name,
    }],
    pages: fileRequestPages,
    resources: ['cache', 'storage'],
    bindResources: bound => { resources = bound; },
    bindPorts: ports => { notifications = ports.notifications; },
  });
}
