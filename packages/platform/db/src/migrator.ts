import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { MigrationSet, MigrationPin } from './types';

const LOCK_KEY = 8_140_231;

export interface AppliedMigration {
  id: string;
  phase: string;
  appliedAt: Date;
  checksum: string;
  order: number;
}

export interface MigrationStatus {
  applied: AppliedMigration[];
  pending: { id: string; phase: string }[];
}

export interface HistoryRow {
  id: string;
  phase: string;
  applied_at: Date;
  checksum: string | null;
  migration_order: number | null;
}

/** Exact SQL bytes are the source of truth; phase and per-owner position are checked separately. */
export function migrationCatalog(sets: readonly MigrationSet[]) {
  const owners = new Set<string>();
  return sets.flatMap(set => {
    if (!/^[a-z][a-z0-9-]*$/.test(set.module) || owners.has(set.module)) {
      throw new Error(`Invalid or duplicate migration owner "${set.module}"`);
    }
    owners.add(set.module);
    let previous = '';
    return set.migrations.map((migration, index) => {
      if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(migration.id) || migration.id <= previous) {
        throw new Error(`Migration ids must be unique and increasing for "${set.module}": ${migration.id}`);
      }
      if (!['expand', 'migrate', 'contract'].includes(migration.phase)) {
        throw new Error(`Invalid migration phase for ${set.module}/${migration.id}`);
      }
      previous = migration.id;
      return {
        id: `${set.module}/${migration.id}`, phase: migration.phase, up: migration.up,
        owner: set.module, order: index + 1,
        checksum: `sha256:${createHash('sha256').update(migration.up, 'utf8').digest('hex')}`,
      };
    });
  });
}

type Catalog = ReturnType<typeof migrationCatalog>;
export type HistoryCatalog = readonly (MigrationPin & { readonly owner: string })[];

export async function ensureHistory(client: PoolClient) {
  // Nullable additions preserve the legacy binary's three-column inserts during a tested rollback.
  // A subsequent new binary refuses those rows until an explicit legacy baseline is adopted.
  await client.query(`CREATE TABLE IF NOT EXISTS public.platform_migration_baselines (
    id text PRIMARY KEY, catalog_id text NOT NULL, source_release text NOT NULL,
    catalog_checksum text NOT NULL, evidence text NOT NULL,
    historical_sql_verified boolean NOT NULL DEFAULT false,
    historical_runtime_verified boolean NOT NULL DEFAULT false,
    accepted_at timestamptz NOT NULL DEFAULT now()
  )`);
  await client.query(`ALTER TABLE public.platform_migration_baselines
    ADD COLUMN IF NOT EXISTS historical_sql_verified boolean NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS historical_runtime_verified boolean NOT NULL DEFAULT false`);
  await client.query(`CREATE TABLE IF NOT EXISTS public.platform_migrations (
    id text PRIMARY KEY, phase text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now(),
    checksum text, migration_order integer
  )`);
  await client.query(`ALTER TABLE public.platform_migrations
    ADD COLUMN IF NOT EXISTS checksum text,
    ADD COLUMN IF NOT EXISTS migration_order integer,
    ADD COLUMN IF NOT EXISTS legacy_baseline_id text REFERENCES public.platform_migration_baselines(id),
    ADD COLUMN IF NOT EXISTS migration_owner text,
    ADD COLUMN IF NOT EXISTS migration_id text,
    ADD COLUMN IF NOT EXISTS module_id text,
    ADD COLUMN IF NOT EXISTS module_version text,
    ADD COLUMN IF NOT EXISTS release_id text,
    ADD COLUMN IF NOT EXISTS release_version text`);
  await client.query(`CREATE TABLE IF NOT EXISTS public.platform_release_history (
    sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    release_id text NOT NULL, release_version text NOT NULL,
    base_version text NOT NULL, build_manifest_checksum text NOT NULL,
    effective_manifest_checksum text NOT NULL, effective_manifest jsonb NOT NULL,
    legacy_baseline_id text REFERENCES public.platform_migration_baselines(id),
    recorded_at timestamptz NOT NULL DEFAULT now()
  )`);
  await client.query(`ALTER TABLE public.platform_release_history
    ADD COLUMN IF NOT EXISTS legacy_baseline_id text REFERENCES public.platform_migration_baselines(id)`);
}

export function validateHistory(catalog: HistoryCatalog, rows: HistoryRow[]): void {
  const expected = new Map(catalog.map(migration => [migration.id, migration]));
  const applied = new Map(rows.map(row => [row.id, row]));
  for (const row of rows) {
    const migration = expected.get(row.id);
    if (!migration) throw new Error(`Unknown migration history: ${row.id}`);
    if (row.checksum === null || row.migration_order === null) {
      throw new Error(`Legacy migration history requires an explicit baseline: ${row.id}`);
    }
    if (row.phase !== migration.phase || row.checksum !== migration.checksum || row.migration_order !== migration.order) {
      throw new Error(`Migration history drift: ${row.id} (phase, checksum or owner order differs)`);
    }
  }
  const pendingOwners = new Set<string>();
  for (const migration of catalog) {
    if (!applied.has(migration.id)) pendingOwners.add(migration.owner);
    else if (pendingOwners.has(migration.owner)) {
      throw new Error(`Migration history is not an applied prefix for "${migration.owner}": ${migration.id}`);
    }
  }
}

