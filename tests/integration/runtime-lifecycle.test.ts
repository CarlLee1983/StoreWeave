import { Controller } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as kernel from '@storeweave/kernel';
import { bootstrapRelease } from '../../packages/platform/bundle/src/bootstrap-release';
import { release as baseRelease } from '../../packages/platform/bundle/src/releases/base';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { createReleaseServer } from '../../apps/api/src/release-server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { BASE_ROLES } from '@storeweave/authorization';
import { baseConfigSchema } from '@storeweave/config';
import { noopLogger } from '@storeweave/contracts';
import { Database, platformMigrations, runMigrations } from '@storeweave/db';
import { defineExtension, type ExtensionContext, type ExtensionDefinition, type ExtensionRegistration } from '@storeweave/extension-sdk';
import { createRuntime, type Runtime } from '@storeweave/kernel';
import { createTestDatabase, testSecretProvider } from './helpers';

const runtimes: Runtime[] = [];
afterEach(async () => {
  await Promise.allSettled(runtimes.splice(0).map(runtime => runtime.close()));
  vi.restoreAllMocks();
});
function extension(id: string, setup: ExtensionDefinition['setup'], permissions: readonly string[] = []) {
  return defineExtension({
    manifest: { id, name: id, version: '1.0.0', platformVersion: '^1.0.0', permissions,
      configuration: z.object({}), subscribedEvents: [], registeredCommands: [], registeredQueries: [], registeredProviders: [] },
    setup,
  });
}
async function options(extensions: ExtensionDefinition[]) {
  const url = await createTestDatabase();
  const initial = new Database({ url });
  try { await runMigrations(initial.pool, [platformMigrations]); }
  finally { await initial.close(); }
  return {
    release: { id: 'test', version: '1.0.0', buildManifestChecksum: `sha256:${'0'.repeat(64)}` },
    roles: BASE_ROLES, modules: [], logger: noopLogger,
    secrets: testSecretProvider({ SW_SIGNING_KEY_TEST: Buffer.alloc(32, 3).toString('base64url') }),
    config: baseConfigSchema.parse({ version: 1, store: { id: 'lifecycle', name: 'Lifecycle' }, database: { url },
      extensions: extensions.map(extension => ({ id: extension.manifest.id })),
      security: { signingKeys: [{ id: 'test', secretRef: 'SW_SIGNING_KEY_TEST' }] } }),
    availableExtensions: Object.fromEntries(extensions.map(extension => [extension.manifest.id, extension])),
  };
}
function observeDatabaseClose(order: string[]) {
  const close = Database.prototype.close;
  return vi.spyOn(Database.prototype, 'close').mockImplementation(function (this: Database) {
    order.push('database');
    return close.call(this);
  });
}

