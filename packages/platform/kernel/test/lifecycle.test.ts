import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { build } from 'esbuild';
import { describe, expect, it } from 'vitest';
import { closeInReverse, withCleanupDeadline } from '../src/lifecycle';

describe('resource lifecycle', () => {
  it('attempts every cleanup in reverse order and retains failures', async () => {
    const order: number[] = [];
    const first = new Error('first');
    const second = new Error('second');
    const result = closeInReverse([
      () => { order.push(1); throw first; },
      () => { order.push(2); },
      () => { order.push(3); throw second; },
    ]);
    await expect(result).rejects.toMatchObject({ errors: [second, first] });
    expect(order).toEqual([3, 2, 1]);
  });

  it('rejects a hung library cleanup within its deadline', async () => {
    await expect(withCleanupDeadline(20, () => new Promise(() => {}))).rejects.toThrow('Cleanup deadline exceeded');
  });

  it.each([false, true])('hard-exits a hung worker once even when logging fails=%s', async loggingFails => {
    const directory = mkdtempSync(join(tmpdir(), 'storeweave-shutdown-'));
    const fixture = join(directory, 'hung-worker.js');
    await build({
      stdin: { contents: `
        import { Worker } from ${JSON.stringify(resolve('packages/platform/kernel/src/worker.ts'))};
        import { installShutdown } from ${JSON.stringify(resolve('packages/platform/kernel/src/lifecycle.ts'))};
        const logger = { info: () => {}, error: () => {} };
        const worker = new Worker({ config: { worker: { pollIntervalMs: 50 } }, logger });
        worker.tick = () => new Promise(() => {});
        worker.start();
        setInterval(() => {}, 1000); // An in-flight external resource keeps the process alive.
        installShutdown(80, async () => {
          process.stdout.write('closing\\n');
          await worker.stop();
        }, ${loggingFails ? "{ info: () => { throw new Error('logger closed'); }, error: () => { throw new Error('logger closed'); } }" : 'logger'});
        process.stdout.write('ready\\n');
      `, resolveDir: process.cwd(), loader: 'ts' },
      outfile: fixture, bundle: true, platform: 'node', format: 'cjs',
      external: ['pg-native'], tsconfig: resolve('tsconfig.json'), logLevel: 'silent',
    });
    const child = spawn(process.execPath, [fixture], { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    let stderr = '';
    child.stdout.on('data', data => { output += data; });
    child.stderr.on('data', data => { stderr += data; });
    const exited = new Promise<number | null>(resolve => child.once('exit', resolve));
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Worker fixture did not start: ${stderr}`)), 5_000);
        child.stdout.on('data', () => { if (output.includes('ready')) { clearTimeout(timer); resolve(); } });
        child.once('exit', () => { clearTimeout(timer); if (!output.includes('ready')) reject(new Error(stderr)); });
      });
      const started = Date.now();
      const closing = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Shutdown handler did not start')), 2_000);
        child.stdout.on('data', () => { if (output.includes('closing')) { clearTimeout(timer); resolve(); } });
      });
      child.kill('SIGTERM');
      await closing;
      child.kill('SIGINT');
      expect(await exited).toBe(1);
      expect(Date.now() - started).toBeLessThan(3_000);
      expect(output.match(/closing/g)).toHaveLength(1);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await exited;
      rmSync(directory, { recursive: true });
    }
  });
});
