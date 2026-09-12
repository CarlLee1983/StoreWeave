import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { defineEvent } from '@storeweave/contracts';
import type { Runtime } from '@storeweave/kernel';
import { bootstrapRelease } from '../../packages/platform/bundle/src/bootstrap-release';
import { release } from '../../packages/platform/bundle/src/releases/base';
import { createReleaseServer } from '../../apps/api/src/release-server';
import { httpAdapter } from '../../apps/api/src/releases/base';
import { createTestDatabase } from './helpers';

/**
 * 維運端點的 HTTP 層，帶真實資料。
 *
 * Bus 層的行為由 `scheduler.test.ts`／`outbox-delivery.test.ts` 覆蓋；這裡只證明
 * 「走 HTTP 才會遇到」的那些事：路由存在、path param 怎麼併進 descriptor input、
 * `Idempotency-Key` header、權限拒絕的狀態碼與錯誤封套、以及 DTO 真的序列化得出來。
 *
 * 用 base release 而不是 commerce：這五個入口都是平台維運端點，與領域無關，
 * 而 base release 起得快、也順便證明它們不依賴任何商務模組。
 */

const HOUR = 60 * 60 * 1000;
let readonly: { authorization: string };
let admin: { authorization: string };

let directory: string;
let runtime: Runtime;
let app: NestFastifyApplication;

beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), 'storeweave-ops-http-'));
  const configPath = join(directory, 'config.json');
  process.env.SW_SIGNING_KEY_TEST = Buffer.alloc(32, 3).toString('base64url');
  writeFileSync(configPath, JSON.stringify({ version: 1,
    store: { id: 'ops-http', name: 'Ops HTTP' },
    database: { url: await createTestDatabase() }, logging: { level: 'error' },
    security: { signingKeys: [{ id: 'test', secretRef: 'SW_SIGNING_KEY_TEST' }] },
  }));
  const boot = await bootstrapRelease(release, { configPath, loggerName: 'ops-http' });
  runtime = boot.runtime;
  await runtime.migrate();
  // readonly 有 jobs:read 沒有 jobs:write，admin 是 `*`——兩把 token 剛好切出
  // 「讀得到但寫不了」與「寫得了」兩條路徑。
  const issuedReadonly = await runtime.database.transaction(tx => runtime.apiTokens.issue(tx,
    { name: 'readonly', role: 'readonly', ttlMs: 60 * 60_000 }));
  const issuedAdmin = await runtime.database.transaction(tx => runtime.apiTokens.issue(tx,
    { name: 'admin', role: 'admin', ttlMs: 60 * 60_000 }));
  readonly = { authorization: `Bearer ${issuedReadonly.secret}` };
  admin = { authorization: `Bearer ${issuedAdmin.secret}` };
  app = await createReleaseServer({ runtime, httpAdapter, release: { version: release.version, configPath } });
}, 300_000);

afterAll(async () => {
  await app?.close();
  await runtime?.close();
  if (directory) rmSync(directory, { recursive: true });
});

const intervalPayload = z.object({ bucket: z.number().int(), scheduledFor: z.string().datetime() }).strict();

let seq = 0;
function registerSchedule(everyMs = HOUR): string {
  const type = `ops.http.schedule.${seq += 1}`;
  runtime.jobRegistry.register(type, vi.fn(async () => {}), 'test', {
    currentVersion: 1, versions: { 1: intervalPayload },
  });
  runtime.recurring.register(type, { everyMs });
  return type;
}

interface ScheduleItem {
  type: string;
  paused: boolean;
  nextOccurrenceAt: string | null;
  lastOccurrenceAt: string | null;
  skippedCatchup: number;
}

async function listSchedules(headers: Record<string, string>) {
  const response = await app.inject({ url: '/api/v1/system/schedules', headers });
  return { status: response.statusCode, body: response.json() as { data: { items: ScheduleItem[] } } };
}

