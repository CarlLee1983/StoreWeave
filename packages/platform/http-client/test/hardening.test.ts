import { describe, expect, it, vi } from 'vitest';
import { createHttpClient } from '../src/client';
import { checkDestination, safeUrl } from '../src/destination';

const json = (body: string, init: ResponseInit = {}) =>
  new Response(body, { status: 200, headers: { 'content-type': 'application/json' }, ...init });

describe('cross-origin header stripping', () => {
  it('drops every header that could carry a credential, not just authorization', async () => {
    const seen: Array<Record<string, string>> = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      seen.push({ ...(init?.headers as Record<string, string> | undefined) });
      if (String(input) === 'https://a.example.com/x') {
        return new Response(null, { status: 302, headers: { location: 'https://b.example.com/y' } });
      }
      return json('{}');
    }) as unknown as typeof fetch;

    const client = createHttpClient({ timeoutMs: 1000, allowedHosts: ['a.example.com', 'b.example.com'], fetch: fetchImpl });
    await client.request({
      method: 'GET',
      url: 'https://a.example.com/x',
      headers: { authorization: 'Bearer S', 'x-api-key': 'K', 'x-auth-token': 'T', 'accept': 'application/json' },
    });

    expect(Object.keys(seen[1]).sort()).toEqual(['accept']);
    expect(JSON.stringify(seen[1])).not.toContain('K');
    expect(JSON.stringify(seen[1])).not.toContain('T');
  });
});

describe('private address policy', () => {
  it('blocks loopback, link-local and private ranges by default', () => {
    for (const url of [
      'http://127.0.0.1:5432/', 'http://localhost/x', 'http://169.254.169.254/latest/meta-data/',
      'http://10.1.2.3/x', 'http://192.168.1.1/x', 'http://172.16.0.1/x', 'http://[::1]/x', 'http://0.0.0.0/x',
    ]) {
      expect(checkDestination(url, { allowInsecureHttp: true })).toMatchObject({ ok: false });
    }
  });

  it('still allows a public address', () => {
    expect(checkDestination('https://93.184.216.34/x', {}).ok).toBe(true);
  });

  it('lets a deployment opt in explicitly for an internal endpoint', () => {
    expect(checkDestination('http://10.1.2.3/x', { allowInsecureHttp: true, allowPrivateAddresses: true }).ok).toBe(true);
  });

  it('blocks a redirect into a private address even when the first hop was public', async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => (
      String(input) === 'https://api.example.com/a'
        ? new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/latest' } })
        : json('{}')
    )) as unknown as typeof fetch;
    const client = createHttpClient({ timeoutMs: 1000, fetch: fetchImpl });
    expect(await client.request({ method: 'GET', url: 'https://api.example.com/a' }))
      .toMatchObject({ ok: false, reason: 'blocked_destination' });
  });
});

describe('allowlist entries', () => {
  it('honours a port when the entry names one', () => {
    expect(checkDestination('https://example.com:9200/x', { allowedHosts: ['example.com'] })).toMatchObject({ ok: false });
    expect(checkDestination('https://example.com/x', { allowedHosts: ['example.com'] }).ok).toBe(true);
    expect(checkDestination('https://example.com:9200/x', { allowedHosts: ['example.com:9200'] }).ok).toBe(true);
  });

  it('normalises a unicode entry to punycode so it can actually match', () => {
    expect(checkDestination('https://台灣.tw/x', { allowedHosts: ['台灣.tw'] }).ok).toBe(true);
  });
});

describe('safeUrl', () => {
  it('keeps only the origin, because paths carry webhook tokens', () => {
    expect(safeUrl('https://hooks.slack.com/services/T000/B000/SUPERSECRET?a=1#f')).toBe('https://hooks.slack.com');
    expect(safeUrl('https://u:p@api.example.com/v1/keys/sk-live-abc')).toBe('https://api.example.com');
  });
});

