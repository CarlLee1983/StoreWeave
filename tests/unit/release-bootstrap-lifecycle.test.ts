import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { bootstrapRelease } from '../../packages/platform/release/src/bootstrap';
import { release } from '../../packages/releases/base/src/runtime';

const directories: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true });
});
function directory() {
  const value = mkdtempSync(join(tmpdir(), 'storeweave-release-bootstrap-'));
  directories.push(value);
  return value;
}

describe('release bootstrap logger lifecycle', () => {
  it.each([false, true])('closes its file logger when bootstrap failure=%s', async failure => {
    const location = directory();
    const file = join(location, 'app.log');
    const configPath = join(location, 'base.json');
    writeFileSync(configPath, JSON.stringify({
      version: 1, store: { id: 'logger-test', name: 'Logger Test' },
      database: { url: 'postgres://unused.invalid/test' },
      logging: { level: 'info', destination: 'file', file },
      theme: { id: failure ? 'missing' : 'none' },
      security: { signingKeys: [{ id: 'test', secretRef: 'SW_SIGNING_KEY_TEST' }] },
    }));
    process.env.SW_SIGNING_KEY_TEST = Buffer.alloc(32, 5).toString('base64url');
    const destination = vi.spyOn(pino, 'destination');
    if (failure) {
      await expect(bootstrapRelease(release, { configPath, loggerName: 'test' })).rejects.toThrow('not part of release');
    } else {
      const { runtime } = await bootstrapRelease(release, { configPath, loggerName: 'test' });
      runtime.logger.info({}, 'before close');
      await runtime.close();
      expect(readFileSync(file, 'utf8')).toContain('before close');
    }
    expect(destination.mock.results[0]?.value.destroyed).toBe(true);
  });
});