describe('GET /health/metrics', () => {
  it('requires a bearer token and returns stable counters without operational identifiers', async () => {
    const anonymous = await app.inject({ url: '/health/metrics' });
    expect(anonymous.statusCode).toBe(401);

    // Browser sessions must not become monitoring credentials merely because
    // their role happens to carry jobs:read.
    const session = await app.inject({ url: '/health/metrics', headers: { cookie: 'session=not-a-token' } });
    expect(session.statusCode).toBe(401);

    const response = await app.inject({ url: '/health/metrics', headers: readonly });
    const body = response.json();
    // metrics 一律 200：監控採集器對非 2xx 一律丟棄整份 payload，狀態要看 body.status。
    expect(response.statusCode).toBe(200);
    expect(body).toMatchObject({
      status: expect.stringMatching(/^(ok|degraded|down)$/),
      outbox: { pending: expect.any(Number), dead: expect.any(Number) },
      jobs: { pending: expect.any(Number), running: expect.any(Number), dead: expect.any(Number), quarantined: expect.any(Number) },
      worker: {},
      scheduler: { total: expect.any(Number), paused: expect.any(Number), skippedCatchup: expect.any(Number), skippedPaused: expect.any(Number), skippedOverlap: expect.any(Number) },
      mail: { enabled: expect.any(Boolean), pending: expect.any(Number), partial: expect.any(Number), unknown: expect.any(Number), rejected: expect.any(Number) },
      storage: { available: expect.any(Boolean) },
    });
    expect(body.outbox.oldestPendingAgeSeconds === null || typeof body.outbox.oldestPendingAgeSeconds === 'number').toBe(true);
    expect(body.worker.lastSeenAgeSeconds === null || typeof body.worker.lastSeenAgeSeconds === 'number').toBe(true);
    // Metrics are collected by third parties; do not give them worker names,
    // provider diagnostics, recipient data, or a free-form detail field.
    expect(JSON.stringify(body)).not.toContain('workerId');
    expect(body).not.toHaveProperty('checks');
  });

  it('does not require a worker heartbeat when the worker capability is disabled', async () => {
    const wasEnabled = runtime.config.worker.enabled;
    const storage = vi.spyOn(runtime.storage, 'healthCheck').mockResolvedValue();
    runtime.config.worker.enabled = false;
    try {
      const response = await app.inject({ url: '/health/metrics', headers: readonly });
      expect(response.statusCode).toBe(200);
      expect(response.json().status).toBe('ok');
      expect(response.json().worker.lastSeenAgeSeconds).toBeNull();
    } finally {
      runtime.config.worker.enabled = wasEnabled;
      storage.mockRestore();
    }
  });

  it('returns a stable down payload when PostgreSQL is unavailable', async () => {
    const ping = vi.spyOn(runtime.database, 'ping').mockResolvedValue({ ok: false, latencyMs: 0, error: 'intentionally offline' });
    try {
      const response = await app.inject({ url: '/health/metrics', headers: readonly });
      // 狀態碼必須是 200，否則監控採集器拿不到這份 payload；down 狀態看 body.status。
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        status: 'down',
        outbox: { pending: 0, dead: 0, oldestPendingAgeSeconds: null },
        jobs: { pending: 0, running: 0, dead: 0, quarantined: 0 },
        worker: { lastSeenAgeSeconds: null },
      });
    } finally {
      ping.mockRestore();
    }
  });

  it('stays 200 when there is a dead outbox message', async () => {
    const outbox = vi.spyOn(runtime.outbox, 'stats').mockResolvedValue({
      pending: 0, relayed: 0, dead: 1, oldestPendingAgeSeconds: null,
    });
    try {
      const response = await app.inject({ url: '/health/metrics', headers: readonly });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ status: 'down', outbox: { dead: 1 } });
    } finally {
      outbox.mockRestore();
    }
  });

  it('does not report the worker as missing merely because its heartbeat query failed', async () => {
    const wasEnabled = runtime.config.worker.enabled;
    const storage = vi.spyOn(runtime.storage, 'healthCheck').mockResolvedValue();
    // Only the heartbeat query fails: the point of this case is that one
    // unreadable table does not take the rest of the payload down with it.
    const original = runtime.database.db.execute.bind(runtime.database.db);
    const execute = vi.spyOn(runtime.database.db, 'execute').mockImplementation(((query: Parameters<typeof original>[0]) => {
      const text = ((query as { queryChunks?: readonly unknown[] }).queryChunks ?? [])
        .map(chunk => (chunk as { value?: unknown }).value).join('');
      if (text.includes('platform_worker_heartbeat')) return Promise.reject(new Error('intentional heartbeat failure'));
      return original(query);
    }) as typeof original);
    runtime.config.worker.enabled = true;
    try {
      const response = await app.inject({ url: '/health/metrics', headers: readonly });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      // An unreadable heartbeat table is degraded, not a down worker.
      expect(body.status).toBe('degraded');
      expect(body.worker.lastSeenAgeSeconds).toBeNull();
    } finally {
      runtime.config.worker.enabled = wasEnabled;
      execute.mockRestore();
      storage.mockRestore();
    }
  });

  it('degrades instead of failing when one metrics query rejects', async () => {
    const schedules = vi.spyOn(runtime.recurring, 'list').mockRejectedValue(new Error('intentional query failure'));
    try {
      const response = await app.inject({ url: '/health/metrics', headers: readonly });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.status).not.toBe('ok');
      // 失敗的那組欄位保留零值形狀，不影響其他組回報真實數字。
      expect(body.scheduler).toEqual({ total: 0, paused: 0, skippedCatchup: 0, skippedPaused: 0, skippedOverlap: 0 });
      expect(typeof body.outbox.pending).toBe('number');
      expect(typeof body.jobs.pending).toBe('number');
    } finally {
      schedules.mockRestore();
    }
  });
});

