import { sql } from 'drizzle-orm';
import type { DrizzleDb } from '@storeweave/contracts';
import type { MigrationSet } from './types';

const LOCK_KEY = 8_140_231; // 任意但固定的 advisory lock key

export interface AppliedMigration {
  id: string;
  phase: string;
  appliedAt: Date;
}

export interface MigrationStatus {
  applied: AppliedMigration[];
  pending: { id: string; phase: string }[];
}

function flatten(sets: readonly MigrationSet[]) {
  return sets.flatMap((set) =>
    set.migrations.map((m) => ({ id: `${set.module}/${m.id}`, phase: m.phase, up: m.up })),
  );
}

async function ensureTable(db: DrizzleDb) {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS platform_migrations (
      id         text PRIMARY KEY,
      phase      text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
}

export async function migrationStatus(db: DrizzleDb, sets: readonly MigrationSet[]): Promise<MigrationStatus> {
  await ensureTable(db);
  const rows = await db.execute<{ id: string; phase: string; applied_at: Date }>(
    sql`SELECT id, phase, applied_at FROM platform_migrations ORDER BY id`,
  );
  const appliedIds = new Set(rows.rows.map((r) => r.id));
  const all = flatten(sets);
  return {
    applied: rows.rows.map((r) => ({ id: r.id, phase: r.phase, appliedAt: r.applied_at })),
    pending: all.filter((m) => !appliedIds.has(m.id)).map((m) => ({ id: m.id, phase: m.phase })),
  };
}

/**
 * 依序套用未執行的 migration。使用 advisory lock，多個實例同時啟動也安全。
 * 每個 migration 在自己的交易內執行 —— 失敗即中止，已成功的保留。
 */
export async function runMigrations(
  db: DrizzleDb,
  sets: readonly MigrationSet[],
  log: (msg: string) => void = () => {},
): Promise<string[]> {
  await ensureTable(db);
  await db.execute(sql`SELECT pg_advisory_lock(${LOCK_KEY})`);
  const executed: string[] = [];
  try {
    const rows = await db.execute<{ id: string }>(sql`SELECT id FROM platform_migrations`);
    const applied = new Set(rows.rows.map((r) => r.id));
    for (const m of flatten(sets)) {
      if (applied.has(m.id)) continue;
      log(`applying ${m.id} (${m.phase})`);
      await db.transaction(async (tx) => {
        await tx.execute(sql.raw(m.up));
        await tx.execute(
          sql`INSERT INTO platform_migrations (id, phase) VALUES (${m.id}, ${m.phase})`,
        );
      });
      executed.push(m.id);
    }
  } finally {
    await db.execute(sql`SELECT pg_advisory_unlock(${LOCK_KEY})`);
  }
  return executed;
}
