import { mkdtempSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';
import { describe, expect, it } from 'vitest';

type Mode = 'fatal-rejects-first-log-throws' | 'first-log-throws' | 'cleanup-rejects-second-log-throws' | 'cleanup-hangs-second-log-throws' | 'shutdown-and-repeated-fatal';

async function runFatalBoundary(mode: Mode): Promise<{ code: number | null; output: string; elapsedMs: number }> {
  const directory = mkdtempSync(join(tmpdir(), 'storeweave-worker-fatal-'));
  const fixture = join(directory, 'fatal-boundary.js');
  const started = Date.now();
  try {
    await build({
      stdin: { contents: `
        import { installFatalBoundary, onceAsync } from ${JSON.stringify(resolve('apps/worker/src/fatal-boundary.ts'))};
        const mode = process.argv[2];
        let cleanupCalls = 0;
        let logCalls = 0;
        const logger = { error: () => {
          logCalls += 1;
          if ((mode === 'first-log-throws' || mode === 'fatal-rejects-first-log-throws') && logCalls === 1) throw new Error('first logger closed');
          if ((mode === 'cleanup-rejects-second-log-throws' || mode === 'cleanup-hangs-second-log-throws') && logCalls === 2) throw new Error('second logger closed');
        } };
        const close = onceAsync(async () => {
          cleanupCalls += 1;
          process.stdout.write('cleanup:' + cleanupCalls + '\\n');
          if (mode === 'cleanup-rejects-second-log-throws') throw new Error('cleanup rejected');
          if (mode === 'cleanup-hangs-second-log-throws') await new Promise(() => {});
        });
        if (mode === 'shutdown-and-repeated-fatal') {
          void close();
        }
        installFatalBoundary({
          fatal: mode === 'fatal-rejects-first-log-throws' ? Promise.reject(new Error('fatal rejected')) : Promise.resolve(new Error('fatal one')),
          timeoutMs: 70,
          close,
          logger,
          exit: status => { process.stdout.write('exit:' + status + '\\n'); process.exit(status); },
        });
        if (mode === 'shutdown-and-repeated-fatal') {
          installFatalBoundary({
            fatal: Promise.resolve(new Error('fatal two')),
            timeoutMs: 70,
            close,
            logger,
            exit: status => { process.stdout.write('exit:' + status + '\\n'); process.exit(status); },
          });
        }
        setInterval(() => {}, 1_000);
      `, resolveDir: process.cwd(), loader: 'ts' },
      outfile: fixture, bundle: true, platform: 'node', format: 'cjs',
      external: ['pg-native'], tsconfig: resolve('tsconfig.json'), logLevel: 'silent',
    });
    const child = spawn(process.execPath, [fixture, mode], { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', data => { output += data; });
    child.stderr.on('data', data => { output += data; });
    const exited = new Promise<number | null>(childResolve => child.once('exit', childResolve));
    let deadline: NodeJS.Timeout | undefined;
    try {
      const code = await Promise.race([
        exited,
        new Promise<never>((_resolve, childReject) => {
          deadline = setTimeout(() => childReject(new Error(`fatal fixture timed out: ${output}`)), 3_000);
        }),
      ]);
      return { code, output, elapsedMs: Date.now() - started };
    } finally {
      if (deadline) clearTimeout(deadline);
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await exited;
    }
  } finally {
    rmSync(directory, { recursive: true });
  }
}

describe('worker production fatal boundary', () => {
  it.each<Mode>([
    'fatal-rejects-first-log-throws',
    'first-log-throws',
    'cleanup-rejects-second-log-throws',
    'cleanup-hangs-second-log-throws',
    'shutdown-and-repeated-fatal',
  ])('always cleans up once and exits 1 when %s', async mode => {
    const result = await runFatalBoundary(mode);

    expect(result.code).toBe(1);
    expect(result.output.match(/cleanup:1/g)).toHaveLength(1);
    expect(result.output).toContain('exit:1');
    expect(result.elapsedMs).toBeLessThan(2_000);
  });
});
