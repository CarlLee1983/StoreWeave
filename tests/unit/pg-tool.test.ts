import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { runPgTool, writePgBackup } from '../../tools/cli/src/pg-tool';

let directory: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'storeweave-pg-tool-test-'));
  const bin = join(directory, 'bin');
  mkdirSync(bin);
  for (const tool of ['pg_dump', 'pg_restore']) writeFileSync(join(bin, tool), `#!/usr/bin/env node
    const fs = require('node:fs'), crypto = require('node:crypto');
    const file = process.env.PGPASSFILE;
    if (!file) {
      fs.writeFileSync(${JSON.stringify(join(directory, 'offline-validation'))}, JSON.stringify({ args: process.argv.slice(2), env: process.env }));
      if (fs.existsSync(${JSON.stringify(join(directory, `fail-${tool}`))})) { console.error('fixture tool failure'); process.exit(2); }
      process.exit(0);
    }
    fs.writeFileSync(${JSON.stringify(join(directory, 'observed-passfile'))}, file);
    console.log(JSON.stringify({ args: process.argv.slice(2), env: process.env, passfile: file,
      fileMode: fs.statSync(file).mode & 0o777, directoryMode: fs.statSync(require('node:path').dirname(file)).mode & 0o777,
      hash: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') }));
    if (${JSON.stringify(tool)} === 'pg_dump' && process.argv.includes('--file')) {
      fs.writeFileSync(process.argv[process.argv.indexOf('--file') + 1], 'PGDMPfixture');
      if (fs.existsSync(${JSON.stringify(join(directory, 'create-target'))})) fs.writeFileSync(${JSON.stringify(join(directory, 'published.dump'))}, 'preserve');
    }
    if (fs.existsSync(${JSON.stringify(join(directory, `fail-${tool}`))})) { console.error('fixture tool failure'); process.exitCode = 2; }
    if (process.argv.includes('--fail')) { console.error('authentication failure fixture-secret'); process.exitCode = 2; }
  `, { mode: 0o755 });
  vi.stubEnv('PATH', `${bin}:${process.env.PATH}`);
  vi.stubEnv('HOME', directory);
  vi.stubEnv('PGPASSWORD', 'inherited-password');
  vi.stubEnv('DATABASE_URL', 'postgres://app:application-secret@host/database');
  vi.stubEnv('UNRELATED_SECRET', 'not-for-native-tools');
  vi.stubEnv('PGSERVICE', 'unrelated-service');
  vi.stubEnv('PGDATABASE', 'postgres://other:other-secret@host/database');
});
afterEach(() => { vi.unstubAllEnvs(); rmSync(directory, { recursive: true, force: true }); });
const digest = (value: string) => createHash('sha256').update(value).digest('hex');

it.each(['pg_dump', 'pg_restore'] as const)('%s receives only sanitized connection args and a private, removed password file', async tool => {
  const dump = join(directory, 'fixture.dump');
  const result = await runPgTool(tool, 'postgres://operator:p%3Aa%5Css@db.example:5433/store?sslmode=require', ['--file', dump]);
  const output = JSON.parse(result.stdout);
  expect(output.args).toEqual(['--no-password', '--dbname', 'postgres://operator@db.example:5433/store?sslmode=require', '--file', dump]);
  expect(output).toMatchObject({ fileMode: 0o600, directoryMode: 0o700, hash: digest('*:*:*:*:p\\:a\\\\ss\n') });
  for (const key of ['PGPASSWORD', 'DATABASE_URL', 'UNRELATED_SECRET', 'PGSERVICE', 'PGDATABASE']) expect(output.env).not.toHaveProperty(key);
  expect(existsSync(output.passfile)).toBe(false);
});

it('publishes a private completed backup without leaving staging or extra hard links', async () => {
  const target = join(directory, 'published.dump');
  await writePgBackup('postgres://user:secret@host/db', target);
  expect(readFileSync(target, 'utf8')).toBe('PGDMPfixture');
  expect(statSync(target).mode & 0o777).toBe(0o600);
  expect(statSync(target).nlink).toBe(1);
  const validation = JSON.parse(readFileSync(join(directory, 'offline-validation'), 'utf8'));
  expect(validation.args[0]).toBe('--list');
  expect(validation.args).not.toContain('--dbname');
  expect(Object.keys(validation.env).filter(key => key.startsWith('PG'))).toEqual([]);
  expect(readdirSync(directory).filter(name => name.startsWith('.backup-'))).toEqual([]);
});

