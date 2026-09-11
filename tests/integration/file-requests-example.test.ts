import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { csrfTokenFor } from '@storeweave/identity';
import type { Actor } from '@storeweave/contracts';
import { moduleResourceNamespace, Worker, type Runtime } from '@storeweave/kernel';
import { analyzeText, createFileRequestsModule, type FileAnalyzer, type FileRequestDto } from '@storeweave/example-file-requests';
import { bootstrapRelease } from '../../packages/platform/bundle/src/bootstrap-release';
import { release } from '../../packages/platform/bundle/src/releases/file-requests';
import type { ReleaseDefinition } from '../../packages/platform/bundle/src/release';
import type { BaseConfig } from '@storeweave/config';
import { createReleaseServer } from '../../apps/api/src/release-server';
import { httpAdapter } from '../../apps/api/src/releases/file-requests';
import { SESSION_COOKIE } from '../../apps/api/src/http/cookie-names';
import { ADMIN_ACTOR, createTestDatabase } from './helpers';

process.env.SW_SIGNING_KEY_TEST = Buffer.alloc(32, 3).toString('base64url');
const shortTiming = { staleLockSeconds: 4, heartbeatIntervalMs: 1_200, databaseTimeoutMs: 1_000, abortGraceMs: 1_000 };
const UPLOAD = '/api/v1/modules/file-requests/uploads/request-file';
const BOUNDARY = 'b16-file-request';
const FORM = { 'content-type': 'application/x-www-form-urlencoded' };

