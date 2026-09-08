import { createContext, useContext, useSyncExternalStore } from 'react';
import { ApiError } from './api';

export type AdminOperation = { area: string; scope: string; idempotencyKey: string };
export type AdminOperationEntry<T extends AdminOperation = AdminOperation> = { operation: T; phase: 'pending' | 'unknown'; error?: unknown; attempt: number };
export type AdminOperationHandle = { scope: string; generation: number; attempt: number };


export function createAdminOperationStore() {
  let generation = 0;
  let attempt = 0;
  const entries = new Map<string, AdminOperationEntry>();
  const listeners = new Set<() => void>();
  let snapshot: readonly AdminOperationEntry[] = [];
  const emit = () => { snapshot = [...entries.values()]; listeners.forEach((listener) => listener()); };
  const valid = (handle: AdminOperationHandle) => handle.generation === generation && entries.get(handle.scope)?.attempt === handle.attempt;
  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) { listeners.add(listener); return () => listeners.delete(listener); },
    begin<T extends AdminOperation>(operation: T): AdminOperationHandle | null {
      const scope = operation.scope; if (entries.has(scope)) return null;
      const nextAttempt = ++attempt; entries.set(scope, { operation, phase: 'pending', attempt: nextAttempt }); emit();
      return { scope, generation, attempt: nextAttempt };
    },
    retry<T extends AdminOperation>(entry: AdminOperationEntry<T>): AdminOperationHandle | null {
      const scope = entry.operation.scope; if (entry.phase !== 'unknown' || entries.get(scope) !== entry) return null;
      const nextAttempt = ++attempt; entries.set(scope, { operation: entry.operation, phase: 'pending', attempt: nextAttempt }); emit();
      return { scope, generation, attempt: nextAttempt };
    },
    find(scope: string) { return entries.get(scope) ?? null; },
    markUnknown(handle: AdminOperationHandle, error: unknown) { if (!valid(handle)) return false; entries.set(handle.scope, { ...entries.get(handle.scope)!, phase: 'unknown', error }); emit(); return true; },
    finish(handle: AdminOperationHandle) { if (!valid(handle)) return false; entries.delete(handle.scope); emit(); return true; },
    isCurrentGeneration(handle: AdminOperationHandle) { return handle.generation === generation; },
    reject(handle: AdminOperationHandle) { return this.finish(handle); },
    clearIdentity() { generation += 1; entries.clear(); emit(); },
  };
}

export type AdminOperationStore = ReturnType<typeof createAdminOperationStore>;
export const isDefiniteCommandRejection = (error: unknown) => error instanceof ApiError
  && error.status >= 400 && error.status < 500
  && error.code !== 'IDEMPOTENCY_IN_PROGRESS' && error.code !== 'UNKNOWN_ERROR';
export async function executeAdminOperation<T extends AdminOperation, R>(store: AdminOperationStore, operation: T, run: (operation: T) => Promise<R>, onConfirmed: (result: R, operation: T) => undefined, retryEntry?: AdminOperationEntry<T>) {
  const handle = retryEntry ? store.retry(retryEntry) : store.begin(operation);
  if (!handle) return { state: 'blocked' as const };
  const live = retryEntry ? retryEntry.operation : operation;
  try {
    const result = await run(live);
    if (!store.finish(handle) || !store.isCurrentGeneration(handle)) return { state: 'stale' as const };
    // Confirmation effects start synchronously; their failures cannot change the command result.
    try { onConfirmed(result, live); } catch {}
    return { state: 'success' as const, result };
  } catch (error) {
    const definite = isDefiniteCommandRejection(error);
    const applied = definite ? store.reject(handle) : store.markUnknown(handle, error);
    return !applied ? { state: 'stale' as const } : definite ? { state: 'rejected' as const, error } : { state: 'unknown' as const, error };
  }
}

const AdminOperationContext = createContext<AdminOperationStore | null>(null);
export const AdminOperationProvider = AdminOperationContext.Provider;
export function useAdminOperations() { const store = useContext(AdminOperationContext); if (!store) throw new Error('useAdminOperations must be used within AdminOperationProvider'); return store; }
export function useAdminOperationEntries() { const store = useAdminOperations(); return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot); }
