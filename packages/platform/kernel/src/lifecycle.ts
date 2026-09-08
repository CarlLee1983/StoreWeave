/** Attempt every acquired resource in reverse order, retaining all cleanup failures. */
export async function closeInReverse(cleanups: readonly (() => void | Promise<void>)[]): Promise<void> {
  const errors: unknown[] = [];
  for (const close of [...cleanups].reverse()) {
    try { await close(); } catch (error) { errors.push(error); }
  }
  if (errors.length) throw new AggregateError(errors, 'Resource cleanup failed');
}

/** Bounds library cleanup; process entrypoints additionally enforce a hard exit deadline. */
export async function withCleanupDeadline(timeoutMs: number, close: () => Promise<void>): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      Promise.resolve().then(close),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`Cleanup deadline exceeded (${timeoutMs}ms)`)), timeoutMs);
      }),
    ]);
  } finally { if (timer) clearTimeout(timer); }
}

/** One deadline covers the entire process shutdown, including an uncooperative in-flight job. */
export function installShutdown(
  timeoutMs: number, close: () => Promise<void>,
  logger: import('@storeweave/contracts').Logger,
): void {
  let closing = false;
  const shutdown = (signal: string) => {
    if (closing) return;
    closing = true;
    const deadline = setTimeout(() => {
      try { logger.error({ timeoutMs }, 'shutdown deadline exceeded'); }
      finally { process.exit(1); }
    }, timeoutMs);
    let exitCode = 0;
    try { logger.info({ signal }, 'shutting down'); }
    catch { exitCode = 1; }
    void Promise.resolve().then(close).then(() => {
      clearTimeout(deadline);
      process.exit(exitCode);
    }, error => {
      try { logger.error({ error: error instanceof Error ? error.message : String(error) }, 'shutdown cleanup failed'); }
      finally { clearTimeout(deadline); process.exit(1); }
    });
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}