it('CLI backup uses private publication without activating the application runtime', () => {
  const config = join(directory, 'commerce.json');
  writeFileSync(config, JSON.stringify({ version: 1, store: { id: 'backup', name: 'Backup' },
    database: { url: 'postgres://user:fixture-secret@127.0.0.1:1/unreachable' }, extensions: [],
    paths: { backupDir: join(directory, 'backups'), dataDir: join(directory, 'data') } }));
  const target = join(directory, 'published.dump');
  const output = execFileSync(join(process.cwd(), 'node_modules/.bin/tsx'), [join(process.cwd(), 'tools/cli/src/main.ts'), 'backup', '--out', target],
    { encoding: 'utf8', env: { ...process.env, STOREWEAVE_CONFIG: config }, timeout: 10_000 });
  expect(output).toContain('備份完成');
  expect(output).not.toContain('fixture-secret');
  expect(readFileSync(target, 'utf8')).toBe('PGDMPfixture');
  expect(statSync(target).mode & 0o777).toBe(0o600);
}, 15_000);

it('CLI refuses a missing pg_restore before running pg_dump', () => {
  const config = join(directory, 'commerce.json');
  writeFileSync(config, JSON.stringify({ version: 1, store: { id: 'backup', name: 'Backup' },
    database: { url: 'postgres://user:secret@127.0.0.1:1/unreachable' }, extensions: [],
    paths: { backupDir: join(directory, 'backups'), dataDir: join(directory, 'data') } }));
  writeFileSync(join(directory, 'bin', 'sh'), `#!/usr/bin/env node
    process.exit(process.argv[3] === 'command -v pg_dump' ? 0 : 1);
  `, { mode: 0o755 });
  let failure = '';
  try {
    execFileSync(join(process.cwd(), 'node_modules/.bin/tsx'), [join(process.cwd(), 'tools/cli/src/main.ts'), 'backup'],
      { encoding: 'utf8', env: { ...process.env, STOREWEAVE_CONFIG: config }, timeout: 10_000, stdio: 'pipe' });
  } catch (error) { failure = String((error as { stderr: string }).stderr); }
  expect(failure).toContain('找不到 pg_restore');
  expect(existsSync(join(directory, 'observed-passfile'))).toBe(false);
}, 15_000);

it.each(['pg_dump', 'pg_restore'])('removes partial staging when %s fails', async tool => {
  const target = join(directory, 'published.dump');
  writeFileSync(join(directory, `fail-${tool}`), '');
  await expect(writePgBackup('postgres://user:secret@host/db', target)).rejects.toThrow('fixture tool failure');
  expect(existsSync(target)).toBe(false);
  expect(readdirSync(directory).filter(name => name.startsWith('.backup-'))).toEqual([]);
});

it.each(['before', 'during'])('preserves a backup destination created %s dumping', async when => {
  const target = join(directory, 'published.dump');
  if (when === 'before') writeFileSync(target, 'preserve');
  else writeFileSync(join(directory, 'create-target'), '');
  await expect(writePgBackup('postgres://user:secret@host/db', target)).rejects.toThrow();
  expect(readFileSync(target, 'utf8')).toBe('preserve');
  expect(readdirSync(directory).filter(name => name.startsWith('.backup-'))).toEqual([]);
});

it('moves an inherited PGPASSWORD into the private file instead of forwarding it', async () => {
  const result = JSON.parse((await runPgTool('pg_dump', 'postgres://operator@host/store', [])).stdout);
  expect(result.hash).toBe(digest('*:*:*:*:inherited-password\n'));
  expect(result.env).not.toHaveProperty('PGPASSWORD');
  expect(existsSync(result.passfile)).toBe(false);
});

it('accepts an authority port without mistaking it for an empty password', async () => {
  const result = JSON.parse((await runPgTool('pg_dump', 'postgres://host:5432/store', [])).stdout);
  expect(result.args[2]).toBe('postgres://host:5432/store');
});

it('uses a private copy of an existing password file when no inline password is supplied', async () => {
  vi.stubEnv('PGPASSWORD', '');
  const passfile = join(directory, 'configured.pgpass');
  writeFileSync(passfile, 'host:5432:store:operator:configured-password\n', { mode: 0o600 });
  vi.stubEnv('PGPASSFILE', passfile);
  const result = JSON.parse((await runPgTool('pg_dump', 'postgres://operator@host/store', [])).stdout);
  expect(result.hash).toBe(digest('host:5432:store:operator:configured-password\n'));
  expect(result.passfile).not.toBe(passfile);
  expect(existsSync(result.passfile)).toBe(false);
  expect(existsSync(passfile)).toBe(true);
});

