import { readLegacySafetySnapshot } from './legacy-safety-snapshot';
import { readLegacyPairedSnapshot } from './legacy-paired-snapshot';
import { z } from 'zod';
import { readPairedSnapshot } from './read-release-snapshot';
import { runReleaseCli } from './run-release-cli';

/** Cold check only: retained code must recognize the restored history without activation or extension setup. */
export async function verifySourceRuntime(directory: string, checksum: string, configFile: string, databaseUrl: string, lockFd?: number) {
  const pair = await readPairedSnapshot(directory, checksum);
  let output: string;
  try { output = runReleaseCli(pair.manifest.source, configFile, databaseUrl, 'status', lockFd); }
  catch (error) {
    if (error instanceof Error && error.message === 'Release CLI failed') throw new Error('Retained source runtime verification failed');
    throw error;
  }
  let status: unknown;
  try { status = JSON.parse(output); } catch { throw new Error('Retained source runtime returned invalid status'); }
  if (!z.object({ releaseCurrent: z.literal(true), pending: z.tuple([]), applied: z.array(z.unknown()) }).safeParse(status).success) {
    throw new Error('Retained source runtime does not match the restored database');
  }
  await readPairedSnapshot(directory, checksum);
}

/** B01 exposes human-readable status only. Exact DB/history validation surrounds this compatibility check. */
export async function verifyLegacySourceRuntime(directory: string, checksum: string, configFile: string, databaseUrl: string, lockFd?: number) {
  const pair = await readLegacyPairedSnapshot(directory, checksum);
  runReleaseCli(pair.manifest.source, configFile, databaseUrl, 'status', lockFd);
  await readLegacyPairedSnapshot(directory, checksum);
}

/** Raw pre-adoption recovery uses the same status-only old CLI check. */
export async function verifyLegacySafetyRuntime(directory: string, checksum: string, configFile: string, databaseUrl: string, lockFd?: number) {
  const safety = await readLegacySafetySnapshot(directory, checksum);
  runReleaseCli(safety.manifest.source, configFile, databaseUrl, 'status', lockFd);
  await readLegacySafetySnapshot(directory, checksum);
}
