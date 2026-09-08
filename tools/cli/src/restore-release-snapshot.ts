import { readLegacySafetySnapshot } from './legacy-safety-snapshot';
import { readLegacyPairedSnapshot } from './legacy-paired-snapshot';
import { writeRestoreJournal } from './restore-journal';
import { lstatSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Client, escapeIdentifier as ident, escapeLiteral as literal } from 'pg';
import { catalogDigest, readSnapshotDatabase } from '@storeweave/db';
import { readPairedSnapshot } from './read-release-snapshot';
import { parsePgUrl, runPgTool } from './pg-tool';

/** Restores only to a new database. Persists intent and the created OID before restoring; caller must verify source runtime before cutover. */
export async function restoreSnapshotToScratch(directory: string, expectedChecksum: string, maintenanceUrl: string, journalDirectory: string, lockFd?: number, format: 'modern' | 'legacy-b01' | 'legacy-b01-safety' = 'modern') {
  const readSnapshot = format === 'legacy-b01-safety' ? readLegacySafetySnapshot : format === 'legacy-b01' ? readLegacyPairedSnapshot : readPairedSnapshot;
  const pair = await readSnapshot(directory, expectedChecksum);
  const saved = pair.manifest.evidence;
  let url: URL;
  try { url = parsePgUrl(maintenanceUrl); } catch { throw new Error('Invalid maintenance database URL'); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error('Invalid maintenance database protocol');
  if (!url.hostname || !url.pathname || url.pathname === '/') throw new Error('Scratch restore requires an explicit maintenance endpoint');
  url.port = url.port || process.env.PGPORT || '5432';
  if (catalogDigest({ host: url.hostname, port: url.port, database: saved.database.name }) !== pair.manifest.endpointChecksum) throw new Error('Snapshot endpoint mismatch');
  const client = new Client({ connectionString: url.toString() });
  const id = randomUUID();
  const name = `storeweave_restore_${id.replaceAll('-', '')}`;
  const journalRoot = resolve(journalDirectory);
  const rootStat = lstatSync(journalRoot);
  if (!rootStat.isDirectory() || (rootStat.mode & 0o777) !== 0o700 || rootStat.uid !== process.geteuid?.()) throw new Error('Journal root must be a pre-existing owned 0700 directory');
  const journalHome = join(journalRoot, id);
  mkdirSync(journalHome, { mode: 0o700 });
  const journalFile = join(journalHome, 'journal.json');
  let scratchOid: string | null = null;
  function persist(phase: 'planned' | 'created' | 'restored' | 'failed') {
    writeRestoreJournal(journalFile, { schemaVersion: 1, kind: format === 'legacy-b01-safety' ? 'legacy-b01-safety-restore' : format === 'legacy-b01' ? 'legacy-b01-restore' : 'restore', id, phase,
      snapshot: { directory: pair.directory, checksum: expectedChecksum }, systemIdentifier: saved.database.systemIdentifier,
      live: { name: saved.database.name, oid: saved.database.oid }, scratch: { name, oid: scratchOid },
      quarantineName: `storeweave_retained_${id.replaceAll('-', '')}` }, journalRoot);
  }
  persist('planned');
  try {
    await client.connect();
    await client.query('SET search_path = pg_catalog');
    const cluster = (await client.query('SELECT system_identifier::pg_catalog.text FROM pg_catalog.pg_control_system()')).rows[0].system_identifier;
    if (cluster !== saved.database.systemIdentifier) throw new Error('Snapshot cluster mismatch');
    const server = (await client.query("SELECT pg_catalog.current_setting('server_version_num') AS version, rolsuper FROM pg_catalog.pg_roles WHERE rolname = CURRENT_USER")).rows[0];
    if (!/^17(?:\.|$)/.test(saved.database.serverVersion) || Math.floor(Number(server.version) / 10000) !== 17) throw new Error('Paired scratch restoration requires PostgreSQL 17 source and target');
    if (!server.rolsuper) throw new Error('Scratch restoration requires a maintenance superuser');
    const live = (await client.query('SELECT oid::pg_catalog.text FROM pg_catalog.pg_database WHERE datname = $1', [saved.database.name])).rows[0];
    if (live?.oid !== saved.database.oid) throw new Error('Snapshot live database OID mismatch');
    const p = saved.database.properties;
    const provider = { c: 'libc', i: 'icu', b: 'builtin' }[p.localeProvider];
    if (!provider) throw new Error('Unsupported snapshot locale provider');
    const locale = provider === 'icu' ? `ICU_LOCALE ${literal(p.locale ?? '')}${p.icuRules === null ? '' : ` ICU_RULES ${literal(p.icuRules)}`}`
      : provider === 'builtin' ? `BUILTIN_LOCALE ${literal(p.locale ?? '')}` : '';
    await client.query(`CREATE DATABASE ${ident(name)} TEMPLATE template0 OWNER ${ident(p.owner)} ENCODING ${literal(p.encoding)}
      LOCALE_PROVIDER ${provider} LC_COLLATE ${literal(p.collate)} LC_CTYPE ${literal(p.ctype)} ${locale} TABLESPACE ${ident(p.tablespace)} CONNECTION LIMIT 0`);
    const oid = (await client.query('SELECT oid::pg_catalog.text FROM pg_catalog.pg_database WHERE datname = $1', [name])).rows[0].oid as string;
    scratchOid = oid;
    persist('created');
    const scratchUrl = new URL(url);
    scratchUrl.pathname = `/${name}`;
    // Missing roles/extensions/tablespaces fail here; live and the failed scratch remain untouched for diagnosis.
    await runPgTool('pg_restore', scratchUrl.toString(), ['--exit-on-error', '--single-transaction', pair.dump], lockFd);
    await readSnapshot(directory, expectedChecksum);
    await client.query('BEGIN');
    try {
      await client.query(`COMMENT ON DATABASE ${ident(name)} IS ${p.comment === null ? 'NULL' : literal(p.comment)}`);
      await client.query(`REVOKE ALL PRIVILEGES ON DATABASE ${ident(name)} FROM PUBLIC, ${ident(p.owner)}`);
      const pending = [...p.acl];
      while (pending.length) {
        let applied = false;
        for (let index = pending.length - 1; index >= 0; index--) {
          const grant = pending[index]!;
          const capable = await client.query('SELECT pg_catalog.has_database_privilege($1, $2, $3) AS allowed',
            [grant.grantor, name, `${grant.privilege} WITH GRANT OPTION`]);
          if (!capable.rows[0].allowed) continue;
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
            // Empty list and one empty list item have different stored forms. Only known empty-list GUCs take this path.
            const previous = (await client.query('SELECT pg_catalog.current_setting($1) AS value', [key])).rows[0].value;
            await client.query('SELECT pg_catalog.set_config($1, $2, true)', [key, entry.slice(split + 1)]);
            await client.query(`${command} FROM CURRENT`);
            await client.query('SELECT pg_catalog.set_config($1, $2, true)', [key, previous]);
          } else await client.query(`${command} TO ${encoded}`);
        }
      }
      await client.query(`ALTER DATABASE ${ident(name)} CONNECTION LIMIT ${p.connectionLimit}`);
      const actual = await readSnapshotDatabase(client, name);
      if (actual.oid !== oid || catalogDigest(actual.properties) !== catalogDigest(p)) throw new Error('Restored database properties differ from the snapshot');
      await client.query('COMMIT');
    } catch (error) {
      try { await client.query('ROLLBACK'); }
      catch (cleanup) { throw new AggregateError([error, cleanup], 'Scratch metadata restoration and cleanup failed'); }
      throw error;
    }
    persist('restored');
    return { name, oid, systemIdentifier: cluster as string, snapshotChecksum: expectedChecksum, journalFile };
  } catch (error) {
    try { persist('failed'); }
    catch (journalError) { throw new AggregateError([error, journalError], 'Scratch restoration and journal update failed'); }
    throw error;
  } finally { await client.end(); }
}



// PG17 pg_dump/dumputils.c uses this list-quote distinction. Nonempty values never alter this session.
function settingValue(key: string, value: string): string | null {
  const quotedLists = ['local_preload_libraries', 'output_plugin_libraries', 'search_path', 'session_preload_libraries',
    'shared_preload_libraries', 'temp_tablespaces', 'unix_socket_directories'];
  if (!quotedLists.includes(key.toLowerCase())) return literal(value);
  if (/^[ \t\r\n\v\f]*$/.test(value)) return null;
  const token = /[ \t\r\n\v\f]*(?:"((?:[^"]|"")*)"|(?!")([^, \t\r\n\v\f]+))[ \t\r\n\v\f]*(,|$)/gy;
  const entries: string[] = [];
  for (;;) {
    const matched = token.exec(value);
    if (!matched) throw new Error('Invalid quoted-list database setting');
    entries.push(literal(matched[1] === undefined ? matched[2]! : matched[1].replaceAll('""', '"')));
    if (!matched[3]) break;
  }
  return entries.join(', ');
}
