import { createHash } from 'node:crypto';
import type { ReleaseOwnerPin } from './types';

/** Object key order is irrelevant; ordered migration arrays remain significant. */
export function catalogDigest(value: unknown): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(value, (_key, entry) => {
    if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
      return Object.fromEntries(Object.entries(entry).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
    }
    return entry;
  })).digest('hex')}`;
}

export function validateWorkOwnership(owners: readonly ReleaseOwnerPin[]): void {
  const ids = new Set<string>();
  for (const owner of owners) {
    if (ids.has(owner.id)) throw new Error(`Duplicate release owner: ${owner.id}`);
    ids.add(owner.id);
  }
  for (const field of ['jobTypes', 'subscriberIds', 'emittedEventNames'] as const) {
    const claims = new Map<string, string>();
    for (const owner of owners) {
      for (const value of owner.work[field]) {
        if (!value || claims.has(value)) throw new Error(`Duplicate or invalid ${field} ownership: ${value}`);
        claims.set(value, owner.id);
      }
    }
  }
}