const runtimes: Runtime[] = [];
const apps: NestFastifyApplication[] = [];
const directories: string[] = [];
afterEach(async () => {
  await Promise.allSettled(apps.splice(0).map(app => app.close()));
  await Promise.allSettled(runtimes.splice(0).map(runtime => runtime.close()));
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

async function configPath(databaseUrl?: string): Promise<string> {
  const directory = mkdtempSync(join(tmpdir(), 'storeweave-file-requests-'));
  directories.push(directory);
  const path = join(directory, 'config.json');
  writeFileSync(path, JSON.stringify({
    version: 1, store: { id: 'file-requests-test', name: 'File Requests', supportEmail: 'reviewer@example.test' },
    database: { url: databaseUrl ?? await createTestDatabase() }, logging: { level: 'error' }, extensions: [],
    storage: { localRoot: join(directory, 'storage'), maxUploadBytes: 1024 * 1024 },
    security: { signingKeys: [{ id: 'test', secretRef: 'SW_SIGNING_KEY_TEST' }] },
  }));
  return path;
}

async function boot(definition: ReleaseDefinition<BaseConfig>, path: string) {
  const result = await bootstrapRelease(definition, { configPath: path, loggerName: 'file-requests-test' });
  runtimes.push(result.runtime);
  await result.runtime.migrate();
  return result;
}

function multipart(body: string, contentType = 'text/plain'): Buffer {
  return Buffer.from(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="report.csv"\r\nContent-Type: ${contentType}\r\n\r\n${body}\r\n--${BOUNDARY}--\r\n`);
}

function form(values: Record<string, string>): string {
  return new URLSearchParams(values).toString();
}

async function drain(runtime: Runtime, workerId: string): Promise<void> {
  const worker = new Worker(runtime, { workerId, ...shortTiming });
  try { await worker.drain(); } finally { await worker.stop(); }
}

async function notificationCount(runtime: Runtime, templateId: string): Promise<number> {
  const result = await runtime.database.pool.query<{ count: string }>(
    'SELECT count(*)::text AS count FROM platform_notifications WHERE template_id = $1', [templateId],
  );
  return Number(result.rows[0]!.count);
}

/** 直接以模組的 storage scope 與收件 Command 送出一筆申請，等同上傳入口做的兩步。 */
async function submitDirectly(runtime: Runtime, actor: Actor, title: string, body = 'a,b\nc,d\n') {
  const object = await runtime.storage.forNamespace(moduleResourceNamespace('file-requests')).upload({
    stream: Readable.from(Buffer.from(body)), originalName: `${title}.csv`, contentType: 'text/csv', visibility: 'private', ownerActorId: actor.id,
  });
  return runtime.commands.execute<FileRequestDto>('filerequests.request.submit', { storageObjectId: object.id, title }, { actor });
}

const memberActor = (id: string): Actor => ({ id, type: 'user', displayName: id, permissions: ['file-requests:submit'] });

describe('B16 file-requests example release', () => {
  it('runs authorized upload → background processing → status → review → mail and in-app notifications over HTTP', async () => {
    const booted = await boot(release, await configPath());
    const { runtime } = booted;
    await expect(runtime.migrate()).resolves.toEqual([]);
    const tables = await runtime.database.pool.query<{ tablename: string }>("SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename LIKE 'file_requests%'");
    expect(tables.rows).toEqual([{ tablename: 'file_requests_records' }]);
    const app = await createReleaseServer({ runtime, theme: booted.theme, httpAdapter, release: { version: release.version, configPath: booted.loaded.sourcePath } });
    apps.push(app);

    const register = async (email: string) => {
      const response = await app.inject({ method: 'POST', url: '/register', headers: FORM,
        payload: form({ email, password: 'member-password-1', displayName: email.split('@')[0]!, next: '/' }) });
      expect(response.statusCode).toBe(303);
      return response.cookies.find(cookie => cookie.name === SESSION_COOKIE)!.value;
    };
    const member = await register('member@example.test');
    const stranger = await register('stranger@example.test');

    // 1. 授權上傳：未登入、缺 CSRF、沒有權限的角色都在寫入任何位元組之前被擋下。
    const index = await app.inject({ url: '/file-requests', cookies: { [SESSION_COOKIE]: member } });
    expect(index.statusCode).toBe(200);
    expect(index.body).toContain('id="file-request-form"');
    expect(index.body).toContain(csrfTokenFor(member));
    expect((await app.inject({ url: '/file-requests' })).statusCode).toBe(303);
    const upload = (cookie: string | undefined, title: string, headers: Record<string, string> = {}) => app.inject({
      method: 'POST', url: `${UPLOAD}?title=${encodeURIComponent(title)}`, payload: multipart('a,b\nc,d\n'),
      cookies: cookie ? { [SESSION_COOKIE]: cookie } : {},
      headers: { 'content-type': `multipart/form-data; boundary=${BOUNDARY}`, ...headers },
    });
    expect((await upload(undefined, 'anonymous')).statusCode).toBe(401);
    expect((await upload(member, 'no csrf')).statusCode).toBe(403);
    const readonlyToken = (await runtime.database.transaction(tx => runtime.apiTokens.issue(tx, { name: 'readonly', role: 'readonly', ttlMs: 60_000 }))).secret;
    expect((await upload(undefined, 'readonly', { authorization: `Bearer ${readonlyToken}` })).statusCode).toBe(403);
    expect((await runtime.database.pool.query('SELECT count(*)::int AS count FROM platform_storage_objects WHERE namespace = $1',
      [moduleResourceNamespace('file-requests')])).rows[0]).toEqual({ count: 0 });

    // 標題會進審核信主旨：換行在入口就被拒絕，不留到寄信時才失敗。
    expect((await upload(member, 'line\nbreak', { 'x-csrf-token': csrfTokenFor(member) })).statusCode).toBe(400);
    const submitted = await upload(member, '<季報>', { 'x-csrf-token': csrfTokenFor(member) });
    expect(submitted.statusCode).toBe(201);
    const request = submitted.json().data as FileRequestDto;
    expect(request).toMatchObject({ title: '<季報>', status: 'queued', contentType: 'text/plain', byteSize: 8 });

    // 2. 排 job → 背景處理 → 狀態查詢。
    await drain(runtime, 'file-requests-worker');
    const detail = await app.inject({ url: `/file-requests/${request.id}`, cookies: { [SESSION_COOKIE]: member } });
    expect(detail.statusCode).toBe(200);
    expect(detail.body).toContain('等待審核');
    expect(detail.body).toContain('&lt;季報&gt;');
    expect(detail.body).not.toContain('<季報>');
    expect((await app.inject({ url: `/file-requests/${request.id}`, cookies: { [SESSION_COOKIE]: stranger } })).statusCode).toBe(404);

    // 3. 站內通知給申請人、審核信給 release 設定的收件人。
    const inbox = async () => (await app.inject({ url: '/api/v1/notifications', cookies: { [SESSION_COOKIE]: member } })).json().data as { items: { title: string }[] };
    expect((await inbox()).items.map(item => item.title)).toContain('檔案已處理完成');
    const mail = await runtime.database.pool.query<{ recipient_email: string }>(
      "SELECT recipient_email FROM platform_notifications WHERE template_id = 'filerequests.review-needed'",
    );
    expect(mail.rows).toEqual([{ recipient_email: 'reviewer@example.test' }]);

    // 4. 後台審核：會員被拒絕，staff 可審核，重複審核回 400 並重畫審核頁。
    expect((await app.inject({ url: '/file-requests/review', cookies: { [SESSION_COOKIE]: member } })).statusCode).toBe(403);
    const memberDecision = await app.inject({ method: 'POST', url: `/file-requests/review/${request.id}/decision`, headers: FORM,
      cookies: { [SESSION_COOKIE]: member }, payload: form({ decision: 'approved', _csrf: csrfTokenFor(member) }) });
    expect(memberDecision.statusCode).toBe(403);

    await runtime.commands.execute('platform.identity.createUser', {
      email: 'staff@example.test', password: 'staff-password-123', displayName: 'Staff', role: 'staff',
    }, { actor: ADMIN_ACTOR, idempotencyKey: randomUUID() });
    const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: 'staff@example.test', password: 'staff-password-123' } });
    expect(login.statusCode).toBe(200);
    const staff = login.cookies.find(cookie => cookie.name === SESSION_COOKIE)!.value;
    // 保留期內累積的結案資料比列表上限還多時，待審核的申請仍然要看得到。
    await runtime.database.pool.query(`
      INSERT INTO file_requests_records (id, owner_actor_id, title, storage_object_id, filename, content_type, byte_size, status, submitted_at, updated_at)
      SELECT gen_random_uuid(), 'user:archived', 'archived ' || n, gen_random_uuid(), 'old.csv', 'text/csv', 1, 'approved',
        now() - interval '10 days', now() - interval '10 days'
      FROM generate_series(1, 60) AS n`);
    const review = await app.inject({ url: '/file-requests/review', cookies: { [SESSION_COOKIE]: staff } });
    expect(review.statusCode).toBe(200);
    expect(review.body).toContain(`/file-requests/review/${request.id}/decision`);

    const decide = () => app.inject({ method: 'POST', url: `/file-requests/review/${request.id}/decision`, headers: FORM,
      cookies: { [SESSION_COOKIE]: staff }, payload: form({ decision: 'approved', note: 'OK', _csrf: csrfTokenFor(staff) }) });
    const withoutCsrf = await app.inject({ method: 'POST', url: `/file-requests/review/${request.id}/decision`, headers: FORM,
      cookies: { [SESSION_COOKIE]: staff }, payload: form({ decision: 'approved' }) });
    expect(withoutCsrf.statusCode).toBe(403);
    const decided = await decide();
    expect(decided.statusCode).toBe(303);
    expect(decided.headers.location).toBe('/file-requests/review');
    const again = await decide();
    expect(again.statusCode).toBe(400);
    expect(again.body).toContain('這筆申請目前不能審核');

    expect((await inbox()).items.map(item => item.title)).toContain('檔案處理申請已審核');
    // 快取的計數在寫入後失效，看得到剛核准的那一筆。
    await expect(runtime.queries.execute('filerequests.request.summary', {}, { actor: runtime.actorForRole('staff') }))
      .resolves.toMatchObject({ approved: 61, ready_for_review: 0 });
  });

  it('retries a transient processing failure after a worker restart and notifies exactly once', async () => {
    let transientFailures = 1;
    const flaky: FileAnalyzer = async (content, signal) => {
      if (transientFailures > 0) {
        transientFailures -= 1;
        content.destroy();
        throw new Error('storage hiccup');
      }
      return analyzeText(content, signal);
    };
    const flakyRelease: ReleaseDefinition<BaseConfig> = {
      ...release,
      createModules: context => release.createModules(context).map(module => module.name === 'file-requests'
        ? createFileRequestsModule({ reviewUrl: 'http://localhost:3000/file-requests/review', analyze: flaky })
        : module),
    };
    const path = await configPath();
    const first = await boot(flakyRelease, path);
    const request = await submitDirectly(first.runtime, memberActor('user:retry-member'), 'retry me');

    await drain(first.runtime, 'file-requests-worker-a');
    const afterFailure = await first.runtime.database.pool.query<{ status: string; attempts: number }>(
      "SELECT status, attempts FROM platform_jobs WHERE type = 'filerequests.process'",
    );
    expect(afterFailure.rows).toEqual([{ status: 'pending', attempts: 1 }]);
    await expect(first.runtime.queries.execute('filerequests.request.get', { id: request.id }, { actor: first.runtime.actorForRole('staff') }))
      .resolves.toMatchObject({ status: 'queued' });
    await first.runtime.close();
    runtimes.splice(runtimes.indexOf(first.runtime), 1);

    // 重啟：新的 runtime 與 worker 接手同一個資料庫；把重試的等待時間跳過。
    const second = await boot(flakyRelease, path);
    await second.runtime.database.pool.query("UPDATE platform_jobs SET run_at = now() - interval '1 second' WHERE type = 'filerequests.process'");
    await drain(second.runtime, 'file-requests-worker-b');

    const staff = second.runtime.actorForRole('staff');
    await expect(second.runtime.queries.execute('filerequests.request.get', { id: request.id }, { actor: staff }))
      .resolves.toMatchObject({ status: 'ready_for_review', lineCount: 2, generation: 1 });
    expect(await notificationCount(second.runtime, 'filerequests.analysis-ready')).toBe(1);

    // 同一次處理結果重送：狀態轉換條件不成立，不會再通知。
    await second.runtime.commands.execute('filerequests.request.recordAnalysis', {
      id: request.id, generation: 1, byteSize: 8, sha256: 'a'.repeat(64), lineCount: 2,
    }, { actor: staff });
    expect(await notificationCount(second.runtime, 'filerequests.analysis-ready')).toBe(1);
  });

  it('marks a request failed once its processing job has used every attempt, instead of leaving it queued', async () => {
    const brokenRelease: ReleaseDefinition<BaseConfig> = {
      ...release,
      createModules: context => release.createModules(context).map(module => module.name === 'file-requests'
        ? createFileRequestsModule({ reviewUrl: 'http://localhost:3000/file-requests/review', analyze: async content => {
          content.destroy();
          throw new Error('storage unavailable');
        } })
        : module),
    };
    const { runtime } = await boot(brokenRelease, await configPath());
    const request = await submitDirectly(runtime, memberActor('user:broken-member'), 'broken');
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      await runtime.database.pool.query("UPDATE platform_jobs SET run_at = now() - interval '1 second' WHERE type = 'filerequests.process' AND status = 'pending'");
      await drain(runtime, `file-requests-broken-${attempt}`);
    }
    const job = await runtime.database.pool.query<{ status: string; attempts: number }>("SELECT status, attempts FROM platform_jobs WHERE type = 'filerequests.process'");
    expect(job.rows).toEqual([{ status: 'completed', attempts: 5 }]);
    await expect(runtime.queries.execute('filerequests.request.get', { id: request.id }, { actor: runtime.actorForRole('staff') }))
      .resolves.toMatchObject({ status: 'failed', failureReason: expect.stringContaining('處理 5 次仍失敗') });
  });

  it('records unprocessable content as failed and lets an operator re-queue it', async () => {
    const { runtime } = await boot(release, await configPath());
    const request = await submitDirectly(runtime, memberActor('user:empty-member'), 'empty', '');
    await drain(runtime, 'file-requests-worker-empty');
    const staff = runtime.actorForRole('staff');
    await expect(runtime.queries.execute('filerequests.request.get', { id: request.id }, { actor: staff }))
      .resolves.toMatchObject({ status: 'failed', failureReason: '檔案是空的' });
    expect(await notificationCount(runtime, 'filerequests.processing-failed')).toBe(1);
    await expect(runtime.commands.execute('filerequests.request.retry', { id: request.id }, { actor: memberActor('user:empty-member') }))
      .rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(runtime.commands.execute('filerequests.request.retry', { id: request.id }, { actor: staff }))
      .resolves.toMatchObject({ status: 'queued', generation: 2 });

    // 自助註冊的會員都拿得到上傳入口，所以未結案的申請有配額。
    const busy = memberActor('user:busy-member');
    for (let index = 0; index < 10; index += 1) await submitDirectly(runtime, busy, `busy ${index}`);
    await expect(submitDirectly(runtime, busy, 'one too many')).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('cleans up only expired finished requests and their objects, leaving other modules untouched', async () => {
    const { runtime } = await boot(release, await configPath());
    const staff = runtime.actorForRole('staff');
    const owner = memberActor('user:cleanup-member');
    const finished = await submitDirectly(runtime, owner, 'finished');
    const active = await submitDirectly(runtime, owner, 'active');
    await runtime.database.pool.query(
      "UPDATE file_requests_records SET status = 'approved', updated_at = now() - interval '40 days' WHERE id = $1", [finished.id],
    );
    const failedOld = await submitDirectly(runtime, owner, 'failed long ago');
    await runtime.database.pool.query(
      "UPDATE file_requests_records SET status = 'failed', updated_at = now() - interval '40 days' WHERE id = $1", [failedOld.id],
    );
    const unrelated = await runtime.storage.forNamespace('platform-storage').upload({
      stream: Readable.from(Buffer.from('keep me')), originalName: 'keep.txt', contentType: 'text/plain', visibility: 'private',
    });

    // 清理先把列標成 purging：物件刪到一半時，審核者按「重新處理」不會把它救回一筆沒有檔案的申請。
    const claimed = await runtime.commands.execute<{ items: { id: string }[] }>('filerequests.request.claimExpired',
      { olderThan: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(), limit: 10 }, { actor: staff });
    expect(claimed.items.map(item => item.id).sort()).toEqual([finished.id, failedOld.id].sort());
    await expect(runtime.commands.execute('filerequests.request.retry', { id: failedOld.id }, { actor: staff }))
      .rejects.toMatchObject({ code: 'CONFLICT' });

    await runtime.database.transaction(tx => runtime.jobs.enqueue(tx, {
      type: 'filerequests.cleanup', payload: { scheduledFor: new Date().toISOString() }, runAt: new Date(Date.now() - 1_000),
    }));
    await drain(runtime, 'file-requests-cleanup');

    const scope = runtime.storage.forNamespace(moduleResourceNamespace('file-requests'));
    await expect(runtime.queries.execute('filerequests.request.get', { id: finished.id }, { actor: staff })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(scope.get(finished.storageObjectId)).resolves.toBeUndefined();
    await expect(runtime.queries.execute('filerequests.request.get', { id: failedOld.id }, { actor: staff })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(scope.get(failedOld.storageObjectId)).resolves.toBeUndefined();
    await expect(runtime.queries.execute('filerequests.request.get', { id: active.id }, { actor: staff })).resolves.toMatchObject({ id: active.id });
    await expect(scope.get(active.storageObjectId)).resolves.toMatchObject({ id: active.storageObjectId });
    await expect(runtime.storage.forNamespace('platform-storage').get(unrelated.id)).resolves.toMatchObject({ id: unrelated.id });
  });
});
