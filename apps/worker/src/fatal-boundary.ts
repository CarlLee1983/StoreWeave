import { withCleanupDeadline } from '@storeweave/kernel';
import type { Logger } from '@storeweave/contracts';

type FatalLogger = Pick<Logger, 'error'>;

export interface FatalBoundaryOptions {
  readonly fatal: Promise<unknown>;
  readonly timeoutMs: number;
  readonly close: () => Promise<void>;
  readonly logger: FatalLogger;
  readonly workerId?: string;
  readonly exit?: (status: number) => never;
}

/** Shares one cleanup attempt between fatal handling and signal shutdown. */
export function onceAsync(close: () => void | Promise<void>): () => Promise<void> {
  let closing: Promise<void> | undefined;
  return () => closing ??= Promise.resolve().then(close);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Logging must never prevent a fail-stop boundary from cleaning up and exiting. */
function safeError(logger: FatalLogger, context: Record<string, unknown>, message: string): void {
  try { logger.error(context, message); } catch { /* logger may already be closed */ }
}

/** Installs the worker entrypoint's bounded fatal cleanup and fail-stop path. */
export function installFatalBoundary({ fatal, timeoutMs, close, logger, workerId, exit = process.exit }: FatalBoundaryOptions): void {
  let handlingFatal = false;
  const failStop = async (error: unknown): Promise<void> => {
    if (handlingFatal) return;
    handlingFatal = true;
    try {
      safeError(logger, { error: errorMessage(error), workerId }, 'worker fatal execution boundary reached');
      try {
        await withCleanupDeadline(timeoutMs, close);
      } catch (cleanupError) {
        safeError(logger, { error: errorMessage(cleanupError) }, 'worker fatal cleanup failed');
      }
    } finally {
      try { exit(1); } catch { /* hostile process shims cannot escape this boundary */ }
    }
  };

  void fatal.then(failStop, failStop);
}
