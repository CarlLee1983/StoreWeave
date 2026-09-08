import { randomUUID } from 'node:crypto';
import semver from 'semver';
import { z } from 'zod';
import type { Pool, PoolClient } from 'pg';
import { catalogDigest, validateWorkOwnership } from './catalog';
import { ensureHistory, migrationCatalog, readHistory, validateHistory, type HistoryRow, runMigrationsOnClient, withMigrationLock, type HistoryCatalog, type MigrationStatus } from './migrator';
import type { EffectiveReleaseManifest, ExtensionRegistryEntry, MigrationSet, ModulePin, ReleaseOwnerPin, ReleaseSelection } from './types';

const id = z.string().regex(/^[a-z][a-z0-9-]*$/);
const version = z.string().refine(value => Boolean(semver.valid(value)), 'Invalid semantic version');
const checksum = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const work = z.object({
  jobTypes: z.array(z.string().min(1)), subscriberIds: z.array(id),
  emittedEventNames: z.array(z.string().min(1)), subscribedEventNames: z.array(z.string().min(1)),
}).strict();
const ownerSchema: z.ZodType<ReleaseOwnerPin, z.ZodTypeDef, unknown> = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('module'), id, version,
    dataRelations: z.array(z.string().regex(/^[a-z][a-z0-9_]*$/)), migrationOwner: id.nullable(),
    migrations: z.array(z.object({ id: z.string().min(1), phase: z.enum(['expand', 'migrate', 'contract']),
      order: z.number().int().positive(), checksum }).strict()), work,
  }).strict(),
  z.object({ kind: z.literal('extension'), id, version, migrations: z.tuple([]), work }).strict(),
]);
const releaseFields = { releaseId: id, releaseVersion: version, baseVersion: version, buildManifestChecksum: checksum };
const selectionSchema: z.ZodType<ReleaseSelection, z.ZodTypeDef, unknown> = z.object({
  ...releaseFields, activeOwners: z.array(ownerSchema),
}).strict();
const effectiveSchema: z.ZodType<EffectiveReleaseManifest, z.ZodTypeDef, unknown> = z.object({
  schemaVersion: z.literal(1), ...releaseFields,
  owners: z.array(z.object({ state: z.enum(['active', 'disabled']), owner: ownerSchema }).strict()),
}).strict();

export interface PreparedRelease {
  readonly previousSequence: string | null;
  readonly manifest: EffectiveReleaseManifest;
  readonly checksum: string;
  readonly appliedMigrations: readonly string[];
}

/** A persisted effective-release row must be self-authenticating before use. */
export interface EffectiveReleaseHistoryRecord {
  readonly effective_manifest: unknown;
  readonly effective_manifest_checksum: string;
  readonly release_id: string;
  readonly release_version: string;
  readonly base_version: string;
  readonly build_manifest_checksum: string;
}

export interface ReleaseSnapshot {
  readonly snapshotId: string;
  readonly database: { name: string; oid: string; systemIdentifier: string; serverVersion: string; properties: {
    owner: string; encoding: string; localeProvider: string; locale: string | null; icuRules: string | null;
    collate: string; ctype: string; tablespace: string; connectionLimit: number; comment: string | null;
    acl: { grantor: string; grantee: string | null; privilege: string; grantable: boolean }[];
    settings: { role: string | null; values: string[] }[];
  } };
  readonly release: { sequence: string; checksum: string; releaseId: string; releaseVersion: string; buildManifestChecksum: string };
  readonly migrationsChecksum: string;
  readonly historyChecksum: string;
  readonly historySequence: { lastValue: string; isCalled: boolean };
}

export interface LegacyMigrationBaseline {
  readonly id: string;
  readonly sourceRelease: string;
  /** Untrusted JSON from the release's pinned historical catalog; parsed before DB access. */
  readonly manifest: unknown;
}

