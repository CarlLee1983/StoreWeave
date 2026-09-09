import { BASE_ROLES } from '@storeweave/authorization';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { defineCommand, defineEvent, defineQuery, noopLogger, PLATFORM_VERSION } from '@storeweave/contracts';
import { commerceConfigSchema } from '@storeweave/config';
import { platformMigrations } from '@storeweave/db';
import { coreModules } from '@storeweave/bundle';
import { identityModule } from '@storeweave/identity';
import { createOpsModule, createRuntime, type BoundModuleCapability, type PlatformModule, validateModuleGraph } from '@storeweave/kernel';
import { z } from 'zod';

const ROOT = join(__dirname, '..', '..');
const BASE = PLATFORM_VERSION;

function module(name: string, overrides: Partial<PlatformModule> = {}): PlatformModule {
  return { name, version: '1.0.0', baseVersionRange: '^1.0.0', ...overrides };
}

function platform(): PlatformModule {
  return module('platform', {
    version: '0.1.0',
    migrations: platformMigrations,
    data: { owns: ['platform_migrations', 'platform_outbox', 'platform_jobs'] },
    jobs: [{ type: 'platform.event.deliver', handler: async () => undefined }],
  });
}

function dependency(name: string, versionRange = '^1.0.0') {
  return { name, versionRange };
}

function binding(from: string, capability: string, value: unknown = {}): BoundModuleCapability<unknown> {
  return { from, capability, value };
}

function event(name: string) {
  return defineEvent({ name, payload: z.unknown() });
}

function command(name: string, version = 1, permission = 'test:read') {
  return {
    descriptor: defineCommand({ name, version, input: z.unknown(), output: z.unknown(), permission }),
    handler: async () => undefined,
  };
}

function query(name: string, version = 1, permission = 'test:read') {
  return {
    descriptor: defineQuery({ name, version, input: z.unknown(), output: z.unknown(), permission }),
    handler: async () => undefined,
  };
}

function permission(key: string, owner: string) {
  return { key, description: key, owner };
}

function policy(id: string, owner: string) {
  return { id, owner, appliesTo: [], evaluate: () => 'allow' as const };
}

function listNames(modules: readonly PlatformModule[]): string[] {
  return modules.map(({ name }) => name);
}

function expectInvalid(modules: readonly PlatformModule[], message: string) {
  expect(() => validateModuleGraph(modules, BASE)).toThrow(message);
}

function configThatRejectsDatabaseAccess() {
  const config = commerceConfigSchema.parse({
    version: 1,
    store: { id: 'test-store', name: 'Test Store' },
    database: { url: 'postgres://example.invalid/storeweave' },
  });
  let accesses = 0;
  Object.defineProperty(config, 'database', {
    enumerable: true,
    get: () => {
      accesses += 1;
      throw new Error('database must not be constructed before graph validation');
    },
  });
  return { config, accesses: () => accesses };
}

