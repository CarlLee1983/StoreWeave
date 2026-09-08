import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { Client } from 'pg';
import { expect, it, vi } from 'vitest';
import { cutOverOrRecognize } from '../../tools/cli/src/database-cutover';

it('atomically cuts over verified OIDs, retains quarantine, recognizes committed intent and refuses active sessions or mismatches', async () => {
  const container = await new PostgreSqlContainer('postgres:17-alpine').withDatabase('live_test')
    .withUsername('commerce').withPassword('isolated-cutover-password').start();
  const url = new URL(container.getConnectionUri());
  url.pathname = '/postgres';
  const client = new Client({ connectionString: url.toString() });
  await client.connect();
  try {
    await client.query('CREATE DATABASE scratch_test TEMPLATE template0');
    const rows = (await client.query<{ name: string; oid: string }>("SELECT datname AS name, oid::text FROM pg_database WHERE datname IN ('live_test', 'scratch_test')")).rows;
    const live = rows.find(row => row.name === 'live_test')!;
    const scratch = rows.find(row => row.name === 'scratch_test')!;
    const systemIdentifier = (await client.query('SELECT system_identifier::text FROM pg_control_system()')).rows[0].system_identifier;
    const intent = { systemIdentifier, live, scratch, quarantineName: 'retained_test' };
    await expect(cutOverOrRecognize(url.toString(), { ...intent, systemIdentifier: '1' })).rejects.toThrow('recorded cluster');
    await expect(cutOverOrRecognize(url.toString(), { ...intent, live: { ...live, oid: '1' } })).rejects.toThrow('OID mapping');
    await client.query(`CREATE SCHEMA trap; CREATE TABLE trap.pg_database (datname text, oid oid);
      INSERT INTO trap.pg_database VALUES ('live_test', 1), ('scratch_test', 2)`);
    const trapped = new URL(url);
    trapped.searchParams.set('options', '-c search_path=trap,pg_catalog');
    await expect(cutOverOrRecognize(trapped.toString(), { ...intent, live: { ...live, oid: '1' }, scratch: { ...scratch, oid: '2' } })).rejects.toThrow('OID mapping');
    await client.query('BEGIN; CREATE TABLE ambient_marker (id integer)');
    await expect(cutOverOrRecognize(url.toString(), { ...intent, systemIdentifier: '1' })).rejects.toThrow('recorded cluster');
    await client.query('ROLLBACK');
    expect((await client.query("SELECT to_regclass('ambient_marker') AS relation")).rows[0].relation).toBeNull();
    await client.query("CREATE ROLE limited_maintenance LOGIN CREATEDB PASSWORD 'fixture-password'");
    const limited = new URL(url);
    limited.username = 'limited_maintenance'; limited.password = 'fixture-password';
    await expect(cutOverOrRecognize(limited.toString(), intent)).rejects.toThrow('permission denied');
    await client.query('BEGIN; LOCK TABLE pg_catalog.pg_database IN ROW EXCLUSIVE MODE');
    const started = performance.now();
    try { await expect(cutOverOrRecognize(url.toString(), intent)).rejects.toThrow('lock timeout'); }
    finally { await client.query('ROLLBACK'); }
    expect(performance.now() - started).toBeLessThan(10_000);
    const active = new Client({ connectionString: container.getConnectionUri() });
    await active.connect();
    try { await expect(cutOverOrRecognize(url.toString(), intent)).rejects.toThrow('sessions to be closed'); }
    finally { await active.end(); }
    // Force a real PostgreSQL failure at the second rename after the first has executed.
    const query = Client.prototype.query;
    const intercepted = vi.spyOn(Client.prototype, 'query').mockImplementation((function(this: Client, ...args: unknown[]) {
      if (typeof args[0] === 'string' && args[0].startsWith('ALTER DATABASE "scratch_test"')) {
        return Reflect.apply(query, this, ['ALTER DATABASE "missing_test" RENAME TO "live_test"']);
      }
      return Reflect.apply(query, this, args);
    }) as typeof client.query);
    try { await expect(cutOverOrRecognize(url.toString(), intent)).rejects.toThrow('does not exist'); }
    finally { intercepted.mockRestore(); }
    expect((await client.query("SELECT datname AS name, oid::text FROM pg_database WHERE datname IN ('live_test', 'scratch_test', 'retained_test') ORDER BY datname")).rows)
      .toEqual([live, scratch]);
    const late = new Client({ connectionString: container.getConnectionUri() });
    const lateQuery = Client.prototype.query;
    const lateConnection = vi.spyOn(Client.prototype, 'query').mockImplementation((function(this: Client, ...args: unknown[]) {
      const result = Reflect.apply(lateQuery, this, args);
      if (typeof args[0] === 'string' && args[0].startsWith('SELECT 1 FROM pg_catalog.pg_stat_activity')) {
        return result.then(async (value: unknown) => { await late.connect(); return value; });
      }
      return result;
    }) as typeof client.query);
    try { await expect(cutOverOrRecognize(url.toString(), intent)).rejects.toThrow(/accessed by other users|lock timeout/); }
    finally { lateConnection.mockRestore(); await late.end(); }
    expect((await client.query("SELECT datname AS name, oid::text FROM pg_database WHERE datname IN ('live_test', 'scratch_test', 'retained_test') ORDER BY datname")).rows)
      .toEqual([live, scratch]);
    expect(await cutOverOrRecognize(url.toString(), intent)).toBe('committed');
    expect(await cutOverOrRecognize(url.toString(), intent)).toBe('already-committed');
    const final = (await client.query("SELECT datname AS name, oid::text FROM pg_database WHERE datname IN ('live_test', 'scratch_test', 'retained_test') ORDER BY datname")).rows;
    expect(final).toEqual([{ name: 'live_test', oid: scratch.oid }, { name: 'retained_test', oid: live.oid }]);
  } finally { await client.end(); await container.stop(); }
});
