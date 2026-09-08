import { spawn } from 'node:child_process';
import { closeSync, constants, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, mkdtempSync, openSync, readSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

// Native transition children retain the parent's flock open-file description until they exit.
function exec(tool: string, args: string[], options: { env: NodeJS.ProcessEnv; maxBuffer: number; lockFd?: number }) {
  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(tool, args, { env: options.env, stdio: ['ignore', 'pipe', 'pipe', ...(options.lockFd === undefined ? [] : [options.lockFd])] });
    const output: Buffer[][] = [[], []];
    const sizes = [0, 0];
    let failure: Error | undefined;
    for (const [index, stream] of [child.stdout, child.stderr].entries()) stream?.on('data', (chunk: Buffer) => {
      sizes[index] = sizes[index]! + chunk.length;
      if (sizes[index]! > options.maxBuffer) {
        failure ??= new Error('Native PostgreSQL tool output exceeded its limit');
        child.kill('SIGKILL');
      } else output[index]!.push(chunk);
    });
    child.once('error', error => { failure = error; });
    child.once('close', (code, signal) => {
      const stdout = Buffer.concat(output[0]!).toString(), stderr = Buffer.concat(output[1]!).toString();
      if (failure || code !== 0) reject(Object.assign(failure ?? new Error(`${tool} failed${stderr.trim() ? `: ${stderr.trim()}` : ''}`), { code: code ?? signal, stderr }));
      else resolve({ stdout, stderr });
    });
  });
}

function nativeEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL']) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return env;
}

function syncPath(path: string) {
  const descriptor = openSync(path, 'r');
  try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
}

/** Publishes only a completed private dump, refusing any existing destination. */
export async function writePgBackup(databaseUrl: string, destination: string, snapshotId?: string, lockFd?: number) {
  destination = resolve(destination);
  if (lstatSync(destination, { throwIfNoEntry: false })) throw new Error('Backup destination already exists');
  const parent = dirname(destination);
  mkdirSync(parent, { recursive: true });
  const staging = mkdtempSync(join(parent, '.backup-'));
  try {
    const dump = join(staging, 'database.dump');
    writeFileSync(dump, '', { flag: 'wx', mode: 0o600 });
    const result = await runPgTool('pg_dump', databaseUrl,
      ['--format=custom', '--file', dump, ...(snapshotId ? [`--snapshot=${snapshotId}`] : [])], lockFd);
    await exec('pg_restore', ['--list', dump], { env: nativeEnvironment(), maxBuffer: 16 * 1024 * 1024, lockFd });
    syncPath(dump);
    // Same-filesystem hard-link publication is exclusive; rename would overwrite another writer's file.
    linkSync(dump, destination);
    syncPath(parent);
    return result;
  } finally { rmSync(staging, { recursive: true, force: true }); }
}