/** Both status and writes own one session through DDL, validation, transactions and unlock. */
export async function withMigrationLock<T>(pool: Pool, operation: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  let connectionFailure: Error | undefined;
  const onConnectionError = (error: Error) => { connectionFailure = error; };
  client.on('error', onConnectionError);
  let locked = false;
  let completed = false;
  let reusable = false;
  let failure: unknown;
  try {
    await client.query('SELECT pg_catalog.pg_advisory_lock($1)', [LOCK_KEY]);
    locked = true;
    const result = await operation(client);
    if (connectionFailure) throw connectionFailure;
    completed = true;
    return result;
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    try {
      if (locked) {
        const result = await client.query<{ unlocked: boolean }>(
          'SELECT pg_catalog.pg_advisory_unlock($1) AS unlocked', [LOCK_KEY],
        );
        if (result.rows[0]?.unlocked !== true) throw new Error('Migration advisory lock was not held');
        reusable = completed;
      }
    } catch (unlockError) {
      if (!completed) throw new AggregateError([failure, unlockError], 'Migration and lock release failed');
      throw unlockError;
    } finally {
      // Failure may leave uncertain transaction state. Replacing a failed session is cheaper than reusing it unsafely.
      if (reusable && !connectionFailure) {
        client.release();
        client.removeListener('error', onConnectionError);
      } else {
        // A terminated backend can emit its socket error after the query rejects. Keep the
        // listener until pg finishes closing this discarded client, then remove it.
        client.once('end', () => client.removeListener('error', onConnectionError));
        client.release(true);
      }
    }
  }
}

export async function readHistory(client: PoolClient, catalog: HistoryCatalog) {
  const { rows } = await client.query<HistoryRow>(
    'SELECT id, phase, applied_at, checksum, migration_order FROM public.platform_migrations ORDER BY id',
  );
  validateHistory(catalog, rows);
  return rows;
}

export async function migrationStatus(pool: Pool, sets: readonly MigrationSet[]): Promise<MigrationStatus> {
  const catalog = migrationCatalog(sets);
  return withMigrationLock(pool, async client => {
    await ensureHistory(client);
    const rows = await readHistory(client, catalog);
    const applied = new Set(rows.map(row => row.id));
    return {
      applied: rows.map(row => ({
        id: row.id, phase: row.phase, appliedAt: row.applied_at,
        checksum: row.checksum!, order: row.migration_order!,
      })),
      pending: catalog.filter(migration => !applied.has(migration.id)).map(({ id, phase }) => ({ id, phase })),
    };
  });
}

/** Each migration commits independently; a later failure retains the successful prefix. */
export async function runMigrations(
  pool: Pool, sets: readonly MigrationSet[], log: (msg: string) => void = () => {},
): Promise<string[]> {
  const catalog = migrationCatalog(sets);
  return withMigrationLock(pool, client => runMigrationsOnClient(client, catalog, log));
}

/** Internal DB seam: caller already owns the migration lock; disabled pins contain no executable SQL. */
export async function runMigrationsOnClient(
  client: PoolClient, catalog: Catalog, log: (message: string) => void = () => {},
  historyCatalog: HistoryCatalog = catalog,
  provenance?: { releaseId: string; releaseVersion: string; modules: readonly { id: string; version: string; migrationOwner: string | null }[] },
): Promise<string[]> {
  await ensureHistory(client);
  const rows = await readHistory(client, historyCatalog);
  const applied = new Set(rows.map(row => row.id));
  const executed: string[] = [];
  for (const migration of catalog) {
    if (applied.has(migration.id)) continue;
    log(`applying ${migration.id} (${migration.phase})`);
    await client.query('BEGIN');
    try {
      await client.query(migration.up);
      const module = provenance?.modules.find(module => module.migrationOwner === migration.owner);
      await client.query(`INSERT INTO public.platform_migrations
        (id, phase, checksum, migration_order, migration_owner, migration_id, module_id, module_version, release_id, release_version)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [migration.id, migration.phase, migration.checksum, migration.order, migration.owner,
        migration.id.slice(migration.owner.length + 1), module?.id ?? null, module?.version ?? null,
        provenance?.releaseId ?? null, provenance?.releaseVersion ?? null]);
      await client.query('COMMIT');
    } catch (error) {
      try { await client.query('ROLLBACK'); }
      catch (rollbackError) { throw new AggregateError([error, rollbackError], 'Migration and rollback failed'); }
      throw error;
    }
    executed.push(migration.id);
  }
  return executed;

}
