import { describe, expect, it, vi } from 'vitest';
import { createHttpClient } from '../src/client';

const url = 'https://api.example.com/v1';

function client(fetchImpl: typeof fetch, overrides: Record<string, unknown> = {}) {
  return createHttpClient({ timeoutMs: 50, fetch: fetchImpl, sleep: async () => {}, ...overrides });
}

describe('failure classification', () => {
  it('classifies a transport failure as a network error', async () => {
    const fetchImpl = vi.fn(async () => { throw new TypeError('fetch failed'); }) as unknown as typeof fetch;
    expect(await client(fetchImpl).request({ method: 'GET', url })).toMatchObject({ ok: false, reason: 'network' });
  });

  it('classifies a timeout separately from a caller cancellation', async () => {
    const hang = (async (_input: unknown, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject((init.signal as AbortSignal).reason));
    })) as unknown as typeof fetch;

    expect(await client(hang, { timeoutMs: 10 }).request({ method: 'GET', url }))
      .toMatchObject({ ok: false, reason: 'timeout' });

    const controller = new AbortController();
    const pending = client(hang, { timeoutMs: 10_000 }).request({ method: 'GET', url, signal: controller.signal });
    controller.abort();
    expect(await pending).toMatchObject({ ok: false, reason: 'aborted' });
  });

  it('classifies cancellation while reading the response body as aborted', async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const signal = init?.signal as AbortSignal;
      return new Response(new ReadableStream({
        start(stream) {
          signal.addEventListener('abort', () => stream.error(signal.reason), { once: true });
        },
      }));
    }) as unknown as typeof fetch;
    const pending = client(fetchImpl, { timeoutMs: 10_000 }).request({ method: 'GET', url, signal: controller.signal });
    controller.abort();
    expect(await pending).toMatchObject({ ok: false, reason: 'aborted', attempts: 1 });
  });

  it('reports a non-2xx response as a status failure and keeps the status', async () => {
    const fetchImpl = (async () => new Response('nope', { status: 404 })) as unknown as typeof fetch;
    expect(await client(fetchImpl).request({ method: 'GET', url }))
      .toMatchObject({ ok: false, reason: 'http_status', status: 404 });
  });

  it('reports invalid JSON separately from a transport failure', async () => {
    const fetchImpl = (async () => new Response('not json', { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;
    expect(await client(fetchImpl).requestJson({ method: 'GET', url })).toMatchObject({ ok: false, reason: 'invalid_json' });
  });

  it('reports a JSON response that arrived with the wrong content type', async () => {
    const fetchImpl = (async () => new Response('{"a":1}', { status: 200, headers: { 'content-type': 'text/html' } })) as unknown as typeof fetch;
    expect(await client(fetchImpl).requestJson({ method: 'GET', url })).toMatchObject({ ok: false, reason: 'invalid_json' });
  });

  it('parses a JSON body when the response is well formed', async () => {
    const fetchImpl = (async () => new Response('{"a":1}', { status: 200, headers: { 'content-type': 'application/json; charset=utf-8' } })) as unknown as typeof fetch;
    expect(await client(fetchImpl).requestJson({ method: 'GET', url })).toMatchObject({ ok: true, body: { a: 1 } });
  });

  it('never puts a request header value into the failure message', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error('connect ECONNREFUSED'); }) as unknown as typeof fetch;
    const result = await client(fetchImpl).request({ method: 'GET', url, headers: { authorization: 'Bearer super-secret' } });
    expect(JSON.stringify(result)).not.toContain('super-secret');
  });
});

