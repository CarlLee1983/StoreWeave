import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Client } from 'pg';
import { catalogDigest, type ReleaseSnapshot } from '@storeweave/db';
import type { Runtime } from '@storeweave/kernel';
import { expect, it, vi } from 'vitest';
import { bootstrapRelease } from '../../packages/platform/bundle/src/bootstrap-release';
import { release } from '../../packages/platform/bundle/src/releases/base';

process.env.SW_SIGNING_KEY_TEST = Buffer.alloc(32, 3).toString('base64url');

async function withSource(test: (runtime: Runtime, container: StartedPostgreSqlContainer, directory: string) => Promise<void>) {
  const container = await new PostgreSqlContainer('postgres:17-alpine').withDatabase('source_test')
    .withUsername('commerce').withPassword('isolated-snapshot-password').start();
  const directory = mkdtempSync(join(tmpdir(), 'storeweave-snapshot-'));
  let runtime: Runtime | undefined;
  try {
    const config = join(directory, 'base.json');
    writeFileSync(config, JSON.stringify({ version: 1, store: { id: 'snapshot', name: 'Snapshot' },
      database: { url: container.getConnectionUri() }, extensions: [], logging: { level: 'error' },
      security: { signingKeys: [{ id: 'test', secretRef: 'SW_SIGNING_KEY_TEST' }] } }));
    runtime = (await bootstrapRelease(release, { configPath: config, loggerName: 'snapshot-test' })).runtime;
    await runtime.migrate();
    await test(runtime, container, directory);
  } finally {
    await runtime?.close();
    await container.stop();
    rmSync(directory, { recursive: true, force: true });
  }
}

it('binds pg_dump and complete history fingerprints to the same exported source snapshot', async () => {
  await withSource(async (runtime, container) => {
    await runtime.database.pool.query('CREATE TABLE snapshot_probe (id integer); INSERT INTO snapshot_probe VALUES (1)');
    await runtime.database.pool.query("SELECT setval(pg_get_serial_sequence('platform_release_history', 'sequence'), 9007199254740993, false); UPDATE platform_release_history SET sequence = DEFAULT");
    await runtime.database.pool.query("SELECT setval(pg_get_serial_sequence('platform_release_history', 'sequence'), 9007199254741993, false); SET DateStyle = 'SQL, DMY'");
    await runtime.database.pool.query(`CREATE ROLE database_reader;
      GRANT CONNECT ON DATABASE source_test TO database_reader;
      ALTER DATABASE source_test CONNECTION LIMIT 42;
      COMMENT ON DATABASE source_test IS 'snapshot fixture';
      ALTER DATABASE source_test SET search_path = public;
      ALTER ROLE database_reader IN DATABASE source_test SET statement_timeout = '42s'`);
    let evidence: ReleaseSnapshot | undefined;
    await runtime.withReleaseSnapshot(async snapshot => {
      evidence = snapshot;
      expect(snapshot.release.sequence).toBe('9007199254740993');
      expect(snapshot.historySequence).toEqual({ lastValue: '9007199254741993', isCalled: false });
      expect(snapshot.database).toMatchObject({ name: 'source_test', oid: expect.stringMatching(/^\d+$/), systemIdentifier: expect.stringMatching(/^\d+$/) });
      expect(snapshot.database.properties).toMatchObject({ owner: 'commerce', encoding: 'UTF8', tablespace: 'pg_default', connectionLimit: 42, comment: 'snapshot fixture' });
      expect(snapshot.database.properties.acl).toContainEqual({ grantor: 'commerce', grantee: 'database_reader', privilege: 'CONNECT', grantable: false });
      expect(snapshot.database.properties.settings).toContainEqual({ role: null, values: ['search_path=public'] });
      expect(snapshot.database.properties.settings).toContainEqual({ role: 'database_reader', values: ['statement_timeout=42s'] });
      await runtime.database.pool.query('INSERT INTO snapshot_probe VALUES (2)');
      await runtime.database.pool.query("UPDATE platform_migrations SET applied_at = applied_at + interval '1 microsecond' WHERE id = (SELECT min(id) FROM platform_migrations)");
      const dump = await container.exec(['pg_dump', '-U', 'commerce', '-d', 'source_test', '--format=custom', '--no-owner',
        `--snapshot=${snapshot.snapshotId}`, '--file=/tmp/source.dump']);
      expect(dump.exitCode, dump.output).toBe(0);
    });
    const created = await container.exec(['createdb', '-U', 'commerce', '-T', 'template0', 'restored_test']);
    expect(created.exitCode, created.output).toBe(0);
    const restored = await container.exec(['pg_restore', '-U', 'commerce', '-d', 'restored_test', '--single-transaction', '--no-owner', '/tmp/source.dump']);
    expect(restored.exitCode, restored.output).toBe(0);
    const state = await container.exec(['psql', '-U', 'commerce', '-d', 'restored_test', '-At', '-c', `
      SET TIME ZONE 'UTC';
      SET DateStyle = 'ISO, YMD';
      SELECT jsonb_build_object('data', (SELECT jsonb_agg(id ORDER BY id) FROM snapshot_probe),
        'migrations', (SELECT jsonb_agg(to_jsonb(m) ORDER BY id) FROM platform_migrations m),
        'history', (SELECT jsonb_agg(to_jsonb(r) || jsonb_build_object('sequence', sequence::text) ORDER BY sequence) FROM platform_release_history r),
        'generator', (SELECT jsonb_build_object('lastValue', last_value::text, 'isCalled', is_called) FROM platform_release_history_sequence_seq));
    `]);
    expect(state.exitCode, state.output).toBe(0);
    const parsed = JSON.parse(state.stdout.trim().split('\n').at(-1)!);
    expect(parsed.data).toEqual([1]);
    expect(catalogDigest(parsed.migrations)).toBe(evidence!.migrationsChecksum);
    expect(catalogDigest(parsed.history)).toBe(evidence!.historyChecksum);
    expect(parsed.generator).toEqual(evidence!.historySequence);
    const next = await container.exec(['psql', '-U', 'commerce', '-d', 'restored_test', '-At', '-c', `
      INSERT INTO platform_release_history (effective_manifest, effective_manifest_checksum, release_id, release_version, base_version, build_manifest_checksum)
      SELECT effective_manifest, effective_manifest_checksum, release_id, release_version, base_version, build_manifest_checksum
      FROM platform_release_history LIMIT 1 RETURNING sequence::text;
    `]);
    expect(next.exitCode, next.output).toBe(0);
    expect(next.stdout.split('\n')[0]).toBe('9007199254741993');
    const later = await runtime.withReleaseSnapshot(async snapshot => snapshot);
    expect(later.migrationsChecksum).not.toBe(evidence!.migrationsChecksum);
    expect(later.historyChecksum).toBe(evidence!.historyChecksum);
  });
});

