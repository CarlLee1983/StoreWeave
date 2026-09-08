import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createHarness, type TestHarness } from './helpers';

let h: TestHarness;
beforeEach(async () => { h = await createHarness(); }, 300_000);
afterEach(async () => { await h?.close(); });

/**
 * 其餘 outbox 測試都跑在幾乎空的表上，正是這一類缺陷測不出來的原因：`listFailures` 曾經以
 * `OR` 加上對每列 outbox 的 `dedupe_key LIKE 'evt:<id>:%'` 相關子查詢求值，在這個資料量下
 * 直接跑滿 60 秒 statement timeout。這支測試把「查詢成本不隨事件總量成長」變成可回歸的斷言。
 */
it('lists outbox failures without scanning the whole outbox at volume', async () => {
  const db = h.runtime.database.db;
  await db.execute(sql`
    INSERT INTO platform_outbox (id, event_name, event_version, payload, actor_id, correlation_id, subscriber_ids, status, occurred_at)
    SELECT gen_random_uuid(), 'bench.event', 1, '{"v":1}'::jsonb, 'bench', 'bench', '["alpha"]'::jsonb, 'relayed',
           now() - (g * interval '1 second')
    FROM generate_series(1, 60000) AS g
  `);
  await db.execute(sql`
    INSERT INTO platform_jobs (id, occurrence_id, type, payload, payload_version, dedupe_key, status, max_attempts)
    SELECT gen_random_uuid(), gen_random_uuid(), 'platform.event.deliver', '{}'::jsonb, 1,
           'evt:' || gen_random_uuid()::text || ':alpha', 'completed', 5
    FROM generate_series(1, 60000)
  `);
  const seeded = (await db.execute<{ id: string }>(sql`
    SELECT id FROM platform_outbox ORDER BY occurred_at DESC LIMIT 2000
  `)).rows;
  for (let i = 0; i < seeded.length; i += 500) {
    const chunk = seeded.slice(i, i + 500);
    await db.execute(sql`
      INSERT INTO platform_jobs (id, occurrence_id, type, payload, payload_version, dedupe_key, status, max_attempts)
      SELECT gen_random_uuid(), gen_random_uuid(), 'platform.event.deliver', '{}'::jsonb, 1,
             'evt:' || t.id || ':beta', 'quarantined', 5
      FROM unnest(${sql.raw(`ARRAY['${chunk.map(r => r.id).join("','")}']::text[]`)}) AS t(id)
    `);
  }
  await db.execute(sql`
    INSERT INTO platform_job_quarantine (job_id, occurrence_id, type, payload, payload_version, reason)
    SELECT id, occurrence_id, type, '{}'::jsonb, 1, 'subscriber_missing'
    FROM platform_jobs WHERE status = 'quarantined'
  `);
  await db.execute(sql`ANALYZE platform_outbox`);
  await db.execute(sql`ANALYZE platform_jobs`);
  await db.execute(sql`ANALYZE platform_job_quarantine`);

  await db.execute(sql`SET statement_timeout = '30s'`);
  const started = Date.now();
  const result = await h.runtime.outbox.listFailures(db, { limit: 50, offset: 0 });
  const elapsed = Date.now() - started;
  console.log(`listFailures at volume: ${elapsed} ms, total=${result.total}, items=${result.items.length}`);
  expect(result.total).toBe(2000);
  expect(result.items).toHaveLength(50);
  expect(elapsed).toBeLessThan(5_000);

}, 600_000);