/** Native libpq tools receive a private password file, never the application secret environment. */
export async function runPgTool(tool: 'pg_dump' | 'pg_restore', databaseUrl: string, args: readonly string[], lockFd?: number) {
  const connectionOptions = ['--dbname', '--host', '--hostaddr', '--port', '--username', '--password', '--no-password'];
  if (args.some(arg => arg.startsWith('-') && (!arg.startsWith('--')
    || connectionOptions.some(option => option.startsWith(arg.split('=')[0]!))))) {
    throw new Error('Native PostgreSQL tool arguments cannot override connection credentials');
  }
  const url = parsePgUrl(databaseUrl);
  let password: string;
  try { password = url.searchParams.get('password') ?? (url.password ? decodeURIComponent(url.password) : process.env.PGPASSWORD ?? ''); }
  catch { throw new Error('Invalid PostgreSQL password encoding'); }
  if (/[\r\n\0]/.test(password)) throw new Error('PostgreSQL password cannot be represented in a password file');
  url.password = '';
  url.searchParams.delete('password');
  // libpq URI values use percent encoding, not form-style '+' for spaces.
  url.search = [...url.searchParams].map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`).join('&');
  if (!url.pathname || url.pathname === '/') {
    const database = process.env.PGDATABASE;
    if (database?.includes('://') || database?.includes('=')) throw new Error('PGDATABASE must be a database name');
    if (database) url.pathname = `/${encodeURIComponent(database)}`;
  }
  const directory = mkdtempSync(join(tmpdir(), 'storeweave-pgpass-'));
  try {
    const passfile = join(directory, 'pgpass');
    // Only the URI authority selects the endpoint; extra connection switches are refused above.
    const existingPassfile = process.env.PGPASSFILE ?? (process.env.HOME ? join(process.env.HOME, '.pgpass') : undefined);
    let credentials: string | Buffer = password ? `*:*:*:*:${password.replace(/\\/g, '\\\\').replace(/:/g, '\\:')}\n` : '';
    if (!password && existingPassfile) {
      let descriptor: number | undefined;
      try {
        descriptor = openSync(existingPassfile, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Password file must be a private regular file within 1 MiB');
      }
      if (descriptor !== undefined) {
        try {
          const source = fstatSync(descriptor);
          if (!source.isFile() || source.size > 1024 * 1024 || (source.mode & 0o077)) throw new Error('Password file must be a private regular file within 1 MiB');
          const buffer = Buffer.alloc(1024 * 1024 + 1);
          let length = 0;
          while (length < buffer.length) {
            const count = readSync(descriptor, buffer, length, buffer.length - length, null);
            if (!count) break;
            length += count;
          }
          if (length > 1024 * 1024) throw new Error('Password file must be a private regular file within 1 MiB');
          credentials = buffer.subarray(0, length);
        } finally { closeSync(descriptor); }
      }
    }
    writeFileSync(passfile, credentials, { mode: 0o600, flag: 'wx' });
    const env: NodeJS.ProcessEnv = { ...nativeEnvironment(), PGPASSFILE: passfile };
    for (const key of ['PGHOST', 'PGPORT', 'PGUSER',
      'PGSSLMODE', 'PGSSLROOTCERT', 'PGSSLCERT', 'PGSSLKEY', 'PGSSLCRL', 'PGCONNECT_TIMEOUT', 'PGCLIENTENCODING']) {
      if (process.env[key] !== undefined) env[key] = process.env[key];
    }
    const redact = (value: string) => password ? value.split(password).join('<redacted>').split(encodeURIComponent(password)).join('<redacted>') : value;
    try {
      const result = await exec(tool, ['--no-password', '--dbname', url.toString(), ...args], { env, maxBuffer: 16 * 1024 * 1024, lockFd });
      return { stdout: result.stdout, stderr: redact(result.stderr) };
    } catch (error) {
      const failure = error as NodeJS.ErrnoException & { stderr?: string };
      const detail = (failure.stderr ?? '').trim();
      const redacted = redact(detail);
      throw new Error(`${tool} failed${failure.code ? ` (${failure.code})` : ''}${redacted ? `: ${redacted}` : ''}`);
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

/** One URL policy for native tools and paired database identity checks. */
export function parsePgUrl(databaseUrl: string): URL {
  let url: URL;
  try { url = new URL(databaseUrl); }
  catch { throw new Error('Invalid PostgreSQL connection URL'); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error('Invalid PostgreSQL connection protocol');
  if (url.hash || [...url.searchParams.keys()].some(key => ['passfile', 'service', 'sslpassword', 'host', 'hostaddr', 'port', 'user', 'dbname', 'database'].includes(key.toLowerCase())
    || (key.toLowerCase() === 'password' && key !== 'password'))
    || url.searchParams.getAll('options').length > 1
    || url.searchParams.getAll('password').length > 1 || (url.password && url.searchParams.has('password'))) {
    throw new Error('Unsupported or ambiguous PostgreSQL credential parameters');
  }
  // Reject ambiguous form encoding; both the application driver and libpq accept explicit %2B.
  if (url.search.slice(1).split('&').some(part => {
    const equal = part.indexOf('=');
    return equal >= 0 && new URLSearchParams(part).has('password') && part.slice(equal + 1).includes('+');
  })) throw new Error('Encode a literal plus in a PostgreSQL query password as %2B');
  const authority = databaseUrl.match(/^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/i)?.[1] ?? '';
  const userinfo = authority.includes('@') ? authority.slice(0, authority.lastIndexOf('@')) : '';
  if (url.searchParams.get('password') === '' || (userinfo.includes(':') && !url.password)) throw new Error('An explicit PostgreSQL password cannot be empty');
  return url;
}