describe('GET /api/v1/system/schedules', () => {
  it('回傳真實的排程狀態，日期序列化成 ISO 字串', async () => {
    const type = registerSchedule();
    await runtime.recurring.ensureScheduled(new Date('2026-01-05T03:10:00.000Z'));

    const { status, body } = await listSchedules(readonly);
    expect(status).toBe(200);
    const item = body.data.items.find((entry) => entry.type === type);
    // descriptor 的 output schema 要求 string|null；handler 的 toISOString() 對映
    // 只有走 QueryBus 才會被驗到——直接呼叫 recurring.list() 拿到的是 Date。
    expect(item).toMatchObject({ type, paused: false });
    expect(item?.lastOccurrenceAt).toBe('2026-01-05T03:00:00.000Z');
    expect(typeof item?.nextOccurrenceAt).toBe('string');
    expect(item?.skippedCatchup).toBe(0);
  });

  it('沒有憑證是 401，不是 403 也不是 404', async () => {
    const response = await app.inject({ url: '/api/v1/system/schedules' });
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe('UNAUTHENTICATED');
  });
});

describe('POST /api/v1/system/schedules/:type/pause 與 /resume', () => {
  it('暫停後 list 立刻反映，且不再顯示下一次；恢復後回復', async () => {
    const type = registerSchedule();
    await runtime.recurring.ensureScheduled(new Date('2026-01-05T03:10:00.000Z'));

    const paused = await app.inject({
      method: 'POST', url: `/api/v1/system/schedules/${type}/pause`,
      headers: { ...admin, 'idempotency-key': randomUUID() },
    });
    expect(paused.statusCode).toBe(200);
    expect(paused.json().data).toEqual({ type, paused: true });

    const afterPause = (await listSchedules(admin)).body.data.items.find((entry) => entry.type === type);
    expect(afterPause).toMatchObject({ paused: true });
    // 暫停中顯示一個不會發生的時間比不顯示更糟——這條契約只有經過 DTO 才看得到。
    expect(afterPause?.nextOccurrenceAt).toBeNull();

    const resumed = await app.inject({
      method: 'POST', url: `/api/v1/system/schedules/${type}/resume`,
      headers: { ...admin, 'idempotency-key': randomUUID() },
    });
    expect(resumed.statusCode).toBe(200);
    expect(resumed.json().data).toEqual({ type, paused: false });

    const afterResume = (await listSchedules(admin)).body.data.items.find((entry) => entry.type === type);
    expect(afterResume).toMatchObject({ paused: false });
    expect(typeof afterResume?.nextOccurrenceAt).toBe('string');
  });

  it('帶點的排程型別走 path param 不會被切斷', async () => {
    // `commerce.cart.cleanup` 這種名字是常態；路由若把點當分隔就會 404 或截字。
    const type = registerSchedule();
    expect(type).toContain('.');
    const response = await app.inject({
      method: 'POST', url: `/api/v1/system/schedules/${type}/pause`,
      headers: { ...admin, 'idempotency-key': randomUUID() },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().data.type).toBe(type);
  });

  it('缺 Idempotency-Key header 是 400，不是靜默執行', async () => {
    const type = registerSchedule();
    const response = await app.inject({
      method: 'POST', url: `/api/v1/system/schedules/${type}/pause`, headers: admin,
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('VALIDATION_ERROR');
    // 真的沒有執行：狀態表不該出現這個排程的列。
    const rows = await runtime.database.db.execute<{ count: string }>(sql`
      SELECT count(*)::text AS count FROM platform_job_schedules WHERE type = ${type}
    `);
    expect(rows.rows).toEqual([{ count: '0' }]);
  });

  it('同一把 key 重放不會寫第二列 audit', async () => {
    const type = registerSchedule();
    const idempotencyKey = randomUUID();
    const headers = { ...admin, 'idempotency-key': idempotencyKey };
    const url = `/api/v1/system/schedules/${type}/pause`;
    const first = await app.inject({ method: 'POST', url, headers });
    const second = await app.inject({ method: 'POST', url, headers });
    expect(first.statusCode).toBe(200);
    expect(second.json()).toEqual(first.json());

    const audit = await runtime.database.db.execute<{ count: string }>(sql`
      SELECT count(*)::text AS count FROM platform_audit_log
      WHERE action = 'jobs.schedule.paused' AND resource_id = ${type}
    `);
    expect(audit.rows).toEqual([{ count: '1' }]);
  });

  it('沒有 jobs:write 的讀者被擋在 403，錯誤封套不外洩內部細節', async () => {
    const type = registerSchedule();
    for (const action of ['pause', 'resume']) {
      const response = await app.inject({
        method: 'POST', url: `/api/v1/system/schedules/${type}/${action}`,
        headers: { ...readonly, 'idempotency-key': randomUUID() },
      });
      expect(response.statusCode).toBe(403);
      expect(response.json()).toEqual({ success: false, error: { code: 'FORBIDDEN', message: expect.any(String) } });
    }
  });

  it('未註冊的型別是 404，而不是在狀態表留下沒有人會讀的列', async () => {
    const type = 'ops.http.never.registered';
    const response = await app.inject({
      method: 'POST', url: `/api/v1/system/schedules/${type}/pause`,
      headers: { ...admin, 'idempotency-key': randomUUID() },
    });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('NOT_FOUND');
    const rows = await runtime.database.db.execute<{ count: string }>(sql`
      SELECT count(*)::text AS count FROM platform_job_schedules WHERE type = ${type}
    `);
    expect(rows.rows).toEqual([{ count: '0' }]);
  });

  it('空的 type 區段被 descriptor 擋下——擋它的是 min(1) 而不是路由', async () => {
    // 實測 `POST /api/v1/system/schedules//pause` 會 match 成功並帶 `type: ''`，
    // 所以 `scheduleTypeInput` 的 `min(1)` 是承重的。放寬它會讓空 type 走到 setPaused。
    const response = await app.inject({
      method: 'POST', url: '/api/v1/system/schedules//pause',
      headers: { ...admin, 'idempotency-key': randomUUID() },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('VALIDATION_ERROR');
  });
});

describe('GET /api/v1/system/outbox/failures', () => {
  /** 直接寫列：這一端點只做讀，seeding 走 relay 只會把測試綁到不相干的機制上。 */
  async function seedFailure(occurredAt: string, status: 'dead' | 'quarantined'): Promise<string> {
    const id = randomUUID();
    await runtime.database.db.execute(sql`
      INSERT INTO platform_outbox (id, event_name, event_version, payload, actor_id, correlation_id,
                                   occurred_at, status, attempts, last_error)
      VALUES (${id}, 'ops.http.seeded', 1, '{}'::jsonb, 'ops', ${randomUUID()},
              CAST(${occurredAt} AS timestamptz), ${status}, 3, ${`seeded ${status}`})
    `);
    return id;
  }

  it('回傳真實的失敗列，最新的排在最前面，且不外洩 payload', async () => {
    const older = await seedFailure('2026-02-01T00:00:00.000Z', 'dead');
    const newer = await seedFailure('2026-02-03T00:00:00.000Z', 'quarantined');

    const response = await app.inject({ url: '/api/v1/system/outbox/failures', headers: readonly });
    expect(response.statusCode).toBe(200);
    const { items, total } = response.json().data as { items: Array<Record<string, unknown>>; total: number };
    expect(total).toBeGreaterThanOrEqual(2);
    // ORDER BY occurred_at DESC, id DESC——只斷這兩列的相對順序，不斷資料庫裡共有幾列，
    // 否則這一例會隨其他 describe 的 seed 而紅，而它想證的事跟列數無關。
    const seeded = items.map((item) => item.id).filter((id) => id === newer || id === older);
    expect(seeded).toEqual([newer, older]);
    const row = items.find((item) => item.id === newer);
    expect(row).toMatchObject({
      id: newer, eventName: 'ops.http.seeded', eventVersion: 1, status: 'quarantined',
      attempts: 3, subscriberIds: null, snapshotState: 'legacy_unknown', reason: 'seeded quarantined',
    });
    expect(row).not.toHaveProperty('payload');
    expect(typeof row?.occurredAt).toBe('string');
  });

  it('分頁真的切在同一組排序上，limit 與 offset 不會各自為政', async () => {
    // 自己 seed，且斷言全部綁在同一次的全量結果上，不綁「資料庫裡剛好有幾列」——
    // 兩者少一個，這一例就會隨執行順序而紅，而它想證的事跟順序、列數都無關。
    await seedFailure('2026-04-01T00:00:00.000Z', 'dead');
    await seedFailure('2026-04-03T00:00:00.000Z', 'dead');

    const all = await app.inject({ url: '/api/v1/system/outbox/failures', headers: readonly });
    const ids = (all.json().data as { items: Array<{ id: string }> }).items.map((item) => item.id);
    const total = (all.json().data as { total: number }).total;
    expect(ids.length).toBeGreaterThan(1);

    const response = await app.inject({ url: '/api/v1/system/outbox/failures?limit=1&offset=1', headers: readonly });
    expect(response.statusCode).toBe(200);
    const page = response.json().data as { items: Array<{ id: string }>; total: number };
    expect(page.items).toHaveLength(1);
    // total 是整個結果集而不是這一頁——否則維運看到的數字會隨翻頁跳動
    expect(page.total).toBe(total);
    expect(page.items[0]?.id).toBe(ids[1]);
  });
});

describe('POST /api/v1/system/outbox/failures/:outboxId/redrive', () => {
  const body = { subscriberIds: [], evidence: 'ops-http test', acknowledgeEmptyFanout: true };

  /**
   * Base release 的 `createModules()` 回空陣列，所以沒有任何領域事件，而 redrive 會先驗
   * 事件名稱與版本已註冊。這裡直接在 EventBus 上註冊一個合成事件與訂閱者——模組系統
   * 底下走的就是 `registerEvent`／`subscribe` 這兩支公開 API，而這個端點本來就與領域無關。
   */
  const EVENT_NAME = 'ops.http.redriven.v1';
  const SUBSCRIBER = 'ops-http-subscriber';
  let registered = false;

  async function seedFrozenFailure(): Promise<string> {
    if (!registered) {
      runtime.events.registerEvent(defineEvent({
        name: EVENT_NAME, payload: z.object({ value: z.string() }).strict(),
      }));
      runtime.events.subscribe({ subscriberId: SUBSCRIBER, eventName: EVENT_NAME, handler: async () => {} });
      registered = true;
    }
    const id = randomUUID();
    await runtime.database.db.execute(sql`
      INSERT INTO platform_outbox (id, event_name, event_version, payload, actor_id, correlation_id,
                                   occurred_at, status, attempts, last_error, subscriber_ids)
      VALUES (${id}, ${EVENT_NAME}, 1, ${JSON.stringify({ value: 'x' })}::jsonb, 'ops', ${randomUUID()},
              now(), 'dead', 3, 'delivery failed', ${JSON.stringify([SUBSCRIBER])}::jsonb)
    `);
    return id;
  }

  it('重現 frozen snapshot 就重送成功，並留下 operator evidence', async () => {
    const outboxId = await seedFrozenFailure();
    const response = await app.inject({
      method: 'POST', url: `/api/v1/system/outbox/failures/${outboxId}/redrive`,
      headers: { ...admin, 'idempotency-key': randomUUID() },
      payload: { subscriberIds: [SUBSCRIBER], evidence: 'subscriber restored in ops-http test' },
    });
    expect(response.statusCode).toBe(200);
    // 只斷 status 屬於 pending|relayed 是恆真的——CommandBus 已經用 descriptor 的
    // `z.enum(['pending','relayed'])` 驗過 output，能回 200 就必然滿足。要斷的是副作用。
    expect(response.json().data.outboxId).toBe(outboxId);
    const after = await runtime.database.db.execute<{ status: string; subscriber_ids: unknown }>(sql`
      SELECT status, subscriber_ids FROM platform_outbox WHERE id = ${outboxId}
    `);
    expect(after.rows[0]?.status).not.toBe('dead');
    // frozen snapshot 不該被重送改寫——它是這次重送的唯一真實來源。
    expect(after.rows[0]?.subscriber_ids).toEqual([SUBSCRIBER]);

    // audit 是這個端點存在的理由：重送必須留下是誰、為什麼。
    const audit = await runtime.database.db.execute<{ count: string }>(sql`
      SELECT count(*)::text AS count FROM platform_audit_log
      WHERE action = 'outbox.failure.redriven' AND resource_id = ${outboxId}
    `);
    expect(audit.rows).toEqual([{ count: '1' }]);
  });

  it('snapshot 對不上就拒絕，而且什麼都沒寫', async () => {
    const outboxId = await seedFrozenFailure();
    const before = await runtime.database.db.execute<{ status: string }>(sql`
      SELECT status FROM platform_outbox WHERE id = ${outboxId}
    `);
    const response = await app.inject({
      method: 'POST', url: `/api/v1/system/outbox/failures/${outboxId}/redrive`,
      headers: { ...admin, 'idempotency-key': randomUUID() },
      payload: { subscriberIds: [SUBSCRIBER, 'someone-else'], evidence: 'wrong snapshot' },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('VALIDATION_ERROR');
    const after = await runtime.database.db.execute<{ status: string }>(sql`
      SELECT status FROM platform_outbox WHERE id = ${outboxId}
    `);
    expect(after.rows).toEqual(before.rows);
  });

  it('缺 Idempotency-Key header 是 400', async () => {
    const response = await app.inject({
      method: 'POST', url: `/api/v1/system/outbox/failures/${randomUUID()}/redrive`,
      headers: admin, payload: body,
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('VALIDATION_ERROR');
  });

  it('不存在的 outbox id 是 404', async () => {
    const response = await app.inject({
      method: 'POST', url: `/api/v1/system/outbox/failures/${randomUUID()}/redrive`,
      headers: { ...admin, 'idempotency-key': randomUUID() }, payload: body,
    });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('NOT_FOUND');
  });

  it('outboxId 不是 uuid 時在 descriptor 就被擋下，不會打到資料庫', async () => {
    const response = await app.inject({
      method: 'POST', url: '/api/v1/system/outbox/failures/not-a-uuid/redrive',
      headers: { ...admin, 'idempotency-key': randomUUID() }, payload: body,
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('VALIDATION_ERROR');
  });
});