/** Reconstruct the fixed legacy effective selection for adoption and post-adoption capture. */
export function legacyBaselineSelection(baseline: LegacyMigrationBaseline, sets: readonly MigrationSet[], enabledExtensions: readonly string[] = []) {
  const pinned = effectiveSchema.parse(baseline.manifest);
  const knownExtensions = new Set(pinned.owners.filter(entry => entry.owner.kind === 'extension').map(entry => entry.owner.id));
  if (new Set(enabledExtensions).size !== enabledExtensions.length || enabledExtensions.some(id => !knownExtensions.has(id))) {
    throw new Error('Enabled extension is not covered by the pinned legacy baseline');
  }
  const manifest: EffectiveReleaseManifest = { ...pinned, owners: pinned.owners.map(entry => entry.owner.kind === 'extension'
    ? { ...entry, state: enabledExtensions.includes(entry.owner.id) ? 'active' : 'disabled' } : entry) };
  validateOwners(manifest.owners.map(entry => entry.owner));
  const selection: ReleaseSelection = { releaseId: manifest.releaseId, releaseVersion: manifest.releaseVersion,
    baseVersion: manifest.baseVersion, buildManifestChecksum: manifest.buildManifestChecksum,
    activeOwners: manifest.owners.filter(entry => entry.state === 'active').map(entry => entry.owner) };
  const catalog = historyCatalog(manifest.owners.map(entry => entry.owner));
  const current = new Map(migrationCatalog(sets).map(pin => [pin.id, pin]));
  for (const pin of catalog) {
    const target = current.get(pin.id);
    if (!target || pin.phase !== target.phase || pin.checksum !== target.checksum || pin.order !== target.order) {
      throw new Error(`Legacy baseline does not match the selected migration catalog: ${pin.id}`);
    }
  }
  const pinnedIds = new Set(catalog.map(pin => pin.id));
  const activeOwners = new Set(modules(selection.activeOwners).map(owner => owner.migrationOwner));
  const migrations = sets.filter(set => activeOwners.has(set.module)).map(set => ({ ...set,
    migrations: set.migrations.filter(migration => pinnedIds.has(`${set.module}/${migration.id}`)) }));
  return { manifest, selection, migrations };
}

