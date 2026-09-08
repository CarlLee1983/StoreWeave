import type { Runtime } from '@storeweave/kernel';

export const seed: { releaseId: string; demo?: (runtime: Runtime) => Promise<void> } = { releaseId: 'base' };