describe('retry policy', () => {
  it('does not retry a POST, because the side effect may already have happened', async () => {
    const fetchImpl = vi.fn(async () => { throw new TypeError('fetch failed'); }) as unknown as typeof fetch;
    const result = await client(fetchImpl, { maxAttempts: 3 }).request({ method: 'POST', url, body: '{}' });
    expect(result).toMatchObject({ ok: false, reason: 'network', attempts: 1 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('retries a POST that the caller declared idempotent', async () => {
    const fetchImpl = vi.fn(async () => { throw new TypeError('fetch failed'); }) as unknown as typeof fetch;
    const result = await client(fetchImpl, { maxAttempts: 3 }).request({ method: 'POST', url, body: '{}', idempotent: true });
    expect(result).toMatchObject({ attempts: 3 });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('retries an idempotent method on a transport failure and reports the successful attempt', async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls += 1;
      if (calls < 3) throw new TypeError('fetch failed');
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    expect(await client(fetchImpl, { maxAttempts: 3 }).request({ method: 'GET', url }))
      .toMatchObject({ ok: true, attempts: 3 });
  });

  it('retries a 503 but not a 400', async () => {
    const unavailable = vi.fn(async () => new Response('', { status: 503 })) as unknown as typeof fetch;
    await client(unavailable, { maxAttempts: 2 }).request({ method: 'GET', url });
    expect(unavailable).toHaveBeenCalledTimes(2);

    const badRequest = vi.fn(async () => new Response('', { status: 400 })) as unknown as typeof fetch;
    await client(badRequest, { maxAttempts: 2 }).request({ method: 'GET', url });
    expect(badRequest).toHaveBeenCalledTimes(1);
  });

  it('retries a 429', async () => {
    const throttled = vi.fn(async () => new Response('', { status: 429 })) as unknown as typeof fetch;
    await client(throttled, { maxAttempts: 2 }).request({ method: 'GET', url });
    expect(throttled).toHaveBeenCalledTimes(2);
  });

  it('does not retry a caller cancellation', async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 200 })) as unknown as typeof fetch;
    const result = await client(fetchImpl, { maxAttempts: 3 }).request({ method: 'GET', url, signal: controller.signal });
    expect(result).toMatchObject({ ok: false, reason: 'aborted', attempts: 1 });
  });

  it('does not retry a blocked destination', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 200 })) as unknown as typeof fetch;
    await client(fetchImpl, { maxAttempts: 3, allowedHosts: ['other.example.com'] }).request({ method: 'GET', url });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('backs off between attempts instead of hammering', async () => {
    const waits: number[] = [];
    const fetchImpl = vi.fn(async () => { throw new TypeError('fetch failed'); }) as unknown as typeof fetch;
    await createHttpClient({
      timeoutMs: 50, maxAttempts: 3, fetch: fetchImpl, sleep: async (ms: number) => { waits.push(ms); },
    }).request({ method: 'GET', url });
    expect(waits).toHaveLength(2);
    expect(waits[1]).toBeGreaterThan(waits[0]);
  });

  it('stops an in-progress retry backoff when the caller cancels', async () => {
    const controller = new AbortController();
    let enteredBackoff!: () => void;
    const backoff = new Promise<void>((resolve) => { enteredBackoff = resolve; });
    const fetchImpl = vi.fn(async () => { throw new TypeError('fetch failed'); }) as unknown as typeof fetch;
    const pending = createHttpClient({
      timeoutMs: 10_000,
      maxAttempts: 3,
      fetch: fetchImpl,
      sleep: async () => {
        enteredBackoff();
        await new Promise<void>(() => {});
      },
    }).request({ method: 'GET', url, signal: controller.signal });
    await backoff;
    controller.abort();
    const result = await Promise.race([
      pending,
      new Promise<'still-waiting'>((resolve) => { setTimeout(() => resolve('still-waiting'), 0); }),
    ]);
    expect(result).toMatchObject({ ok: false, reason: 'aborted', attempts: 1 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('clears the default backoff timer when the caller cancels', async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const fetchImpl = vi.fn(async () => { throw new TypeError('fetch failed'); }) as unknown as typeof fetch;
      const pending = createHttpClient({
        timeoutMs: 10_000,
        maxAttempts: 3,
        fetch: fetchImpl,
      }).request({ method: 'GET', url, signal: controller.signal });
      await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
      await Promise.resolve();
      expect(vi.getTimerCount()).toBeGreaterThan(0);
      controller.abort();
      await expect(pending).resolves.toMatchObject({ ok: false, reason: 'aborted', attempts: 1 });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects a maxAttempts that would make retries unbounded', () => {
    expect(() => createHttpClient({ timeoutMs: 50, maxAttempts: 0 })).toThrow(/maxAttempts/);
    expect(() => createHttpClient({ timeoutMs: 50, maxAttempts: 11 })).toThrow(/maxAttempts/);
  });

  it('rejects a non-positive timeout', () => {
    expect(() => createHttpClient({ timeoutMs: 0 })).toThrow(/timeout/i);
  });
});
