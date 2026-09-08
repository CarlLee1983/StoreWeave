import { parsePgUrl } from './pg-tool';
import { Client } from 'pg';
import { z } from 'zod';

const name = z.string().min(1).refine(value => !value.includes('\0') && Buffer.byteLength(value) <= 63);
const database = z.object({ name, oid: z.string().regex(/^[1-9]\d*$/) }).strict();
const intentSchema = z.object({ systemIdentifier: z.string().regex(/^[1-9]\d*$/), live: database, scratch: database, quarantineName: name }).strict();
export type DatabaseCutoverIntent = z.infer<typeof intentSchema>;
const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;

/** Requires fsynced intent, verified scratch and drained managed/external writers. Session checks do not fence new writers.
 * Uses a fresh maintenance session with elevated privileges on pg_catalog.pg_database. No internal retries. */
export function cutOverOrRecognize(maintenanceUrl: string, input: DatabaseCutoverIntent) {
  return processCutover(maintenanceUrl, input, true);
}

/** Read the exact initial/committed mapping under the same catalog lock, without renaming databases. */
export function inspectCutover(maintenanceUrl: string, input: DatabaseCutoverIntent) {
  return processCutover(maintenanceUrl, input, false);
}

async function processCutover(maintenanceUrl: string, input: DatabaseCutoverIntent, commit: boolean) {
  const intent = intentSchema.parse(input);
  const names = [intent.live.name, intent.scratch.name, intent.quarantineName];
  if (new Set(names).size !== 3 || intent.live.oid === intent.scratch.oid) throw new Error('Cutover names and database OIDs must be distinct');
  const client = new Client({ connectionString: parsePgUrl(maintenanceUrl).toString() });
  try {
    await client.connect();
    const identity = (await client.query<{ name: string; systemIdentifier: string }>(
      'SELECT pg_catalog.current_database() AS name, system_identifier::pg_catalog.text AS "systemIdentifier" FROM pg_catalog.pg_control_system()')).rows[0]!;
    if (names.includes(identity.name) || identity.systemIdentifier !== intent.systemIdentifier) throw new Error('Cutover requires a separate maintenance connection to the recorded cluster');
    await client.query('BEGIN');
    try {
      await client.query("SET LOCAL search_path = pg_catalog");
      await client.query("SET LOCAL lock_timeout = '5s'");
      // ponytail: serialize cluster database DDL during this rare cutover; narrow only if operational contention warrants it.
      await client.query('LOCK TABLE pg_catalog.pg_database IN SHARE ROW EXCLUSIVE MODE');
      const rows = (await client.query<{ name: string; oid: string }>(
        'SELECT datname AS name, oid::pg_catalog.text FROM pg_catalog.pg_database WHERE datname = ANY($1::pg_catalog.text[])', [names])).rows;
      const actual = new Map(rows.map(row => [row.name, row.oid]));
      if (actual.get(intent.live.name) === intent.scratch.oid && actual.get(intent.quarantineName) === intent.live.oid
        && !actual.has(intent.scratch.name)) {
        await client.query('COMMIT');
        return 'already-committed' as const;
      }
      if (actual.get(intent.live.name) !== intent.live.oid || actual.get(intent.scratch.name) !== intent.scratch.oid
        || actual.has(intent.quarantineName)) throw new Error('Database OID mapping differs from the recorded cutover intent');
      if (!commit) { await client.query('COMMIT'); return 'ready' as const; }
      const sessions = await client.query('SELECT 1 FROM pg_catalog.pg_stat_activity WHERE datid = ANY($1::pg_catalog.oid[]) LIMIT 1', [[intent.live.oid, intent.scratch.oid]]);
      if (sessions.rowCount) throw new Error('Cutover requires all live and scratch database sessions to be closed');
      await client.query(`ALTER DATABASE ${quote(intent.live.name)} RENAME TO ${quote(intent.quarantineName)}`);
      await client.query(`ALTER DATABASE ${quote(intent.scratch.name)} RENAME TO ${quote(intent.live.name)}`);
      await client.query('COMMIT');
      return 'committed' as const;
    } catch (error) {
      try { await client.query('ROLLBACK'); }
      catch (cleanup) { throw new AggregateError([error, cleanup], 'Cutover failed and transaction cleanup failed'); }
      throw error;
    }
  } finally { await client.end(); }
}