/** Explicit adoption records provenance, not proof of historical SQL or runtime execution. */
export async function baselineMigrations(pool: Pool, sets: readonly MigrationSet[], baseline: LegacyMigrationBaseline, evidence: string,
  enabledExtensions: readonly string[] = []) {
  if (!baseline.id.trim() || !baseline.sourceRelease.trim() || !evidence.trim()) {
    throw new Error('Legacy baseline requires catalog id, source release and operator evidence');
  }
  const { manifest } = legacyBaselineSelection(baseline, sets, enabledExtensions);
  const catalog = historyCatalog(manifest.owners.map(entry => entry.owner));
  const checksum = catalogDigest(manifest);
  const catalogChecksum = catalogDigest({ id: baseline.id, sourceRelease: baseline.sourceRelease, manifest });
  return withMigrationLock(pool, async client => {
    await ensureHistory(client);
    const previous = await latestRelease(client);
    if (previous && previous.checksum !== checksum) throw new Error('Existing effective release differs from legacy baseline');
    const { rows } = await client.query<HistoryRow & { legacy_baseline_id: string | null;
      migration_owner: string | null; migration_id: string | null; module_id: string | null;
      module_version: string | null; release_id: string | null; release_version: string | null }>(
      'SELECT * FROM public.platform_migrations ORDER BY id');
    if (!rows.length) throw new Error('Legacy baseline requires existing migration history');
    const pins = new Map(catalog.map(pin => [pin.id, pin]));
    const adopted = rows.filter(row => row.checksum === null && row.migration_order === null).map(row => row.id);
    const effective = rows.map(row => {
      const pin = pins.get(row.id);
      if (!pin || row.phase !== pin.phase || (row.checksum === null) !== (row.migration_order === null)) {
        throw new Error(`Legacy history is not covered by the pinned baseline: ${row.id}`);
      }
      return { ...row, checksum: row.checksum ?? pin.checksum, migration_order: row.migration_order ?? pin.order };
    });
    validateHistory(catalog, effective);
    const timestamps = new Map<string, number>();
    const effectiveById = new Map(effective.map(row => [row.id, row]));
    for (const pin of catalog) {
      const row = effectiveById.get(pin.id);
      if (!row) continue;
      const before = timestamps.get(pin.owner);
      const time = row.applied_at.getTime();
      if (!Number.isFinite(time) || (before !== undefined && time < before)) throw new Error(`Legacy history timestamp order differs for owner "${pin.owner}"`);
      timestamps.set(pin.owner, time);
    }
    await requireStoredData(client, manifest, new Set(rows.map(row => row.id)));
    // Historical enablement is unverified: conservatively drain events owed to any known legacy subscriber.
    await checkWork(client, manifest, { ...manifest, owners: manifest.owners.map(entry => ({ ...entry, state: 'active' })) });
    const provenance = rows.map(row => {
      const pin = pins.get(row.id)!;
      const owner = modules(manifest.owners.map(entry => entry.owner)).find(owner => owner.migrationOwner === pin.owner)!;
      const expected = { migration_owner: pin.owner, migration_id: row.id.slice(pin.owner.length + 1),
        module_id: owner.id, module_version: owner.version, release_id: manifest.releaseId, release_version: manifest.releaseVersion };
      for (const field of Object.keys(expected) as (keyof typeof expected)[]) {
        if (row[field] !== null && row[field] !== expected[field]) throw new Error(`Legacy migration provenance differs: ${row.id}/${field}`);
      }
      return { row, pin, expected };
    });
    if (previous) {
      const recorded = await client.query<{ id: string }>(`SELECT b.id FROM public.platform_release_history r
        JOIN public.platform_migration_baselines b ON b.id = r.legacy_baseline_id
        WHERE r.sequence = $1 AND b.catalog_checksum = $2
          AND b.historical_sql_verified = false AND b.historical_runtime_verified = false`, [previous.sequence, catalogChecksum]);
      const baselineId = recorded.rows[0]?.id;
      if (!baselineId || provenance.some(({ row, expected }) => row.legacy_baseline_id !== baselineId
        || row.checksum === null || row.migration_order === null
        || Object.keys(expected).some(field => row[field as keyof typeof expected] === null))) {
        throw new Error('Existing legacy baseline is incomplete or differs');
      }
      return { baselineId: null, adopted: [], catalogChecksum, historicalSqlVerified: false as const, historicalRuntimeVerified: false as const };
    }
    const baselineId = randomUUID();
    await client.query('BEGIN');
    try {
      await client.query(`INSERT INTO public.platform_migration_baselines
        (id, catalog_id, source_release, catalog_checksum, evidence, historical_sql_verified, historical_runtime_verified)
        VALUES ($1,$2,$3,$4,$5,false,false)`, [baselineId, baseline.id, baseline.sourceRelease, catalogChecksum, evidence.trim()]);
      for (const { row, pin, expected } of provenance) {
        await client.query(`UPDATE public.platform_migrations SET checksum=$2, migration_order=$3, legacy_baseline_id=$4,
          migration_owner=$5, migration_id=$6, module_id=$7, module_version=$8, release_id=$9, release_version=$10 WHERE id=$1`,
        [row.id, pin.checksum, pin.order, baselineId, expected.migration_owner, expected.migration_id,
          expected.module_id, expected.module_version, expected.release_id, expected.release_version]);
      }
      await client.query(`INSERT INTO public.platform_release_history
        (release_id, release_version, base_version, build_manifest_checksum, effective_manifest_checksum, effective_manifest, legacy_baseline_id)
        VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7)`,
      [manifest.releaseId, manifest.releaseVersion, manifest.baseVersion, manifest.buildManifestChecksum, checksum, JSON.stringify(manifest), baselineId]);
      await client.query('COMMIT');
    } catch (error) {
      try { await client.query('ROLLBACK'); }
      catch (rollbackError) { throw new AggregateError([error, rollbackError], 'Baseline and rollback failed'); }
      throw error;
    }
    return { baselineId, adopted, catalogChecksum, historicalSqlVerified: false as const, historicalRuntimeVerified: false as const };
  });
}

function modules(owners: readonly ReleaseOwnerPin[]): ModulePin[] {
  return owners.filter((owner): owner is ModulePin => owner.kind === 'module');
}

function historyCatalog(owners: readonly ReleaseOwnerPin[]): HistoryCatalog {
  const catalog = modules(owners).flatMap(module => {
    const owner = module.migrationOwner;
    return owner ? module.migrations.map(pin => ({ ...pin, id: `${owner}/${pin.id}`, owner })) : [];
  });
  const ownersByNamespace = new Set<string>();
  const relationOwners = new Set<string>();
  for (const module of modules(owners)) {
    for (const table of module.dataRelations) {
      if (relationOwners.has(table)) throw new Error(`Duplicate table owner: ${table}`);
      relationOwners.add(table);
    }
    if (!module.migrationOwner) {
      if (module.migrations.length) throw new Error(`Migration owner missing: ${module.id}`);
      continue;
    }
    if (ownersByNamespace.has(module.migrationOwner)) throw new Error(`Duplicate migration owner: ${module.migrationOwner}`);
    ownersByNamespace.add(module.migrationOwner);
    let previous = '';
    for (const [index, pin] of module.migrations.entries()) {
      const localId = pin.id;
      if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(localId)
        || localId <= previous || pin.order !== index + 1) throw new Error(`Invalid migration pin: ${pin.id}`);
      previous = localId;
    }
  }
  return catalog;
}

