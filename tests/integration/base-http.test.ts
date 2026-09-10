import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { RequestMethod, type Type } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { Runtime } from '@storeweave/kernel';
import { bootstrapRelease } from '../../packages/platform/bundle/src/bootstrap-release';
import { release } from '../../packages/platform/bundle/src/releases/base';
import { createReleaseServer } from '../../apps/api/src/release-server';
import { httpAdapter } from '../../apps/api/src/releases/base';
import { SESSION_COOKIE } from '../../apps/api/src/http/cookie-names';
import { csrfTokenFor } from '@storeweave/identity';
import { ADMIN_ACTOR, createTestDatabase } from './helpers';
import { zodToJsonSchema } from 'zod-to-json-schema';
import {
  describeHttpRoutes, HTTP_CONTRACT, validateMountedHttpRoutes,
  type DirectHttpContract, type HttpRouteCatalogCarrier, type HttpRouteCatalogEntry, type HttpRouteContract,
} from '../../apps/api/src/http/contract';
import { AuthController } from '../../apps/api/src/controllers/auth.controller';
import { MetaController } from '../../apps/api/src/controllers/meta.controller';
import { SystemController } from '../../apps/api/src/controllers/system.controller';
import { InventoryController } from '../../apps/api/src/controllers/inventory.controller';
import { PlatformError } from '@storeweave/contracts';
import { httpErrorSchema } from '../../apps/api/src/http/envelope';
import { ExtensionsController } from '../../apps/api/src/controllers/extensions.controller';
import { IS_PUBLIC } from '../../apps/api/src/http/auth';

let directory: string;
let runtime: Runtime;
let app: NestFastifyApplication;
let controllerFactory: ReturnType<typeof vi.fn>;
let READONLY_TOKEN: string;
const email = 'http-boundary@example.com';
const password = 'base-http-valid-password';

function syntheticRouteController(path: string, method: RequestMethod, contract?: HttpRouteContract): Type {
  class SyntheticController {}
  const handler = () => undefined;
  Reflect.defineMetadata(PATH_METADATA, path, SyntheticController);
  Reflect.defineMetadata(METHOD_METADATA, method, handler);
  Reflect.defineMetadata(PATH_METADATA, '', handler);
  if (contract) Reflect.defineMetadata(HTTP_CONTRACT, contract, handler);
  Object.defineProperty(SyntheticController.prototype, 'handle', { value: handler });
  return SyntheticController;
}

beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), 'storeweave-base-http-'));
  const configPath = join(directory, 'config.json');
  process.env.SW_SIGNING_KEY_TEST = Buffer.alloc(32, 3).toString('base64url');
  writeFileSync(configPath, JSON.stringify({ version: 1,
    store: { id: 'base-http', name: 'Base HTTP' },
    database: { url: await createTestDatabase() }, logging: { level: 'error' },
    security: { signingKeys: [{ id: 'test', secretRef: 'SW_SIGNING_KEY_TEST' }] },
  }));
  const boot = await bootstrapRelease(release, { configPath, loggerName: 'base-http' });
  runtime = boot.runtime;
  await runtime.migrate();
  await runtime.commands.execute('platform.identity.createUser', {
    email, password, displayName: 'Operator', role: 'admin',
  }, { actor: ADMIN_ACTOR, idempotencyKey: 'base-http-user' });
  const issuedReadonly = await runtime.database.transaction(tx => runtime.apiTokens.issue(tx, {
    name: 'readonly', role: 'readonly', ttlMs: 60 * 60_000,
  }));
  READONLY_TOKEN = issuedReadonly.secret;
  controllerFactory = vi.fn(httpAdapter.controllers);
  app = await createReleaseServer({ runtime, httpAdapter: { ...httpAdapter, controllers: controllerFactory }, release: { version: release.version, configPath } });
});

afterAll(async () => {
  await app?.close();
  await runtime?.close();
  if (directory) rmSync(directory, { recursive: true });
});

