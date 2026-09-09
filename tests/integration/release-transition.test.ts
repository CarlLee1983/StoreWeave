import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterEach, describe, expect, it } from 'vitest';
import { baselineMigrations, catalogDigest, legacyBaselineSelection, migrationCatalog, platformMigrations, prepareRelease, recordEffectiveRelease as finalizeRelease, releaseMigrationStatus, runMigrations, sqlMigration,
  type EffectiveReleaseManifest, type PreparedRelease, type MigrationSet, type ModulePin, type ReleaseOwnerPin, type ReleaseSelection } from '@storeweave/db';
import { identityMigrations } from '@storeweave/identity';
import { cacheMigrations } from '@storeweave/cache';
import { storageMigrations } from '@storeweave/storage';
import { mailMigrations } from '@storeweave/mail';
import { buildReleaseManifest } from '../../packages/platform/bundle/src/release-manifest';
import { release as base } from '../../packages/platform/bundle/src/releases/base';
import { release as commerce } from '../../packages/platform/bundle/src/releases/commerce';
import legacyCommerce from '../../packages/platform/bundle/src/legacy/commerce-pre-b02.json';
import { ProviderRegistry } from '@storeweave/extension-sdk';
import { createTestDatabase } from './helpers';

const pools: Pool[] = [];
afterEach(async () => { await Promise.all(pools.splice(0).map(pool => pool.end())); });
async function database() {
  const pool = new Pool({ connectionString: await createTestDatabase() });
  pools.push(pool);
  return pool;
}
const foundations: ModulePin[] = buildReleaseManifest(base).modules.map(({ baseVersionRange: _range,
  requiredDependencies: _required, optionalDependencies: _optional, ...pin }) => pin);
const baseSets = [platformMigrations, cacheMigrations, identityMigrations, storageMigrations, mailMigrations];
const featureSet: MigrationSet = { module: 'feature', migrations: [
  sqlMigration('0001', 'expand', 'CREATE TABLE feature_rows(id integer PRIMARY KEY); INSERT INTO feature_rows VALUES (1)'),
] };
function feature(set = featureSet, version = '1.0.0'): ModulePin {
  return { kind: 'module', id: 'feature', version,
    dataRelations: ['feature_rows'], migrationOwner: set.module,
    migrations: migrationCatalog([set]).map(({ id, owner, phase, checksum, order }) => ({ id: id.slice(owner.length + 1), phase, checksum, order })),
    work: { jobTypes: ['feature.run'], subscriberIds: [], emittedEventNames: ['probe.created.v1'], subscribedEventNames: [] } };
}
const observer: ModulePin = { kind: 'module', id: 'observer', version: '1.0.0', dataRelations: [], migrationOwner: null, migrations: [],
  work: { jobTypes: [], subscriberIds: ['observer'], emittedEventNames: [], subscribedEventNames: ['probe.created.v1'] } };
function selection(owners: readonly ReleaseOwnerPin[] = []): ReleaseSelection {
  const activeOwners = [...foundations, ...owners];
  return { releaseId: 'test-release', releaseVersion: '1.0.0', baseVersion: '1.0.0',
    buildManifestChecksum: catalogDigest(activeOwners), activeOwners };
}
async function activate(pool: Pool, owners: readonly ReleaseOwnerPin[], sets = [featureSet]) {
  const prepared = await prepareRelease(pool, selection(owners), [...baseSets, ...sets], 'apply');
  const recorded = await recordEffectiveRelease(pool, prepared, prepared.manifest);
  return { prepared, recorded };
}
function recordEffectiveRelease(pool: Pool, prepared: PreparedRelease, actual: EffectiveReleaseManifest) {
  return finalizeRelease(pool, prepared, actual, actual.owners
    .filter(entry => entry.state === 'active' && entry.owner.kind === 'extension')
    .map(({ owner }) => ({ id: owner.id, name: owner.id, version: owner.version, platformVersion: '*', permissions: [] })));
}
async function historyCount(pool: Pool) {
  return Number((await pool.query('SELECT count(*) AS count FROM platform_release_history')).rows[0].count);
}
async function job(pool: Pool, type: string, status: string, payload: unknown = {}) {
  await pool.query('INSERT INTO platform_jobs(id, type, status, payload) VALUES ($1,$2,$3,$4::jsonb)',
    [randomUUID(), type, status, JSON.stringify(payload)]);
}
async function outbox(pool: Pool, status: string, event = 'probe.created.v1') {
  await pool.query(`INSERT INTO platform_outbox(id, event_name, event_version, payload, actor_id, correlation_id, status)
    VALUES ($1,$2,1,'{}','test','test',$3)`, [randomUUID(), event, status]);
}

