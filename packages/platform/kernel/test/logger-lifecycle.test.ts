import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLogger } from '../src/logger';

const directories: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true });
});
function directory() {
  const value = mkdtempSync(join(tmpdir(), 'storeweave-logger-'));
  directories.push(value);
  return value;
}

describe('owned logger resources', () => {
  it('flushes buffered parent and child logs before closing its file exactly once', async () => {
    const file = join(directory(), 'app.log');
    const destination = vi.spyOn(pino, 'destination');
    const logger = createLogger({ level: 'info', destination: 'file', file });
    logger.info({ password: 'private-value' }, 'first');
    const child = logger.child({ component: 'child' });
    expect(child).not.toHaveProperty('close');
    child.info({}, 'second');
    const closing = logger.close();
    expect(logger.close()).toBe(closing);
    await closing;
    const content = readFileSync(file, 'utf8');
    expect(content.trim().split('\n').map(line => JSON.parse(line).msg)).toEqual(['first', 'second']);
    expect(content).not.toContain('private-value');
    expect(destination.mock.results[0]?.value.destroyed).toBe(true);
  });

  it('does not close a stream supplied by the caller', async () => {
    const stream = { write: vi.fn(), end: vi.fn(), destroy: vi.fn() };
    const logger = createLogger({ level: 'info', destination: 'file', file: 'unused', stream });
    logger.info({}, 'message');
    await logger.close();
    expect(stream.write).toHaveBeenCalledTimes(1);
    expect(stream.end).not.toHaveBeenCalled();
    expect(stream.destroy).not.toHaveBeenCalled();
  });

  it('reports file-open failure through close without an uncaught stream error', async () => {
    const logger = createLogger({ level: 'info', destination: 'file', file: directory() });
    await expect(logger.close()).rejects.toMatchObject({ code: 'EISDIR' });
  });

});