function validateOwners(owners: readonly ReleaseOwnerPin[]): void {
  validateWorkOwnership(owners);
  historyCatalog(owners);
  for (const owner of owners) {
    const requiredSubscribers = owner.work.subscribedEventNames.length ? [owner.id] : [];
    if (catalogDigest(owner.work.subscriberIds) !== catalogDigest(requiredSubscribers)) throw new Error(`Invalid subscriber owner: ${owner.id}`);
    if (owner.kind === 'extension' && (owner.work.emittedEventNames.length
      || owner.work.jobTypes.some(type => !type.startsWith(`ext.${owner.id}.`)))) throw new Error(`Invalid extension work: ${owner.id}`);
  }
}

async function latestRelease(client: PoolClient) {
  const result = await client.query<EffectiveReleaseHistoryRecord & { sequence: string }>(
    'SELECT * FROM public.platform_release_history ORDER BY sequence DESC LIMIT 1');
  const row = result.rows[0];
  if (!row) return null;
  const manifest = validateEffectiveReleaseHistoryRecord(row);
  return { sequence: row.sequence, manifest, checksum: row.effective_manifest_checksum };
}

/**
 * Shared trust boundary for consumers of stored effective release history.
 * It deliberately validates the complete manifest, its digest, metadata, and
 * ownership rather than accepting a convenient JSON projection.
 */
export function validateEffectiveReleaseHistoryRecord(row: EffectiveReleaseHistoryRecord): EffectiveReleaseManifest {
  const manifest = effectiveSchema.parse(row.effective_manifest);
  if (catalogDigest(manifest) !== row.effective_manifest_checksum || manifest.releaseId !== row.release_id
    || manifest.releaseVersion !== row.release_version || manifest.baseVersion !== row.base_version
    || manifest.buildManifestChecksum !== row.build_manifest_checksum) throw new Error('Release history metadata drift');
  validateOwners(manifest.owners.map(entry => entry.owner));
  return manifest;
}

function desiredManifest(selection: ReleaseSelection, previous: EffectiveReleaseManifest | undefined): EffectiveReleaseManifest {
  if (previous && (semver.lt(selection.baseVersion, previous.baseVersion)
    || (selection.releaseId === previous.releaseId && semver.lt(selection.releaseVersion, previous.releaseVersion)))) {
    throw new Error('Release or Base version downgrade requires a verified snapshot rollback');
  }
  const active = new Map(selection.activeOwners.map(owner => [owner.id, owner]));
  for (const { owner: old } of previous?.owners ?? []) {
    const next = active.get(old.id);
    if (!next) continue;
    if (old.kind !== next.kind || semver.lt(next.version, old.version)) throw new Error(`Release owner downgrade or kind change: ${old.id}`);
    if (old.kind === 'module' && next.kind === 'module' && (old.migrationOwner !== next.migrationOwner
      || catalogDigest(old.migrations) !== catalogDigest(next.migrations.slice(0, old.migrations.length)))) {
      throw new Error(`Stored migration pins differ: ${old.id}`);
    }
  }
  const manifest: EffectiveReleaseManifest = {
    schemaVersion: 1, releaseId: selection.releaseId, releaseVersion: selection.releaseVersion,
    baseVersion: selection.baseVersion, buildManifestChecksum: selection.buildManifestChecksum,
    owners: [
      ...selection.activeOwners.map(owner => ({ state: 'active' as const, owner })),
      ...(previous?.owners ?? []).filter(entry => !active.has(entry.owner.id)).map(entry => ({ state: 'disabled' as const, owner: entry.owner })),
    ].sort((a, b) => a.owner.id < b.owner.id ? -1 : a.owner.id > b.owner.id ? 1 : 0),
  };
  // Disabled modules may target an older ABI; only their inert catalogs are validated here.
  validateWorkOwnership(manifest.owners.map(entry => entry.owner));
  historyCatalog(manifest.owners.map(entry => entry.owner));
  return manifest;
}

async function dataRelationNames(client: PoolClient) {
  const { rows } = await client.query<{ name: string }>(`SELECT c.relname AS name FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'S')`);
  return new Set(rows.map(row => row.name));
}

async function requireStoredData(client: PoolClient, manifest: EffectiveReleaseManifest | undefined, applied: ReadonlySet<string>) {
  const tables = await dataRelationNames(client);
  for (const module of modules(manifest?.owners.map(entry => entry.owner) ?? [])) {
    for (const pin of module.migrations) {
      const id = `${module.migrationOwner}/${pin.id}`;
      if (!applied.has(id)) throw new Error(`Stored migration history is missing: ${id}`);
    }
    for (const table of module.dataRelations) if (!tables.has(table)) throw new Error(`Stored module table is missing: ${module.id}/${table}`);
  }
}

