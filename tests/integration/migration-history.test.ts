import { afterEach, describe, expect, it, vi } from 'vitest';
import { Database, baselineMigrations, legacyBaselineSelection, withReleaseSnapshot, catalogDigest, migrationCatalog, migrationStatus, prepareRelease, recordEffectiveRelease, runMigrations, sqlMigration, type MigrationSet } from '@storeweave/db';
import { createTestDatabase } from './helpers';

const databases: Database[] = [];
afterEach(async () => { await Promise.all(databases.splice(0).map(database => database.close())); });
async function database() {
  const db = new Database({ url: await createTestDatabase(), poolSize: 4 });
  databases.push(db);
  return db;
}
const first = sqlMigration('0001', 'expand', 'CREATE TABLE history_probe (id integer PRIMARY KEY)');
const second = sqlMigration('0002', 'migrate', 'INSERT INTO history_probe VALUES (2)');
const sets: MigrationSet[] = [{ module: 'history-test', migrations: [first, second] }];

describe('migration history validation', () => {
  it('records exact-byte checksums and per-owner positions, and rejects changed SQL before pending work', async () => {
    const db = await database();
    await runMigrations(db.pool, [{ module: 'history-test', migrations: [first] }]);
    const status = await migrationStatus(db.pool, sets);
    expect(status.applied[0]).toMatchObject({ id: 'history-test/0001', order: 1, phase: 'expand' });
    expect(status.applied[0]?.checksum).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(status.pending).toEqual([{ id: 'history-test/0002', phase: 'migrate' }]);
    const changed = [{ module: 'history-test', migrations: [{ ...first, up: `${first.up}\n` }, second] }];
    await expect(runMigrations(db.pool, changed)).rejects.toThrow('Migration history drift');
    expect((await db.pool.query('SELECT * FROM history_probe')).rows).toEqual([]);
    await expect(runMigrations(db.pool, sets)).resolves.toEqual(['history-test/0002']);
    expect((await migrationStatus(db.pool, sets)).applied.map(row => row.order)).toEqual([1, 2]);
  });

  it.each([
    ['phase', "UPDATE platform_migrations SET phase = 'contract'"],
    ['checksum', "UPDATE platform_migrations SET checksum = 'sha256:altered'"],
    ['order', 'UPDATE platform_migrations SET migration_order = 3'],
  ])('refuses stored %s drift in both status and migration', async (_name, update) => {
    const db = await database();
    await runMigrations(db.pool, [{ module: 'history-test', migrations: [first] }]);
    await db.pool.query(update);
    await expect(migrationStatus(db.pool, sets)).rejects.toThrow('Migration history drift');
    await expect(runMigrations(db.pool, sets)).rejects.toThrow('Migration history drift');
    expect((await db.pool.query('SELECT * FROM history_probe')).rows).toEqual([]);
  });

  it('rejects unknown rows and gaps without rerunning SQL', async () => {
    const db = await database();
    await runMigrations(db.pool, sets);
    await db.pool.query("INSERT INTO platform_migrations (id, phase) VALUES ('unknown/0001', 'expand')");
    await expect(runMigrations(db.pool, sets)).rejects.toThrow('Unknown migration history');
    await db.pool.query("DELETE FROM platform_migrations WHERE id IN ('unknown/0001', 'history-test/0001')");
    await expect(runMigrations(db.pool, sets)).rejects.toThrow('not an applied prefix');
    expect((await db.pool.query('SELECT * FROM history_probe')).rows).toEqual([{ id: 2 }]);
  });

  it('rejects duplicate owner, duplicate id, and source order before acquiring a connection', async () => {
    const db = await database();
    const connect = vi.spyOn(db.pool, 'connect');
    await expect(runMigrations(db.pool, [...sets, ...sets])).rejects.toThrow('duplicate migration owner');
    await expect(runMigrations(db.pool, [{ module: 'history-test', migrations: [first, first] }])).rejects.toThrow('unique and increasing');
    await expect(runMigrations(db.pool, [{ module: 'history-test', migrations: [second, first] }])).rejects.toThrow('unique and increasing');
    expect(connect).not.toHaveBeenCalled();
    connect.mockRestore();
  });

  it('refuses checksumless legacy history without guessing what SQL previously ran', async () => {
    const db = await database();
    await db.pool.query(`CREATE TABLE platform_migrations (
      id text PRIMARY KEY, phase text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    await db.pool.query(first.up);
    await db.pool.query("INSERT INTO platform_migrations (id, phase) VALUES ('history-test/0001', 'expand')");
    await expect(runMigrations(db.pool, sets)).rejects.toThrow('requires an explicit baseline');
    expect((await db.pool.query('SELECT checksum, migration_order FROM platform_migrations')).rows)
      .toEqual([{ checksum: null, migration_order: null }]);
    expect((await db.pool.query('SELECT * FROM history_probe')).rows).toEqual([]);
  });
});

function pinnedBaseline(count = 2) {
  const owner = { kind: 'module' as const, id: 'history-test', version: '0.1.0', dataRelations: ['history_probe'],
    migrationOwner: 'history-test', migrations: migrationCatalog(sets).slice(0, count)
      .map(({ id, owner, phase, checksum, order }) => ({ id: id.slice(owner.length + 1), phase, checksum, order })),
    work: { jobTypes: [], subscriberIds: [], emittedEventNames: [], subscribedEventNames: [] } };
  return { id: 'legacy-test', sourceRelease: 'test@0.1.0', manifest: {
    schemaVersion: 1 as const, releaseId: 'test', releaseVersion: '0.1.0', baseVersion: '1.0.0',
    buildManifestChecksum: catalogDigest(owner), owners: [{ state: 'active' as const, owner }],
  } };
}
const baseline = pinnedBaseline();
async function legacyDatabase(count = 2) {
  const db = await database();
  await db.pool.query(`CREATE TABLE platform_migrations (
    id text PRIMARY KEY, phase text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now()
  )`);
  for (const migration of [first, second].slice(0, count)) {
    await db.pool.query(migration.up);
    await db.pool.query('INSERT INTO platform_migrations (id, phase) VALUES ($1, $2)',
      [`history-test/${migration.id}`, migration.phase]);
  }
  return db;
}

describe('explicit legacy baseline', () => {
  it('captures only the fixed legacy SQL prefix while a candidate contains later migrations', async () => {
    const db = await legacyDatabase(1);
    const pinned = pinnedBaseline(1);
    await baselineMigrations(db.pool, sets, pinned, 'operator=test');
    const source = legacyBaselineSelection(pinned, sets);
    expect(source.migrations).toEqual([{ module: 'history-test', migrations: [first] }]);
    await expect(withReleaseSnapshot(db.pool, source.selection, sets, async snapshot => snapshot))
      .rejects.toThrow('Active SQL differs from release pins');
    const snapshot = await withReleaseSnapshot(db.pool, source.selection, source.migrations, async captured => captured);
    expect(snapshot.release.checksum).toBe(catalogDigest(pinned.manifest));
    expect((await db.pool.query('SELECT * FROM history_probe')).rows).toEqual([]);
    expect(() => legacyBaselineSelection(pinned, [{ module: 'history-test', migrations: [{ ...first, up: first.up + '\n' }, second] }]))
      .toThrow('Legacy baseline does not match');
    expect((await db.pool.query('SELECT historical_sql_verified, historical_runtime_verified FROM public.platform_migration_baselines')).rows)
      .toEqual([{ historical_sql_verified: false, historical_runtime_verified: false }]);
  });

  it('atomically adopts effective history and provenance, retains disabled data, and stores both unverified flags', async () => {
    const db = await legacyDatabase();
    const result = await baselineMigrations(db.pool, sets, baseline, 'operator=test');
    expect(result).toMatchObject({ historicalSqlVerified: false, historicalRuntimeVerified: false });
    const sourceSelection = legacyBaselineSelection(baseline, sets).selection;
    const captured = await withReleaseSnapshot(db.pool, sourceSelection, sets, async snapshot => snapshot);
    expect(captured.release).toMatchObject({ releaseId: baseline.manifest.releaseId, releaseVersion: baseline.manifest.releaseVersion,
      buildManifestChecksum: baseline.manifest.buildManifestChecksum, checksum: catalogDigest(baseline.manifest) });

    expect((await db.pool.query(`SELECT migration_owner, migration_id, module_id, module_version, release_id, release_version
      FROM platform_migrations ORDER BY id`)).rows).toEqual(['0001', '0002'].map(id => ({
      migration_owner: 'history-test', migration_id: id, module_id: 'history-test', module_version: '0.1.0',
      release_id: 'test', release_version: '0.1.0',
    })));
    expect((await db.pool.query(`SELECT historical_sql_verified, historical_runtime_verified
      FROM platform_migration_baselines WHERE id=$1`, [result.baselineId])).rows)
      .toEqual([{ historical_sql_verified: false, historical_runtime_verified: false }]);
    expect((await db.pool.query('SELECT legacy_baseline_id FROM platform_release_history')).rows)
      .toEqual([{ legacy_baseline_id: result.baselineId }]);
    const next = await prepareRelease(db.pool, { releaseId: 'base', releaseVersion: '0.1.0', baseVersion: '1.0.0',
      buildManifestChecksum: catalogDigest([]), activeOwners: [] }, [], 'apply');
    expect(next.appliedMigrations).toEqual([]);
    expect(next.manifest.owners[0]?.state).toBe('disabled');
    await recordEffectiveRelease(db.pool, next, next.manifest);
    expect((await db.pool.query('SELECT * FROM history_probe')).rows).toEqual([{ id: 2 }]);
    await expect(baselineMigrations(db.pool, sets, baseline, 'retry')).rejects.toThrow('differs from legacy baseline');
  });

  it('finishes adoption when checksums already exist, and rolls back if effective history insertion fails', async () => {
    const db = await legacyDatabase();
    await expect(migrationStatus(db.pool, sets)).rejects.toThrow('explicit baseline');
    for (const pin of migrationCatalog(sets)) {
      await db.pool.query('UPDATE platform_migrations SET checksum=$2, migration_order=$3 WHERE id=$1', [pin.id, pin.checksum, pin.order]);
    }
    await db.pool.query("ALTER TABLE platform_release_history ADD CONSTRAINT reject_adoption CHECK (release_id <> 'test')");
    await expect(baselineMigrations(db.pool, sets, baseline, 'test')).rejects.toThrow('reject_adoption');
    expect((await db.pool.query('SELECT count(*)::int AS count FROM platform_migration_baselines')).rows).toEqual([{ count: 0 }]);
    expect((await db.pool.query('SELECT module_id, legacy_baseline_id FROM platform_migrations')).rows)
      .toEqual([{ module_id: null, legacy_baseline_id: null }, { module_id: null, legacy_baseline_id: null }]);
    await db.pool.query('ALTER TABLE platform_release_history DROP CONSTRAINT reject_adoption');
    const result = await baselineMigrations(db.pool, sets, baseline, 'retry');
    expect(result.adopted).toEqual([]);
    expect(result.baselineId).not.toBeNull();
    expect((await db.pool.query('SELECT count(*)::int AS count FROM platform_release_history')).rows).toEqual([{ count: 1 }]);
    await expect(baselineMigrations(db.pool, sets, baseline, 'repeat')).resolves.toMatchObject({ baselineId: null });
    await db.pool.query("UPDATE platform_migrations SET module_id=NULL WHERE id='history-test/0001'");
    await expect(baselineMigrations(db.pool, sets, baseline, 'corrupt')).rejects.toThrow('incomplete');
  });

  it('records adopted catalog and evidence, preserves SQL history, and is repeatable', async () => {
    const db = await legacyDatabase(1);
    const baseline = pinnedBaseline(1);
    const before = (await db.pool.query('SELECT id, phase, applied_at FROM platform_migrations')).rows;
    const result = await baselineMigrations(db.pool, sets, baseline, 'operator=test; source=legacy fixture');
    expect(result).toMatchObject({ adopted: ['history-test/0001'], historicalSqlVerified: false });
    expect(result.baselineId).toMatch(/^[a-f0-9-]{36}$/);
    expect((await db.pool.query('SELECT id, phase, applied_at FROM platform_migrations')).rows).toEqual(before);
    expect((await db.pool.query('SELECT catalog_id, source_release, evidence FROM platform_migration_baselines')).rows)
      .toEqual([{ catalog_id: baseline.id, source_release: baseline.sourceRelease, evidence: 'operator=test; source=legacy fixture' }]);
    await expect(baselineMigrations(db.pool, sets, baseline, 'same fixture')).resolves.toMatchObject({ baselineId: null, adopted: [] });
    await expect(runMigrations(db.pool, sets)).resolves.toEqual(['history-test/0002']);
    expect((await db.pool.query('SELECT * FROM history_probe')).rows).toEqual([{ id: 2 }]);
  });

  it('upgrades an earlier SQL-only baseline association without executing pending SQL', async () => {
    const db = await legacyDatabase();
    await expect(migrationStatus(db.pool, sets)).rejects.toThrow('explicit baseline');
    const before = (await db.pool.query('SELECT id, phase, applied_at FROM platform_migrations ORDER BY id')).rows;
    await db.pool.query(`INSERT INTO platform_migration_baselines(id, catalog_id, source_release, catalog_checksum, evidence)
      VALUES ('old-baseline','legacy-test','test@0.1.0','old-catalog-digest','original operator evidence')`);
    for (const pin of migrationCatalog(sets)) {
      await db.pool.query("UPDATE platform_migrations SET checksum=$2, migration_order=$3, legacy_baseline_id='old-baseline' WHERE id=$1",
        [pin.id, pin.checksum, pin.order]);
    }
    const future = [{ ...sets[0]!, migrations: [...sets[0]!.migrations, sqlMigration('0003', 'migrate', 'INSERT INTO history_probe VALUES (99)')] }];
    const result = await baselineMigrations(db.pool, future, baseline, 'adopt effective history');
    expect(result).toMatchObject({ adopted: [], historicalSqlVerified: false, historicalRuntimeVerified: false });
    expect(result.baselineId).not.toBeNull();
    expect((await db.pool.query('SELECT id, phase, applied_at FROM platform_migrations ORDER BY id')).rows).toEqual(before);
    expect((await db.pool.query("SELECT evidence FROM platform_migration_baselines WHERE id='old-baseline'")).rows)
      .toEqual([{ evidence: 'original operator evidence' }]);
    expect((await db.pool.query('SELECT legacy_baseline_id FROM platform_release_history')).rows)
      .toEqual([{ legacy_baseline_id: result.baselineId }]);
    expect((await db.pool.query('SELECT * FROM history_probe')).rows).toEqual([{ id: 2 }]);
    await expect(baselineMigrations(db.pool, future, baseline, 'repeat')).resolves.toMatchObject({ baselineId: null });
  });

  it.each([
    ["UPDATE platform_migrations SET phase = 'contract' WHERE id = 'history-test/0001'", 'not covered'],
    ["DELETE FROM platform_migrations WHERE id = 'history-test/0001'", 'not an applied prefix'],
    ["INSERT INTO platform_migrations (id, phase) VALUES ('unknown/0001', 'expand')", 'not covered'],
    ["UPDATE platform_migrations SET applied_at = now() + interval '1 day' WHERE id = 'history-test/0001'", 'timestamp order'],
  ])('refuses inconsistent legacy evidence without filling checksums: %s', async (change, error) => {
    const db = await legacyDatabase();
    await db.pool.query(change);
    await expect(baselineMigrations(db.pool, sets, baseline, 'test')).rejects.toThrow(error);
    expect((await db.pool.query('SELECT count(*)::int AS count FROM platform_migrations WHERE checksum IS NOT NULL')).rows)
      .toEqual([{ count: 0 }]);
    expect((await db.pool.query('SELECT count(*)::int AS count FROM platform_migration_baselines')).rows).toEqual([{ count: 0 }]);
  });

  it('rejects unpinned SQL or empty evidence before database access', async () => {
    const db = await database();
    const connect = vi.spyOn(db.pool, 'connect');
    await expect(baselineMigrations(db.pool, sets, { ...baseline, manifest: { ...baseline.manifest, owners: [{ ...baseline.manifest.owners[0]!, owner: { ...baseline.manifest.owners[0]!.owner, migrations: [{ ...baseline.manifest.owners[0]!.owner.migrations[0]!, checksum: `sha256:${'0'.repeat(64)}` }] } }] } }, 'test'))
      .rejects.toThrow('does not match');
    await expect(baselineMigrations(db.pool, sets, baseline, ' ')).rejects.toThrow('operator evidence');
    expect(connect).not.toHaveBeenCalled();
    connect.mockRestore();
  });

  it('rolls back the baseline record and all prior row updates if a later update fails', async () => {
    const db = await legacyDatabase();
    await expect(migrationStatus(db.pool, sets)).rejects.toThrow('explicit baseline');
    await db.pool.query(`ALTER TABLE platform_migrations ADD CONSTRAINT reject_second
      CHECK (id <> 'history-test/0002' OR checksum IS NULL)`);
    await expect(baselineMigrations(db.pool, sets, baseline, 'test')).rejects.toThrow('reject_second');
    expect((await db.pool.query('SELECT checksum FROM platform_migrations')).rows).toEqual([{ checksum: null }, { checksum: null }]);
    expect((await db.pool.query('SELECT count(*)::int AS count FROM platform_migration_baselines')).rows).toEqual([{ count: 0 }]);
    await db.pool.query('ALTER TABLE platform_migrations DROP CONSTRAINT reject_second');
    await expect(baselineMigrations(db.pool, sets, baseline, 'retry')).resolves.toMatchObject({ adopted: ['history-test/0001', 'history-test/0002'] });
  });
});
