import { randomUUID } from 'node:crypto';
import { Client, escapeIdentifier as ident, escapeLiteral as literal } from 'pg';
import { catalogDigest, readSnapshotDatabase, type ReleaseSnapshot } from '@storeweave/db';
import { parsePgUrl, runPgTool } from './pg-tool';

type DatabaseEvidence = ReleaseSnapshot['database'];

export interface ScratchDatabaseResult {
  readonly systemIdentifier: string;
  readonly targetOid: string | null;
  readonly name: string;
  readonly oid: string;
}

/**
 * Restores a verified custom dump into a newly-created database on the target
 * cluster. Source OIDs/system identifiers are intentionally not inputs: they
 * identify the backup provenance, not a rebuilt target cluster.
 */
export async function restoreDumpToScratch(input: {
  readonly maintenanceUrl: string;
  readonly liveName: string;
  readonly source: DatabaseEvidence;
  readonly dump: string;
  readonly lockFd?: number;
  readonly namePrefix: 'storeweave_full_recovery_' | 'storeweave_restore_';
  readonly id?: string;
  onCreated?(result: ScratchDatabaseResult): void | Promise<void>;
}): Promise<ScratchDatabaseResult> {
  const url = parsePgUrl(input.maintenanceUrl);
  if (!url.hostname || !url.pathname || url.pathname === '/') throw new Error('Scratch restore requires an explicit maintenance endpoint');
  url.port = url.port || process.env.PGPORT || '5432';
  if (decodeURIComponent(url.pathname.slice(1)) === input.liveName) throw new Error('Maintenance database must differ from the recovery live database');
  const id = input.id ?? randomUUID();
  const name = `${input.namePrefix}${id.replaceAll('-', '')}`;
  const client = new Client({ connectionString: url.toString() });
  try {
    await client.connect();
    await client.query('SET search_path = pg_catalog');
    const systemIdentifier = (await client.query<{ system_identifier: string }>('SELECT system_identifier::pg_catalog.text FROM pg_catalog.pg_control_system()')).rows[0]!.system_identifier;
    const server = (await client.query<{ version: string; rolsuper: boolean }>("SELECT pg_catalog.current_setting('server_version_num') AS version, rolsuper FROM pg_catalog.pg_roles WHERE rolname = CURRENT_USER")).rows[0]!;
    if (!/^17(?:\.|$)/.test(input.source.serverVersion) || Math.floor(Number(server.version) / 10000) !== 17) throw new Error('Scratch restoration requires PostgreSQL 17 source and target');
    if (!server.rolsuper) throw new Error('Scratch restoration requires a maintenance superuser');
    const live = (await client.query<{ oid: string }>('SELECT oid::pg_catalog.text FROM pg_catalog.pg_database WHERE datname = $1', [input.liveName])).rows[0];
    const p = input.source.properties;
    const provider = { c: 'libc', i: 'icu', b: 'builtin' }[p.localeProvider];
    if (!provider) throw new Error('Unsupported snapshot locale provider');
    const locale = provider === 'icu' ? `ICU_LOCALE ${literal(p.locale ?? '')}${p.icuRules === null ? '' : ` ICU_RULES ${literal(p.icuRules)}`}`
      : provider === 'builtin' ? `BUILTIN_LOCALE ${literal(p.locale ?? '')}` : '';
    await client.query(`CREATE DATABASE ${ident(name)} TEMPLATE template0 OWNER ${ident(p.owner)} ENCODING ${literal(p.encoding)}
      LOCALE_PROVIDER ${provider} LC_COLLATE ${literal(p.collate)} LC_CTYPE ${literal(p.ctype)} ${locale} TABLESPACE ${ident(p.tablespace)} CONNECTION LIMIT 0`);
    const scratch = (await client.query<{ oid: string }>('SELECT oid::pg_catalog.text FROM pg_catalog.pg_database WHERE datname = $1', [name])).rows[0]!;
    const result = { systemIdentifier, targetOid: live?.oid ?? null, name, oid: scratch.oid };
    await input.onCreated?.(result);
    const scratchUrl = new URL(url);
    scratchUrl.pathname = `/${encodeURIComponent(name)}`;
    await runPgTool('pg_restore', scratchUrl.toString(), ['--exit-on-error', '--single-transaction', input.dump], input.lockFd);
    await client.query('BEGIN');
    try {
      await client.query(`COMMENT ON DATABASE ${ident(name)} IS ${p.comment === null ? 'NULL' : literal(p.comment)}`);
      await client.query(`REVOKE ALL PRIVILEGES ON DATABASE ${ident(name)} FROM PUBLIC, ${ident(p.owner)}`);
      const pending = [...p.acl];
      while (pending.length) {
        let applied = false;
        for (let index = pending.length - 1; index >= 0; index--) {
          const grant = pending[index]!;
          const capable = await client.query<{ allowed: boolean }>('SELECT pg_catalog.has_database_privilege($1, $2, $3) AS allowed', [grant.grantor, name, `${grant.privilege} WITH GRANT OPTION`]);
          if (!capable.rows[0]!.allowed) continue;
          await client.query(`SET LOCAL ROLE ${ident(grant.grantor)}`);
          await client.query(`GRANT ${grant.privilege} ON DATABASE ${ident(name)} TO ${grant.grantee === null ? 'PUBLIC' : ident(grant.grantee)}${grant.grantable ? ' WITH GRANT OPTION' : ''}`);
          await client.query('RESET ROLE');
          pending.splice(index, 1);
          applied = true;
        }
        if (!applied) throw new Error('Snapshot database grant chain cannot be restored');
      }
      for (const setting of p.settings) {
        for (const entry of setting.values) {
          const split = entry.indexOf('=');
          if (split < 1) throw new Error('Invalid snapshot database setting');
          const key = entry.slice(0, split);
          const command = `${setting.role === null ? `ALTER DATABASE ${ident(name)}` : `ALTER ROLE ${ident(setting.role)} IN DATABASE ${ident(name)}`} SET ${ident(key)}`;
          const encoded = settingValue(key, entry.slice(split + 1));
          if (encoded === null) {
            const previous = (await client.query('SELECT pg_catalog.current_setting($1) AS value', [key])).rows[0]!.value;
            await client.query('SELECT pg_catalog.set_config($1, $2, true)', [key, entry.slice(split + 1)]);
            await client.query(`${command} FROM CURRENT`);
            await client.query('SELECT pg_catalog.set_config($1, $2, true)', [key, previous]);
          } else await client.query(`${command} TO ${encoded}`);
        }
      }
      await client.query(`ALTER DATABASE ${ident(name)} CONNECTION LIMIT ${p.connectionLimit}`);
      const actual = await readSnapshotDatabase(client, name);
      if (actual.oid !== scratch.oid || catalogDigest(actual.properties) !== catalogDigest(p)) throw new Error('Restored database properties differ from the backup');
      await client.query('COMMIT');
    } catch (error) {
      try { await client.query('ROLLBACK'); }
      catch (cleanup) { throw new AggregateError([error, cleanup], 'Scratch metadata restoration and cleanup failed'); }
      throw error;
    }
    return result;
  } finally { await client.end(); }
}

// PG17 pg_dump/dumputils.c distinguishes an empty list from one empty item.
function settingValue(key: string, value: string): string | null {
  const quotedLists = ['local_preload_libraries', 'output_plugin_libraries', 'search_path', 'session_preload_libraries',
    'shared_preload_libraries', 'temp_tablespaces', 'unix_socket_directories'];
  if (!quotedLists.includes(key.toLowerCase())) return literal(value);
  if (/^[ \t\r\n\v\f]*$/.test(value)) return null;
  const token = /[ \t\r\n\v\f]*(?:\"((?:[^\"]|\"\")*)\"|(?!\")([^, \t\r\n\v\f]+))[ \t\r\n\v\f]*(,|$)/gy;
  const entries: string[] = [];
  for (;;) {
    const matched = token.exec(value);
    if (!matched) throw new Error('Invalid quoted-list database setting');
    entries.push(literal(matched[1] === undefined ? matched[2]! : matched[1].replaceAll('\"\"', '\"')));
    if (!matched[3]) break;
  }
  return entries.join(', ');
}