async function checkWork(client: PoolClient, target: EffectiveReleaseManifest, previous?: EffectiveReleaseManifest) {
  const findActive = (field: 'jobTypes' | 'subscriberIds' | 'emittedEventNames', value: string) => {
    const entry = target.owners.find(entry => entry.owner.work[field].includes(value));
    if (!entry || entry.state !== 'active') throw new Error(`Pending work has unknown or disabled ${field}: ${value}`);
    return entry.owner;
  };
  const tables = await dataRelationNames(client);
  if (tables.has('platform_jobs')) {
    const { rows } = await client.query<{ id: string; type: string; payload: unknown }>(
      "SELECT id, type, payload FROM platform_jobs WHERE status IN ('pending', 'running', 'dead')");
    for (const row of rows) {
      findActive('jobTypes', row.type);
      if (row.type === 'platform.event.deliver') {
        const payload = z.object({ subscriberId: z.string(), event: z.object({ name: z.string() }) }).parse(row.payload);
        const subscriber = findActive('subscriberIds', payload.subscriberId);
        findActive('emittedEventNames', payload.event.name);
        if (!subscriber.work.subscribedEventNames.includes(payload.event.name)) throw new Error(`Pending delivery subscription removed: ${payload.subscriberId}`);
      }
    }
  }
  if (tables.has('platform_outbox')) {
    const { rows } = await client.query<{ event_name: string }>("SELECT event_name FROM platform_outbox WHERE status IN ('pending', 'dead')");
    for (const row of rows) {
      findActive('emittedEventNames', row.event_name);
      for (const { state, owner: old } of previous?.owners ?? []) {
        if (state !== 'active' || !old.work.subscribedEventNames.includes(row.event_name)) continue;
        const next = target.owners.find(entry => entry.owner.id === old.id && entry.state === 'active');
        if (!next?.owner.work.subscribedEventNames.includes(row.event_name)) throw new Error(`Pending outbox subscription removed: ${old.id}`);
      }
    }
  }
}

function validateSelection(selectionInput: ReleaseSelection, sets: readonly MigrationSet[]) {
  const selection = selectionSchema.parse(selectionInput);
  validateOwners(selection.activeOwners);
  const sqlCatalog = migrationCatalog(sets);
  const declared = historyCatalog(selection.activeOwners);
  if (catalogDigest([...sqlCatalog].map(({ up: _up, ...pin }) => pin).sort((a, b) => a.id < b.id ? -1 : 1))
    !== catalogDigest([...declared].sort((a, b) => a.id < b.id ? -1 : 1))) throw new Error('Active SQL differs from release pins');
  return { selection, sqlCatalog };
}

/** Status includes retained history, but never executes SQL migrations or extension setup. */
export async function releaseMigrationStatus(pool: Pool, selectionInput: ReleaseSelection, sets: readonly MigrationSet[]):
Promise<MigrationStatus & { releaseCurrent: boolean }> {
  const { selection, sqlCatalog } = validateSelection(selectionInput, sets);
  return withMigrationLock(pool, async client => {
    await ensureHistory(client);
    const previous = await latestRelease(client);
    const manifest = desiredManifest(selection, previous?.manifest);
    const rows = await readHistory(client, historyCatalog(manifest.owners.map(entry => entry.owner)));
    const applied = new Set(rows.map(row => row.id));
    await requireStoredData(client, previous?.manifest, applied);
    return {
      applied: rows.map(row => ({ id: row.id, phase: row.phase, appliedAt: row.applied_at,
        checksum: row.checksum!, order: row.migration_order! })),
      pending: sqlCatalog.filter(pin => !applied.has(pin.id)).map(({ id, phase }) => ({ id, phase })),
      releaseCurrent: previous?.checksum === catalogDigest(manifest),
    };
  });
}

