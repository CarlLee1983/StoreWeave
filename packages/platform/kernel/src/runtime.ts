import { closeInReverse, withCleanupDeadline } from './lifecycle';
import {
  PLATFORM_VERSION, PlatformError, SYSTEM_ACTOR,
  type Actor, type Logger,
} from '@storeweave/contracts';
import { Database, platformMigrations, prepareRelease, recordEffectiveRelease, releaseMigrationStatus, withReleaseSnapshot, type ReleaseSnapshot, type ReleaseSelection, type MigrationSet } from '@storeweave/db';
import { AuthorizationService, roleFor, type ReleaseRoleCatalog } from '@storeweave/authorization';
import { AuditWriter } from '@storeweave/audit';
import { OutboxStore } from '@storeweave/outbox';
import { JobQueue } from '@storeweave/jobs';
import { RecurringScheduler } from './recurring';
import { EventBus } from '@storeweave/event-bus';
import { CommandBus } from '@storeweave/command-bus';
import { QueryBus } from '@storeweave/query-bus';
import { ProviderRegistry, type ExtensionDefinition } from '@storeweave/extension-sdk';
import type { BaseConfig, SecretProvider } from '@storeweave/config';
import { ExtensionHost, type MountedExtension } from './extension-host';
import { JobRegistry } from './job-registry';
import { McpToolRegistry } from './mcp-registry';
import { EVENT_DELIVERY_JOB, createEventDeliveryHandler } from './event-delivery';
import type { PlatformModule } from './module';
import { createOpsModule } from './ops-module';
import { AuthService, createIdentityModule } from '@storeweave/identity';
import { validateModuleGraph } from './module-graph';
import packageJson from '../package.json';
import { projectModulePins, projectExtensionPin } from './release-pins';


export interface RuntimeOptions<C extends BaseConfig = BaseConfig> {
  roles: ReleaseRoleCatalog;
  release: { id: string; version: string; buildManifestChecksum: string };
  config: C;
  secrets: SecretProvider;
  logger: Logger;
  modules: readonly PlatformModule[];
  /** 建置時就編進 Release 的 Extension 目錄；設定檔只能啟用其中存在的項目。 */
  availableExtensions: Record<string, ExtensionDefinition<any>>;
  /** 由呼叫端先建立，讓 Core 模組（例如 order）可以在組裝前就拿到同一個實例。 */
  providers?: ProviderRegistry;
  platformVersion?: string;
}