async function expectRuntimePreflightFailure(modules: readonly PlatformModule[]) {
  const { config, accesses } = configThatRejectsDatabaseAccess();
  await expect(createRuntime({
    release: { id: 'test', version: '1.0.0', buildManifestChecksum: `sha256:${'0'.repeat(64)}` },
    roles: BASE_ROLES,
    config,
    secrets: { get: () => undefined, has: () => false, listNames: () => [] },
    logger: noopLogger,
    modules,
    availableExtensions: {},
  })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  expect(accesses()).toBe(0);
}

describe('module graph', () => {
  it('orders a shuffled static graph deterministically', () => {
    const alpha = module('alpha');
    const beta = module('beta', { dependencies: { required: [dependency('alpha')] } });
    const gamma = module('gamma', { dependencies: { required: [dependency('beta')] } });

    expect(listNames(validateModuleGraph([gamma, alpha, beta], BASE))).toEqual(['alpha', 'beta', 'gamma']);
    expect(listNames(validateModuleGraph([beta, gamma, alpha], BASE))).toEqual(['alpha', 'beta', 'gamma']);
  });

  it('validates required and optional dependency presence, versions, ranges, and Base compatibility', () => {
    expectInvalid([module('consumer', { dependencies: { required: [dependency('missing')] } })], 'requires missing module');
    expect(validateModuleGraph([module('consumer', { dependencies: { optional: [dependency('missing')] } })], BASE)).toHaveLength(1);
    expect(listNames(validateModuleGraph([
      module('consumer', { dependencies: { optional: [dependency('provider')] } }), module('provider'),
    ], BASE))).toEqual(['provider', 'consumer']);
    expectInvalid([
      module('consumer', { dependencies: { optional: [dependency('provider', '^2.0.0')] } }), module('provider'),
    ], 'requires provider@^2.0.0, found 1.0.0');
    expectInvalid([module('consumer', { dependencies: { required: [dependency('provider', 'not-a-range')] } })], 'invalid dependency');
    expectInvalid([module('consumer', { version: 'not-a-version' })], 'invalid version');
    expectInvalid([module('consumer', { baseVersionRange: 'not-a-range' })], 'invalid Base range');
    expectInvalid([module('consumer', { baseVersionRange: '^2.0.0' })], 'requires Base ^2.0.0');
    expect(() => validateModuleGraph([module('consumer')], 'not-a-version')).toThrow('invalid Base version');
  });

  it('rejects invalid and duplicate names plus static dependency cycles', () => {
    expectInvalid([module('not valid')], 'invalid module name');
    expectInvalid([module('same'), module('same')], 'duplicate module');
    expectInvalid([
      module('alpha', { dependencies: { required: [dependency('beta')] } }),
      module('beta', { dependencies: { required: [dependency('alpha')] } }),
    ], 'module dependency cycle: alpha -> beta -> alpha');
  });

  it('validates capability providers and explicit bindings', () => {
    const capability = 'test.service.port';
    const provider = module('provider', { capabilities: { provides: [capability] } });
    const consumer = module('consumer', {
      capabilities: {
        required: [{ from: 'provider', capability, versionRange: '^1.0.0' }],
        bound: [binding('provider', capability)],
      },
    });
    expect(listNames(validateModuleGraph([consumer, provider], BASE))).toEqual(['consumer', 'provider']);
    expectInvalid([provider, module('other', { capabilities: { provides: [capability] } })], 'capability "test.service.port" is declared');
    expectInvalid([provider, module('other'), module('consumer', {
      capabilities: { required: [{ from: 'provider', capability, versionRange: '^1.0.0' }], bound: [binding('other', capability)] },
    })], 'must bind capability "test.service.port" from installed module "provider"');
    expectInvalid([provider, module('consumer', {
      capabilities: { required: [{ from: 'provider', capability, versionRange: '^1.0.0' }] },
    })], 'must bind capability');
    expectInvalid([module('provider', { version: '1.0.0', capabilities: { provides: [capability] } }), module('consumer', {
      capabilities: { required: [{ from: 'provider', capability, versionRange: '^2.0.0' }], bound: [binding('provider', capability)] },
    })], 'requires provider@^2.0.0, found 1.0.0');
    expectInvalid([module('provider'), module('consumer', {
      capabilities: { required: [{ from: 'provider', capability, versionRange: '^1.0.0' }], bound: [binding('provider', capability)] },
    })], 'but it is not provided');
    expectInvalid([provider, module('consumer', { capabilities: { bound: [binding('provider', capability)] } })], 'undeclared binding');
    expectInvalid([provider, module('consumer', {
      capabilities: { optional: [{ from: 'provider', capability, versionRange: '^1.0.0' }] },
    })], 'must bind capability');
    expectInvalid([module('consumer', {
      capabilities: {
        optional: [{ from: 'provider', capability, versionRange: '^1.0.0' }], bound: [binding('provider', capability)],
      },
    })], 'binds capability "test.service.port" from missing module "provider"');
    expect(validateModuleGraph([module('consumer', {
      capabilities: { optional: [{ from: 'provider', capability, versionRange: '^1.0.0' }] },
    })], BASE)).toHaveLength(1);
    expect(listNames(validateModuleGraph([provider, module('consumer', {
      capabilities: {
        optional: [{ from: 'provider', capability, versionRange: '^1.0.0' }], bound: [binding('provider', capability)],
      },
    })], BASE))).toEqual(['consumer', 'provider']);
    expectInvalid([module('consumer', { capabilities: { bound: [binding('provider', capability, null)] } })], 'empty binding');
  });

  it('rejects data and migration ownership collisions while allowing identity namespace ownership', () => {
    expectInvalid([module('alpha', { data: { owns: ['shared_table'] } }), module('beta', { data: { owns: ['shared_table'] } })], 'data resource "shared_table" is declared');
    expectInvalid([
      module('alpha', { migrations: { module: 'shared', migrations: [] } }),
      module('beta', { migrations: { module: 'shared', migrations: [] } }),
    ], 'migration owner "shared" is declared');
    expect(validateModuleGraph([
      module('platform-identity', { migrations: { module: 'identity', migrations: [] } }),
    ], BASE)).toHaveLength(1);
  });

  it('rejects registration collisions', () => {
    expectInvalid([module('alpha', { events: [event('test.event.created.v1')] }), module('beta', { events: [event('test.event.created.v1')] })], 'event "test.event.created.v1" is declared');
    expectInvalid([module('alpha', { commands: [command('test.command.run')] }), module('beta', { commands: [command('test.command.run')] })], 'command "test.command.run" is declared');
    expectInvalid([module('alpha', { queries: [query('test.query.get')] }), module('beta', { queries: [query('test.query.get')] })], 'query "test.query.get" is declared');
    expectInvalid([module('alpha', { jobs: [{ type: 'test.job', handler: async () => undefined }] }), module('beta', { jobs: [{ type: 'test.job', handler: async () => undefined }] })], 'job "test.job" is declared');
    expectInvalid([
      module('alpha', { permissions: [permission('test:read', 'alpha')] }),
      module('beta', { permissions: [permission('test:read', 'beta')] }),
    ], 'permission "test:read" is declared');
    expectInvalid([
      module('alpha', { policies: [policy('test-policy', 'alpha')] }),
      module('beta', { policies: [policy('test-policy', 'beta')] }),
    ], 'policy "test-policy" is declared');
    expectInvalid([module('listener', { subscribers: [
      { eventName: 'test.event.created.v1', handler: async () => undefined },
      { eventName: 'test.event.created.v1', handler: async () => undefined },
    ] })], 'subscription "listener:test.event.created.v1" is declared');
  });

  it('validates subscribers, including foreign command owner, version, and dependency grants', () => {
    const signal = event('test.signal.sent.v1');
    const producer = module('producer', { events: [signal] });
    const owner = module('owner', { commands: [command('test.owner.run', 2, 'owner:run')], permissions: [permission('owner:run', 'owner')] });
    const subscriber = (commands: readonly { from: string; name: string; version: number }[], dependencies?: PlatformModule['dependencies']) => module('listener', {
      dependencies,
      subscribers: [{ eventName: 'test.signal.sent.v1', handler: async () => undefined, commands }],
    });

    expectInvalid([module('listener', { subscribers: [{ eventName: 'test.signal.missing.v1', handler: async () => undefined }] })], 'subscribes to unknown event');
    expectInvalid([producer, owner, subscriber([{ from: 'owner', name: 'test.owner.run', version: 2 }])], 'no dependency or binding to command owner');
    expectInvalid([producer, owner, subscriber([{ from: 'wrong-owner', name: 'test.owner.run', version: 2 }], { required: [dependency('owner')] })], 'requires unknown command');
    expectInvalid([producer, owner, subscriber([{ from: 'owner', name: 'test.owner.run', version: 1 }], { required: [dependency('owner')] })], 'requires unknown command');
    expect(listNames(validateModuleGraph([
      producer, owner, subscriber([{ from: 'owner', name: 'test.owner.run', version: 2 }], { required: [dependency('owner')] }),
    ], BASE))).toEqual(['owner', 'listener', 'producer']);
  });

  it('accepts the real commerce assembly, including reciprocal shipping/refund capabilities', () => {
    const modules = [
      platform(), identityModule, createOpsModule({} as never, {} as never),
      // 商務模組宣告依賴 base 通知能力；真實組裝由 createRuntime 補上它。
      module('platform-notifications', { version: '0.1.0', data: { owns: ['platform_notifications'] } }),
      ...coreModules({ providers: { list: () => [] } as never, defaultCurrency: 'TWD', orderNumberPrefix: 'SW', timezone: 'Asia/Taipei', locale: 'zh-TW' }),
    ];
    const validated = validateModuleGraph(modules, BASE);
    const shipping = validated.find(({ name }) => name === 'shipping')!;
    const refund = validated.find(({ name }) => name === 'refund')!;

    expect(identityModule.migrations?.module).toBe('identity');
    expect(shipping.capabilities?.optional).toContainEqual(expect.objectContaining({ from: 'refund', capability: 'commerce.refund.shipment-guard' }));
    expect(refund.capabilities?.required).toContainEqual(expect.objectContaining({ from: 'shipping', capability: 'commerce.shipping.shipment-lookup' }));
    expect(shipping.capabilities?.bound?.map(({ from }) => from)).toContain('refund');
    expect(refund.capabilities?.bound?.map(({ from }) => from)).toContain('shipping');
  }, 30_000);

  it('rejects duplicate platform modules before any database access', async () => {
    await expectRuntimePreflightFailure([platform()]);
  });

  it('rejects missing dependencies before any database access', async () => {
    await expectRuntimePreflightFailure([
      module('consumer', { dependencies: { required: [dependency('missing')] } }),
    ]);
  });
});

describe('commerce module declaration boundary', () => {
  function sourceFiles(dir: string): string[] {
    const files: string[] = [];
    const walk = (current: string) => {
      for (const entry of readdirSync(current)) {
        if (entry === 'node_modules' || entry === 'dist') continue;
        const file = join(current, entry);
        if (statSync(file).isDirectory()) walk(file);
        else if (file.endsWith('.ts') && !file.endsWith('.d.ts')) files.push(file);
      }
    };
    walk(join(ROOT, dir));
    return files;
  }

  const commerceRoot = join(ROOT, 'packages', 'commerce');
  const domainModules = new Set(readdirSync(commerceRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name));
  domainModules.add('identity');
  const moduleFiles = sourceFiles('packages/commerce').filter((file) => file.includes('/src/'));

  it('does not import another domain module’s repository or schema, including Identity and barrel Repository/Row symbols', () => {
    const violations: string[] = [];
    for (const file of moduleFiles) {
      const owner = relative(commerceRoot, file).split('/')[0];
      const source = readFileSync(file, 'utf8');
      for (const match of source.matchAll(/import\s+(?:type\s+)?([\s\S]*?)\s+from\s+['"]([^'"]+)['"]/g)) {
        const [, bindings, specifier] = match;
        const foreignCommerce = specifier.match(/^@storeweave\/([a-z-]+)/)?.[1];
        const foreignCommerceModule = foreignCommerce !== owner && domainModules.has(foreignCommerce ?? '');
        const foreignRelative = specifier.startsWith('.')
          && relative(join(commerceRoot, owner), resolve(dirname(file), specifier)).startsWith('..');
        if (!foreignCommerceModule && !foreignRelative) continue;
        if (/(?:^|\/)(?:repository|schema)(?:$|\/)/.test(specifier) || /\b\w*(?:Repository|Row)\b/.test(bindings)) {
          violations.push(`${relative(ROOT, file)} -> ${specifier}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });
});