/** Call within a UTC/ISO read-only transaction; shared by raw capture and raw restore verification. */
export async function readLegacySafetyHistory(client: Pick<PoolClient, 'query'>): Promise<string> {
  const shape = await client.query<{ columns: string[] | null; history: string | null; baseline: string | null }>(`SELECT
    (SELECT array_agg(attname::text ORDER BY attname) FROM pg_catalog.pg_attribute
      WHERE attrelid = pg_catalog.to_regclass('public.platform_migrations') AND attnum > 0 AND NOT attisdropped) AS columns,
    pg_catalog.to_regclass('public.platform_release_history')::text AS history,
    pg_catalog.to_regclass('public.platform_migration_baselines')::text AS baseline`);
  if (JSON.stringify(shape.rows[0]?.columns) !== JSON.stringify(['applied_at', 'id', 'phase'])
    || shape.rows[0]?.history !== null || shape.rows[0]?.baseline !== null) throw new Error('Legacy safety requires unadopted three-column migration history');
  const rows = await client.query<{ entries: unknown }>("SELECT coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(m) ORDER BY id), '[]'::pg_catalog.jsonb) AS entries FROM public.platform_migrations m");
  return catalogDigest(rows.rows[0]!.entries);
}

/** B01 safety capture before baseline DDL. Never creates, alters or adopts migration history. */
export async function withLegacySafetySnapshot<T>(pool: Pool,
  dump: (snapshot: { snapshotId: string; database: ReleaseSnapshot['database']; migrationsChecksum: string }) => Promise<T>): Promise<T> {
  return withMigrationLock(pool, async client => {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    try {
      await client.query("SET LOCAL search_path = pg_catalog; SET LOCAL TIME ZONE 'UTC'; SET LOCAL DateStyle = 'ISO, YMD'");
      const migrationsChecksum = await readLegacySafetyHistory(client);
      const database = await readSnapshotDatabase(client);
      const exported = await client.query<{ id: string }>('SELECT pg_catalog.pg_export_snapshot() AS id');
      const result = await dump({ database, migrationsChecksum, snapshotId: exported.rows[0]!.id });
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try { await client.query('ROLLBACK'); }
      catch (cleanup) { throw new AggregateError([error, cleanup], 'Legacy safety snapshot and transaction cleanup failed'); }
      throw error;
    }
  });
}

/** Dump and provenance share one exported snapshot. Callback only stages output; publish after this resolves. */
export async function withReleaseSnapshot<T>(pool: Pool, selectionInput: ReleaseSelection, sets: readonly MigrationSet[],
  dump: (snapshot: ReleaseSnapshot, client: PoolClient) => Promise<T>): Promise<T> {
  const { selection, sqlCatalog } = validateSelection(selectionInput, sets);
  return withMigrationLock(pool, async client => {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    try {
      await client.query("SET LOCAL search_path = pg_catalog; SET LOCAL TIME ZONE 'UTC'");
      await client.query("SET LOCAL DateStyle = 'ISO, YMD'");
      const previous = await latestRelease(client);
      const manifest = desiredManifest(selection, previous?.manifest);
      if (!previous || previous.checksum !== catalogDigest(manifest)) throw new Error('Snapshot requires the current effective release');
      const rows = await readHistory(client, historyCatalog(manifest.owners.map(entry => entry.owner)));
      const applied = new Set(rows.map(row => row.id));
      if (sqlCatalog.some(pin => !applied.has(pin.id))) throw new Error('Snapshot requires all source migrations to be applied');
      await requireStoredData(client, manifest, applied);
      const identity = await readSnapshotDatabase(client);
      const historyEvidence = await readSnapshotHistory(client);
      const exported = await client.query<{ id: string }>('SELECT pg_export_snapshot() AS id');
      const result = await dump({ snapshotId: exported.rows[0]!.id, database: identity,
        release: { sequence: previous.sequence, checksum: previous.checksum, releaseId: manifest.releaseId,
          releaseVersion: manifest.releaseVersion, buildManifestChecksum: manifest.buildManifestChecksum },
        ...historyEvidence, historySequence: { ...historyEvidence.historySequence } }, client);
      // Sequence state is not MVCC: reject an unexpected advance while the dump callback was running.
      const after = await readReleaseHistorySequence(client);
      if (after.lastValue !== historyEvidence.historySequence.lastValue || after.isCalled !== historyEvidence.historySequence.isCalled) {
        throw new Error('Release history sequence changed during snapshot');
      }
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try { await client.query('ROLLBACK'); }
      catch (rollbackError) { throw new AggregateError([error, rollbackError], 'Snapshot and transaction cleanup failed'); }
      throw error;
    }
  });
}