describe('runtime cleanup', () => {
  it('cleans setup, pool and owned logger when newly-created work rejects finalization, without registry or history writes', async () => {
    const url = await createTestDatabase();
    const directory = mkdtempSync(join(tmpdir(), 'storeweave-finalizer-'));
    const configPath = join(directory, 'base.json');
    const order: string[] = [];
    const closeLogger = vi.fn(async () => { order.push('logger'); });
    vi.spyOn(kernel, 'createLogger').mockReturnValue({ ...noopLogger, close: closeLogger });
    const probe = extension('finalizer-probe', async () => {
      const connection = new Database({ url });
      try {
        await connection.pool.query("INSERT INTO platform_jobs(id,type,payload,status) VALUES ($1,'unknown.after-setup','{}','pending')", [randomUUID()]);
      } finally { await connection.close(); }
      return { close: () => { order.push('extension'); } };
    });
    process.env.SW_SIGNING_KEY_TEST = Buffer.alloc(32, 3).toString('base64url');
    writeFileSync(configPath, JSON.stringify({ version: 1, store: { id: 'finalizer', name: 'Finalizer' },
      database: { url }, extensions: [{ id: probe.manifest.id }],
      security: { signingKeys: [{ id: 'test', secretRef: 'SW_SIGNING_KEY_TEST' }] } }));
    try {
      const { runtime } = await bootstrapRelease({ ...baseRelease, availableExtensions: { [probe.manifest.id]: probe } },
        { configPath, loggerName: 'finalizer-test' });
      runtimes.push(runtime);
      const closeDatabase = vi.spyOn(runtime.database, 'close');
      await expect(runtime.migrate()).rejects.toThrow('unknown or disabled');
      expect(order).toEqual(['extension', 'logger']);
      expect(closeDatabase).toHaveBeenCalledTimes(1);
      expect(runtime.database.pool.totalCount).toBe(0);
      expect(closeLogger).toHaveBeenCalledTimes(1);
      const inspection = new Database({ url });
      try {
        expect((await inspection.pool.query('SELECT id FROM platform_extension_registry')).rows).toEqual([]);
        expect((await inspection.pool.query('SELECT sequence FROM platform_release_history')).rows).toEqual([]);
      } finally { await inspection.close(); }
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it('refuses unknown queued work before setup or pending SQL and closes the runtime', async () => {
    const setup = vi.fn(() => ({}));
    const settings = await options([extension('probe', setup)]);
    const runtime = await createRuntime(settings);
    runtimes.push(runtime);
    await runtime.database.pool.query("INSERT INTO platform_jobs(id,type,payload,status) VALUES ($1,'unknown.work','{}','pending')", [randomUUID()]);
    await expect(runtime.migrate()).rejects.toThrow('unknown or disabled');
    expect(setup).not.toHaveBeenCalled();
    const inspection = new Database({ url: settings.config.database.url });
    try {
      expect((await inspection.pool.query('SELECT count(*)::int AS count FROM platform_release_history')).rows).toEqual([{ count: 0 }]);
      expect((await inspection.pool.query("SELECT to_regclass('platform_users') AS users")).rows).toEqual([{ users: null }]);
    } finally { await inspection.close(); }
  });

  it('defers setup until activation, requires migrate for a new release, and records successful setup once', async () => {
    const setup = vi.fn(() => ({}));
    const settings = await options([extension('probe', setup)]);
    const pending = await createRuntime(settings);
    runtimes.push(pending);
    expect(pending.activatedRelease).toBeNull();
    expect(setup).not.toHaveBeenCalled();
    expect(pending.extensions.list()).toEqual([]);
    expect((await pending.migrationStatus()).releaseCurrent).toBe(false);
    await expect(pending.activateRelease('require-current')).rejects.toThrow('requires the migrate command');
    expect(pending.activatedRelease).toBeNull();
    expect(setup).not.toHaveBeenCalled();
    expect(pending.database.pool.totalCount).toBe(0);
    const runtime = await createRuntime(settings);
    runtimes.push(runtime);
    expect(await runtime.migrate()).not.toEqual([]);
    expect(runtime.activatedRelease).toEqual({ id: 'test', version: '1.0.0' });
    expect(Object.isFrozen(runtime.activatedRelease)).toBe(true);
    expect(setup).toHaveBeenCalledTimes(1);
    expect(await runtime.migrate()).toEqual([]);
    expect((await runtime.migrationStatus()).releaseCurrent).toBe(true);
    expect((await runtime.database.pool.query('SELECT count(*)::int AS count FROM platform_release_history')).rows).toEqual([{ count: 1 }]);
    const restarted = await createRuntime(settings);
    runtimes.push(restarted);
    await restarted.activateRelease('require-current');
    expect(setup).toHaveBeenCalledTimes(2);
    expect((await runtime.database.pool.query('SELECT count(*)::int AS count FROM platform_release_history')).rows).toEqual([{ count: 1 }]);
  });

  it('requires declared extension job types before registering them and closes rejected setup resources', async () => {
    const runtime = await createRuntime(await options([]));
    runtimes.push(runtime);
    const close = vi.fn();
    const definition = extension('job-owner', () => ({
      jobs: [{ type: 'ext.job-owner.task', handler: async () => {} }], close,
    }));
    await expect(runtime.extensions.mount(definition, {})).rejects.toThrow('jobs mismatch');
    expect(close).toHaveBeenCalledTimes(1);
    expect(runtime.jobRegistry.types()).not.toContain('ext.job-owner.task');
    const declared = { ...definition, manifest: { ...definition.manifest, registeredJobs: ['ext.job-owner.task'] } };
    const mounted = await runtime.extensions.mount(declared, {});
    expect(mounted.jobs).toEqual(['ext.job-owner.task']);
    expect(runtime.jobRegistry.types()).toContain('ext.job-owner.task');
  });

  it('bridges signal and logical occurrence idempotency key into a mounted extension job', async () => {
    const runtime = await createRuntime(await options([]));
    runtimes.push(runtime);
    const seen: { occurrenceId?: string; idempotencyKey?: string; signal?: AbortSignal } = {};
    const type = 'ext.job-bridge.task';
    const definition = extension('job-bridge', () => ({
      jobs: [{
        type,
        jobContractV1: { currentVersion: 1, versions: { 1: z.object({}).strict() } },
        handler: async (_payload, ctx) => {
          seen.occurrenceId = ctx.occurrenceId;
          seen.idempotencyKey = ctx.idempotencyKey;
          seen.signal = ctx.signal;
        },
      }],
    }));
    const declared = { ...definition, manifest: { ...definition.manifest, registeredJobs: [type] } };
    await runtime.extensions.mount(declared, {});
    const occurrenceId = randomUUID();
    const controller = new AbortController();
    await runtime.jobRegistry.get(type)({}, {
      logger: noopLogger, attempt: 2, jobId: randomUUID(), occurrenceId, idempotencyKey: occurrenceId, signal: controller.signal,
    });
    expect(seen).toEqual({ occurrenceId, idempotencyKey: occurrenceId, signal: controller.signal });
  });

  it('authorizes extension mail and namespaces its local references', async () => {
    let firstContext: ExtensionContext | undefined;
    let secondContext: ExtensionContext | undefined;
    let deniedContext: ExtensionContext | undefined;
    const first = extension('mail-first', context => { firstContext = context; return {}; }, ['mail:send']);
    const second = extension('mail-second', context => { secondContext = context; return {}; }, ['mail:send']);
    const denied = extension('mail-denied', context => { deniedContext = context; return {}; });
    const runtime = await createRuntime(await options([first, second, denied]));
    runtimes.push(runtime);
    await runtime.migrate();
    const request = {
      reference: 'shared-report', to: [{ email: 'recipient@example.test' }],
      template: { id: 'report-ready', version: 1, subject: 'Report', text: 'Ready', html: '<p>Ready</p>' },
    };
    const [firstResult, secondResult] = await Promise.all([
      firstContext!.mail.enqueue(request), secondContext!.mail.enqueue(request),
    ]);
    expect(firstResult.reference).toBe('ext:mail-first:shared-report');
    expect(secondResult.reference).toBe('ext:mail-second:shared-report');
    await expect(deniedContext!.mail.enqueue(request)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const persisted = await runtime.database.pool.query('SELECT reference FROM public.platform_mail_messages ORDER BY reference');
    expect(persisted.rows).toEqual([
      { reference: 'ext:mail-first:shared-report' },
      { reference: 'ext:mail-second:shared-report' },
    ]);
  });

  it('cleans mounted extensions in reverse order after a later setup failure, then closes the live DB pool', async () => {
    const order: string[] = [];
    const settings = await options([
      extension('first', async ctx => { await ctx.store.set('open', true); return { close: () => { order.push('first'); } }; }),
      extension('second', () => ({ close: () => { order.push('second'); } })),
      extension('failure', () => { throw new Error('setup failed'); }),
    ]);
    const close = observeDatabaseClose(order);
    const runtime = await createRuntime(settings);
    await expect(runtime.migrate()).rejects.toThrow('setup failed');
    expect(order).toEqual(['second', 'first', 'database']);
    const closedDatabase = close.mock.contexts[0];
    expect(closedDatabase).toBeInstanceOf(Database);
    if (!(closedDatabase instanceof Database)) throw new Error('Database close was not observed');
    expect(closedDatabase.pool.totalCount).toBe(0);
    const inspection = new Database({ url: settings.config.database.url });
    try {
      expect((await inspection.pool.query('SELECT count(*)::int AS count FROM platform_release_history')).rows).toEqual([{ count: 0 }]);
      expect((await inspection.pool.query("SELECT id FROM platform_migrations WHERE migration_owner='identity' ORDER BY id")).rows)
        .toEqual([{ id: 'identity/0001_users_and_sessions' }, { id: 'identity/0003_password_resets' }]);
    } finally { await inspection.close(); }
  });

  it('cleans a returned registration when manifest validation fails before mount completes', async () => {
    const order: string[] = [];
    const invalid = extension('invalid', () => ({
      events: [{ event: 'undeclared', handler: async () => {} }], close: () => { order.push('invalid'); },
    }));
    const settings = await options([invalid]);
    observeDatabaseClose(order);
    const runtime = await createRuntime(settings);
    await expect(runtime.migrate()).rejects.toThrow('mismatch');
    expect(order).toEqual(['invalid', 'database']);
  });

  it('attempts all resources despite cleanup errors and closes each only once', async () => {
    const order: string[] = [];
    const settings = await options([
      extension('first', () => ({ close: () => { order.push('first'); } })),
      extension('second', () => ({ close: () => { order.push('second'); throw new Error('close failed'); } })),
    ]);
    const runtime = await createRuntime(settings);
    runtimes.push(runtime);
    await runtime.migrate();
    observeDatabaseClose(order);
    const firstClose = runtime.close();
    expect(runtime.close()).toBe(firstClose);
    await expect(firstClose).rejects.toBeInstanceOf(AggregateError);
    await expect(runtime.close()).rejects.toBeInstanceOf(AggregateError);
    expect(order).toEqual(['second', 'first', 'database']);
  });

  it('waits for a concurrent mount before closing and rejects later mounts', async () => {
    const runtime = await createRuntime(await options([]));
    runtimes.push(runtime);
    let complete!: (value: ExtensionRegistration) => void;
    const closed = vi.fn();
    const mounting = runtime.extensions.mount(extension('pending', () => new Promise(resolve => { complete = resolve; })), {});
    const closing = runtime.extensions.close();
    complete({ close: closed });
    await mounting;
    await closing;
    expect(closed).toHaveBeenCalledTimes(1);
    await expect(runtime.extensions.mount(extension('late', () => ({})), {})).rejects.toThrow('closing');
  });
});


describe('HTTP initialization cleanup', () => {
  it('rejects controller construction failure instead of aborting the process and closes its adapter', async () => {
    const runtime = await createRuntime(await options([]));
    runtimes.push(runtime);
    class BrokenController { constructor() { throw new Error('controller construction failed'); } }
    Controller('broken')(BrokenController);
    const close = vi.spyOn(FastifyAdapter.prototype, 'close');
    await expect(createReleaseServer({ runtime,
      release: { version: 'test', configPath: '<test>' },
      httpAdapter: { releaseId: 'test', anonymousRole: null, controllers: () => [BrokenController], startSession: async () => null },
    })).rejects.toThrow('controller construction failed');
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('runs destroy hooks and closes the adapter after app.init fails', async () => {
    const runtime = await createRuntime(await options([]));
    runtimes.push(runtime);
    const destroy = vi.fn();
    class BrokenInit {
      onModuleInit() { throw new Error('app initialization failed'); }
      onModuleDestroy() { destroy(); }
    }
    Controller('broken-init')(BrokenInit);
    const close = vi.spyOn(FastifyAdapter.prototype, 'close');
    await expect(createReleaseServer({ runtime,
      release: { version: 'test', configPath: '<test>' },
      httpAdapter: { releaseId: 'test', anonymousRole: null, controllers: () => [BrokenInit], startSession: async () => null },
    })).rejects.toThrow('app initialization failed');
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
  });
});
