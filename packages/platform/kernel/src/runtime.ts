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
import { EVENT_DELIVERY_JOB, createEventDeliveryHandler, eventDeliveryJobContract } from './event-delivery';
import type { PlatformModule } from './module';
import { createOpsModule, OPS_MODULE_NAME } from './ops-module';
import { ApiTokenService, AuthService, IdentityTokenService, MfaService, createIdentityModule, type IdentityCleanupDeps } from '@storeweave/identity';
import { validateModuleGraph } from './module-graph';
import { requireKeyring, resolveKeyring } from './keyring';
import type { Keyring } from '@storeweave/crypto';
import { createHash } from 'node:crypto';
import { cacheMigrations, PostgresCacheManager, PostgresMutexManager, type CacheScope, type MutexScope } from '@storeweave/cache';
import { LocalObjectStore, S3ObjectStore, StorageManager, storageMigrations, type StorageScope } from '@storeweave/storage';
import { MEDIA_NAMESPACE, MEDIA_ORPHAN_CLEANUP_JOB, MEDIA_PROCESS_JOB, MediaService, mediaMigrations, mediaOrphanCleanupPayload, mediaProcessPayload } from '@storeweave/media';
import { MailService, createMailJob, MAIL_SEND_JOB, mailMigrations, mailSendJobPayload } from '@storeweave/mail';
import {
  NOTIFICATION_DELIVER_JOB, NotificationService, createListDeliveriesHandler, createListInboxHandler,
  createMarkInboxReadHandler, createNotificationDeliverJob, createSendNotificationHandler, listDeliveriesQuery,
  listInboxQuery, markInboxReadCommand, notificationDeliverJobPayload, notificationsMigrations, sendNotificationCommand,
} from '@storeweave/notifications';
import packageJson from '../package.json';
import { projectModulePins, projectExtensionPin } from './release-pins';
import { join } from 'node:path';
import type { PoolClient } from 'pg';


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
  /**
   * Composition-only injection seam for modules that need cache/mutex. Each
   * binding receives scopes fixed to its declared module id, never a manager.
   */
  cacheBindings?: readonly ModuleCacheBinding[];
  /** Composition-only storage scopes for modules that declare stored-object ownership. */
  storageBindings?: readonly ModuleStorageBinding[];
  platformVersion?: string;
}

export interface ModuleCacheScopes {
  readonly cache: CacheScope;
  readonly mutex: MutexScope;
}

export interface ModuleCacheBinding {
  readonly module: string;
  bind(scopes: ModuleCacheScopes): void;
}

export interface ModuleStorageBinding {
  readonly module: string;
  bind(scope: StorageScope): void;
}

/** Module ids are not length-limited, while persisted cache namespaces deliberately are. */
function cacheNamespaceForModule(module: string): string {
  return `m-${createHash('sha256').update(module, 'utf8').digest('hex').slice(0, 62)}`;
}