/** The operator must stop old writers; the advisory lock serializes transitions, not queue producers. */
export async function prepareRelease(pool: Pool, selectionInput: ReleaseSelection, sets: readonly MigrationSet[],
  mode: 'apply' | 'require-current', log?: (message: string) => void): Promise<PreparedRelease> {
  if (mode !== 'apply' && mode !== 'require-current') throw new Error('Invalid release activation mode');
  const { selection, sqlCatalog } = validateSelection(selectionInput, sets);
  return withMigrationLock(pool, async client => {
    await ensureHistory(client);
    const previous = await latestRelease(client);
    const manifest = desiredManifest(selection, previous?.manifest);
    const checksum = catalogDigest(manifest);
    const catalog = historyCatalog(manifest.owners.map(entry => entry.owner));
    const rows = await readHistory(client, catalog);
    await requireStoredData(client, previous?.manifest, new Set(rows.map(row => row.id)));
    await checkWork(client, manifest, previous?.manifest);
    if (mode === 'require-current' && previous?.checksum !== checksum) throw new Error('Release transition requires the migrate command while writers are stopped');
    const appliedMigrations = mode === 'apply'
      ? await runMigrationsOnClient(client, sqlCatalog, log, catalog, { releaseId: selection.releaseId,
        releaseVersion: selection.releaseVersion, modules: modules(selection.activeOwners) }) : [];
    const current = await readHistory(client, catalog);
    await requireStoredData(client, manifest, new Set(current.map(row => row.id)));
    return { previousSequence: previous?.sequence ?? null, manifest, checksum, appliedMigrations };
  });
}

/** Recheck after setup; never record a target that failed setup or lost the transition race. */
export async function recordEffectiveRelease(pool: Pool, prepared: PreparedRelease, actual: EffectiveReleaseManifest,
  registryInput: readonly ExtensionRegistryEntry[] = []) {
  const manifest = effectiveSchema.parse(actual);
  if (catalogDigest(manifest) !== prepared.checksum) throw new Error('Effective setup registrations differ from prepared release');
  const registry = z.array(z.object({ id, name: z.string().min(1), version,
    platformVersion: z.string().refine(value => Boolean(semver.validRange(value))),
    permissions: z.array(z.string().min(1)),
  }).strict()).parse(registryInput);
  const activeExtensions = manifest.owners.filter(entry => entry.state === 'active' && entry.owner.kind === 'extension');
  if (registry.length !== activeExtensions.length || new Set(registry.map(entry => entry.id)).size !== registry.length
    || registry.some(entry => !activeExtensions.some(owner => owner.owner.id === entry.id && owner.owner.version === entry.version)
      || !semver.satisfies(manifest.baseVersion, entry.platformVersion, { includePrerelease: true }))) {
    throw new Error('Extension registry differs from effective release');
  }
  return withMigrationLock(pool, async client => {
    await ensureHistory(client);
    await client.query('BEGIN');
    try {
      const previous = await latestRelease(client);
      if (previous?.checksum !== prepared.checksum && (previous?.sequence ?? null) !== prepared.previousSequence) throw new Error('Release changed during setup');
      // Matching the latest target alone misses an intervening A -> B -> A transition.
      const intervening = await client.query(`SELECT 1 FROM public.platform_release_history
        WHERE sequence > COALESCE($1::bigint, 0) AND effective_manifest_checksum <> $2 LIMIT 1`,
      [prepared.previousSequence, prepared.checksum]);
      if (intervening.rows.length) throw new Error('Release changed during setup');
      const rows = await readHistory(client, historyCatalog(manifest.owners.map(entry => entry.owner)));
      await requireStoredData(client, manifest, new Set(rows.map(row => row.id)));
      await checkWork(client, manifest, previous?.manifest);
      for (const entry of registry) {
        await client.query(`INSERT INTO platform_extension_registry (id, name, version, platform_version, permissions, updated_at)
          VALUES ($1,$2,$3,$4,$5::jsonb,now()) ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name,
          version=EXCLUDED.version, platform_version=EXCLUDED.platform_version, permissions=EXCLUDED.permissions, updated_at=now()`,
        [entry.id, entry.name, entry.version, entry.platformVersion, JSON.stringify(entry.permissions)]);
      }
      let result = { historySequence: previous?.sequence ?? '', changed: false };
      if (previous?.checksum !== prepared.checksum) {
        const { rows: inserted } = await client.query<{ sequence: string }>(`INSERT INTO public.platform_release_history
          (release_id, release_version, base_version, build_manifest_checksum, effective_manifest_checksum, effective_manifest)
          VALUES ($1, $2, $3, $4, $5, $6::jsonb) RETURNING sequence`,
        [manifest.releaseId, manifest.releaseVersion, manifest.baseVersion, manifest.buildManifestChecksum, prepared.checksum, JSON.stringify(manifest)]);
        result = { historySequence: inserted[0]!.sequence, changed: true };
      }
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try { await client.query('ROLLBACK'); }
      catch (rollbackError) { throw new AggregateError([error, rollbackError], 'Release finalization and rollback failed'); }
      throw error;
    }
  });
}