it.each(['permissions', 'fifo', 'size', 'symlink'])('refuses a password file with invalid %s before execution', async kind => {
  vi.stubEnv('PGPASSWORD', '');
  const passfile = join(directory, 'invalid.pgpass');
  if (kind === 'symlink') symlinkSync(join(directory, 'missing'), passfile);
  else if (kind === 'fifo') execFileSync('mkfifo', [passfile]);
  else {
    writeFileSync(passfile, 'host:5432:store:operator:secret\n', { mode: 0o600 });
    if (kind === 'permissions') chmodSync(passfile, 0o644);
    if (kind === 'size') truncateSync(passfile, 1024 * 1024 + 1);
  }
  vi.stubEnv('PGPASSFILE', passfile);
  await expect(runPgTool('pg_dump', 'postgres://operator@host/store', [])).rejects.toThrow('private regular file');
  expect(existsSync(join(directory, 'observed-passfile'))).toBe(false);
});

it.each(['host', 'hostaddr', 'port', 'user', 'dbname', 'database'])('refuses URI %s overrides before execution', async key => {
  await expect(runPgTool('pg_dump', `postgres://user:secret@host/db?${key}=override`, [])).rejects.toThrow('credential parameters');
  expect(existsSync(join(directory, 'observed-passfile'))).toBe(false);
});

it.each(['--dbname=other', '--db=other', '--host', '--username=other', '-hother', '-vUother'])('refuses connection argument %s before execution', async arg => {
  await expect(runPgTool('pg_dump', 'postgres://user:secret@host/db', [arg])).rejects.toThrow('override connection');
  expect(existsSync(join(directory, 'observed-passfile'))).toBe(false);
});

it('rejects duplicate session options before execution', async () => {
  await expect(runPgTool('pg_dump', 'postgres://user:secret@host/db?options=-c%20timezone%3DUTC&options=-c%20search_path%3Dpublic', []))
    .rejects.toThrow('ambiguous PostgreSQL credential parameters');
  expect(existsSync(join(directory, 'observed-passfile'))).toBe(false);
});

it.each(['postgres://user:@host/db', 'postgres://user@host/db?password='])('does not replace an explicit empty password with other credentials', async url => {
  const passfile = join(directory, 'other.pgpass');
  writeFileSync(passfile, '*:*:*:*:other-secret\n', { mode: 0o600 });
  vi.stubEnv('PGPASSFILE', passfile);
  await expect(runPgTool('pg_dump', url, [])).rejects.toThrow('cannot be empty');
  expect(existsSync(join(directory, 'observed-passfile'))).toBe(false);
});

it('redacts failures and removes credentials on native tool failure', async () => {
  let message = '';
  try { await runPgTool('pg_restore', 'postgres://operator:fixture-secret@host/store', ['--fail']); }
  catch (error) { message = (error as Error).message; }
  expect(message).toContain('pg_restore failed (2): authentication failure <redacted>');
  expect(message).not.toContain('fixture-secret');
  expect(existsSync(readFileSync(join(directory, 'observed-passfile'), 'utf8'))).toBe(false);
});

it('preserves percent-encoded spaces in libpq query parameters', async () => {
  const result = JSON.parse((await runPgTool('pg_dump', 'postgres://operator:secret@host/store?sslrootcert=%2Ftmp%2Fmy%20certificate.pem', [])).stdout);
  expect(result.args[2]).toBe('postgres://operator@host/store?sslrootcert=%2Ftmp%2Fmy%20certificate.pem');
});

it.each(['postgres://user:one@host/db?password=two', 'postgres://user@host/db?sslpassword=secret',
  'postgres://user@host/db?Password=secret', 'postgres://user:line%0Abreak@host/db', 'not-a-url'])('rejects unsupported credentials before execution', async url => {
  await expect(runPgTool('pg_dump', url, [])).rejects.toThrow();
});

it.each([['a%2Bb', 'a+b'], ['a%20b', 'a b']])('decodes explicit query password %s', async (encoded, decoded) => {
  const result = JSON.parse((await runPgTool('pg_dump', `postgres://user@host/db?password=${encoded}`, [])).stdout);
  expect(result.hash).toBe(digest(`*:*:*:*:${decoded}\n`));
});

it('rejects ambiguous raw plus in query passwords before execution', async () => {
  await expect(runPgTool('pg_dump', 'postgres://user@host/db?password=a+b', [])).rejects.toThrow('%2B');
  expect(existsSync(join(directory, 'observed-passfile'))).toBe(false);
});


it('bounds native tool output and removes its owned credentials on failure', async () => {
  writeFileSync(join(directory, 'bin', 'pg_dump'), `#!/usr/bin/env node
    require('node:fs').writeFileSync(${JSON.stringify(join(directory, 'observed-passfile'))}, process.env.PGPASSFILE);
    process.stdout.write(Buffer.alloc(17 * 1024 * 1024, 'x'));
    setTimeout(() => {}, 30000);
  `, { mode: 0o755 });
  await expect(runPgTool('pg_dump', 'postgres://operator:secret@host/store', [])).rejects.toThrow('pg_dump failed');
  expect(existsSync(readFileSync(join(directory, 'observed-passfile'), 'utf8'))).toBe(false);
});