describe('timeout is a budget for the whole attempt', () => {
  it('does not restart the clock on every redirect hop', async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const hop = Number(new URL(String(input)).searchParams.get('n') ?? 0);
      await new Promise((resolve) => { setTimeout(resolve, 40); });
      if ((init?.signal as AbortSignal | undefined)?.aborted) throw new Error('aborted');
      return new Response(null, { status: 302, headers: { location: `https://api.example.com/a?n=${hop + 1}` } });
    }) as unknown as typeof fetch;
    const client = createHttpClient({ timeoutMs: 100, allowedHosts: ['api.example.com'], fetch: fetchImpl });
    const started = Date.now();
    const result = await client.request({ method: 'GET', url: 'https://api.example.com/a?n=0' });
    expect(result).toMatchObject({ ok: false, reason: 'timeout' });
    expect(Date.now() - started).toBeLessThan(300);
  });
});

describe('request hygiene', () => {
  it('refuses a GET that carries a body instead of retrying a transport error', async () => {
    const fetchImpl = vi.fn(async () => json('{}')) as unknown as typeof fetch;
    const client = createHttpClient({ timeoutMs: 100, maxAttempts: 3, fetch: fetchImpl, sleep: async () => {} });
    expect(await client.request({ method: 'GET', url: 'https://api.example.com/a', body: '{}' }))
      .toMatchObject({ ok: false, reason: 'invalid_request', attempts: 1 });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('releases the body of a response it is about to discard', async () => {
    const responses: Response[] = [];
    const fetchImpl = vi.fn(async () => {
      const response = new Response('busy', { status: 503 });
      responses.push(response);
      return response;
    }) as unknown as typeof fetch;
    const client = createHttpClient({ timeoutMs: 100, maxAttempts: 3, fetch: fetchImpl, sleep: async () => {} });
    await client.request({ method: 'GET', url: 'https://api.example.com/a' });
    expect(responses).toHaveLength(3);
    expect(responses.every((response) => response.bodyUsed || response.body === null)).toBe(true);
  });

  it('stops reading a response that exceeds the size budget', async () => {
    const fetchImpl = vi.fn(async () => json(JSON.stringify({ pad: 'x'.repeat(5000) }))) as unknown as typeof fetch;
    const client = createHttpClient({ timeoutMs: 100, maxResponseBytes: 1000, fetch: fetchImpl });
    expect(await client.request({ method: 'GET', url: 'https://api.example.com/a' }))
      .toMatchObject({ ok: false, reason: 'response_too_large' });
  });

  it('does not hand set-cookie back to the caller', async () => {
    const fetchImpl = vi.fn(async () => json('{}', { headers: { 'content-type': 'application/json', 'set-cookie': 'sid=SECRET; HttpOnly' } })) as unknown as typeof fetch;
    const client = createHttpClient({ timeoutMs: 100, fetch: fetchImpl });
    const result = await client.request({ method: 'GET', url: 'https://api.example.com/a' });
    expect(result.ok).toBe(true);
    expect(JSON.stringify(result)).not.toContain('SECRET');
  });

  it('keeps the underlying cause of a transport failure', async () => {
    const cause = new Error('connect ECONNREFUSED 127.0.0.1:443');
    const fetchImpl = vi.fn(async () => { throw new TypeError('fetch failed', { cause }); }) as unknown as typeof fetch;
    const client = createHttpClient({ timeoutMs: 100, fetch: fetchImpl });
    const result = await client.request({ method: 'GET', url: 'https://api.example.com/a' });
    expect(result).toMatchObject({ ok: false, reason: 'network' });
    expect((result as { message: string }).message).toContain('ECONNREFUSED');
  });
});

describe('json responses without a body', () => {
  it('treats an empty 204 as an absent body rather than invalid JSON', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 })) as unknown as typeof fetch;
    const client = createHttpClient({ timeoutMs: 100, fetch: fetchImpl });
    expect(await client.requestJson({ method: 'GET', url: 'https://api.example.com/a' }))
      .toMatchObject({ ok: true, status: 204, body: undefined });
  });

  it('still rejects a non-empty body that claims to be JSON but is not', async () => {
    const fetchImpl = vi.fn(async () => json('not json')) as unknown as typeof fetch;
    const client = createHttpClient({ timeoutMs: 100, fetch: fetchImpl });
    expect(await client.requestJson({ method: 'GET', url: 'https://api.example.com/a' }))
      .toMatchObject({ ok: false, reason: 'invalid_json' });
  });
});
