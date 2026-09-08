import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startServices, stopServices } from '../../tools/cli/src/service';

// These tests own only their PID-mode children, even on a host with installed systemd units.
vi.mock('node:child_process', async original => {
  const actual = await original<typeof import('node:child_process')>();
  return { ...actual, spawn: vi.fn(actual.spawn), execFileSync: vi.fn(() => { throw new Error('No systemd units in this fixture'); }) };
});

let directory: string;
let pidFile: string;
const children: ChildProcess[] = [];
const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'storeweave-service-stop-'));
  mkdirSync(join(directory, 'run'));
  vi.stubEnv('STOREWEAVE_DATA_DIR', directory);
  pidFile = join(directory, 'run', 'commerce-api.pid');
});
afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      await exited;
    }
  }
  vi.unstubAllEnvs();
  Object.defineProperty(process, 'platform', platformDescriptor);
  vi.mocked(execFileSync).mockReset().mockImplementation(() => { throw new Error('No systemd units in this fixture'); });
  rmSync(directory, { recursive: true, force: true });
});
async function service(ignore = false) {
  const child = spawn(process.execPath, ['-e', `
    setInterval(() => {}, 1000);
    process.on('SIGTERM', () => { ${ignore ? '' : 'setTimeout(() => process.exit(0), 150);'} });
    process.stdout.write('ready');
  `], { stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  await once(child.stdout!, 'data');
  writeFileSync(pidFile, String(child.pid));
  return child;
}

describe('CLI service drain', () => {
  it('keeps the PID file until the real process has drained and exited', async () => {
    const child = await service();
    const stopped = stopServices(2_000);
    expect(existsSync(pidFile)).toBe(true);
    expect(child.exitCode).toBeNull();
    expect((await stopped).every(status => !status.running)).toBe(true);
    expect(child.exitCode).toBe(0);
    expect(existsSync(pidFile)).toBe(false);
  });

  it('retains the live PID and fails when a process ignores shutdown', async () => {
    const child = await service(true);
    await expect(stopServices(60)).rejects.toThrow('timed out');
    expect(existsSync(pidFile)).toBe(true);
    expect(child.exitCode).toBeNull();
    expect(() => process.kill(child.pid!, 0)).not.toThrow();
  });

  it.each(['-1', '0', '12junk', '9007199254740992'])('rejects unsafe PID value %s without signaling it', async value => {
    writeFileSync(pidFile, value);
    const kill = vi.spyOn(process, 'kill');
    try {
      await expect(stopServices()).rejects.toThrow('Invalid PID file');
      expect(kill).not.toHaveBeenCalled();
    } finally { kill.mockRestore(); }
  });
});


it('drains an already-started API when the worker entrypoint is missing', async () => {
  vi.stubEnv('STOREWEAVE_HOME', join(directory, 'home'));
  vi.stubEnv('STOREWEAVE_APP_DIR', directory);
  vi.stubEnv('STOREWEAVE_LOG_DIR', join(directory, 'logs'));
  mkdirSync(join(directory, 'app'));
  writeFileSync(join(directory, 'app/api.js'), 'setInterval(() => {}, 1000);');
  await expect(startServices()).rejects.toThrow('Missing application entrypoint');
  const started = vi.mocked(spawn).mock.results.at(-1)!.value as ChildProcess;
  expect(() => process.kill(started.pid!, 0)).toThrow();
  expect(existsSync(pidFile)).toBe(false);
  expect(existsSync(join(directory, 'run/commerce-worker.pid'))).toBe(false);
});

it('preserves an API that was running before a failed worker start', async () => {
  vi.stubEnv('STOREWEAVE_HOME', join(directory, 'home'));
  vi.stubEnv('STOREWEAVE_APP_DIR', directory);
  vi.stubEnv('STOREWEAVE_LOG_DIR', join(directory, 'logs'));
  const api = await service();
  await expect(startServices()).rejects.toThrow('Missing application entrypoint');
  expect(() => process.kill(api.pid!, 0)).not.toThrow();
  expect(readFileSync(pidFile, 'utf8')).toBe(String(api.pid));
  expect(api.exitCode).toBeNull();
});

it('systemd startup cleanup stops only units that were inactive before the attempt', async () => {
  Object.defineProperty(process, 'platform', { ...platformDescriptor, value: 'linux' });
  const stopped: string[][] = [];
  vi.mocked(execFileSync).mockImplementation((_file, args) => {
    if (args?.[0] === 'cat') return '';
    if (args?.[0] === 'is-active') {
      if (args[1] === 'commerce-api.service') return 'active';
      throw Object.assign(new Error('Inactive'), { status: 3, stdout: 'inactive' });
    }
    if (args?.[0] === 'start') throw new Error('Worker startup failed');
    if (args?.[0] === 'stop') { stopped.push([...args].slice(1)); return ''; }
    throw new Error('Unexpected systemctl invocation');
  });
  await expect(startServices()).rejects.toThrow('Worker startup failed');
  expect(stopped).toEqual([['commerce-worker.service']]);
});

it.each(['', 'inactive'])('refuses systemd startup when the state query fails with stdout %j', async stdout => {
  Object.defineProperty(process, 'platform', { ...platformDescriptor, value: 'linux' });
  vi.mocked(execFileSync).mockImplementation((_file, args) => {
    if (args?.[0] === 'cat') return '';
    if (args?.[0] === 'is-active') throw Object.assign(new Error('State query failed'), { status: 1, stdout });
    throw new Error('Unexpected mutation');
  });
  await expect(startServices()).rejects.toThrow('Cannot determine systemd service state');
  expect(vi.mocked(execFileSync).mock.calls.some(([, args]) => args?.[0] === 'start' || args?.[0] === 'stop')).toBe(false);
});
