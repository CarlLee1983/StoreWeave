import { stripVTControlCharacters } from 'node:util';
import { validateLegacyB01Directory, validateReleaseDirectory } from './release-validation';
import { parsePgUrl } from './pg-tool';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';

/** Execute only a complete, validated private copy; callers revalidate their durable pair after the command. */
export function runReleaseCli(expected: ReturnType<typeof validateReleaseDirectory> | ReturnType<typeof validateLegacyB01Directory>, configFile: string, databaseUrl: string,
  command: 'migrate' | 'status', lockFd?: number) {
  const legacy = 'format' in expected;
  if (legacy && command !== 'status') throw new Error('Legacy recovery CLI only supports status');
  const url = parsePgUrl(databaseUrl);
  // B01 status runs CREATE TABLE IF NOT EXISTS; target the existing public ledger, never a preceding schema.
  if (legacy) url.searchParams.set('options', `${url.searchParams.get('options') ?? ''} -c search_path=public`.trim());
  databaseUrl = url.toString();
  const config = z.record(z.unknown()).parse(parse(readFileSync(configFile, 'utf8')));
  const database = z.record(z.unknown()).parse(config.database);
  const temporary = mkdtempSync(join(tmpdir(), 'storeweave-release-cli-'));
  try {
    const executable = join(temporary, 'source');
    cpSync(expected.directory, executable, { recursive: true, force: false, errorOnExist: true });
    const copied = legacy ? validateLegacyB01Directory(executable) : validateReleaseDirectory(executable);
    if (copied.releaseId !== expected.releaseId || copied.version !== expected.version || copied.name !== expected.name
      || ('manifestChecksum' in expected && (!('manifestChecksum' in copied) || copied.manifestChecksum !== expected.manifestChecksum))
      || copied.treeChecksum !== expected.treeChecksum) throw new Error('Retained source changed before execution');
    const file = join(temporary, 'config.json');
    // Keep the original unresolved settings. The private override is interpolated exactly once by the retained loader.
    writeFileSync(file, JSON.stringify({ ...config, database: { ...database, url: '${STOREWEAVE_VERIFY_DATABASE_URL}', autoMigrate: false },
      logging: { level: 'error', destination: 'stdout' } }), { mode: 0o600, flag: 'wx' });
    let output: string;
    try {
      output = execFileSync(join(executable, 'runtime/bin/node'),
        [join(executable, 'app/cli.js'), ...(command === 'status' ? ['migrate', '--status', ...(legacy ? [] : ['--json'])] : ['migrate'])], {
          env: { ...process.env, STOREWEAVE_CONFIG: file, COMMERCE_CONFIG: file,
            STOREWEAVE_VERIFY_DATABASE_URL: databaseUrl, ...('manifestChecksum' in expected ? { STOREWEAVE_BUILD_MANIFEST_SHA: expected.manifestChecksum } : {}) },
          encoding: 'utf8', maxBuffer: 1024 * 1024, timeout: command === 'status' ? 30_000 : undefined, killSignal: 'SIGKILL',
          stdio: ['ignore', 'pipe', 'pipe', ...(lockFd === undefined ? [] : [lockFd])],
        });
    } catch { throw new Error('Release CLI failed'); }
    if (legacy) {
      const lines = stripVTControlCharacters(output).split(/\r?\n/).map(line => line.trim()).filter(Boolean);
      const pending = lines.indexOf('待套用');
      if (lines[0] !== '已套用' || pending < 1 || pending !== lines.length - 2 || lines[pending + 1] !== '（無）'
        || lines.filter(line => line === '待套用').length !== 1) throw new Error('Legacy source reports pending migrations or invalid status');
    }
    return output;
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}
