import { withMigrationLock } from '../../packages/platform/db/src/migrator';
import { escapeIdentifier } from 'pg';
import { afterEach, describe, expect, it } from 'vitest';
import { Database, runMigrations, sqlMigration, type MigrationSet } from '@storeweave/db';
import { createTestDatabase } from './helpers';

const databases: Database[] = [];
afterEach(async () => {
  await Promise.all(databases.splice(0).map(database => database.close()));
});

async function database(url?: string) {
  const result = new Database({ url: url ?? await createTestDatabase(), poolSize: 4 });
  databases.push(result);
  return result;
}

const once: MigrationSet[] = [{ module: 'lock-test', migrations: [sqlMigration('0001', 'expand', `
  CREATE TABLE migration_probe (id integer PRIMARY KEY);
  SELECT pg_sleep(0.05);
  INSERT INTO migration_probe VALUES (1);
`)] }];

describe('migration connection ownership', () => {
  it('acquires and releases the real advisory lock despite preceding schema functions', async () => {
    const url = await createTestDatabase(), setup = await database(url);
    const name = (await setup.pool.query('SELECT current_database() AS name')).rows[0].name;
    await setup.pool.query(`CREATE SCHEMA trap;
      CREATE FUNCTION trap.pg_advisory_lock(bigint) RETURNS void LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'shadow lock'; END $$;
      CREATE FUNCTION trap.pg_advisory_unlock(bigint) RETURNS boolean LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'shadow unlock'; END $$;
      ALTER DATABASE ${escapeIdentifier(name)} SET search_path = trap, pg_catalog, public`);
    const db = await database(url);
    await expect(db.pool.query('SELECT pg_advisory_lock(8140231::bigint)')).rejects.toThrow('shadow lock');
    await expect(withMigrationLock(db.pool, async client => {
      const locks = await client.query("SELECT count(*)::int AS count FROM pg_catalog.pg_locks WHERE pid = pg_catalog.pg_backend_pid() AND locktype = 'advisory' AND objid = 8140231");
      const blocked = await setup.pool.query('SELECT pg_catalog.pg_try_advisory_lock(8140231) AS acquired');
      expect(blocked.rows[0].acquired).toBe(false);
      return locks.rows[0].count;
    })).resolves.toBe(1);
    const released = await db.pool.query("SELECT count(*)::int AS count FROM pg_catalog.pg_locks WHERE pid = pg_catalog.pg_backend_pid() AND locktype = 'advisory' AND objid = 8140231");
    expect(released.rows[0].count).toBe(0);
  });

  it('serializes concurrent cold starts on the same pool', async () => {
    const db = await database();
    const runs = await Promise.all(Array.from({ length: 4 }, () => runMigrations(db.pool, once)));
    expect(runs.flat()).toEqual(['lock-test/0001']);
    expect((await db.pool.query('SELECT * FROM migration_probe')).rows).toEqual([{ id: 1 }]);
    expect(db.pool.totalCount).toBe(db.pool.idleCount);
  });

  it('serializes separate pools using the same database lock', async () => {
    const url = await createTestDatabase();
    const first = await database(url);
    const second = await database(url);
    const runs = await Promise.all([runMigrations(first.pool, once), runMigrations(second.pool, once)]);
    expect(runs.flat()).toEqual(['lock-test/0001']);
  });

  it('keeps the successful prefix, rolls back the failed step, and releases the lock for retry', async () => {
    const db = await database();
    const broken: MigrationSet[] = [{ ...once[0], migrations: [...once[0]!.migrations,
      sqlMigration('0002', 'expand', 'INSERT INTO migration_probe VALUES (2); SELECT missing_migration_function()'),
    ] }];
    await expect(runMigrations(db.pool, broken)).rejects.toThrow('missing_migration_function');
    expect((await db.pool.query('SELECT id FROM platform_migrations')).rows).toEqual([{ id: 'lock-test/0001' }]);
    expect((await db.pool.query('SELECT * FROM migration_probe')).rows).toEqual([{ id: 1 }]);
    const fixed: MigrationSet[] = [{ ...once[0], migrations: [...once[0]!.migrations,
      sqlMigration('0002', 'expand', 'INSERT INTO migration_probe VALUES (2)'),
    ] }];
    await expect(runMigrations(db.pool, fixed)).resolves.toEqual(['lock-test/0002']);
    await expect(runMigrations(db.pool, fixed)).resolves.toEqual([]);
    expect(db.pool.totalCount).toBe(db.pool.idleCount);
  });

  it('releases session ownership after backend termination and another pool can retry', async () => {
    const url = await createTestDatabase();
    const db = await database(url);
    const other = await database(url);
    const disconnected: MigrationSet[] = [{ module: 'disconnect', migrations: [
      sqlMigration('0001', 'expand', 'CREATE TABLE disconnected_probe (id integer)'),
      sqlMigration('0002', 'expand', 'SELECT pg_terminate_backend(pg_backend_pid())'),
    ] }];
    await expect(runMigrations(db.pool, disconnected)).rejects.toBeInstanceOf(AggregateError);
    expect(db.pool.totalCount).toBe(0);
    const recovered: MigrationSet[] = [{ ...disconnected[0], migrations: [
      disconnected[0]!.migrations[0]!, sqlMigration('0002', 'expand', 'INSERT INTO disconnected_probe VALUES (2)'),
    ] }];
    await expect(runMigrations(other.pool, recovered)).resolves.toEqual(['disconnect/0002']);
    expect((await other.pool.query('SELECT * FROM disconnected_probe')).rows).toEqual([{ id: 2 }]);
  });

  it('destroys a client whose lock ownership was lost instead of returning it to the pool', async () => {
    const db = await database();
    const lost: MigrationSet[] = [{ module: 'lost-lock', migrations: [sqlMigration('0001', 'expand', `
      CREATE TABLE migration_backend AS SELECT pg_backend_pid() AS pid;
      SELECT pg_advisory_unlock_all();
    `)] }];
    await expect(runMigrations(db.pool, lost)).rejects.toThrow('Migration advisory lock was not held');
    expect(db.pool.totalCount).toBe(0);
    await expect(runMigrations(db.pool, lost)).resolves.toEqual([]);
    const result = await db.pool.query('SELECT pid <> pg_backend_pid() AS replaced FROM migration_backend');
    expect(result.rows).toEqual([{ replaced: true }]);
  });
});