it('refuses a migrationless pending source before dumping and releases the lock after dump failure', async () => {
  await withSource(async (runtime, container, directory) => {
    const next = (await bootstrapRelease({ ...release, version: '99.0.0' }, { configPath: join(directory, 'base.json'), loggerName: 'snapshot-next-test' })).runtime;
    const dump = vi.fn();
    try { await expect(next.withReleaseSnapshot(dump)).rejects.toThrow('current effective release'); }
    finally { await next.close(); }
    expect(dump).not.toHaveBeenCalled();
    const removed = await runtime.database.pool.query<{ entry: unknown }>(`DELETE FROM platform_migrations
      WHERE id = (SELECT id FROM platform_migrations ORDER BY migration_order DESC LIMIT 1)
      RETURNING to_jsonb(platform_migrations) AS entry`);
    await expect(runtime.withReleaseSnapshot(dump)).rejects.toThrow('all source migrations');
    expect(dump).not.toHaveBeenCalled();
    await runtime.database.pool.query('INSERT INTO platform_migrations SELECT * FROM jsonb_populate_record(NULL::platform_migrations, $1::jsonb)',
      [JSON.stringify(removed.rows[0]!.entry)]);
    let holderPid: number | undefined;
    await expect(runtime.withReleaseSnapshot(async () => {
      holderPid = (await runtime.database.pool.query("SELECT pid FROM pg_locks WHERE locktype = 'advisory' AND objid = 8140231 AND granted")).rows[0].pid;
      throw new Error('dump failed');
    })).rejects.toThrow('dump failed');
    const client = new Client({ connectionString: container.getConnectionUri() });
    await client.connect();
    try {
      expect((await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid).not.toBe(holderPid);
      expect((await client.query('SELECT pg_try_advisory_lock(8140231) AS locked')).rows).toEqual([{ locked: true }]);
      await client.query('SELECT pg_advisory_unlock(8140231)');
    } finally { await client.end(); }
    await expect(runtime.withReleaseSnapshot(async () => {
      await runtime.database.pool.query("SELECT nextval(pg_get_serial_sequence('platform_release_history', 'sequence'))");
    })).rejects.toThrow('sequence changed during snapshot');
    await expect(runtime.withReleaseSnapshot(async snapshot => snapshot.release.releaseId)).resolves.toBe('base');
  });
});

it('fails closed when physical cluster identifier access has been revoked', async () => {
  await withSource(async (runtime, container, directory) => {
    await runtime.database.pool.query(`CREATE ROLE snapshot_reader LOGIN PASSWORD 'isolated-reader-password';
      REVOKE EXECUTE ON FUNCTION pg_control_system() FROM PUBLIC;
      GRANT CONNECT ON DATABASE source_test TO snapshot_reader;
      GRANT USAGE ON SCHEMA public TO snapshot_reader;
      GRANT SELECT ON ALL TABLES IN SCHEMA public TO snapshot_reader`);
    const url = new URL(container.getConnectionUri());
    url.username = 'snapshot_reader'; url.password = 'isolated-reader-password';
    const config = join(directory, 'reader.json');
    writeFileSync(config, JSON.stringify({ version: 1, store: { id: 'snapshot', name: 'Snapshot' },
      database: { url: url.toString() }, extensions: [], logging: { level: 'error' },
      security: { signingKeys: [{ id: 'test', secretRef: 'SW_SIGNING_KEY_TEST' }] } }));
    const reader = (await bootstrapRelease(release, { configPath: config, loggerName: 'snapshot-reader-test' })).runtime;
    const dump = vi.fn();
    try { await expect(reader.withReleaseSnapshot(dump)).rejects.toThrow('permission denied for function pg_control_system'); }
    finally { await reader.close(); }
    expect(dump).not.toHaveBeenCalled();
  });
});