describe('release transitions', () => {
  it('commits registry and history together, and leaves neither on a history insertion failure', async () => {
    const pool = await database();
    const extension: ReleaseOwnerPin = { kind: 'extension', id: 'atomic-probe', version: '1.0.0', migrations: [],
      work: { jobTypes: [], subscriberIds: [], emittedEventNames: [], subscribedEventNames: [] } };
    const prepared = await prepareRelease(pool, selection([extension]), baseSets, 'apply');
    await expect(finalizeRelease(pool, prepared, prepared.manifest)).rejects.toThrow('registry differs');
    await pool.query("ALTER TABLE platform_release_history ADD CONSTRAINT fail_history CHECK (release_id <> 'test-release')");
    await expect(recordEffectiveRelease(pool, prepared, prepared.manifest)).rejects.toThrow('fail_history');
    expect(await historyCount(pool)).toBe(0);
    expect((await pool.query('SELECT id FROM platform_extension_registry')).rows).toEqual([]);
    await pool.query('ALTER TABLE platform_release_history DROP CONSTRAINT fail_history');
    await recordEffectiveRelease(pool, prepared, prepared.manifest);
    await pool.query('DELETE FROM platform_extension_registry');
    await expect(recordEffectiveRelease(pool, prepared, prepared.manifest)).resolves.toMatchObject({ changed: false });
    expect(await historyCount(pool)).toBe(1);
    const registry = [{ id: extension.id, name: extension.id, version: extension.version, platformVersion: '*', permissions: [] }];
    for (const invalid of [[], [...registry, ...registry], [{ ...registry[0]!, id: 'unknown' }], [{ ...registry[0]!, version: '2.0.0' }]]) {
      await expect(finalizeRelease(pool, prepared, prepared.manifest, invalid)).rejects.toThrow('registry differs');
    }
    await activate(pool, [extension, observer], []);
    const before = (await pool.query('SELECT * FROM platform_extension_registry')).rows;
    await expect(finalizeRelease(pool, prepared, prepared.manifest, [{ id: extension.id, name: 'stale writer',
      version: extension.version, platformVersion: '*', permissions: [] }])).rejects.toThrow('changed during setup');
    expect((await pool.query('SELECT * FROM platform_extension_registry')).rows).toEqual(before);
  });

  it('rolls back earlier registry updates if a later registry row fails', async () => {
    const pool = await database();
    const first: ReleaseOwnerPin = { kind: 'extension', id: 'first-probe', version: '1.0.0', migrations: [],
      work: { jobTypes: [], subscriberIds: [], emittedEventNames: [], subscribedEventNames: [] } };
    await activate(pool, [first], []);
    const second = { ...first, id: 'second-probe' };
    const prepared = await prepareRelease(pool, selection([first, second]), baseSets, 'apply');
    await pool.query("ALTER TABLE platform_extension_registry ADD CONSTRAINT fail_registry CHECK (name <> 'reject')");
    await expect(finalizeRelease(pool, prepared, prepared.manifest, [
      { id: first.id, name: 'updated', version: first.version, platformVersion: '*', permissions: [] },
      { id: second.id, name: 'reject', version: second.version, platformVersion: '*', permissions: [] },
    ])).rejects.toThrow('fail_registry');
    expect((await pool.query('SELECT id, name FROM platform_extension_registry')).rows).toEqual([{ id: first.id, name: first.id }]);
    expect(await historyCount(pool)).toBe(1);
    await pool.query('ALTER TABLE platform_extension_registry DROP CONSTRAINT fail_registry');
    await recordEffectiveRelease(pool, prepared, prepared.manifest);
    expect(await historyCount(pool)).toBe(2);
  });

  it('serializes identical extension finalizers into one history row and one registry row', async () => {
    const pool = await database();
    const extension: ReleaseOwnerPin = { kind: 'extension', id: 'concurrent-probe', version: '1.0.0', migrations: [],
      work: { jobTypes: [], subscriberIds: [], emittedEventNames: [], subscribedEventNames: [] } };
    const [first, second] = await Promise.all([prepareRelease(pool, selection([extension]), baseSets, 'apply'),
      prepareRelease(pool, selection([extension]), baseSets, 'apply')]);
    const result = await Promise.all([recordEffectiveRelease(pool, first, first.manifest), recordEffectiveRelease(pool, second, second.manifest)]);
    expect(result.map(entry => entry.changed).sort()).toEqual([false, true]);
    expect(await historyCount(pool)).toBe(1);
    expect((await pool.query('SELECT id, version FROM platform_extension_registry')).rows).toEqual([{ id: extension.id, version: extension.version }]);
  });

  it('adopts the full pinned Commerce legacy state before forward Base migrations', async () => {
    const pool = await database();
    const modules = commerce.createModules({ config: commerce.config.schema.parse(commerce.manifestConfig), providers: new ProviderRegistry() });
    const sets = [...baseSets, ...modules.flatMap(module => module.migrations ? [module.migrations] : [])];
    const legacySource = legacyBaselineSelection(legacyCommerce, sets);
    await pool.query('CREATE TABLE platform_migrations(id text PRIMARY KEY, phase text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())');
    // Create the fixed pre-B02 source fixture, never an unpinned slice of the
    // current catalog (which legitimately contains later B04 migrations).
    for (const migration of migrationCatalog(legacySource.migrations)) {
      await pool.query(migration.up);
      await pool.query('INSERT INTO platform_migrations(id, phase) VALUES ($1,$2)', [migration.id, migration.phase]);
    }
    const productId = randomUUID();
    await pool.query("INSERT INTO catalog_products(id, sku, name, price_cents, currency) VALUES ($1,'legacy','Legacy product',123,'TWD')", [productId]);
    const before = (await pool.query('SELECT id, phase, applied_at FROM platform_migrations ORDER BY id')).rows;
    const adopted = await baselineMigrations(pool, sets, legacyCommerce, 'isolated old three-column Commerce fixture');
    expect(adopted.adopted).toHaveLength(49);
    expect((await pool.query('SELECT id, phase, applied_at FROM platform_migrations ORDER BY id')).rows).toEqual(before);
    expect((await pool.query('SELECT count(*)::int AS count FROM platform_migrations WHERE module_id IS NOT NULL')).rows).toEqual([{ count: 49 }]);
    await expect(baselineMigrations(pool, sets, legacyCommerce, 'repeat')).resolves.toMatchObject({ baselineId: null, adopted: [] });
    const prepared = await prepareRelease(pool, { ...selection(), releaseId: 'base', releaseVersion: '0.1.0' }, baseSets, 'apply');
    expect(prepared.appliedMigrations).toEqual([
      'platform/0003_job_occurrence_fencing',
      'platform/0004_job_payload_quarantine',
      'platform/0005_outbox_subscriber_snapshot_quarantine',
      'platform/0006_job_retention_dedupe_horizon',
      'platform/0007_ops_listing_indexes',
      'platform/0008_job_schedules',
      'platform-cache/0001_init',
      'platform-storage/0001_init',
      'platform-mail/0001_init',
    ]);
    expect(prepared.manifest.owners.filter(entry => entry.state === 'active')).toHaveLength(6);
    expect(prepared.manifest.owners.filter(entry => entry.state === 'disabled')).toHaveLength(22);
    expect(JSON.stringify(prepared.manifest)).not.toContain('CREATE TABLE');
    await recordEffectiveRelease(pool, prepared, prepared.manifest);
    expect((await pool.query('SELECT name, price_cents FROM catalog_products WHERE id=$1', [productId])).rows)
      .toEqual([{ name: 'Legacy product', price_cents: 123 }]);
    expect((await pool.query("SELECT nextval('order_number_seq')::int AS value")).rows).toEqual([{ value: 1000 }]);
  });

  it.each(['pending', 'dead'])('requires draining %s legacy outbox subscriptions or explicitly adopting their configured extension', async status => {
    const pool = await database();
    const sets = [...baseSets, featureSet];
    await runMigrations(pool, sets);
    const extension: ReleaseOwnerPin = { kind: 'extension', id: 'legacy-observer', version: '1.0.0', migrations: [],
      work: { jobTypes: [], subscriberIds: ['legacy-observer'], emittedEventNames: [], subscribedEventNames: ['probe.created.v1'] } };
    const selected = selection([feature(), extension]);
    const baseline = { id: 'legacy-test', sourceRelease: 'test@1.0.0', manifest: {
      schemaVersion: 1, releaseId: selected.releaseId, releaseVersion: selected.releaseVersion,
      baseVersion: selected.baseVersion, buildManifestChecksum: selected.buildManifestChecksum,
      owners: selected.activeOwners.map(owner => ({ state: owner.kind === 'extension' ? 'disabled' : 'active', owner })),
    } };
    await outbox(pool, status);
    await expect(baselineMigrations(pool, sets, baseline, 'operator=test')).rejects.toThrow('subscription removed');
    expect(await historyCount(pool)).toBe(0);
    await expect(baselineMigrations(pool, sets, baseline, 'operator=test', ['unknown'])).rejects.toThrow('not covered');
    await baselineMigrations(pool, sets, baseline, 'operator=test; current config enables legacy-observer', ['legacy-observer']);
    expect(await historyCount(pool)).toBe(1);
    await expect(activate(pool, [feature()])).rejects.toThrow('subscription removed');
  });

  it('retains owned sequences alongside tables and refuses a missing sequence', async () => {
    const pool = await database();
    const set = { ...featureSet, migrations: [...featureSet.migrations,
      sqlMigration('0002', 'expand', 'CREATE SEQUENCE feature_sequence START 41')] };
    const owner = { ...feature(set), dataRelations: ['feature_rows', 'feature_sequence'] };
    await activate(pool, [owner], [set]);
    await activate(pool, [], []);
    expect((await pool.query("SELECT nextval('feature_sequence')::int AS value")).rows).toEqual([{ value: 41 }]);
    await activate(pool, [owner], [set]);
    expect((await pool.query("SELECT nextval('feature_sequence')::int AS value")).rows).toEqual([{ value: 42 }]);
    await pool.query('DROP SEQUENCE feature_sequence');
    await expect(activate(pool, [], [])).rejects.toThrow('feature_sequence');
  });

  it('reports pending SQL and migrationless transitions without applying or losing disabled history', async () => {
    const pool = await database();
    const fresh = await releaseMigrationStatus(pool, selection([feature()]), [...baseSets, featureSet]);
    expect(fresh).toMatchObject({ releaseCurrent: false, applied: [] });
    expect(fresh.pending).toContainEqual({ id: 'feature/0001', phase: 'expand' });
    expect((await pool.query("SELECT to_regclass('feature_rows') AS table_name")).rows[0].table_name).toBeNull();
    expect(await historyCount(pool)).toBe(0);
    await activate(pool, [feature()]);
    await expect(releaseMigrationStatus(pool, selection([feature(), observer]), [...baseSets, featureSet]))
      .resolves.toMatchObject({ releaseCurrent: false, pending: [] });
    expect(await historyCount(pool)).toBe(1);
    await activate(pool, [], []);
    const disabled = await releaseMigrationStatus(pool, selection(), baseSets);
    expect(disabled).toMatchObject({ releaseCurrent: true, pending: [] });
    expect(disabled.applied.map(row => row.id)).toContain('feature/0001');
    expect(await historyCount(pool)).toBe(2);
  });

  it('round-trips neutral v1 pins and rejects graph fields or qualified migration ids', async () => {
    const pool = await database();
    const extension: ReleaseOwnerPin = { kind: 'extension', id: 'probe-plugin', version: '1.0.0', migrations: [],
      work: { jobTypes: [], subscriberIds: [], emittedEventNames: [], subscribedEventNames: [] } };
    const { prepared } = await activate(pool, [feature(), extension]);
    const stored = (await pool.query('SELECT effective_manifest FROM platform_release_history')).rows[0].effective_manifest;
    expect(stored).toEqual(prepared.manifest);
    expect(stored.owners.find((entry: { owner: { id: string } }) => entry.owner.id === 'feature').owner.migrations[0].id).toBe('0001');
    expect(stored.owners.find((entry: { owner: { id: string } }) => entry.owner.id === 'probe-plugin').owner.migrations).toEqual([]);
    await expect(prepareRelease(pool, { ...selection(), activeOwners: buildReleaseManifest(base).modules }, baseSets, 'apply'))
      .rejects.toThrow('Unrecognized key');
    const qualified = feature();
    await expect(activate(pool, [{ ...qualified, migrations: qualified.migrations.map(pin => ({ ...pin, id: `feature/${pin.id}` })) }]))
      .rejects.toThrow('Invalid migration pin');
    const disabled = await activate(pool, [], []);
    expect(disabled.prepared.manifest.owners.filter(entry => entry.state === 'disabled').map(entry => entry.owner))
      .toEqual([feature(), extension]);
  });

  it('records effective state only after finalize, preserves disabled data, and applies only forward SQL on re-enable', async () => {
    const pool = await database();
    const prepared = await prepareRelease(pool, selection([feature()]), [...baseSets, featureSet], 'apply');
    expect(await historyCount(pool)).toBe(0);
    await recordEffectiveRelease(pool, prepared, prepared.manifest);
    const disabled = await activate(pool, [], []);
    expect(disabled.prepared.appliedMigrations).toEqual([]);
    expect(disabled.prepared.manifest.owners.find(entry => entry.owner.id === 'feature')?.state).toBe('disabled');
    expect(JSON.stringify(disabled.prepared.manifest)).not.toContain('CREATE TABLE');
    expect((await pool.query('SELECT * FROM feature_rows')).rows).toEqual([{ id: 1 }]);
    const upgradedSet = { ...featureSet, migrations: [...featureSet.migrations,
      sqlMigration('0002', 'migrate', 'INSERT INTO feature_rows VALUES (2)')] };
    const enabled = await activate(pool, [feature(upgradedSet, '1.1.0')], [upgradedSet]);
    expect(enabled.prepared.appliedMigrations).toEqual(['feature/0002']);
    expect((await pool.query('SELECT * FROM feature_rows ORDER BY id')).rows).toEqual([{ id: 1 }, { id: 2 }]);
    expect((await pool.query("SELECT module_id, module_version, release_id FROM platform_migrations WHERE id='feature/0002'")).rows)
      .toEqual([{ module_id: 'feature', module_version: '1.1.0', release_id: 'test-release' }]);
    await expect(activate(pool, [feature()], [featureSet])).rejects.toThrow('downgrade');
  });

  it('records migrationless changes, rejects require-current transitions, and makes identical finalizers idempotent', async () => {
    const pool = await database();
    await activate(pool, [], []);
    await expect(prepareRelease(pool, selection([observer]), baseSets, 'require-current')).rejects.toThrow('requires the migrate command');
    const [first, second] = await Promise.all([prepareRelease(pool, selection([observer]), baseSets, 'apply'),
      prepareRelease(pool, selection([observer]), baseSets, 'apply')]);
    expect(await historyCount(pool)).toBe(1);
    const results = await Promise.all([recordEffectiveRelease(pool, first, first.manifest), recordEffectiveRelease(pool, second, second.manifest)]);
    expect(results.map(result => result.changed).sort()).toEqual([false, true]);
    expect(await historyCount(pool)).toBe(2);
    await expect(prepareRelease(pool, selection([observer]), baseSets, 'require-current')).resolves.toMatchObject({ appliedMigrations: [] });
  });

  it('rejects stale finalizers after an intervening release even when the latest target matches again', async () => {
    const pool = await database();
    await activate(pool, [feature(), observer]);
    const stale = await prepareRelease(pool, selection([feature()]), [...baseSets, featureSet], 'apply');
    await recordEffectiveRelease(pool, stale, stale.manifest);
    await activate(pool, [feature(), observer]);
    await activate(pool, [feature()]);
    await expect(recordEffectiveRelease(pool, stale, stale.manifest)).rejects.toThrow('changed during setup');
    expect(await historyCount(pool)).toBe(4);
  });

  it('rejects an intervening different release and rechecks work produced during setup', async () => {
    const pool = await database();
    await activate(pool, [feature()]);
    const removing = await prepareRelease(pool, selection(), baseSets, 'apply');
    await job(pool, 'feature.run', 'pending');
    await expect(recordEffectiveRelease(pool, removing, removing.manifest)).rejects.toThrow('disabled');
    expect(await historyCount(pool)).toBe(1);
    await pool.query("UPDATE platform_jobs SET status='completed'");
    const other = await prepareRelease(pool, selection([feature(), observer]), [...baseSets, featureSet], 'apply');
    await recordEffectiveRelease(pool, other, other.manifest);
    await expect(recordEffectiveRelease(pool, removing, removing.manifest)).rejects.toThrow('changed during setup');
  });

  it.each(['pending', 'running', 'dead'])('blocks %s direct and subscriber jobs before disabling their owners', async status => {
    const pool = await database();
    await activate(pool, [feature(), observer]);
    await job(pool, 'feature.run', status);
    await expect(activate(pool, [], [])).rejects.toThrow('disabled');
    await pool.query("UPDATE platform_jobs SET status='completed'");
    await job(pool, 'platform.event.deliver', status, { subscriberId: 'observer', event: { name: 'probe.created.v1' } });
    await expect(activate(pool, [feature()])).rejects.toThrow('disabled');
    expect(await historyCount(pool)).toBe(1);
  });

  it.each(['pending', 'dead'])('blocks %s outbox events when emitter or subscriber is removed', async status => {
    const pool = await database();
    await activate(pool, [feature(), observer]);
    await outbox(pool, status);
    await expect(activate(pool, [], [])).rejects.toThrow('disabled');
    await expect(activate(pool, [feature()])).rejects.toThrow('subscription removed');
    await pool.query("UPDATE platform_outbox SET status='relayed'");
    await expect(activate(pool, [], [])).resolves.toMatchObject({ recorded: { changed: true } });
  });

  it.each(['pending', 'dead'])('allows %s outbox events created after a subscriber was disabled', async status => {
    const pool = await database();
    await activate(pool, [feature(), observer]);
    await activate(pool, [feature()]);
    await outbox(pool, status);
    await expect(activate(pool, [feature()])).resolves.toMatchObject({ recorded: { changed: false } });
    const next = { ...feature(), version: '1.1.0' };
    await expect(activate(pool, [next])).resolves.toMatchObject({ recorded: { changed: true } });
  });

  it('blocks removal of work or subscriptions even while their owner remains active', async () => {
    const pool = await database();
    await activate(pool, [feature(), observer]);
    await job(pool, 'feature.run', 'pending');
    const withoutJobs = { ...feature(), work: { ...feature().work, jobTypes: [] } };
    await expect(activate(pool, [withoutJobs, observer])).rejects.toThrow('unknown');
    await pool.query("UPDATE platform_jobs SET status='completed'");
    await outbox(pool, 'pending');
    const withoutSubscriptions = { ...observer, work: { ...observer.work, subscriberIds: [], subscribedEventNames: [] } };
    await expect(activate(pool, [feature(), withoutSubscriptions])).rejects.toThrow('subscription removed');
  });

  it.each(['job', 'subscriber', 'event', 'payload'])('fails closed for unknown/malformed %s work', async kind => {
    const pool = await database();
    await activate(pool, [feature(), observer]);
    if (kind === 'job') await job(pool, 'unknown.job', 'pending');
    if (kind === 'subscriber') await job(pool, 'platform.event.deliver', 'pending', { subscriberId: 'unknown', event: { name: 'probe.created.v1' } });
    if (kind === 'event') await outbox(pool, 'pending', 'unknown.event.v1');
    if (kind === 'payload') await job(pool, 'platform.event.deliver', 'pending', {});
    await expect(activate(pool, [feature(), observer])).rejects.toThrow();
    expect(await historyCount(pool)).toBe(1);
  });

  it('rejects changed pins, missing recorded migration rows and missing retained tables', async () => {
    const pool = await database();
    await activate(pool, [feature(), observer]);
    const changedSet = { ...featureSet, migrations: [{ ...featureSet.migrations[0]!, up: 'SELECT 1' }] };
    await expect(activate(pool, [feature(changedSet), observer], [changedSet])).rejects.toThrow('Stored migration pins differ');
    await pool.query("DELETE FROM platform_migrations WHERE id='feature/0001'");
    await expect(activate(pool, [feature(), observer])).rejects.toThrow('history is missing');
    const pin = feature().migrations[0]!;
    await pool.query('INSERT INTO platform_migrations(id, phase, checksum, migration_order) VALUES ($1,$2,$3,$4)', [`feature/${pin.id}`, pin.phase, pin.checksum, pin.order]);
    await pool.query('ALTER TABLE feature_rows RENAME TO missing_feature_rows');
    await expect(activate(pool, [], [])).rejects.toThrow('table is missing');
  });

  it('retains successful SQL prefixes without recording a failed target and retries only pending SQL', async () => {
    const pool = await database();
    await activate(pool, [feature()]);
    const forward = sqlMigration('0002', 'migrate', 'INSERT INTO feature_rows VALUES (2)');
    const broken = { ...featureSet, migrations: [...featureSet.migrations, forward,
      sqlMigration('0003', 'migrate', 'SELECT * FROM missing_transition_table')] };
    await expect(activate(pool, [feature(broken, '1.1.0')], [broken])).rejects.toThrow('does not exist');
    expect(await historyCount(pool)).toBe(1);
    expect((await pool.query('SELECT * FROM feature_rows ORDER BY id')).rows).toEqual([{ id: 1 }, { id: 2 }]);
    const repaired = { ...featureSet, migrations: [...featureSet.migrations, forward,
      sqlMigration('0003', 'migrate', 'INSERT INTO feature_rows VALUES (3)')] };
    expect((await activate(pool, [feature(repaired, '1.1.0')], [repaired])).prepared.appliedMigrations).toEqual(['feature/0003']);
  });

  it('keeps disabled extension evidence inert across a Base ABI upgrade', async () => {
    const pool = await database();
    const extension: ReleaseOwnerPin = { kind: 'extension', id: 'legacy-plugin', version: '1.0.0', migrations: [],
      work: { jobTypes: ['ext.legacy-plugin.run'], subscriberIds: [], emittedEventNames: [], subscribedEventNames: [] } };
    await activate(pool, [extension], []);
    const upgraded = { ...selection(), releaseVersion: '2.0.0', baseVersion: '2.0.0',
      activeOwners: foundations };
    const prepared = await prepareRelease(pool, upgraded, baseSets, 'apply');
    expect(prepared.manifest.owners.find(entry => entry.owner.id === extension.id)?.state).toBe('disabled');
    await recordEffectiveRelease(pool, prepared, prepared.manifest);
    await expect(prepareRelease(pool, upgraded, baseSets, 'require-current')).resolves.toMatchObject({ appliedMigrations: [] });
  });

  it('refuses changed release evidence and actual setup metadata', async () => {
    const pool = await database();
    const prepared = await prepareRelease(pool, selection(), baseSets, 'apply');
    await expect(recordEffectiveRelease(pool, prepared, { ...prepared.manifest, releaseVersion: '2.0.0' }))
      .rejects.toThrow('setup registrations differ');
    expect(await historyCount(pool)).toBe(0);
    await recordEffectiveRelease(pool, prepared, prepared.manifest);
    await pool.query("UPDATE platform_release_history SET effective_manifest_checksum = 'sha256:changed'");
    await expect(prepareRelease(pool, selection(), baseSets, 'apply')).rejects.toThrow('metadata drift');
  });
});
