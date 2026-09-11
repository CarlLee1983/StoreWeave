import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

const exec = promisify(execFile);
it.each([
  ['upgrade', [], 'upgrade requires --external-writers-stopped'],
  ['upgrade', ['--external-writers-stopped'], 'Use --release, --resume, or --snapshot with --checksum'],
  ['rollback', [], 'rollback requires --yes and --external-writers-stopped'],
  ['rollback', ['--yes'], 'rollback requires --yes and --external-writers-stopped'],
  ['rollback', ['--external-writers-stopped'], 'rollback requires --yes and --external-writers-stopped'],
  ['rollback', ['--yes', '--external-writers-stopped'], 'Use --snapshot or --safety with --checksum'],
] as const)('%s refuses incomplete operator input before touching installation state: %j', async (command, args, message) => {
  const root = mkdtempSync(join(tmpdir(), 'storeweave-cli-gate-'));
  const home = join(root, 'uncreated-home');
  try {
    await expect(exec(join(process.cwd(), 'node_modules/.bin/tsx'), ['tools/cli/src/main.ts', command, ...args],
      { env: { ...process.env, STOREWEAVE_HOME: home }, timeout: 10_000 }))
      .rejects.toMatchObject({ stderr: expect.stringContaining(message) });
    expect(existsSync(home)).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 10_000);