export interface Runtime<C extends BaseConfig = BaseConfig> {
  readonly roles: ReleaseRoleCatalog;
  readonly config: C;
  readonly secrets: SecretProvider;
  readonly logger: Logger;
  readonly database: Database;
  readonly authorization: AuthorizationService;
  /** 後台操作者的登入與 session 解析。認證發生在 Actor 存在之前，因此不走 Command Bus。 */
  readonly auth: AuthService;
  readonly audit: AuditWriter;
  readonly outbox: OutboxStore;
  readonly jobs: JobQueue;
  readonly jobRegistry: JobRegistry;
  /** 週期性工作的登記處；Worker 每一輪據此確保當下這個切片已排入。 */
  readonly recurring: RecurringScheduler;
  readonly events: EventBus;
  readonly commands: CommandBus;
  readonly queries: QueryBus;
  readonly providers: ProviderRegistry;
  readonly mcpTools: McpToolRegistry;
  readonly extensions: ExtensionHost;
  readonly migrations: readonly MigrationSet[];
  readonly platformVersion: string;
  readonly modules: readonly PlatformModule[];
  /** The release successfully recorded for this runtime, or null before activation. */
  readonly activatedRelease: Readonly<{ readonly id: string; readonly version: string }> | null;
  actorForRole(role: string, id?: string): Actor;
  migrate(): Promise<string[]>;
  activateRelease(mode: 'apply' | 'require-current'): Promise<readonly string[]>;
  migrationStatus(): ReturnType<typeof releaseMigrationStatus>;
  withReleaseSnapshot<T>(dump: (snapshot: ReleaseSnapshot) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/** Pure composition shared by runtime and release metadata projection; no handlers execute here. */
export function composeRuntimeModules({ modules, roles, logger, platformVersion, jobs, events }: {
  modules: readonly PlatformModule[];
  roles: ReleaseRoleCatalog;
  logger: Logger;
  platformVersion: string;
  jobs: JobQueue;
  events: EventBus;
}): readonly PlatformModule[] {
  const platformModule: PlatformModule = {
    name: 'platform', version: packageJson.version, baseVersionRange: '^1.0.0',
    migrations: platformMigrations,
    data: { owns: [
      'platform_migrations', 'platform_migration_baselines', 'platform_release_history', 'platform_outbox', 'platform_jobs', 'platform_idempotency',
      'platform_audit_log', 'platform_extension_state', 'platform_extension_registry', 'platform_worker_heartbeat',
    ] },
    jobs: [{ type: EVENT_DELIVERY_JOB, handler: createEventDeliveryHandler(events, logger) }],
  };
  return validateModuleGraph(
    [platformModule, createOpsModule(jobs), createIdentityModule(roles), ...modules], platformVersion,
  );
}

/**
 * 組裝整個平台。API、Worker、CLI 都呼叫這個函式，因此三者行為必然一致。
 */
export async function createRuntime<C extends BaseConfig>(options: RuntimeOptions<C>): Promise<Runtime<C>> {
  const { config, logger, secrets } = options;
  const platformVersion = options.platformVersion ?? PLATFORM_VERSION;
  for (const token of config.auth.tokens) {
    if (!roleFor(options.roles, token.role)?.tokenAllowed) {
      throw PlatformError.validation(`Role "${token.role}" cannot be used by an API token in this release`);
    }
  }


  const jobs = new JobQueue();
  const events = new EventBus();
  const allModules = composeRuntimeModules({ modules: options.modules, roles: options.roles, logger, platformVersion, jobs, events });
  const enabled = config.extensions.filter(entry => entry.enabled).map(entry => {
    const definition = options.availableExtensions[entry.id];
    if (!definition || definition.manifest.id !== entry.id) {
      throw PlatformError.validation(`Extension "${entry.id}" is enabled but not present in this release`);
    }
    return { definition, config: entry.config, pin: projectExtensionPin(definition, platformVersion) };
  });
  const selection: ReleaseSelection = {
    releaseId: options.release.id, releaseVersion: options.release.version, baseVersion: platformVersion,
    buildManifestChecksum: options.release.buildManifestChecksum,
    activeOwners: [...projectModulePins(allModules), ...enabled.map(entry => entry.pin)],
  };
  const database = new Database({
    url: config.database.url,
    poolSize: config.database.poolSize,
    ssl: config.database.ssl,
  });
  let extensions: ExtensionHost | undefined;
  let closing: Promise<void> | undefined;
  const close = () => closing ??= withCleanupDeadline(config.shutdown.timeoutMs,
    () => closeInReverse([() => database.close(), () => extensions?.close()]));
  try {
    const authorization = new AuthorizationService();
    const auth = new AuthService({
      operatorMs: config.auth.sessionTtlMinutes.operator * 60_000,
      customerMs: config.auth.sessionTtlMinutes.customer * 60_000,
    }, options.roles);
    const audit = new AuditWriter();
    const outbox = new OutboxStore();
    const jobRegistry = new JobRegistry();
    const recurring = new RecurringScheduler({ jobs, database, logger });
    const providers = options.providers ?? new ProviderRegistry(logger);
    const mcpTools = new McpToolRegistry();

    const commands = new CommandBus({ database, authorization, audit, outbox, jobs, events, logger });
    const queries = new QueryBus({ database, authorization, logger });

    const migrations: MigrationSet[] = [];

    for (const mod of allModules) {
      if (mod.migrations) migrations.push(mod.migrations);
      authorization.permissions.registerMany(mod.permissions ?? []);
      events.registerEvents(mod.events ?? []);
    }
    // 權限全部註冊完才註冊 command/query，避免順序依賴
    for (const mod of allModules) {
      for (const c of mod.commands ?? []) commands.register(c.descriptor, c.handler, mod.name);
      for (const q of mod.queries ?? []) queries.register(q.descriptor, q.handler, mod.name);
      for (const j of mod.jobs ?? []) {
        jobRegistry.register(j.type, j.handler, mod.name);
        if (j.schedule) recurring.register({ type: j.type, everyMs: j.schedule.everyMs });
      }
      for (const p of mod.policies ?? []) authorization.policies.register(p);
      for (const sub of mod.subscribers ?? []) {
        events.subscribe({
          subscriberId: mod.name, eventName: sub.eventName, maxAttempts: sub.maxAttempts,
          handler: (event, ctx) => sub.handler(event, {
            ...ctx,
            executeCommand: ctx.executeCommand && (async (name, input, idempotencyKey) => {
              const target = commands.get(name);
              if (target.owner !== mod.name && !sub.commands?.some((grant) =>
                grant.from === target.owner && grant.name === name && grant.version === target.descriptor.version)) {
                throw PlatformError.forbidden(`Module "${mod.name}" cannot execute command "${name}" owned by "${target.owner}"`);
              }
              return ctx.executeCommand!(name, input, idempotencyKey);
            }),
          }),
        });
      }
    }

    extensions = new ExtensionHost({
      database, commandBus: commands, queryBus: queries, eventBus: events,
      jobs, jobRegistry, providers, mcpTools, authorization, secrets, logger, platformVersion,
    });

    const host = extensions;
    let activation: Promise<readonly string[]> | undefined;
    let activatedRelease: Readonly<{ readonly id: string; readonly version: string }> | null = null;

    const runtime: Runtime<C> = {
      roles: options.roles, config, secrets, logger, database, authorization, auth, audit, outbox, jobs, jobRegistry, recurring,
      events, commands, queries, providers, mcpTools, extensions, migrations, platformVersion, modules: allModules,
      get activatedRelease() { return activatedRelease; },
      actorForRole(role, id) {
        if (role === 'system') return SYSTEM_ACTOR;
        const permissions = roleFor(options.roles, role)?.permissions ?? [];
        if (permissions.length === 0) throw PlatformError.validation(`Unknown role "${role}"`);
        return { id: id ?? `role:${role}`, type: 'service', displayName: role, permissions };
      },
      activateRelease(mode) {
        if (mode !== 'apply' && mode !== 'require-current') return Promise.reject(new Error('Invalid release activation mode'));
        if (closing) return Promise.reject(new Error('Runtime is closing'));
        return activation ??= (async () => {
          try {
            const prepared = await prepareRelease(database.pool, selection, migrations, mode,
              msg => logger.info({ migration: msg }, 'migration'));
            for (const entry of enabled) await host.mount(entry.definition, entry.config);
            const actual = { ...prepared.manifest, owners: prepared.manifest.owners.map(entry => {
              if (entry.state !== 'active' || entry.owner.kind !== 'extension') return entry;
              const mounted = host.list().find(extension => extension.id === entry.owner.id);
              if (!mounted) throw new Error(`Configured extension was not mounted: ${entry.owner.id}`);
              return { ...entry, owner: { ...entry.owner, version: mounted.version, work: {
                ...entry.owner.work, jobTypes: [...mounted.jobs].sort(),
                subscriberIds: mounted.subscribedEvents.length ? [mounted.id] : [],
                subscribedEventNames: [...mounted.subscribedEvents].sort(),
              } } };
            }) };
            if (closing) throw new Error('Runtime closed during activation');
            await recordEffectiveRelease(database.pool, prepared, actual, host.list().map(extension => ({
              id: extension.id, name: extension.name, version: extension.version,
              platformVersion: extension.platformVersion, permissions: [...new Set(extension.permissions)].sort(),
            })));
            activatedRelease = Object.freeze({ id: actual.releaseId, version: actual.releaseVersion });
            return prepared.appliedMigrations;
          } catch (error) {
            try { await runtime.close(); }
            catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Runtime activation and cleanup failed'); }
            throw error;
          }
        })();
      },
      async migrate() {
        if (closing) throw new Error('Runtime is closing');
        if (activation) { await activation; return []; }
        return [...await runtime.activateRelease('apply')];
      },
      migrationStatus() {
        return releaseMigrationStatus(database.pool, selection, migrations);
      },
      withReleaseSnapshot(dump) {
        if (closing) throw new Error('Runtime is closing');
        return withReleaseSnapshot(database.pool, selection, migrations, dump);
      },
      close,
    };
    return runtime;
  } catch (error) {
    try { await close(); }
    catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Runtime initialization and cleanup failed'); }
    throw error;
  }
}

export type { MountedExtension };
