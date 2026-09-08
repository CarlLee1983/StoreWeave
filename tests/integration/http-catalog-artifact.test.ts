import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Runtime } from '@storeweave/kernel';
import { bootstrapRelease } from '../../packages/platform/bundle/src/bootstrap-release';
import { release as baseRelease } from '../../packages/platform/bundle/src/releases/base';
import { release as commerceRelease } from '../../packages/platform/bundle/src/releases/commerce';
import { createReleaseServer } from '../../apps/api/src/release-server';
import { httpAdapter as baseHttpAdapter } from '../../apps/api/src/releases/base';
import { writeStartupHttpCatalog } from '../../apps/api/src/http/catalog-artifact';
import type { HttpRouteCatalogCarrier, HttpRouteCatalogEntry } from '../../apps/api/src/http/contract';
import { createTestDatabase } from './helpers';
import { httpAdapter as commerceHttpAdapter } from '../../apps/api/src/releases/commerce';

const directories: string[] = [];
const executeFile = promisify(execFile);

afterEach(async () => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function directory() {
  const value = mkdtempSync(join(tmpdir(), 'storeweave-http-catalog-'));
  directories.push(value);
  return value;
}

function catalogRoute(path = '/z'): HttpRouteCatalogEntry {
  return {
    method: 'GET', path, kind: 'static-admin-index', auth: 'public', request: 'none', rateLimit: null,
    input: { type: 'object', properties: {}, additionalProperties: false },
    success: { status: 200, contentType: 'text/html; charset=utf-8', cacheControl: 'no-cache', body: 'index-html' },
  };
}

function runtime(options: { activated?: boolean; extensions?: string[]; mounted?: string[] } = {}): Runtime {
  const activated = options.activated ?? true;
  const extensions = options.extensions ?? [];
  const mounted = options.mounted ?? extensions;
  return {
    activatedRelease: activated ? Object.freeze({ id: 'test', version: '1.0.0' }) : null,
    config: { extensions: extensions.map(id => ({ id, enabled: true, config: {} })) },
    extensions: { list: () => mounted.map(id => ({ id })) },
  } as unknown as Runtime;
}

function write(output: string, routes: readonly HttpRouteCatalogEntry[], options?: { activated?: boolean; extensions?: string[]; mounted?: string[] }) {
  writeStartupHttpCatalog({ output, runtime: runtime(options), carrier: { storeweaveHttpCatalog: routes } });
}

function normalizedRoutes(carrier: HttpRouteCatalogCarrier) {
  return JSON.parse(JSON.stringify([...carrier.storeweaveHttpCatalog!].sort((a, b) => `${a.method} ${a.path}` < `${b.method} ${b.path}` ? -1 : `${a.method} ${a.path}` > `${b.method} ${b.path}` ? 1 : 0)));
}

describe('startup HTTP catalog artifact', () => {
  it('serializes strict canonical JSON without changing its retained catalog', () => {
    const root = directory();
    const routes = [catalogRoute('/z'), { ...catalogRoute('/a'), optional: undefined }] as unknown as HttpRouteCatalogEntry[];
    write(join(root, 'catalog.json'), routes);
    expect(routes.map(route => route.path)).toEqual(['/z', '/a']);
    expect(readFileSync(join(root, 'catalog.json'), 'utf8')).toBe(
      '{"format":"storeweave.http-catalog.v1","release":{"id":"test","version":"1.0.0"},"routes":[{"auth":"public","input":{"additionalProperties":false,"properties":{},"type":"object"},"kind":"static-admin-index","method":"GET","path":"/a","rateLimit":null,"request":"none","success":{"body":"index-html","cacheControl":"no-cache","contentType":"text/html; charset=utf-8","status":200}},{"auth":"public","input":{"additionalProperties":false,"properties":{},"type":"object"},"kind":"static-admin-index","method":"GET","path":"/z","rateLimit":null,"request":"none","success":{"body":"index-html","cacheControl":"no-cache","contentType":"text/html; charset=utf-8","status":200}}]}\n',
    );
    const proto = catalogRoute('/proto') as any;
    proto.input = JSON.parse('{"__proto__":{"preserved":true}}');
    write(join(root, 'proto.json'), [proto]);
    expect(JSON.parse(readFileSync(join(root, 'proto.json'), 'utf8')).routes[0].input).toHaveProperty('__proto__', { preserved: true });
  });

  it('keeps integer-like nested schema keys in lexical order', () => {
    const root = directory();
    const route = catalogRoute() as any;
    route.input = { type: 'object', properties: { '2': { type: 'string' }, '10': { type: 'number' } } };
    const output = join(root, 'numeric-keys.json');
    write(output, [route]);
    expect(readFileSync(output, 'utf8')).toContain('"properties":{"10":{"type":"number"},"2":{"type":"string"}}');
  });

  it('rejects incomplete activation, mismatched extensions, non-JSON data, and unsafe output paths without publishing', () => {
    const root = directory();
    const missing = join(root, 'missing.json');
    expect(() => write(missing, [catalogRoute()], { activated: false })).toThrow('activated release');
    expect(() => write(missing, [catalogRoute()], { extensions: ['configured'], mounted: [] })).toThrow('match mounted');
    expect(() => write(missing, [{ ...catalogRoute(), input: { value: new Date() } }] as unknown as HttpRouteCatalogEntry[])).toThrow('non-plain object');
    expect(() => write('relative.json', [catalogRoute()])).toThrow('absolute path');
    expect(() => write(join(root, 'missing', 'catalog.json'), [catalogRoute()])).toThrow('parent directory');
    expect(() => write(missing, [catalogRoute()])).not.toThrow();
    expect(() => write(missing, [catalogRoute()])).toThrow('already exists');
    const link = join(root, 'link.json');
    symlinkSync(missing, link);
    expect(() => write(link, [catalogRoute()])).toThrow('already exists');
    expect(readFileSync(missing, 'utf8')).toContain('storeweave.http-catalog.v1');
    expect(() => write(join(root, 'invalid.json'), [{ ...catalogRoute(), input: [undefined] }] as unknown as HttpRouteCatalogEntry[])).toThrow('array contains undefined');
    expect(() => write(join(root, 'sparse.json'), [{ ...catalogRoute(), input: new Array(1) }] as unknown as HttpRouteCatalogEntry[])).toThrow('array contains undefined');
    expect(() => write(join(root, 'symbol.json'), [{ ...catalogRoute(), input: { [Symbol('private')]: 'value' } }] as unknown as HttpRouteCatalogEntry[])).toThrow('symbol key');
    expect(() => write(join(root, 'array-symbol.json'), [{ ...catalogRoute(), input: Object.assign([], { [Symbol('private')]: 'value' }) }] as unknown as HttpRouteCatalogEntry[])).toThrow('symbol key');
    expect(() => write(join(root, 'cycle.json'), [(() => { const route = catalogRoute() as any; route.input = {}; route.input.self = route.input; return route; })()])).toThrow('cycle');
    expect(() => readFileSync(join(root, 'invalid.json'))).toThrow();
    expect(() => readFileSync(join(root, 'cycle.json'))).toThrow();
  });

  it('does not remove a colliding temporary file it did not create', async () => {
    const root = directory();
    const collision = '00000000-0000-4000-8000-000000000000';
    const temporary = join(root, `.${collision}.storeweave-http-catalog`);
    writeFileSync(temporary, 'keep');
    vi.resetModules();
    vi.doMock('node:crypto', async importOriginal => ({ ...await importOriginal<typeof import('node:crypto')>(), randomUUID: () => collision }));
    try {
      const artifact = await import('../../apps/api/src/http/catalog-artifact');
      expect(() => artifact.writeStartupHttpCatalog({ output: join(root, 'catalog.json'), runtime: runtime(),
        carrier: { storeweaveHttpCatalog: [catalogRoute()] } })).toThrow();
      expect(readFileSync(temporary, 'utf8')).toBe('keep');
    } finally {
      vi.doUnmock('node:crypto');
      vi.resetModules();
    }
  });

  it('cleans its temporary file when the exclusive write fails before publication', async () => {
    const root = directory();
    const collision = '00000000-0000-4000-8000-000000000001';
    vi.resetModules();
    vi.doMock('node:crypto', async importOriginal => ({ ...await importOriginal<typeof import('node:crypto')>(), randomUUID: () => collision }));
    vi.doMock('node:fs', async importOriginal => {
      const fs = await importOriginal<typeof import('node:fs')>();
      return { ...fs, writeFileSync: (...args: Parameters<typeof fs.writeFileSync>) => {
        if (typeof args[0] === 'number') throw new Error('write failed');
        return fs.writeFileSync(...args);
      } };
    });
    const output = join(root, 'catalog.json');
    const temporary = join(root, `.${collision}.storeweave-http-catalog`);
    try {
      const artifact = await import('../../apps/api/src/http/catalog-artifact');
      expect(() => artifact.writeStartupHttpCatalog({ output, runtime: runtime(),
        carrier: { storeweaveHttpCatalog: [catalogRoute()] } })).toThrow('write failed');
      expect(existsSync(output)).toBe(false);
      expect(existsSync(temporary)).toBe(false);
    } finally {
      vi.doUnmock('node:fs');
      vi.doUnmock('node:crypto');
      vi.resetModules();
    }
  });

  it('allows exactly one concurrent publisher to create an artifact', async () => {
    const root = directory();
    const output = join(root, 'race.json');
    const source = join(process.cwd(), 'apps/api/src/http/catalog-artifact.ts');
    const tsx = join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs');
    const script = `import { writeStartupHttpCatalog } from ${JSON.stringify(source)};
      writeStartupHttpCatalog({ output: process.argv.at(-1), runtime: {
        activatedRelease: Object.freeze({ id: 'race', version: '1.0.0' }), config: { extensions: [] }, extensions: { list: () => [] },
      }, carrier: { storeweaveHttpCatalog: [{ method: 'GET', path: '/race', kind: 'static-admin-index', auth: 'public', request: 'none', rateLimit: null,
        input: { type: 'object', properties: {}, additionalProperties: false }, success: { status: 200, contentType: 'text/html; charset=utf-8', cacheControl: 'no-cache', body: 'index-html' } }] } });`;
    const publish = () => executeFile(process.execPath, [tsx, '-e', script, output], { cwd: process.cwd() });
    const results = await Promise.allSettled([publish(), publish()]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
    expect(readFileSync(output, 'utf8')).toMatch(/\n$/);
    expect(JSON.parse(readFileSync(output, 'utf8')).release).toEqual({ id: 'race', version: '1.0.0' });
  });

  it('rejects real Base and Commerce runtimes before activation even when an incomplete server can construct', async () => {
    const root = directory();
    const assertUnactivated = async (name: string, selected: typeof baseRelease | typeof commerceRelease, adapter: typeof baseHttpAdapter | typeof commerceHttpAdapter) => {
      const configPath = join(root, `${name}.json`);
      const commerce = selected.id === 'commerce';
      writeFileSync(configPath, JSON.stringify({ version: 1,
        store: commerce ? { id: name, name, currency: 'TWD' } : { id: name, name },
        database: { url: await createTestDatabase() }, logging: { level: 'error' },
        ...(commerce ? { theme: { id: 'default' }, extensions: [] } : { extensions: [] }),
      }));
      const boot = await bootstrapRelease(selected as never, { configPath, loggerName: name });
      const app = await createReleaseServer({ runtime: boot.runtime, theme: boot.theme, httpAdapter: adapter as never,
        release: { version: 'unrelated-http-version', configPath } });
      const output = join(root, `${name}.catalog.json`);
      try {
        expect(boot.runtime.activatedRelease).toBeNull();
        expect(() => writeStartupHttpCatalog({ output, runtime: boot.runtime,
          carrier: app.getHttpAdapter().getInstance() as HttpRouteCatalogCarrier })).toThrow('activated release');
        expect(() => readFileSync(output)).toThrow();
      } finally {
        await app.close();
        await boot.runtime.close();
      }
    };
    await assertUnactivated('unactivated-base', baseRelease, baseHttpAdapter);
    await assertUnactivated('unactivated-commerce', commerceRelease, commerceHttpAdapter);
  }, 300_000);

  it('exports identical effective Base and Commerce catalogs across independent bootstraps without reactivation', async () => {
    const root = directory();
    const exportBase = async (name: string) => {
      const configPath = join(root, `${name}.json`);
      writeFileSync(configPath, JSON.stringify({ version: 1, store: { id: name, name },
        database: { url: await createTestDatabase() }, logging: { level: 'error' }, extensions: [],
        http: { cors: { allowedOrigins: ['https://console.example'], credentials: true } } }));
      const base = await bootstrapRelease(baseRelease, { configPath, loggerName: name });
      await base.runtime.migrate();
      const app = await createReleaseServer({ runtime: base.runtime, httpAdapter: baseHttpAdapter,
        release: { version: 'unrelated-http-version', configPath } });
      try {
        const carrier = app.getHttpAdapter().getInstance() as HttpRouteCatalogCarrier;
        const output = join(root, `${name}.catalog.json`);
        const activate = vi.spyOn(base.runtime, 'activateRelease');
        const query = vi.spyOn(base.runtime.database.pool, 'query');
        const providers = vi.spyOn(base.runtime.providers, 'list');
        writeStartupHttpCatalog({ output, runtime: base.runtime, carrier });
        const duplicate = join(root, `${name}.duplicate.json`);
        writeStartupHttpCatalog({ output: duplicate, runtime: base.runtime, carrier });
        const bytes = readFileSync(output, 'utf8');
        expect(bytes).not.toContain('"$ref"');
        expect(readFileSync(duplicate, 'utf8')).toBe(bytes);
        expect(activate).not.toHaveBeenCalled();
        expect(query).not.toHaveBeenCalled();
        expect(providers).not.toHaveBeenCalled();
        return { bytes, parsed: JSON.parse(bytes), routes: normalizedRoutes(carrier) };
      } finally {
        await app.close();
        await base.runtime.close();
      }
    };
    const baseOne = await exportBase('artifact-base-one');
    const baseTwo = await exportBase('artifact-base-two');
    expect(baseOne.bytes).toBe(baseTwo.bytes);
    expect(baseOne.parsed).toEqual({ format: 'storeweave.http-catalog.v1',
      release: { id: 'base', version: baseRelease.version }, routes: baseOne.routes });
    expect(baseTwo.parsed.routes).toEqual(baseTwo.routes);
    expect(baseOne.parsed.routes.find((route: { kind: string }) => route.kind === 'cors-preflight')).toMatchObject({
      method: 'OPTIONS', path: '*', automaticRoute: true,
      policy: { allowedOrigins: ['https://console.example'], credentials: true,
        methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'],
        allowedHeaders: ['Authorization', 'Content-Type', 'Idempotency-Key', 'X-CSRF-Token', 'X-Correlation-Id'], exposedHeaders: ['Retry-After'] },
    });

    const adminDir = join(root, 'admin-sentinel');
    // createReleaseServer only mounts admin routes when the directory and index exist.
    mkdirSync(adminDir);
    writeFileSync(join(adminDir, 'index.html'), '<!doctype html>admin');
    const exportCommerce = async (name: string, secret: string) => {
      const configPath = join(root, `${name}.json`);
      writeFileSync(configPath, JSON.stringify({ version: 1,
        store: { id: name, name, currency: 'TWD' }, database: { url: await createTestDatabase() },
        logging: { level: 'error' }, theme: { id: 'default' }, admin: { enabled: true }, mcp: { enabled: true },
        http: { cors: { allowedOrigins: ['https://console.example'], credentials: true } },
        extensions: [
          { id: 'mock-payment', config: { autoApprove: true } },
          { id: 'mock-notification', config: { deliver: true, retainSensitiveVariables: true } },
          { id: 'demo-erp', config: { endpoint: 'mock://artifact-erp' } },
          { id: 'mcp', config: {} },
        ],
      }));
      const priorSecret = process.env.DEMO_ERP_API_KEY;
      process.env.DEMO_ERP_API_KEY = secret;
      let closeRuntime: (() => Promise<void>) | undefined;
      let app: Awaited<ReturnType<typeof createReleaseServer>> | undefined;
      try {
        const commerce = await bootstrapRelease(commerceRelease, { configPath, loggerName: name });
        closeRuntime = () => commerce.runtime.close();
        await commerce.runtime.migrate();
        app = await createReleaseServer({ runtime: commerce.runtime, theme: commerce.theme, httpAdapter: commerceHttpAdapter,
          release: { version: 'unrelated-http-version', configPath, adminDir } });
        const carrier = app.getHttpAdapter().getInstance() as HttpRouteCatalogCarrier;
        const output = join(root, `${name}.catalog.json`);
        const activate = vi.spyOn(commerce.runtime, 'activateRelease');
        const query = vi.spyOn(commerce.runtime.database.pool, 'query');
        const providers = vi.spyOn(commerce.runtime.providers, 'list');
        writeStartupHttpCatalog({ output, runtime: commerce.runtime, carrier });
        writeStartupHttpCatalog({ output: join(root, `${name}.duplicate.json`), runtime: commerce.runtime, carrier });
        const bytes = readFileSync(output, 'utf8');
        expect(bytes).not.toContain('"$ref"');
        expect(bytes).not.toContain(secret);
        expect(bytes).not.toContain(commerce.runtime.config.database.url);
        expect(bytes).not.toContain(adminDir);
        expect(activate).not.toHaveBeenCalled();
        expect(query).not.toHaveBeenCalled();
        expect(providers).not.toHaveBeenCalled();
        return { bytes, parsed: JSON.parse(bytes), routes: normalizedRoutes(carrier) };
      } finally {
        await app?.close();
        await closeRuntime?.();
        if (priorSecret === undefined) delete process.env.DEMO_ERP_API_KEY;
        else process.env.DEMO_ERP_API_KEY = priorSecret;
      }
    };
    const commerceOne = await exportCommerce('artifact-commerce-one', 'commerce-secret-one');
    const commerceTwo = await exportCommerce('artifact-commerce-two', 'commerce-secret-two');
    expect(commerceOne.bytes).toBe(commerceTwo.bytes);
    expect(commerceOne.parsed).toEqual({ format: 'storeweave.http-catalog.v1',
      release: { id: commerceRelease.id, version: commerceRelease.version }, routes: commerceOne.routes });
    expect(commerceTwo.parsed.routes).toEqual(commerceTwo.routes);
    expect(commerceOne.parsed.routes.find((route: { kind: string }) => route.kind === 'cors-preflight')).toMatchObject({
      method: 'OPTIONS', path: '*', automaticRoute: true,
      policy: { allowedOrigins: ['https://console.example'], credentials: true },
    });
  }, 300_000);
});