export interface Runtime<C extends BaseConfig = BaseConfig> {
  readonly roles: ReleaseRoleCatalog;
  readonly config: C;
  readonly secrets: SecretProvider;
  /** 簽章金鑰環。未設定 `security.signingKeys` 的 release 沒有這個能力。 */
  readonly keyring?: Keyring;
  readonly logger: Logger;
  readonly database: Database;
  readonly authorization: AuthorizationService;
  /** 後台操作者的登入與 session 解析。認證發生在 Actor 存在之前，因此不走 Command Bus。 */
  readonly auth: AuthService;
  /** 機器對機器的 bearer token：資料庫擁有，可到期可撤銷（ADR 0043）。 */
  readonly apiTokens: ApiTokenService;
  /** 高權限帳號的第二因素（TOTP＋一次性復原碼，ADR 0044）。 */
  readonly mfa: MfaService;
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
  readonly storage: StorageManager;
  /** Image identity, processing, references, and deletion policy; B09 keeps byte ownership. */
  readonly media: MediaService;
  /** Base mail capability. SMTP is disabled unless explicitly configured. */
  readonly mail: MailService;
  /** Base notification capability: generic recipients, per-channel delivery evidence. */
  readonly notifications: NotificationService;
  readonly migrations: readonly MigrationSet[];
  readonly platformVersion: string;
  readonly modules: readonly PlatformModule[];
  /** The release successfully recorded for this runtime, or null before activation. */
  readonly activatedRelease: Readonly<{ readonly id: string; readonly version: string }> | null;
  actorForRole(role: string, id?: string): Actor;
  migrate(): Promise<string[]>;
  activateRelease(mode: 'apply' | 'require-current'): Promise<readonly string[]>;
  migrationStatus(): ReturnType<typeof releaseMigrationStatus>;
  /**
   * Runs the callback under the same exported, read-only PostgreSQL snapshot
   * used by the release dump.  Operational captures may use the client to
   * enumerate metadata that must agree with that dump (for example storage
   * objects); they must not write through it.
   */
  withReleaseSnapshot<T>(dump: (snapshot: ReleaseSnapshot, client: PoolClient) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/** Pure composition shared by runtime and release metadata projection; no handlers execute here. */
export function composeRuntimeModules({ modules, roles, logger, platformVersion, jobs, events, outbox, scheduler, cache, media, mail, notifications, identityCleanup }: {
  modules: readonly PlatformModule[];
  roles: ReleaseRoleCatalog;
  logger: Logger;
  platformVersion: string;
  jobs: JobQueue;
  events: EventBus;
  outbox: OutboxStore;
  scheduler: () => RecurringScheduler;
  cache?: () => CacheScope;
  media?: () => MediaService | undefined;
  /** Deferred because module metadata is composed before runtime resources exist. */
  mail?: () => MailService | undefined;
  notifications?: () => NotificationService | undefined;
  identityCleanup?: () => IdentityCleanupDeps | undefined;
}): readonly PlatformModule[] {
  const platformModule: PlatformModule = {
    name: 'platform', version: packageJson.version, baseVersionRange: '^1.0.0',
    migrations: platformMigrations,
    data: { owns: [
      'platform_migrations', 'platform_migration_baselines', 'platform_release_history', 'platform_outbox', 'platform_jobs', 'platform_idempotency',
      'platform_audit_log', 'platform_extension_state', 'platform_extension_registry', 'platform_worker_heartbeat', 'platform_job_quarantine',
      'platform_outbox_quarantine', 'platform_outbox_quarantine_audit', 'platform_job_schedules',
    ] },
    jobs: [{ type: EVENT_DELIVERY_JOB, handler: createEventDeliveryHandler(events, logger), jobContractV1: eventDeliveryJobContract }],
  };
  const cacheModule: PlatformModule = {
    name: 'platform-cache', version: packageJson.version, baseVersionRange: '^1.0.0',
    migrations: cacheMigrations, data: { owns: ['platform_cache'] },
  };
  const storageModule: PlatformModule = {
    name: 'platform-storage', version: packageJson.version, baseVersionRange: '^1.0.0',
    migrations: storageMigrations, data: { owns: ['platform_storage_objects'] },
    permissions: [
      { key: 'storage:read', description: 'Read stored objects', owner: 'platform-storage' },
      { key: 'storage:write', description: 'Upload stored objects', owner: 'platform-storage' },
      { key: 'storage:delete', description: 'Delete stored objects', owner: 'platform-storage' },
      { key: 'storage:share', description: 'Issue signed download URLs', owner: 'platform-storage' },
      { key: 'storage:publish', description: 'Publish objects for unauthenticated download', owner: 'platform-storage' },
    ],
  };
  const mediaModule: PlatformModule = {
    name: 'platform-media', version: packageJson.version, baseVersionRange: '^1.0.0',
    dependencies: { required: [{ name: 'platform-storage', versionRange: '^0.1.0' }] },
    migrations: mediaMigrations,
    data: { owns: ['platform_media_assets', 'platform_media_references'] },
    permissions: [
      { key: 'media:read', description: 'Read media library metadata and previews', owner: 'platform-media' },
      { key: 'media:write', description: 'Upload and update media library assets', owner: 'platform-media' },
      { key: 'media:delete', description: 'Delete unreferenced media library assets', owner: 'platform-media' },
    ],
    jobs: [
      { type: MEDIA_PROCESS_JOB, handler: async (payload, ctx) => {
        const service = media?.();
        if (!service) throw new Error('Media service is not ready');
        await service.process(mediaProcessPayload.parse(payload), ctx);
      }, jobContractV1: {
        currentVersion: 1, versions: { 1: mediaProcessPayload },
        execution: { timeoutMs: 45_000, concurrencyKey: 'platform-media-processing', concurrencyLimit: 2 },
      } },
      { type: MEDIA_ORPHAN_CLEANUP_JOB, handler: async (payload) => {
        mediaOrphanCleanupPayload.parse(payload);
        const service = media?.();
        if (!service) throw new Error('Media service is not ready');
        await service.cleanup();
      }, schedule: { everyMs: 24 * 60 * 60 * 1_000, overlap: 'skip' }, jobContractV1: {
        currentVersion: 1, versions: { 1: mediaOrphanCleanupPayload },
        execution: { timeoutMs: 60_000, concurrencyKey: 'platform-media-cleanup', concurrencyLimit: 1 },
      } },
    ],
  };
  const mailModule: PlatformModule = {
    name: 'platform-mail', version: packageJson.version, baseVersionRange: '^1.0.0',
    dependencies: { required: [{ name: 'platform', versionRange: '^0.1.0' }, { name: 'platform-storage', versionRange: '^0.1.0' }] },
    migrations: mailMigrations, data: { owns: ['platform_mail_messages'] },
    permissions: [{ key: 'mail:send', description: 'Send mail through the configured base transport', owner: 'platform-mail' }],
    jobs: [{ type: MAIL_SEND_JOB, handler: createMailJob(mail ?? (() => undefined)),
      jobContractV1: { currentVersion: 1, versions: { 1: mailSendJobPayload }, execution: { timeoutMs: 60_000, concurrencyKey: 'platform-mail-smtp', concurrencyLimit: 4 } } }],
  };
  const notificationsService = notifications ?? (() => undefined);
  const notificationsModule: PlatformModule = {
    name: 'platform-notifications', version: packageJson.version, baseVersionRange: '^1.0.0',
    dependencies: { required: [{ name: 'platform', versionRange: '^0.1.0' }, { name: 'platform-mail', versionRange: '^0.1.0' }] },
    migrations: notificationsMigrations, data: { owns: ['platform_notifications', 'platform_notification_deliveries'] },
    permissions: [
      { key: 'notifications:send', description: 'Create notifications through the base capability', owner: 'platform-notifications' },
      { key: 'notifications:inbox', description: 'Read and mark your own in-app notifications', owner: 'platform-notifications' },
      { key: 'notifications:read', description: 'Read masked notification delivery evidence', owner: 'platform-notifications' },
    ],
    commands: [
      { descriptor: sendNotificationCommand, handler: createSendNotificationHandler(notificationsService) },
      { descriptor: markInboxReadCommand, handler: createMarkInboxReadHandler(notificationsService) },
    ],
    queries: [
      { descriptor: listInboxQuery, handler: createListInboxHandler(notificationsService) },
      { descriptor: listDeliveriesQuery, handler: createListDeliveriesHandler(notificationsService) },
    ],
    jobs: [{ type: NOTIFICATION_DELIVER_JOB, handler: createNotificationDeliverJob(notificationsService),
      jobContractV1: { currentVersion: 1, versions: { 1: notificationDeliverJobPayload }, execution: { timeoutMs: 60_000, concurrencyKey: 'platform-mail-smtp', concurrencyLimit: 4 } } }],
  };
  return validateModuleGraph(
    [platformModule, cacheModule, storageModule, mediaModule, mailModule, notificationsModule, createOpsModule(jobs, {
      events, outbox, scheduler,
      cache: cache ?? (() => { throw new Error('Cache scope is not configured'); }),
    }), createIdentityModule(roles, identityCleanup ?? (() => undefined)), ...modules], platformVersion,
  );
}

/**
 * 組裝整個平台。API、Worker、CLI 都呼叫這個函式，因此三者行為必然一致。
 */
export async function createRuntime<C extends BaseConfig>(options: RuntimeOptions<C>): Promise<Runtime<C>> {
  const { config, logger, secrets } = options;
  const platformVersion = options.platformVersion ?? PLATFORM_VERSION;


  // 宣告了金鑰卻讀不到秘密要在這裡就失敗，不要等到第一個簽章請求。
  const keyring = resolveKeyring(config, secrets);

  const jobs = new JobQueue();
  jobs.setRetentionPolicy({
    completedPayloadRetentionDays: config.worker.completedPayloadRetentionDays,
    cancelledPayloadRetentionDays: config.worker.cancelledPayloadRetentionDays,
    dedupeHorizonDays: config.worker.dedupeHorizonDays,
  });
  const events = new EventBus();
  const outbox = new OutboxStore();
  // 排程器要等資料庫建立後才生得出來，但模組組裝在那之前就得完成（Release 選取需要模組清單）。
  let scheduler: RecurringScheduler | undefined;
  let opsCache: ModuleCacheScopes | undefined;
  let mail: MailService | undefined;
  let media: MediaService | undefined;
  let notifications: NotificationService | undefined;
  let identityCleanupDeps: IdentityCleanupDeps | undefined;
  const allModules = composeRuntimeModules({
    modules: options.modules, roles: options.roles, logger, platformVersion, jobs, events, outbox,
    scheduler: () => {
      if (!scheduler) throw new Error('Scheduler is not ready yet');
      return scheduler;
    },
    cache: () => {
      if (!opsCache) throw new Error('Cache scope is not ready yet');
      return opsCache.cache;
    },
    media: () => media,
    mail: () => mail,
    notifications: () => notifications,
    identityCleanup: () => identityCleanupDeps,
  });
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
  const cache = new PostgresCacheManager(database.pool, {
    cleanupBatchSize: config.cache.cleanupBatchSize,
    cleanupIntervalMs: config.cache.cleanupIntervalMs,
    onCleanupError: error => logger.warn({ error: error instanceof Error ? error.message : String(error) }, 'cache cleanup failed'),
  });
  const objectStore = config.storage.driver === 'local'
    ? new LocalObjectStore({ root: config.storage.localRoot ?? join(config.paths.dataDir, 'storage') })
    : (() => {
      const settings = config.storage.s3!;
      const accessKeyId = secrets.get(settings.accessKeyIdRef);
      const secretAccessKey = secrets.get(settings.secretAccessKeyRef);
      if (!accessKeyId || !secretAccessKey) {
        throw PlatformError.validation('S3 storage credentials are not available from the configured secret provider');
      }
      return new S3ObjectStore({
        bucket: settings.bucket, region: settings.region, endpoint: settings.endpoint,
        forcePathStyle: settings.forcePathStyle, prefix: settings.prefix,
        credentials: { accessKeyId, secretAccessKey },
      });
    })();
  const storage = new StorageManager(database.pool, objectStore, config.storage.maxUploadBytes);
  media = new MediaService(database, storage.forNamespace(MEDIA_NAMESPACE), jobs);
  mail = new MailService(database, jobs, storage, config, secrets, logger);
  notifications = new NotificationService(database, mail, logger, (tx, job) => jobs.enqueue(tx, job));
  const mutex = new PostgresMutexManager({
    url: config.database.url, ssl: config.database.ssl, poolSize: config.cache.mutexPoolSize,
    connectionTimeoutMs: Math.min(config.cache.mutexConnectionTimeoutMs, Math.max(1, Math.floor(config.shutdown.timeoutMs / 2))),
    retryIntervalMs: config.cache.lockRetryIntervalMs,
    onIdleError: error => logger.warn({ error: error.message }, 'mutex idle connection failed'),
  });
  let extensions: ExtensionHost | undefined;
  let closing: Promise<void> | undefined;
  const close = () => closing ??= withCleanupDeadline(config.shutdown.timeoutMs,
    () => closeInReverse([() => database.close(), () => cache.close(), () => storage.close(), () => mail?.close(), () => mutex.close(), () => extensions?.close()]));
  try {
    const moduleNames = new Set(allModules.map(module => module.name));
    const boundModules = new Set<string>();
    const boundNamespaces = new Set<string>();
    const cacheBindings: readonly ModuleCacheBinding[] = [
      { module: OPS_MODULE_NAME, bind: scopes => { opsCache = scopes; } },
      ...(options.cacheBindings ?? []),
    ];
    for (const binding of cacheBindings) {
      if (!moduleNames.has(binding.module)) throw PlatformError.validation(`Cache binding targets unknown module "${binding.module}"`);
      if (boundModules.has(binding.module)) throw PlatformError.validation(`Duplicate cache binding for module "${binding.module}"`);
      boundModules.add(binding.module);
      const namespace = cacheNamespaceForModule(binding.module);
      if (boundNamespaces.has(namespace)) throw PlatformError.validation(`Cache namespace collision for module "${binding.module}"`);
      boundNamespaces.add(namespace);
      binding.bind(Object.freeze({ cache: cache.forNamespace(namespace), mutex: mutex.forNamespace(namespace) }));
    }
    const boundStorageModules = new Set<string>();
    for (const binding of options.storageBindings ?? []) {
      if (!moduleNames.has(binding.module)) throw PlatformError.validation(`Storage binding targets unknown module "${binding.module}"`);
      if (boundStorageModules.has(binding.module)) throw PlatformError.validation(`Duplicate storage binding for module "${binding.module}"`);
      boundStorageModules.add(binding.module);
      binding.bind(storage.forNamespace(cacheNamespaceForModule(binding.module)));
    }
    const authorization = new AuthorizationService();
    // 重設與驗證連結是 base 一定會用到的簽發值，所以簽章金鑰不是選配（ADR 0042）。
    const identityTokens = new IdentityTokenService(requireKeyring({ keyring }, 'identity'));
    const apiTokens = new ApiTokenService(options.roles);
    const mfa = new MfaService(requireKeyring({ keyring }, 'identity'), config.store.name);
    identityCleanupDeps = { database, tokens: identityTokens };
    const auth = new AuthService({
      operatorMs: config.auth.sessionTtlMinutes.operator * 60_000,
      customerMs: config.auth.sessionTtlMinutes.customer * 60_000,
    }, options.roles, {
      database,
      tokens: identityTokens,
      mfa,
      // 延後取值，和同檔其他晚一步的相依一致：直接抓當下的值，會讓「mail 的建構
      // 哪天挪到這行之後」變成第一個按下忘記密碼的人才收到的 500。
      mail: { queue: (tx, request) => mail!.queue(tx, request) },
      publicUrl: config.http.publicUrl.replace(/\/+$/, ''),
      storeName: config.store.name,
      locale: config.store.locale,
    });
    // 綁定放在 auth 建好之後：登入頁要的是這個實例，而這一行以上它還不存在。
    // 資料庫握柄在這裡補上，模組拿到的 port 看不到它（ADR 0040 的 bindPorts 機制）。
    for (const mod of allModules) {
      mod.bindPorts?.({
        // 兩者都延後取值，和同檔 mail 的做法一致：這個迴圈已經因為建構順序被搬過一次，
        // 傳值的寫法下次再搬就會靜默變成 undefined。
        get notifications() { return notifications; },
        get media() { return media!.references; },
        authentication: {
          authenticate: input => auth.authenticate(database.db, input),
          register: input => auth.register(input),
          requestPasswordReset: input => auth.requestPasswordReset(input),
          resetPassword: async input => { await auth.resetPassword(input); },
        },
        logger,
      });
    }

    const audit = new AuditWriter();
    const jobRegistry = new JobRegistry();
    const recurring = new RecurringScheduler({ jobs, database, logger, pollIntervalMs: config.worker.pollIntervalMs });
    scheduler = recurring;
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
        jobRegistry.register(j.type, j.handler, mod.name, j.jobContractV1);
        if (j.schedule) recurring.register(j.type, j.schedule);
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
      jobs, jobRegistry, providers, mcpTools, authorization, secrets, logger, platformVersion, mail,
    });
    jobs.setPayloadVersionResolver((type) => jobRegistry.currentVersion(type));

    const host = extensions;
    let activation: Promise<readonly string[]> | undefined;
    let activatedRelease: Readonly<{ readonly id: string; readonly version: string }> | null = null;

    const runtime: Runtime<C> = {
      roles: options.roles, config, secrets, keyring, logger, database, authorization, auth, apiTokens, mfa, audit, outbox, jobs, jobRegistry, recurring, storage, media, mail, notifications,
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
            cache.startCleanup();
            storage.startCleanup({
              intervalMs: config.storage.cleanupIntervalMs,
              staleAfterMs: config.storage.staleObjectSeconds * 1_000,
              onError: error => logger.warn({ error: error instanceof Error ? error.message : String(error) }, 'storage cleanup failed'),
            });
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
