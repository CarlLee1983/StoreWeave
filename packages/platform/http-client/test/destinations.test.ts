import { describe, expect, it } from 'vitest';
import { createHttpClient } from '../src/client';

const okFetch = async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });

function client(overrides: Partial<Parameters<typeof createHttpClient>[0]> = {}) {
  return createHttpClient({ timeoutMs: 1000, fetch: okFetch, ...overrides });
}

describe('trusted destinations', () => {
  it('allows a host on the allowlist', async () => {
    const result = await client({ allowedHosts: ['api.example.com'] }).request({ method: 'GET', url: 'https://api.example.com/v1' });
    expect(result.ok).toBe(true);
  });

  it('blocks a host that is not on the allowlist', async () => {
    const result = await client({ allowedHosts: ['api.example.com'] }).request({ method: 'GET', url: 'https://evil.example.com/v1' });
    expect(result).toMatchObject({ ok: false, reason: 'blocked_destination' });
  });

  it('does not treat a suffix match as membership', async () => {
    const result = await client({ allowedHosts: ['example.com'] }).request({ method: 'GET', url: 'https://notexample.com/v1' });
    expect(result).toMatchObject({ ok: false, reason: 'blocked_destination' });
  });

  it('does not let a subdomain inherit the parent allowlist entry', async () => {
    const result = await client({ allowedHosts: ['example.com'] }).request({ method: 'GET', url: 'https://api.example.com/v1' });
    expect(result).toMatchObject({ ok: false, reason: 'blocked_destination' });
  });

  it('compares hosts case-insensitively', async () => {
    const result = await client({ allowedHosts: ['API.example.com'] }).request({ method: 'GET', url: 'https://api.EXAMPLE.com/v1' });
    expect(result.ok).toBe(true);
  });

  it('blocks credentials embedded in the URL', async () => {
    const result = await client().request({ method: 'GET', url: 'https://user:pass@api.example.com/v1' });
    expect(result).toMatchObject({ ok: false, reason: 'blocked_destination' });
  });

  it('blocks protocols other than http and https', async () => {
    for (const url of ['file:///etc/passwd', 'ftp://api.example.com/x', 'data:text/plain,hi']) {
      expect(await client().request({ method: 'GET', url })).toMatchObject({ ok: false, reason: 'blocked_destination' });
    }
  });

  it('blocks plaintext http unless the destination opted in', async () => {
    expect(await client().request({ method: 'GET', url: 'http://api.example.com/v1' }))
      .toMatchObject({ ok: false, reason: 'blocked_destination' });
    expect(await client({ allowInsecureHttp: true }).request({ method: 'GET', url: 'http://api.example.com/v1' }).then((r: { ok: boolean }) => r.ok))
      .toBe(true);
  });

  it('rejects an unparseable URL as a blocked destination rather than throwing', async () => {
    expect(await client().request({ method: 'GET', url: 'not a url' })).toMatchObject({ ok: false, reason: 'blocked_destination' });
  });

  it('keeps the secret out of the reported message when the URL carries one', async () => {
    const result = await client().request({ method: 'GET', url: 'https://user:hunter2@api.example.com/v1?token=abcdef' });
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain('hunter2');
    expect(JSON.stringify(result)).not.toContain('abcdef');
  });
});