describe('Base HTTP input boundary', () => {
  it('selects Base controllers once and retains the validated 9-controller, 52-route catalog', () => {
    expect(controllerFactory).toHaveBeenCalledTimes(1);
    expect(controllerFactory.mock.results[0]?.value).toHaveLength(9);
    const catalog = app.getHttpAdapter().getInstance() as HttpRouteCatalogCarrier;
    expect(catalog.storeweaveHttpCatalog).toHaveLength(52);
    expect(catalog.storeweaveHttpCatalog?.filter(route => route.method === 'GET').every(route => route.automaticMethods?.[0] === 'HEAD')).toBe(true);
    expect(app.getHttpAdapter().getInstance().hasRoute({ method: 'OPTIONS', url: '*' })).toBe(false);
  });

  it('rejects phantom, unexpected, duplicate, and orphan HEAD identities before startup can return an app', () => {
    const route: HttpRouteCatalogEntry = {
      method: 'GET', path: '/static', kind: 'static-admin-index', auth: 'public', request: 'none',
      rateLimit: null,
      input: { type: 'object', properties: {}, additionalProperties: false },
      success: { status: 200, contentType: 'text/html; charset=utf-8', cacheControl: 'no-cache', body: 'index-html' },
    };
    expect(() => validateMountedHttpRoutes([route], [])).toThrow('Declared HTTP route was not mounted');
    expect(() => validateMountedHttpRoutes([route], [{ method: 'GET', path: '/unexpected' }])).toThrow('Unexpected HTTP route');
    expect(() => validateMountedHttpRoutes([route], [{ method: 'OPTIONS', path: '/static' }])).toThrow('Unexpected HTTP route');
    expect(() => validateMountedHttpRoutes([route, route], [{ method: 'GET', path: '/static' }])).toThrow('Duplicate HTTP route');
    expect(() => validateMountedHttpRoutes([route], [{ method: 'GET', path: '/static' }, { method: 'GET', path: '/static' }])).toThrow('Duplicate mounted HTTP route');
    expect(() => validateMountedHttpRoutes([route], [{ method: 'HEAD', path: '/static' }])).toThrow('Declared HTTP route was not mounted');
    expect(validateMountedHttpRoutes([route], [{ method: 'GET', path: '/static' }, { method: 'HEAD', path: '/static' }])[0])
      .toMatchObject({ automaticMethods: ['HEAD'] });
  });

  it('rejects invalid controller contracts during real startup and cleans up the failed app', async () => {
    const cases: Array<[string, Type]> = [
      ['Missing HTTP contract', syntheticRouteController('missing-contract', RequestMethod.GET)],
      ['not found', syntheticRouteController('missing-target', RequestMethod.GET, {
        kind: 'bus', request: 'none', target: { kind: 'query', name: 'platform.missing' },
      })],
      ['Invalid HTTP body mapping', syntheticRouteController('invalid-projection', RequestMethod.POST, {
        kind: 'composed', request: 'body', target: { kind: 'command', name: 'platform.identity.createUser' },
        bodyFields: ['email'], serverDefaulted: ['role'], output: 'target',
      })],
    ];
    for (const [message, controller] of cases) {
      const factory = vi.fn(() => [controller]);
      await expect(createReleaseServer({ runtime,
        httpAdapter: { ...httpAdapter, controllers: factory }, release: { version: 'test', configPath: '<test>' },
      })).rejects.toThrow(message);
      expect(factory).toHaveBeenCalledTimes(1);
    }
  });
  it('catalogs direct auth and meta JSON routes without inventing Bus targets', async () => {
    const routes = describeHttpRoutes(runtime, [AuthController, MetaController]);
    expect(routes.map(route => [route.method, route.path, route.status, route.auth])).toEqual([
      ['POST', '/api/v1/auth/login', 200, 'anonymous'],
      ['POST', '/api/v1/auth/logout', 200, 'session-or-anonymous'],
      ['GET', '/api/v1/auth/me', 200, 'session'],
      ['POST', '/api/v1/auth/change-password', 200, 'session'],
      ['POST', '/api/v1/auth/register', 200, 'anonymous'],
      ['POST', '/api/v1/auth/forgot-password', 200, 'anonymous'],
      ['POST', '/api/v1/auth/reset-password', 200, 'anonymous'],
      ['POST', '/api/v1/auth/verify-email', 200, 'anonymous'],
      ['POST', '/api/v1/auth/resend-verification', 200, 'session'],
      ['POST', '/api/v1/auth/change-email', 200, 'session'],
      ['POST', '/api/v1/auth/confirm-email-change', 200, 'anonymous'],
      ['POST', '/api/v1/auth/revoke-other-sessions', 200, 'session'],
      ['GET', '/api/v1/auth/mfa', 200, 'session'],
      ['POST', '/api/v1/auth/mfa/enroll', 200, 'session'],
      ['POST', '/api/v1/auth/mfa/confirm', 200, 'session'],
      ['POST', '/api/v1/auth/mfa/recovery-codes', 200, 'session'],
      ['POST', '/api/v1/auth/mfa/disable', 200, 'session'],
      ['GET', '/api/v1/meta', 200, 'bearer-or-session'],
      ['GET', '/api/v1/meta/commands', 200, 'bearer-or-session'],
      ['GET', '/api/v1/meta/queries', 200, 'bearer-or-session'],
      ['GET', '/api/v1/meta/events', 200, 'bearer-or-session'],
      ['GET', '/api/v1/meta/permissions', 200, 'bearer-or-session'],
    ]);
    for (const route of routes) {
      expect(route.kind).toBe('direct');
      expect(route).not.toHaveProperty('target');
      expect(app.getHttpAdapter().getInstance().hasRoute({ method: route.method, url: route.path })).toBe(true);
    }
    const login = routes.find(route => route.path.endsWith('/login'))!;
    const meta = routes.find(route => route.path === '/api/v1/meta/commands')!;
    if (login.kind !== 'direct' || meta.kind !== 'direct') throw new Error('Missing direct route contracts');
    expect(login.input).toMatchObject({ required: ['email', 'password'], additionalProperties: false });
    expect(login.output).toMatchObject({ properties: { data: { required: ['id', 'email', 'displayName', 'role', 'cartNotice'] } } });
    expect(login.error).toMatchObject({ properties: { error: { properties: { code: { type: 'string' } } } } });
    expect(meta.output).toMatchObject({ properties: { data: { properties: { items: { items: {
      required: ['name', 'version', 'owner', 'permission', 'idempotency', 'input', 'output'],
    } } } } } });

    const session = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email, password } });
    const token = session.cookies.find(cookie => cookie.name === SESSION_COOKIE)!.value;
    expect((await app.inject({ url: '/api/v1/auth/me', cookies: { [SESSION_COOKIE]: token } })).json().data.email).toBe(email);
    expect((await app.inject({ url: '/api/v1/meta/commands', cookies: { [SESSION_COOKIE]: token } })).json().data.items).toHaveLength(runtime.commands.list().length);
  });

  it('keeps Base extension wildcards empty and rejects impossible public session metadata', () => {
    const routes = describeHttpRoutes(runtime, [ExtensionsController]);
    expect(routes.map(route => [route.method, route.path, route.kind])).toEqual([
      ['GET', '/api/v1/extensions', 'direct'],
      ['POST', '/api/v1/extensions/:id/commands/:command', 'extension-command'],
      ['GET', '/api/v1/extensions/:id/queries/:query', 'extension-query'],
    ]);
    for (const route of routes) {
      expect(app.getHttpAdapter().getInstance().hasRoute({ method: route.method, url: route.path })).toBe(true);
      if (route.kind === 'extension-command' || route.kind === 'extension-query') expect(route.targets).toEqual([]);
    }

    const controller = class InvalidPublicSessionContract {};
    Reflect.defineMetadata(PATH_METADATA, 'invalid-public-session', controller);
    const handler = () => undefined;
    Reflect.defineMetadata(METHOD_METADATA, RequestMethod.GET, handler);
    Reflect.defineMetadata(PATH_METADATA, '', handler);
    Reflect.defineMetadata(IS_PUBLIC, true, handler);
    Reflect.defineMetadata(HTTP_CONTRACT, {
      kind: 'direct', request: 'none', auth: 'session',
      input: { type: 'object', properties: {}, additionalProperties: false }, output: { type: 'object' },
    } satisfies DirectHttpContract, handler);
    Object.defineProperty(controller.prototype, 'handle', { value: handler });
    expect(() => describeHttpRoutes(runtime, [controller])).toThrow('Invalid HTTP session requirement');
  });

  it('uses the declared error envelope without exposing internal details', async () => {
    const execute = vi.spyOn(runtime.queries, 'execute');
    const headers = { authorization: `Bearer ${READONLY_TOKEN}` };
    try {
      for (const [error, status, code] of [
        [new Error('private-database-password'), 500, 'INTERNAL_ERROR'],
        [PlatformError.internal('Request failed', { password: 'private-database-password' }), 500, 'INTERNAL_ERROR'],
        [PlatformError.conflict('Resource busy', { password: 'private-database-password' }), 409, 'CONFLICT'],
      ] as const) {
        execute.mockRejectedValueOnce(error);
        const response = await app.inject({ url: '/api/v1/system/jobs/dead', headers });
        expect(response.statusCode).toBe(status);
        expect(response.json().error.code).toBe(code);
        expect(httpErrorSchema.safeParse(response.json()).success).toBe(true);
        expect(response.body).not.toContain('private-database-password');
        expect(response.json().error).not.toHaveProperty('details');
      }
      const details = [{ path: ['limit'], message: 'Invalid limit' }];
      execute.mockRejectedValueOnce(PlatformError.validation('Invalid input', details));
      const response = await app.inject({ url: '/api/v1/system/jobs/dead', headers });
      expect(response.statusCode).toBe(400);
      expect(httpErrorSchema.parse(response.json()).error.details).toEqual(details);
    } finally { execute.mockRestore(); }
  });

  it('validates pagination and rejects a reader attempting a write', async () => {
    expect(describeHttpRoutes(runtime, [SystemController])).toHaveLength(9);
    expect(() => describeHttpRoutes(runtime, [InventoryController])).toThrow('not found');
    const headers = { authorization: `Bearer ${READONLY_TOKEN}` };
    const valid = await app.inject({ url: '/api/v1/system/jobs/dead?limit=1&offset=0', headers });
    expect(valid.statusCode).toBe(200);
    expect(valid.json().data).toEqual({ items: [], total: 0 });
    for (const url of ['/api/v1/system/jobs/quarantined', '/api/v1/system/outbox/failures']) {
      const response = await app.inject({ url, headers });
      expect(response.statusCode).toBe(200);
      expect(response.json().data).toEqual({ items: [], total: 0 });
    }
    for (const query of ['limit=0', 'limit=201', 'limit=1.5', 'offset=-1', 'offset=NaN']) {
      const invalid = await app.inject({ url: `/api/v1/system/jobs/dead?${query}`, headers });
      expect(invalid.statusCode).toBe(400);
      expect(invalid.json().error.code).toBe('VALIDATION_ERROR');
    }
    const denied = await app.inject({ method: 'POST',
      url: '/api/v1/system/jobs/dead/00000000-0000-4000-8000-000000000000/retry', headers });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error.code).toBe('FORBIDDEN');
    for (const request of [
      { url: '/api/v1/system/jobs/quarantined/00000000-0000-4000-8000-000000000000/redrive' },
      { url: '/api/v1/system/outbox/failures/00000000-0000-4000-8000-000000000000/redrive', payload: { subscriberIds: [], evidence: 'test' } },
    ]) {
      const response = await app.inject({ method: 'POST', headers, ...request });
      expect(response.statusCode).toBe(403);
      expect(response.json().error.code).toBe('FORBIDDEN');
    }
  });

  it('keeps Commerce and callback routes absent from Base', async () => {
    for (const url of ['/api/v1/products', '/api/v1/cart', '/mcp', '/callbacks/payment/example']) {
      for (const method of ['GET', 'POST'] as const) {
        expect((await app.inject({ method, url })).statusCode).toBe(404);
      }
    }
  });

  it('rejects an oversized body before authentication', async () => {
    const authenticate = vi.spyOn(runtime.auth, 'authenticate');
    try {
      const response = await app.inject({ method: 'POST', url: '/api/v1/auth/login',
        payload: { email, password: 'x'.repeat(runtime.config.http.bodyLimitBytes + 1) } });
      expect(response.statusCode).toBe(413);
      expect(response.json()).toMatchObject({ success: false, error: { code: 'VALIDATION_ERROR' } });
      expect(authenticate).not.toHaveBeenCalled();
      expect(response.headers['set-cookie']).toBeUndefined();
    } finally { authenticate.mockRestore(); }
  });

  it('does not let spoofed proxy headers evade the login limiter', async () => {
    const authenticate = vi.spyOn(runtime.auth, 'authenticate');
    try {
      for (let attempt = 0; attempt < 11; attempt++) {
        const response = await app.inject({ method: 'POST', url: '/api/v1/auth/login',
          remoteAddress: '192.0.2.42',
          headers: { 'x-forwarded-for': `198.51.100.${attempt + 1}` },
          payload: { email: 'proxy-probe@example.com', password: 123 } });
        expect(response.statusCode).toBe(attempt < 10 ? 400 : 429);
        if (attempt === 10) {
          expect(response.json()).toMatchObject({ success: false, error: { code: 'RATE_LIMITED' } });
          expect(Number(response.headers['retry-after'])).toBeGreaterThan(0);
        }
      }
      expect(authenticate).not.toHaveBeenCalled();
    } finally { authenticate.mockRestore(); }
  });

  it('uses the forwarded client only when the configured proxy is trusted', async () => {
    const trustProxy = runtime.config.http.trustProxy;
    runtime.config.http.trustProxy = true;
    const trusted = await createReleaseServer({ runtime, httpAdapter, release: { version: 'test', configPath: '<test>' } });
    try {
      for (let attempt = 0; attempt < 11; attempt++) {
        const response = await trusted.inject({ method: 'POST', url: '/api/v1/auth/login',
          remoteAddress: `192.0.2.${attempt + 1}`,
          headers: { 'x-forwarded-for': '198.51.100.99' },
          payload: { email: 'trusted-proxy@example.com', password: 123 } });
        expect(response.statusCode).toBe(attempt < 10 ? 400 : 429);
      }
    } finally {
      runtime.config.http.trustProxy = trustProxy;
      await trusted.close();
    }
  });

  it('leaves cross-origin responses without ACAO by default', async () => {
    const response = await app.inject({ url: '/health/live', headers: { origin: 'https://evil.example' } });
    expect(response.statusCode).toBe(200);
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('uses the configured CORS allowlist without changing authentication or CSRF', async () => {
    const cors = runtime.config.http.cors;
    const savedOrigins = [...cors.allowedOrigins];
    const savedCredentials = cors.credentials;
    let withoutCredentials: NestFastifyApplication | undefined;
    let withCredentials: NestFastifyApplication | undefined;
    const authenticate = vi.spyOn(runtime.auth, 'authenticate');
    const execute = vi.spyOn(runtime.commands, 'execute');
    try {
      cors.allowedOrigins.splice(0, cors.allowedOrigins.length, 'https://console.example');
      cors.credentials = false;
      withoutCredentials = await createReleaseServer({ runtime, httpAdapter, release: { version: 'test', configPath: '<test>' } });
      const catalog = (withoutCredentials.getHttpAdapter().getInstance() as HttpRouteCatalogCarrier).storeweaveHttpCatalog!;
      expect(catalog).toHaveLength(53);
      expect(catalog.find(route => route.kind === 'cors-preflight')).toMatchObject({
        method: 'OPTIONS', path: '*', automaticRoute: true, auth: 'unauthenticated', request: 'headers', rateLimit: null,
        policy: { allowedOrigins: ['https://console.example'], credentials: false,
          methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'],
          allowedHeaders: ['Authorization', 'Content-Type', 'Idempotency-Key', 'X-CSRF-Token', 'X-Correlation-Id'], exposedHeaders: ['Retry-After'] },
      });
      const allowed = await withoutCredentials.inject({ url: '/health/live', headers: { origin: 'https://console.example' } });
      expect(allowed).toMatchObject({ statusCode: 200, headers: { 'access-control-allow-origin': 'https://console.example',
        'access-control-expose-headers': 'Retry-After', vary: 'Origin' } });
      expect(allowed.headers['access-control-allow-credentials']).toBeUndefined();
      const deniedResponse = await withoutCredentials.inject({ url: '/health/live', headers: { origin: 'https://evil.example' } });
      expect(deniedResponse).toMatchObject({ statusCode: 200, headers: { vary: 'Origin' } });
      expect(deniedResponse.headers['access-control-allow-origin']).toBeUndefined();

      const preflight = await withoutCredentials.inject({ method: 'OPTIONS', url: '/api/v1/auth/login', headers: {
        origin: 'https://console.example', 'access-control-request-method': 'TRACE', 'access-control-request-headers': 'X-Not-Allowed',
      } });
      expect(preflight).toMatchObject({ statusCode: 204, body: '', headers: {
        'access-control-allow-origin': 'https://console.example',
        'access-control-allow-methods': 'GET, HEAD, POST, PUT, PATCH, DELETE',
        'access-control-allow-headers': 'Authorization, Content-Type, Idempotency-Key, X-CSRF-Token, X-Correlation-Id',
      } });
      expect(preflight.headers['access-control-allow-credentials']).toBeUndefined();
      const deniedPreflight = await withoutCredentials.inject({ method: 'OPTIONS', url: '/api/v1/auth/login', headers: {
        origin: 'https://evil.example', 'access-control-request-method': 'POST',
      } });
      expect(deniedPreflight).toMatchObject({ statusCode: 204, body: '' });
      expect(deniedPreflight.headers['access-control-allow-origin']).toBeUndefined();
      expect((await withoutCredentials.inject({ method: 'OPTIONS', url: '/not-a-route', headers: {
        origin: 'https://console.example', 'access-control-request-method': 'GET',
      } })).statusCode).toBe(204);
      expect(authenticate).not.toHaveBeenCalled();
      expect(execute).not.toHaveBeenCalled();
      for (const headers of [
        { origin: 'https://console.example' },
        { 'access-control-request-method': 'GET' },
        {},
      ]) {
        const missing = await withoutCredentials.inject({ method: 'OPTIONS', url: '/health/live', headers });
        expect(missing).toMatchObject({ statusCode: 400, body: 'Invalid Preflight Request' });
        expect(missing.headers['content-type']).toContain('text/plain');
      }

      cors.credentials = true;
      withCredentials = await createReleaseServer({ runtime, httpAdapter, release: { version: 'test', configPath: '<test>' } });
      const allowedPreflight = await withCredentials.inject({ method: 'OPTIONS', url: '/health/live', headers: {
        origin: 'https://console.example', 'access-control-request-method': 'GET',
      } });
      expect(allowedPreflight).toMatchObject({ statusCode: 204, headers: {
        'access-control-allow-origin': 'https://console.example', 'access-control-allow-credentials': 'true',
      } });
      const deniedCredentialsPreflight = await withCredentials.inject({ method: 'OPTIONS', url: '/health/live', headers: {
        origin: 'https://evil.example', 'access-control-request-method': 'GET',
      } });
      expect(deniedCredentialsPreflight).toMatchObject({ statusCode: 204, headers: { 'access-control-allow-credentials': 'true' } });
      expect(deniedCredentialsPreflight.headers['access-control-allow-origin']).toBeUndefined();
      const login = await withCredentials.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email, password } });
      const token = login.cookies.find(cookie => cookie.name === SESSION_COOKIE)!.value;
      const csrf = await withCredentials.inject({ method: 'POST', url: '/api/v1/auth/change-password',
        headers: { origin: 'https://console.example' }, cookies: { [SESSION_COOKIE]: token },
        payload: { currentPassword: password, newPassword: 'replacement-password' } });
      expect(csrf).toMatchObject({ statusCode: 403, headers: { 'access-control-allow-origin': 'https://console.example' } });
      const crossSiteLogin = await withCredentials.inject({ method: 'POST', url: '/api/v1/auth/login',
        headers: { origin: 'https://console.example' }, payload: { email, password } });
      expect(crossSiteLogin.statusCode).toBe(403);
      const bearer = await withCredentials.inject({ url: '/api/v1/meta', headers: {
        origin: 'https://console.example', authorization: `Bearer ${READONLY_TOKEN}`,
      } });
      expect(bearer).toMatchObject({ statusCode: 200, headers: {
        'access-control-allow-origin': 'https://console.example', 'access-control-allow-credentials': 'true',
      } });
    } finally {
      cors.allowedOrigins.splice(0, cors.allowedOrigins.length, ...savedOrigins);
      cors.credentials = savedCredentials;
      authenticate.mockRestore();
      execute.mockRestore();
      await withoutCredentials?.close();
      await withCredentials?.close();
    }
  });

  it('publishes both schemas from every selected bus descriptor behind authentication', async () => {
    const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email, password } });
    expect(login.statusCode).toBe(200);
    const token = login.cookies.find(cookie => cookie.name === SESSION_COOKIE)!.value;
    for (const kind of ['commands', 'queries'] as const) {
      const url = `/api/v1/meta/${kind}`;
      expect((await app.inject({ url })).statusCode).toBe(401);
      const response = await app.inject({ url, cookies: { [SESSION_COOKIE]: token } });
      expect(response.statusCode).toBe(200);
      const expected = runtime[kind].list();
      const items = response.json().data.items;
      expect(items).toHaveLength(expected.length);
      for (const { descriptor, owner } of expected) {
        expect(items.find((item: { name: string }) => item.name === descriptor.name)).toMatchObject({
          name: descriptor.name, owner, permission: descriptor.permission,
          input: zodToJsonSchema(descriptor.input as never, { target: 'jsonSchema7' }),
          output: zodToJsonSchema(descriptor.output as never, { target: 'jsonSchema7' }),
        });
      }
      expect(items.every((item: { name: string }) => item.name.startsWith('platform.'))).toBe(true);
    }
  });

  it('rejects wrong types and unknown login fields before authentication', async () => {
    const authenticate = vi.spyOn(runtime.auth, 'authenticate');
    try {
      for (const payload of [
        { email, password: 123 }, { email: ['operator'], password },
        { email, password, role: 'admin' }, {},
      ]) {
        const response = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload });
        expect(response.statusCode).toBe(400);
        expect(response.json()).toMatchObject({ success: false, error: { code: 'VALIDATION_ERROR' } });
        expect(response.headers['set-cookie']).toBeUndefined();
      }
      expect(authenticate).not.toHaveBeenCalled();
    } finally { authenticate.mockRestore(); }
  });

  it('preserves valid login and rejects malformed password changes without changing credentials', async () => {
    const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email, password } });
    expect(login.statusCode).toBe(200);
    const token = login.cookies.find(cookie => cookie.name === SESSION_COOKIE)!.value;
    const change = vi.spyOn(runtime.auth, 'changePassword');
    try {
      for (const payload of [
        { currentPassword: password, newPassword: { value: 'replacement' } },
        { currentPassword: password, newPassword: 'replacement-password', role: 'staff' },
      ]) {
        const response = await app.inject({ method: 'POST', url: '/api/v1/auth/change-password', payload,
          cookies: { [SESSION_COOKIE]: token }, headers: { 'x-csrf-token': csrfTokenFor(token) } });
        expect(response.statusCode).toBe(400);
        expect(response.json().error.code).toBe('VALIDATION_ERROR');
      }
      expect(change).not.toHaveBeenCalled();
    } finally { change.mockRestore(); }
    const again = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email, password } });
    expect(again.statusCode).toBe(200);
  });
});
