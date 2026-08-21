import {
  PLATFORM_VERSION, PlatformError, SYSTEM_ACTOR,
  type Actor, type Logger,
} from '@storeweave/contracts';
import { Database, platformMigrations, runMigrations, migrationStatus, type MigrationSet } from '@storeweave/db';
import { AuthorizationService, permissionsForRole } from '@storeweave/authorization';
import { AuditWriter } from '@storeweave/audit';
import { OutboxStore } from '@storeweave/outbox';
import { JobQueue } from '@storeweave/jobs';
import { EventBus } from '@storeweave/event-bus';
import { CommandBus } from '@storeweave/command-bus';
import { QueryBus } from '@storeweave/query-bus';
import { ProviderRegistry, type ExtensionDefinition } from '@storeweave/extension-sdk';
import type { CommerceConfig, SecretProvider } from '@storeweave/config';
import { ExtensionHost, type MountedExtension } from './extension-host';
import { JobRegistry } from './job-registry';
import { McpToolRegistry } from './mcp-registry';
import { EVENT_DELIVERY_JOB, createEventDeliveryHandler } from './event-delivery';
import type { PlatformModule } from './module';
import { createOpsModule } from './ops-module';

export interface RuntimeOptions {
  config: CommerceConfig;
  secrets: SecretProvider;
  logger: Logger;
  modules: readonly PlatformModule[];
  /** 建置時就編進 Release 的 Extension 目錄；設定檔只能啟用其中存在的項目。 */
  availableExtensions: Record<string, ExtensionDefinition<any>>;
  /** 由呼叫端先建立，讓 Core 模組（例如 order）可以在組裝前就拿到同一個實例。 */
  providers?: ProviderRegistry;
  platformVersion?: string;
}

export interface Runtime {
  readonly config: CommerceConfig;
  readonly secrets: SecretProvider;
  readonly logger: Logger;
  readonly database: Database;
  readonly authorization: AuthorizationService;
  readonly audit: AuditWriter;
  readonly outbox: OutboxStore;
  readonly jobs: JobQueue;
  readonly jobRegistry: JobRegistry;
  readonly events: EventBus;
  readonly commands: CommandBus;
  readonly queries: QueryBus;
  readonly providers: ProviderRegistry;
  readonly mcpTools: McpToolRegistry;
  readonly extensions: ExtensionHost;
  readonly migrations: readonly MigrationSet[];
  readonly platformVersion: string;
  actorForRole(role: string, id?: string): Actor;
  migrate(): Promise<string[]>;
  migrationStatus(): ReturnType<typeof migrationStatus>;
  close(): Promise<void>;
}

/**
 * 組裝整個平台。API、Worker、CLI 都呼叫這個函式，因此三者行為必然一致。
 */
export async function createRuntime(options: RuntimeOptions): Promise<Runtime> {
  const { config, logger, secrets } = options;
  const platformVersion = options.platformVersion ?? PLATFORM_VERSION;

  const database = new Database({
    url: config.database.url,
    poolSize: config.database.poolSize,
    ssl: config.database.ssl,
  });
  const authorization = new AuthorizationService();
  const audit = new AuditWriter();
  const outbox = new OutboxStore();
  const jobs = new JobQueue();
  const jobRegistry = new JobRegistry();
  const events = new EventBus();
  const providers = options.providers ?? new ProviderRegistry(logger);
  const mcpTools = new McpToolRegistry();

  const commands = new CommandBus({ database, authorization, audit, outbox, jobs, events, logger });
  const queries = new QueryBus({ database, authorization, logger });

  const migrations: MigrationSet[] = [platformMigrations];

  // 平台自身的維運模組永遠在，與這個 Release 編進哪些產品模組無關。
  const allModules: readonly PlatformModule[] = [createOpsModule(jobs), ...options.modules];

  for (const mod of allModules) {
    if (mod.migrations) migrations.push(mod.migrations);
    authorization.permissions.registerMany(mod.permissions ?? []);
    events.registerEvents(mod.events ?? []);
  }
  // 權限全部註冊完才註冊 command/query，避免順序依賴
  for (const mod of allModules) {
    for (const c of mod.commands ?? []) commands.register(c.descriptor, c.handler, mod.name);
    for (const q of mod.queries ?? []) queries.register(q.descriptor, q.handler, mod.name);
    for (const j of mod.jobs ?? []) jobRegistry.register(j.type, j.handler, mod.name);
    for (const p of mod.policies ?? []) authorization.policies.register(p);
  }

  jobRegistry.register(EVENT_DELIVERY_JOB, createEventDeliveryHandler(events, logger), 'platform');

  const extensions = new ExtensionHost({
    database, commandBus: commands, queryBus: queries, eventBus: events,
    jobs, jobRegistry, providers, mcpTools, authorization, secrets, logger, platformVersion,
  });

  for (const entry of config.extensions) {
    if (!entry.enabled) {
      logger.info({ extension: entry.id }, 'extension disabled by configuration');
      continue;
    }
    const definition = options.availableExtensions[entry.id];
    if (!definition) {
      throw PlatformError.validation(
        `Extension "${entry.id}" is enabled in commerce.yaml but not present in this release. ` +
        `Available: ${Object.keys(options.availableExtensions).join(', ') || '(none)'}`,
      );
    }
    await extensions.mount(definition, entry.config);
  }

  return {
    config, secrets, logger, database, authorization, audit, outbox, jobs, jobRegistry,
    events, commands, queries, providers, mcpTools, extensions, migrations, platformVersion,
    actorForRole(role, id) {
      if (role === 'system') return SYSTEM_ACTOR;
      const permissions = permissionsForRole(role);
      if (permissions.length === 0) throw PlatformError.validation(`Unknown role "${role}"`);
      return { id: id ?? `role:${role}`, type: 'service', displayName: role, permissions };
    },
    async migrate() {
      return runMigrations(database.db, migrations, (msg) => logger.info({ migration: msg }, 'migration'));
    },
    migrationStatus() {
      return migrationStatus(database.db, migrations);
    },
    async close() {
      await database.close();
    },
  };
}

export type { MountedExtension };
