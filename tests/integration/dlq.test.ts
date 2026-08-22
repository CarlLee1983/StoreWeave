import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PermanentJobError } from '@storeweave/jobs';
import { ADMIN_ACTOR, actorWith, createHarness, type TestHarness } from './helpers';

const ALWAYS_FAILS = 'test.always-fails';
const SUCCEEDS = 'test.succeeds';

let h: TestHarness;

beforeAll(async () => {
  h = await createHarness();
  h.runtime.jobRegistry.register(
    ALWAYS_FAILS,
    async () => {
      throw new PermanentJobError('ERP 端沒有這張單');
    },
    'test',
  );
}, 300_000);

afterAll(async () => {
  await h?.close();
});

/** 排進一個必定永久失敗的工作，drain 過後它會落到死信佇列。 */
async function deadJob(): Promise<string> {
  const dedupeKey = `dead-${randomUUID()}`;
  const { id } = await h.runtime.database.transaction((tx) =>
    h.runtime.jobs.enqueue(tx, { type: ALWAYS_FAILS, payload: { dedupeKey }, dedupeKey }),
  );
  // 一輪 drain 未必把重試次數耗盡：同一個資料庫裡還有其他模組的週期性工作在搶
  // 認領名額。跑到它真的進死信為止，才是這個 helper 宣稱要做的事。
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await h.worker.drain();
    const rows = await h.runtime.database.db.execute<{ status: string }>(sql`
      SELECT status FROM platform_jobs WHERE id = ${id}
    `);
    if (rows.rows[0]?.status === 'dead') return id;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return id;
}

describe('死信佇列（DLQ）', () => {
  it('列出耗盡重試而進入死信的工作', async () => {
    const id = await deadJob();

    const result = await h.runtime.queries.execute<{ items: { id: string; type: string; attempts: number; lastError: string | null }[]; total: number }>(
      'platform.jobs.listDeadJobs',
      {},
      { actor: ADMIN_ACTOR },
    );

    const found = result.items.find((j) => j.id === id);
    expect(found).toBeDefined();
    expect(found!.type).toBe(ALWAYS_FAILS);
    expect(found!.lastError).toContain('ERP 端沒有這張單');
  });

  it('重送會把工作放回佇列，並從死信清單消失', async () => {
    const id = await deadJob();

    await h.runtime.commands.execute('platform.jobs.retryJob', { jobId: id }, {
      actor: ADMIN_ACTOR,
      idempotencyKey: randomUUID(),
    });

    const after = await h.runtime.queries.execute<{ items: { id: string }[] }>(
      'platform.jobs.listDeadJobs', {}, { actor: ADMIN_ACTOR },
    );
    expect(after.items.map((j) => j.id)).not.toContain(id);
  });

  it('重送不存在的工作會回報 NOT_FOUND', async () => {
    await expect(
      h.runtime.commands.execute('platform.jobs.retryJob', { jobId: randomUUID() }, {
        actor: ADMIN_ACTOR, idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND', message: expect.stringContaining('Dead job') });
  });

  it('已完成的工作不能用死信重送（否則會再產生一次外部副作用）', async () => {
    const dedupeKey = `ok-${randomUUID()}`;
    h.runtime.jobRegistry.register(SUCCEEDS, async () => {}, 'test');
    const { id } = await h.runtime.database.transaction((tx) =>
      h.runtime.jobs.enqueue(tx, { type: SUCCEEDS, payload: {}, dedupeKey }),
    );
    await h.worker.drain();

    await expect(
      h.runtime.commands.execute('platform.jobs.retryJob', { jobId: id }, {
        actor: ADMIN_ACTOR, idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('沒有 jobs:write 權限就不能重送', async () => {
    const id = await deadJob();
    await expect(
      h.runtime.commands.execute('platform.jobs.retryJob', { jobId: id }, {
        actor: actorWith(['jobs:read']), idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});
