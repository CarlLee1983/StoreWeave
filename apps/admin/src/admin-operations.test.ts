import { describe, expect, it, vi } from 'vitest';
import { QueryObserver } from '@tanstack/react-query';
import { ApiError } from './api';
import { createAdminOperationStore, executeAdminOperation, isDefiniteCommandRejection, type AdminOperation, type AdminOperationEntry } from './admin-operations';
import { createAdminQueryClient } from './query';

type StatusOperation = AdminOperation & { kind: 'status'; productId: string; request: { status: 'active' | 'draft' } };
const operation: StatusOperation = { area: 'product', scope: 'product:status:product-1', kind: 'status', productId: 'product-1', request: { status: 'active' }, idempotencyKey: 'key-1' };

describe('admin operation store', () => {
  it('keeps a stable snapshot, blocks duplicate scope, and cannot let an old handle finish a new attempt', () => {
    const store = createAdminOperationStore();
    expect(store.getSnapshot()).toBe(store.getSnapshot());
    const first = store.begin(operation)!;
    expect(store.begin(operation)).toBeNull();
    expect(store.finish(first)).toBe(true);
    const second = store.begin({ ...operation, idempotencyKey: 'key-2' })!;
    expect(store.finish(first)).toBe(false);
    expect(store.finish(second)).toBe(true);
  });

  it('identity clear makes late handles inert and clears the cached snapshot', () => {
    const store = createAdminOperationStore();
    const handle = store.begin(operation)!;
    store.clearIdentity();
    expect(store.getSnapshot()).toEqual([]);
    expect(store.markUnknown(handle, new Error('offline'))).toBe(false);
  });

  it.each([
    [new TypeError('offline'), false],
    [new DOMException('aborted', 'AbortError'), false],
    [new ApiError('UNKNOWN_ERROR', 'bad JSON', 200), false],
    [new ApiError('UNKNOWN_ERROR', 'bad JSON', 400), false],
    [new ApiError('UNKNOWN_ERROR', 'bad JSON', 500), false],
    [new ApiError('INTERNAL_ERROR', 'server error', 500), false],
    [new ApiError('IDEMPOTENCY_IN_PROGRESS', 'still running', 409), false],
    [new ApiError('VALIDATION_ERROR', 'bad input', 400), true],
  ])('classifies %o as definite rejection: %s', (error, expected) => {
    expect(isDefiniteCommandRejection(error)).toBe(expected);
  });

  it('uses the saved retry payload/key and makes identity-cleared command results stale', async () => {
    const store = createAdminOperationStore();
    const saved: StatusOperation = { ...operation, request: { status: 'draft' }, idempotencyKey: 'saved-key' };
    const handle = store.begin(saved)!;
    store.markUnknown(handle, new TypeError('offline'));
    const entry = store.find(saved.scope)! as AdminOperationEntry<typeof saved>;
    const seen: typeof saved[] = [];
    await expect(executeAdminOperation(store, operation, async (live) => { seen.push(live); return 'ok'; }, () => undefined, entry)).resolves.toEqual({ state: 'success', result: 'ok' });
    expect(seen).toEqual([saved]);

    let reject!: (error: Error) => void;
    const pending = new Promise<never>((_, fail) => { reject = fail; });
    const result = executeAdminOperation(store, operation, () => pending, () => undefined);
    store.clearIdentity();
    reject(new Error('offline'));
    await expect(result).resolves.toEqual({ state: 'stale' });
  });

  it('cannot let an old attempt or a confirmed-effect failure alter the current identity', async () => {
    const store = createAdminOperationStore();
    let resolve!: (value: string) => void;
    const old = executeAdminOperation(store, operation, () => new Promise<string>((done) => { resolve = done; }), () => undefined);
    store.clearIdentity();
    const replacement = { ...operation, idempotencyKey: 'replacement-key' };
    const replacementHandle = store.begin(replacement)!;
    resolve('old response');
    await expect(old).resolves.toEqual({ state: 'stale' });
    expect(store.find(replacement.scope)?.operation).toBe(replacement);
    expect(store.finish(replacementHandle)).toBe(true);

    await expect(executeAdminOperation(store, operation, async () => 'confirmed', () => { throw new Error('cache refresh failed'); })).resolves.toEqual({ state: 'success', result: 'confirmed' });
  });

  it('cancels and clears a confirmation-triggered refetch before a new identity can receive it', async () => {
    const store = createAdminOperationStore();
    const client = createAdminQueryClient();
    const queryKey = ['identity-data'];
    client.setQueryData(queryKey, 'settled old result');
    let resolveFetch!: (value: string) => void;
    let refetchSignal!: AbortSignal;
    const queryFn = vi.fn(({ signal }: { signal: AbortSignal }) => {
      refetchSignal = signal;
      return new Promise<string>((resolve) => { resolveFetch = resolve; });
    });
    const observer = new QueryObserver(client, { queryKey, queryFn, staleTime: Infinity });
    const unsubscribe = observer.subscribe(() => undefined);
    expect(queryFn).not.toHaveBeenCalled();
    expect(client.getQueryState(queryKey)?.fetchStatus).toBe('idle');
    let invalidation!: Promise<void>;
    await expect(executeAdminOperation(store, operation, async () => 'confirmed', () => {
      invalidation = client.invalidateQueries({ queryKey });
      return undefined;
    })).resolves.toEqual({ state: 'success', result: 'confirmed' });
    expect(queryFn).toHaveBeenCalledOnce();
    expect(client.getQueryState(queryKey)?.fetchStatus).toBe('fetching');
    store.clearIdentity();
    await client.cancelQueries();
    expect(refetchSignal.aborted).toBe(true);
    unsubscribe();
    client.clear();
    expect(client.getQueryData(queryKey)).toBeUndefined();
    client.setQueryData(queryKey, 'new identity result');
    resolveFetch('late old result');
    await invalidation;
    expect(client.getQueryData(queryKey)).toBe('new identity result');
    expect(queryFn).toHaveBeenCalledOnce();
    client.clear();
  });
});
