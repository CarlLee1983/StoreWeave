import { describe, expect, it, vi } from 'vitest';
import { createHttpClient } from '../src/client';

function redirectingFetch(hops: Record<string, string>) {
  return vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    const location = hops[url];
    if (location) return new Response(null, { status: 302, headers: { location } });
    return new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } });
  });
}

describe('redirects', () => {
  it('follows a redirect that stays inside the allowlist', async () => {
    const fetchImpl = redirectingFetch({ 'https://api.example.com/a': 'https://api.example.com/b' });
    const client = createHttpClient({ timeoutMs: 1000, allowedHosts: ['api.example.com'], fetch: fetchImpl });
    const result = await client.request({ method: 'GET', url: 'https://api.example.com/a' });
    expect(result).toMatchObject({ ok: true, status: 200 });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('blocks a redirect that leaves the allowlist', async () => {
    const fetchImpl = redirectingFetch({ 'https://api.example.com/a': 'https://evil.example.com/steal' });
    const client = createHttpClient({ timeoutMs: 1000, allowedHosts: ['api.example.com'], fetch: fetchImpl });
    expect(await client.request({ method: 'GET', url: 'https://api.example.com/a' }))
      .toMatchObject({ ok: false, reason: 'blocked_destination' });
  });

  it('blocks a redirect that downgrades to plaintext http', async () => {
    const fetchImpl = redirectingFetch({ 'https://api.example.com/a': 'http://api.example.com/b' });
    const client = createHttpClient({ timeoutMs: 1000, allowedHosts: ['api.example.com'], fetch: fetchImpl });
    expect(await client.request({ method: 'GET', url: 'https://api.example.com/a' }))
      .toMatchObject({ ok: false, reason: 'blocked_destination' });
  });

  it('drops the authorization header when the redirect crosses origins', async () => {
    const seen: Array<Record<string, string>> = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      seen.push({ ...(init?.headers as Record<string, string> | undefined) });
      if (String(input) === 'https://a.example.com/x') {
        return new Response(null, { status: 302, headers: { location: 'https://b.example.com/y' } });
      }
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const client = createHttpClient({ timeoutMs: 1000, allowedHosts: ['a.example.com', 'b.example.com'], fetch: fetchImpl });
    await client.request({ method: 'GET', url: 'https://a.example.com/x', headers: { authorization: 'Bearer secret-token' } });
    expect(seen[0].authorization).toBe('Bearer secret-token');
    expect(seen[1]).not.toHaveProperty('authorization');
  });

  it('keeps the authorization header on a same-origin redirect', async () => {
    const seen: Array<Record<string, string>> = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      seen.push({ ...(init?.headers as Record<string, string> | undefined) });
      if (String(input) === 'https://a.example.com/x') {
        return new Response(null, { status: 302, headers: { location: '/y' } });
      }
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const client = createHttpClient({ timeoutMs: 1000, allowedHosts: ['a.example.com'], fetch: fetchImpl });
    await client.request({ method: 'GET', url: 'https://a.example.com/x', headers: { authorization: 'Bearer secret-token' } });
    expect(seen[1].authorization).toBe('Bearer secret-token');
  });

  it('gives up after the redirect budget instead of looping forever', async () => {
    const fetchImpl = redirectingFetch({
      'https://api.example.com/a': 'https://api.example.com/b',
      'https://api.example.com/b': 'https://api.example.com/a',
    });
    const client = createHttpClient({ timeoutMs: 1000, allowedHosts: ['api.example.com'], fetch: fetchImpl });
    expect(await client.request({ method: 'GET', url: 'https://api.example.com/a' }))
      .toMatchObject({ ok: false, reason: 'too_many_redirects' });
  });

  it('treats a redirect without a location header as a plain response', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 302 }));
    const client = createHttpClient({ timeoutMs: 1000, fetch: fetchImpl });
    expect(await client.request({ method: 'GET', url: 'https://api.example.com/a' }))
      .toMatchObject({ ok: false, reason: 'http_status', status: 302 });
  });

  it('never lets a POST body be replayed to the redirect target', async () => {
    const methods: string[] = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      methods.push(String(init?.method));
      if (String(input) === 'https://api.example.com/a') {
        return new Response(null, { status: 302, headers: { location: 'https://api.example.com/b' } });
      }
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const client = createHttpClient({ timeoutMs: 1000, allowedHosts: ['api.example.com'], fetch: fetchImpl });
    const result = await client.request({ method: 'POST', url: 'https://api.example.com/a', body: '{"amount":100}' });
    expect(result).toMatchObject({ ok: false, reason: 'unsafe_redirect' });
    expect(methods).toEqual(['POST']);
  });
});