/** One catalog projection for snapshot capture and exact scratch-property verification. */
export async function readSnapshotDatabase(client: Pick<PoolClient, 'query'>, databaseName?: string): Promise<ReleaseSnapshot['database']> {
  const result = await client.query<ReleaseSnapshot['database']>(`
        SELECT d.datname AS name, d.oid::pg_catalog.text AS oid,
          (SELECT system_identifier::pg_catalog.text FROM pg_catalog.pg_control_system()) AS "systemIdentifier",
          pg_catalog.current_setting('server_version') AS "serverVersion",
          pg_catalog.jsonb_build_object('owner', pg_catalog.pg_get_userbyid(d.datdba), 'encoding', pg_catalog.pg_encoding_to_char(d.encoding),
            'localeProvider', coalesce(pg_catalog.to_jsonb(d)->>'datlocprovider', 'c'),
            'locale', coalesce(pg_catalog.to_jsonb(d)->>'datlocale', pg_catalog.to_jsonb(d)->>'daticulocale'),
            'icuRules', pg_catalog.to_jsonb(d)->>'daticurules', 'collate', d.datcollate, 'ctype', d.datctype,
            'tablespace', t.spcname, 'connectionLimit', d.datconnlimit, 'comment', pg_catalog.shobj_description(d.oid, 'pg_database'),
            'acl', (SELECT coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('grantor', pg_catalog.pg_get_userbyid(a.grantor),
              'grantee', CASE WHEN a.grantee = 0 THEN NULL ELSE pg_catalog.pg_get_userbyid(a.grantee) END,
              'privilege', a.privilege_type, 'grantable', a.is_grantable) ORDER BY a.grantee, a.privilege_type, a.grantor), '[]'::pg_catalog.jsonb)
              FROM pg_catalog.aclexplode(coalesce(d.datacl, pg_catalog.acldefault('d', d.datdba))) a),
            'settings', (SELECT coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('role', CASE WHEN s.setrole = 0 THEN NULL ELSE pg_catalog.pg_get_userbyid(s.setrole) END,
              'values', s.setconfig) ORDER BY s.setrole), '[]'::pg_catalog.jsonb) FROM pg_catalog.pg_db_role_setting s WHERE s.setdatabase = d.oid)
          ) AS properties
        FROM pg_catalog.pg_database d JOIN pg_catalog.pg_tablespace t ON t.oid = d.dattablespace WHERE d.datname = coalesce($1::pg_catalog.text, pg_catalog.current_database())`, [databaseName ?? null]);
  if (!result.rows[0]) throw new Error('Snapshot database is missing');
  return result.rows[0];
}


/** Caller provides a stable read transaction and UTC/ISO DateStyle, preserving timestamp microseconds in server JSON. */
export async function readSnapshotHistory(client: Pick<PoolClient, 'query'>) {
  const migrations = await client.query<{ entries: unknown }>("SELECT coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(m) ORDER BY id), '[]'::pg_catalog.jsonb) AS entries FROM public.platform_migrations m");
  const history = await client.query<{ entries: unknown }>("SELECT coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(r) || pg_catalog.jsonb_build_object('sequence', sequence::pg_catalog.text) ORDER BY sequence), '[]'::pg_catalog.jsonb) AS entries FROM public.platform_release_history r");
  return { migrationsChecksum: catalogDigest(migrations.rows[0]!.entries), historyChecksum: catalogDigest(history.rows[0]!.entries),
    historySequence: await readReleaseHistorySequence(client) };
}

async function readReleaseHistorySequence(client: Pick<PoolClient, 'query'>): Promise<ReleaseSnapshot['historySequence']> {
  const generator = await client.query<{ name: string }>("SELECT pg_catalog.pg_get_serial_sequence('public.platform_release_history', 'sequence') AS name");
  if (!generator.rows[0]?.name) throw new Error('Release history identity sequence is missing');
  // The catalog function returns a quoted, qualified identifier.
  const sequence = await client.query<ReleaseSnapshot['historySequence']>(`SELECT last_value::pg_catalog.text AS "lastValue", is_called AS "isCalled" FROM ${generator.rows[0].name}`);
  return sequence.rows[0]!;
}
